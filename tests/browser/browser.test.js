import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { chromium, devices } from 'playwright'
import { serve } from '@hono/node-server'
import { createServer as createViteServer } from 'vite'
import { createBackend } from '../../server/app.js'
import { MemorySessionStore } from '../../server/storage/memory.js'

/**
 * 浏览器端验证。
 *
 * 单独一个脚本（npm run test:browser），不并进 npm test：需要先装 chromium，
 * 且比接口测试慢一个量级。
 *
 * 这里只验接口测试做不到的事：
 *   1. Vue 应用真的挂载并渲染
 *   2. 下载链路：fetch → blob → <a download> → 落盘，文件名是附件名
 *   3. CORS 在真实浏览器里的放行与拦截
 *   4. 登录：表单、错误展示、localStorage 里存了什么、刷新后是否还在
 *
 * 全部测试共用一个 Vite + 一个 chromium——node --test 会把多个测试文件放进
 * 不同进程并行跑，分成两个文件就会抢同一个端口，所以必须合在一处。
 */

const BACKEND_PORT = 8787
const APP_PORT = 5173
const ALLOWED_ORIGIN = 'http://127.0.0.1:9911' // 模拟 GitHub Pages 域名（已放行）
const BLOCKED_ORIGIN = 'http://127.0.0.1:9912' // 未放行的来源
const APP_ORIGIN = `http://127.0.0.1:${APP_PORT}`
const BACKEND_ORIGIN = `http://127.0.0.1:${BACKEND_PORT}`

const EXPIRES_AT = Date.now() + 3600_000

/** 统一登录接口的响应：一次认证，两个系统各一个 sessionId。 */
const LOGIN_OK = {
  success: true,
  data: {
    ucloud: { sessionId: 'uc-sid', username: '2021001234', realName: '张三' },
    jwgl: { sessionId: 'jw-sid', username: '2021001234' },
    jwglVia: 'cas',
    expiresAt: EXPIRES_AT,
  },
}

/** 单系统探活接口的响应。 */
const UCLOUD_SESSION = {
  success: true,
  data: { sessionId: 'uc-sid', username: '2021001234', realName: '张三', expiresAt: EXPIRES_AT },
}

/** localStorage 里存的样子——只有 sessionId、学号、姓名、过期时间。 */
const STORED_UCLOUD = {
  sessionId: 'uc-sid',
  username: '2021001234',
  realName: '张三',
  expiresAt: EXPIRES_AT,
}

// chrome-headless-shell 没装成（CDN 连接被重置），用完整的 chromium 构建顶上。
const LAUNCH_OPTIONS = { channel: 'chromium' }

// 微信内置浏览器的 UA。企业微信的 webview 也带 MicroMessenger。
const WECHAT_UA =
  'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 '
  + 'MicroMessenger/8.0.49 MicroMessage/6.5.9'

let backend
let vite
let browser
const staticServers = []

function listen(server, port) {
  return new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, '127.0.0.1', resolve)
  })
}

function close(server) {
  return new Promise((resolve) => server.close(() => resolve()))
}

/** 起一个只返回一页 HTML 的静态源，用来模拟「前端在另一个域名上」。 */
function startCrossOriginServer(origin) {
  const { port } = new URL(origin)
  const server = createServer((request, response) => {
    response.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    response.end('<!DOCTYPE html><title>cross-origin</title><h1>cross-origin</h1>')
  })
  staticServers.push(server)
  return listen(server, Number(port))
}

function fulfill(route, body, status = 200) {
  return route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })
}

before(async () => {
  const store = new MemorySessionStore()
  backend = serve({
    fetch: createBackend({ getSessionStore: () => store, allowedOrigins: [ALLOWED_ORIGIN] }).fetch,
    hostname: '127.0.0.1',
    port: BACKEND_PORT,
  })
  await new Promise((resolve) => backend.on('listening', resolve))

  await startCrossOriginServer(ALLOWED_ORIGIN)
  await startCrossOriginServer(BLOCKED_ORIGIN)

  vite = await createViteServer({
    root: process.cwd(),
    configFile: './vite.config.js',
    server: { port: APP_PORT, host: '127.0.0.1' },
    logLevel: 'warn',
  })
  await vite.listen()

  try {
    browser = await chromium.launch(LAUNCH_OPTIONS)
  } catch (error) {
    throw new Error(
      `无法启动 chromium：${error.message}\n` +
        '请先执行：npx playwright install chromium\n' +
        '（若 chrome-headless-shell 下载失败，完整的 chromium 构建就够用，本测试用 channel: "chromium" 指定它）',
    )
  }
})

after(async () => {
  await browser?.close()
  await vite?.close()
  await close(backend)
  await Promise.all(staticServers.map(close))
})

// ── 应用挂载 ────────────────────────────────────────────────────────────────

test('应用真的挂载，并显示后端已连接', async () => {
  const page = await browser.newPage()
  try {
    await page.goto(APP_ORIGIN, { waitUntil: 'networkidle' })

    const heading = await page.textContent('h1')
    assert.equal(heading, 'BUPT-week')

    await page.waitForFunction(() => /后端已连接/.test(document.querySelector('.footnote')?.textContent || ''), {
      timeout: 10000,
    })
  } finally {
    await page.close()
  }
})

// ── 下载链路 ────────────────────────────────────────────────────────────────

test('下载链路：真实浏览器里落盘，文件名是附件名', async () => {
  const page = await browser.newPage()
  try {
    const downloadPromise = page.waitForEvent('download')
    await page.goto(
      `${APP_ORIGIN}/tests/browser/fixtures/download-harness.html` +
        `?url=${encodeURIComponent('/tests/browser/fixtures/sample.pdf')}` +
        `&name=${encodeURIComponent('作业附件-第一章.pdf')}`,
    )

    await page.click('#download')
    const download = await downloadPromise

    // 关键断言：文件名是作业里显示的附件名，不是 S3 的 storageId.pdf
    assert.equal(download.suggestedFilename(), '作业附件-第一章.pdf')

    const saved = await download.path()
    assert.ok(readFileSync(saved, 'utf8').startsWith('%PDF-1.4'), '落盘内容应与源文件一致')
  } finally {
    await page.close()
  }
})

test('下载链路：上游 404 时抛出可读错误', async () => {
  const page = await browser.newPage()
  try {
    // 走 /api 代理打到后端的 404。不能直接用 tests/ 下不存在的文件——Vite dev
    // 开了 SPA fallback，缺失文件会返回 index.html 且状态码是 200，根本不会失败。
    await page.goto(
      `${APP_ORIGIN}/tests/browser/fixtures/download-harness.html` +
        `?url=${encodeURIComponent('/api/does-not-exist')}` +
        `&name=${encodeURIComponent('whatever.pdf')}`,
    )

    await page.click('#download')
    await page.waitForFunction(() => document.getElementById('result').textContent.startsWith('error:'), {
      timeout: 10000,
    })

    assert.match(await page.textContent('#result'), /error: 下载失败（HTTP 404）/)
  } finally {
    await page.close()
  }
})

// ── CORS ────────────────────────────────────────────────────────────────────

test('CORS：已放行的来源在真实浏览器里能调到后端', async () => {
  const page = await browser.newPage()
  try {
    await page.goto(ALLOWED_ORIGIN)

    // evaluate 在页面上下文里跑，所以这个 fetch 是真正跨域的
    const outcome = await page.evaluate(async (url) => {
      try {
        const response = await fetch(url)
        return { ok: response.ok, status: response.status }
      } catch (error) {
        return { blocked: error.message }
      }
    }, `${BACKEND_ORIGIN}/api/health`)

    assert.deepEqual(outcome, { ok: true, status: 200 })
  } finally {
    await page.close()
  }
})

test('CORS：未放行的来源被浏览器拦下', async () => {
  const page = await browser.newPage()
  try {
    await page.goto(BLOCKED_ORIGIN)

    const outcome = await page.evaluate(async (url) => {
      try {
        await fetch(url)
        return { reached: true }
      } catch (error) {
        return { blocked: true, message: error.message }
      }
    }, `${BACKEND_ORIGIN}/api/health`)

    assert.equal(outcome.blocked, true, `本应被拦，实际 ${JSON.stringify(outcome)}`)
    assert.match(outcome.message, /Failed to fetch|NetworkError|CORS/i)
  } finally {
    await page.close()
  }
})

test('下载接口：无会话时返回 401 且带 stage（浏览器侧看到的形状）', async () => {
  const page = await browser.newPage()
  try {
    await page.goto(ALLOWED_ORIGIN)

    const body = await page.evaluate(async (url) => {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: 'nope', resourceId: 'x' }),
      })
      return { status: response.status, payload: await response.json() }
    }, `${BACKEND_ORIGIN}/api/ucloud/resource/download`)

    assert.equal(body.status, 401)
    assert.equal(body.payload.success, false)
    assert.equal(body.payload.stage, 'ucloud-auth')
    assert.match(body.payload.msg, /重新登录/)
  } finally {
    await page.close()
  }
})

// ── 登录 ────────────────────────────────────────────────────────────────────

const panel = '.panel'

test('统一登录：只有一个表单，并说明不登录也能浏览', async () => {
  const page = await browser.newPage()
  try {
    await page.goto(APP_ORIGIN, { waitUntil: 'networkidle' })

    // 未登录时登录面板自动展开，但只有一套输入
    assert.equal(await page.locator('.panel').count(), 1)
    assert.equal(await page.locator('.login-form input[type="text"]').count(), 1)
    assert.equal(await page.locator('.login-form input[type="password"]').count(), 1)
    assert.equal(await page.textContent('.panel h2'), '登录')

    // 文案要说清两件事：登录一次即可 + 不登录也能看
    const hint = await page.textContent('.panel .hint')
    assert.match(hint, /登录一次即可/)
    assert.match(hint, /不登录也能浏览/)
  } finally {
    await page.close()
  }
})

test('登录不是门禁：未登录也能进页面、也能切视图', async () => {
  const page = await browser.newPage()
  try {
    await page.goto(APP_ORIGIN, { waitUntil: 'networkidle' })

    // 没有登录墙：课表视图直接可见
    await page.waitForSelector('.tabs')
    assert.equal(await page.textContent('.view h2'), '课表')
    assert.match(await page.textContent('.view .empty'), /登录后可以查看课表/)

    // 能切到作业视图，照样不被拦
    await page.click('.tabs button:nth-child(2)')
    assert.equal(await page.textContent('.view h2'), '作业')
    assert.match(await page.textContent('.view .empty'), /登录后可以查看作业/)

    // 顶栏显示"未登录"，不是"请先登录"的遮罩
    assert.match(await page.textContent('.topbar-auth'), /未登录/)
  } finally {
    await page.close()
  }
})

test('登录后面板收起，顶栏显示姓名，视图仍可切换', async () => {
  const page = await browser.newPage()
  try {
    await page.route('**/api/auth/login', (route) => fulfill(route, LOGIN_OK))

    await page.goto(APP_ORIGIN, { waitUntil: 'networkidle' })
    await page.fill(`${panel} input[type="text"]`, '2021001234')
    await page.fill(`${panel} input[type="password"]`, 'pw')
    await page.click(`${panel} button[type="submit"]`)

    // 登录后面板收起（v-if 不再渲染），顶栏出现姓名和退出
    await page.waitForFunction(() => document.querySelectorAll('.panel').length === 0)
    assert.match(await page.textContent('.topbar-auth'), /张三/)

    // 视图照常可切
    await page.click('.tabs button:nth-child(2)')
    assert.equal(await page.textContent('.view h2'), '作业')
    // 已登录时的空状态文案不同——说的是"正在开发中"，不是"请登录"
    assert.match(await page.textContent('.view .empty'), /正在开发中/)
  } finally {
    await page.close()
  }
})


test('登录成功后显示姓名，localStorage 里只有 sessionId', async () => {
  const page = await browser.newPage()
  try {
    await page.route('**/api/auth/login', (route) => fulfill(route, LOGIN_OK))

    await page.goto(APP_ORIGIN, { waitUntil: 'networkidle' })
    await page.fill(`${panel} input[type="text"]`, '2021001234')
    await page.fill(`${panel} input[type="password"]`, 'pw')
    await page.click(`${panel} button[type="submit"]`)

    // 登录后面板整块卸载，姓名移到顶栏
    await page.waitForFunction(() => document.querySelectorAll('.panel').length === 0)
    assert.match(await page.textContent('.topbar-auth'), /张三/)

    // 关键断言：凭证不进前端存储
    const stored = await page.evaluate(() => JSON.parse(localStorage.getItem('bupt-week-ucloud-auth')))
    assert.deepEqual(Object.keys(stored).sort(), ['expiresAt', 'realName', 'sessionId', 'username'])
    for (const [key, value] of Object.entries(stored)) {
      const text = String(value)
      for (const secret of ['pw', 'password', 'blade', 'Blade-Auth', 'access_token', 'refresh_token', 'token']) {
        assert.equal(text.includes(secret), false, `${key} 里出现了 ${secret}`)
      }
    }
  } finally {
    await page.close()
  }
})

test('登录失败时展示后端给的人话错误，不暴露 stage', async () => {
  const page = await browser.newPage()
  try {
    await page.route('**/api/auth/login', (route) =>
      fulfill(route, { success: false, stage: 'cas-login', msg: '用户名或密码错误' }, 401),
    )

    await page.goto(APP_ORIGIN, { waitUntil: 'networkidle' })
    await page.fill(`${panel} input[type="text"]`, '2021001234')
    await page.fill(`${panel} input[type="password"]`, 'wrong')
    await page.click(`${panel} button[type="submit"]`)

    await page.waitForSelector(`${panel} .notice.error`)
    const notice = await page.textContent(`${panel} .notice.error`)
    assert.match(notice, /用户名或密码错误/)
    assert.equal(notice.includes('cas-login'), false, 'stage 不该透给用户')

    assert.equal(await page.locator(`${panel} .logged-in`).count(), 0)
  } finally {
    await page.close()
  }
})

test('刷新页面后登录态保持', async () => {
  const page = await browser.newPage()
  try {
    await page.route('**/api/auth/login', (route) => fulfill(route, LOGIN_OK))
    await page.route('**/api/ucloud/session', (route) => fulfill(route, UCLOUD_SESSION))

    await page.goto(APP_ORIGIN, { waitUntil: 'networkidle' })
    await page.fill(`${panel} input[type="text"]`, '2021001234')
    await page.fill(`${panel} input[type="password"]`, 'pw')
    await page.click(`${panel} button[type="submit"]`)
    await page.waitForFunction(() => document.querySelectorAll('.panel').length === 0)

    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForFunction(() => document.querySelectorAll('.panel').length === 0)
    assert.match(await page.textContent('.topbar-auth'), /张三/)
  } finally {
    await page.close()
  }
})

test('会话已失效时刷新页面会被打回登录态', async () => {
  const page = await browser.newPage()
  try {
    await page.goto(APP_ORIGIN)
    await page.evaluate((session) => {
      localStorage.setItem('bupt-week-ucloud-auth', JSON.stringify(session))
    }, STORED_UCLOUD)

    await page.route('**/api/ucloud/session', (route) =>
      fulfill(route, { success: false, stage: 'ucloud-auth', msg: '云邮登录已过期，请重新登录' }, 401),
    )

    await page.reload({ waitUntil: 'networkidle' })

    // restore() 失败后应回到未登录，且 localStorage 被清掉
    await page.waitForSelector(`${panel} .login-form`)
    assert.equal(await page.locator(`${panel} .logged-in`).count(), 0)
    assert.equal(await page.evaluate(() => localStorage.getItem('bupt-week-ucloud-auth')), null)
  } finally {
    await page.close()
  }
})

test('退出登录会调后端并清掉本地状态', async () => {
  const page = await browser.newPage()
  try {
    await page.route('**/api/auth/login', (route) => fulfill(route, LOGIN_OK))
    await page.route('**/api/ucloud/logout', (route) => fulfill(route, { success: true }))

    await page.goto(APP_ORIGIN, { waitUntil: 'networkidle' })
    await page.fill(`${panel} input[type="text"]`, '2021001234')
    await page.fill(`${panel} input[type="password"]`, 'pw')
    await page.click(`${panel} button[type="submit"]`)
    await page.waitForFunction(() => document.querySelectorAll('.panel').length === 0)

    await page.click('.topbar-auth button')

    // 退出后面板重新出现（未登录时常驻）
    await page.waitForSelector(`${panel} .login-form`)
    assert.equal(await page.evaluate(() => localStorage.getItem('bupt-week-ucloud-auth')), null)
  } finally {
    await page.close()
  }
})

test('输入不合法时拦住，不发登录请求', async () => {
  const page = await browser.newPage()
  let loginCalls = 0
  try {
    await page.route('**/api/auth/login', (route) => {
      loginCalls += 1
      return fulfill(route, LOGIN_OK)
    })

    await page.goto(APP_ORIGIN, { waitUntil: 'networkidle' })

    // 完全空着：input 上的 required 拦住 submit。
    await page.click(`${panel} button[type="submit"]`)
    await page.waitForTimeout(300)
    assert.equal(loginCalls, 0, '空表单不该发请求')
    assert.equal(await page.locator(`${panel} .notice.error`).count(), 0)
    assert.equal(await page.locator(`${panel} .login-form`).count(), 1, '应仍停留在登录表单')

    // 学号只填空白：v-model.trim 把它变成空串，同样被 required 拦住。
    await page.fill(`${panel} input[type="text"]`, '   ')
    await page.fill(`${panel} input[type="password"]`, 'pw')
    await page.click(`${panel} button[type="submit"]`)
    await page.waitForTimeout(300)

    assert.equal(loginCalls, 0, '空白学号不该发请求')
    assert.equal(await page.locator(`${panel} .login-form`).count(), 1, '应仍停留在登录表单')
  } finally {
    await page.close()
  }
})

test('一次登录同时建立两个系统的登录态', async () => {
  const page = await browser.newPage()
  try {
    await page.route('**/api/auth/login', (route) =>
      fulfill(route, {
        success: true,
        data: {
          ucloud: { sessionId: 'uc-1', username: '2021001234', realName: '张三' },
          jwgl: { sessionId: 'jw-1', username: '2021001234' },
          expiresAt: Date.now() + 3600_000,
        },
      }),
    )

    await page.goto(APP_ORIGIN, { waitUntil: 'networkidle' })
    await page.fill(`${panel} input[type="text"]`, '2021001234')
    await page.fill(`${panel} input[type="password"]`, 'pw')
    await page.click(`${panel} button[type="submit"]`)

    await page.waitForFunction(() => document.querySelectorAll('.panel').length === 0)

    // 对外是一个登录态：顶栏显示姓名
    assert.match(await page.textContent('.topbar-auth'), /张三/)

    // 内部是两个系统的独立凭证，各存各的 key
    const keys = await page.evaluate(() =>
      Object.keys(localStorage)
        .filter((key) => key.startsWith('bupt-week-'))
        .sort(),
    )
    assert.deepEqual(keys, ['bupt-week-jwgl-auth', 'bupt-week-ucloud-auth'])
  } finally {
    await page.close()
  }
})

// ── 移动端与微信内体验 ──────────────────────────────────────────────────────

test('手机宽度下不错位，触摸目标够大', async () => {
  const context = await browser.newContext({ ...devices['iPhone 13'] })
  const page = await context.newPage()
  try {
    await page.goto(APP_ORIGIN, { waitUntil: 'networkidle' })

    // 没有横向溢出
    const overflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    assert.ok(overflow <= 1, `出现横向溢出 ${overflow}px`)

    // 顶栏登录钮和 tab 的触摸高度不低于 44px
    const tabHeight = await page.locator('.tabs button').first().evaluate((el) => el.getBoundingClientRect().height)
    assert.ok(tabHeight >= 44, `tab 高度仅 ${tabHeight}px`)

    const buttonHeight = await page
      .locator(`${panel} button[type="submit"]`)
      .evaluate((el) => el.getBoundingClientRect().height)
    assert.ok(buttonHeight >= 44, `登录按钮高度仅 ${buttonHeight}px`)
  } finally {
    await context.close()
  }
})

test('普通浏览器不自动发起企业微信流程', async () => {
  const page = await browser.newPage()
  let wecomHits = 0
  await page.route('**/api/auth/wecom/start', (route) => {
    wecomHits += 1
    return route.abort()
  })

  await page.goto(APP_ORIGIN, { waitUntil: 'networkidle' })
  await page.waitForSelector('.tabs')
  await page.waitForTimeout(500)

  assert.equal(wecomHits, 0, '普通浏览器不该自动跳企业微信')
  // 企业微信手动登录按钮也不该出现
  assert.equal(await page.locator('.wecom').count(), 0)
})

test('微信 webview 里未登录会自动发起企业微信流程', async () => {
  const context = await browser.newContext({ userAgent: WECHAT_UA })
  const page = await context.newPage()

  // 用请求事件计数，不用 waitForFunction——后者在浏览器上下文跑，
  // 访问不到 Node 这边的变量。
  const seen = []
  page.on('request', (request) => {
    if (request.url().includes('/api/auth/wecom/start')) seen.push(request.url())
  })
  // abort 掉导航，请求本身就足够证明"应用发起了流程"
  await page.route('**/api/auth/wecom/start', (route) => route.abort())

  await page.goto(APP_ORIGIN, { waitUntil: 'domcontentloaded' })
  await page.waitForRequest('**/api/auth/wecom/start', { timeout: 10000 })

  assert.ok(seen.length >= 1, '微信里未登录应当自动发起企业微信流程')
  await context.close()
})

test('同一会话内不会重复自动跳（防循环标记生效）', async () => {
  const context = await browser.newContext({ userAgent: WECHAT_UA })
  const page = await context.newPage()

  // 预先打下"本次会话已试过"的标记——这正是 App.vue 里防循环用的那个 key
  await context.addInitScript(() => {
    sessionStorage.setItem('bupt-week-auto-wecom-tried', '1')
  })

  const seen = []
  page.on('request', (request) => {
    if (request.url().includes('/api/auth/wecom/start')) seen.push(request.url())
  })

  await page.goto(APP_ORIGIN, { waitUntil: 'networkidle' })
  await page.waitForSelector('.tabs')
  await page.waitForTimeout(800)

  assert.equal(seen.length, 0, '有标记后不该再自动跳，否则用户卡死在循环里')
  // 页面照常可用，登录面板在手边
  await page.waitForSelector(`${panel} .login-form`)
  await context.close()
})

test('微信里即便不自动跳，手动企业微信登录按钮也在（兜底）', async () => {
  const context = await browser.newContext({ userAgent: WECHAT_UA })
  const page = await context.newPage()

  // 预先打下防循环标记：不自动跳，页面才能活着，才看得到兜底按钮
  await context.addInitScript(() => {
    sessionStorage.setItem('bupt-week-auto-wecom-tried', '1')
  })

  await page.goto(APP_ORIGIN, { waitUntil: 'networkidle' })

  // 自动识别没成功时，用户得有个手动入口
  await page.waitForSelector('.wecom')
  assert.equal(await page.textContent('.wecom'), '企业微信登录')
  assert.equal(await page.getAttribute('.wecom', 'href'), '/api/auth/wecom/start')
  await context.close()
})
