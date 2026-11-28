import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { existsSync, readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { extname, resolve } from 'node:path'
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

/**
 * 降级登录的响应：教务密码与统一身份不同（校外实测场景），云邮照常登录。
 * jwgl 为 null + jwglMessage 说明原因，jwglPasswordNeeded 开放补填入口。
 */
const LOGIN_JWGL_UNAVAILABLE = {
  success: true,
  data: {
    ucloud: { sessionId: 'uc-sid', username: '2021001234', realName: '张三' },
    jwgl: null,
    jwglVia: 'unavailable',
    jwglMessage: '教务登录失败：教务系统密码可能与统一身份密码不同。作业功能不受影响；可在课表页补填教务密码。',
    jwglPasswordNeeded: true,
    expiresAt: EXPIRES_AT,
  },
}

/** localStorage 里存的样子——只有 sessionId、学号、姓名、过期时间。 */
const STORED_UCLOUD = {
  sessionId: 'uc-sid',
  username: '2021001234',
  realName: '张三',
  expiresAt: EXPIRES_AT,
}

// 默认用完整的 chromium 构建（channel: 'chromium'）。
// CDN 下载受限的机器可以设 BROWSER_EXECUTABLE 指到系统浏览器顶替，
// 例如 Edge：BROWSER_EXECUTABLE="C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe"
const LAUNCH_OPTIONS = process.env.BROWSER_EXECUTABLE
  ? { executablePath: process.env.BROWSER_EXECUTABLE }
  : { channel: 'chromium' }

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

test('下载链路：流式读取的进度回调最后报满（received === total > 0）', async () => {
  const page = await browser.newPage()
  try {
    await page.goto(
      `${APP_ORIGIN}/tests/browser/fixtures/download-harness.html` +
        `?url=${encodeURIComponent('/tests/browser/fixtures/sample.pdf')}` +
        `&name=${encodeURIComponent('作业附件-第一章.pdf')}`,
    )

    await page.click('#download-progress')
    await page.waitForFunction(
      () => document.getElementById('result').textContent.startsWith('progress: '),
      { timeout: 10000 },
    )

    const last = JSON.parse((await page.textContent('#result')).slice('progress: '.length))
    assert.ok(last.received > 0, `应收到字节数，实际 ${JSON.stringify(last)}`)
    assert.equal(last.received, last.total, 'total 不应为 null（Content-Length 必须透传到前端）')
  } finally {
    await page.close()
  }
})

test('下载链路：解析请求的 body 带上 sessionId（漏发会被服务端当未登录，永远 401）', async () => {
  const page = await browser.newPage()
  try {
    await page.goto(`${APP_ORIGIN}/tests/browser/fixtures/download-harness.html`)

    await page.click('#resolve')
    await page.waitForFunction(
      () => document.getElementById('result').textContent.startsWith('body: '),
      { timeout: 10000 },
    )

    const sent = JSON.parse((await page.textContent('#result')).slice('body: '.length))
    assert.deepEqual(sent, { sessionId: 'sid-from-harness', resourceId: 'res-1' })
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
    await page.route('**/api/jwgl/session', (route) => fulfill(route, { success: true, data: { sessionId: 'jw-sid', username: '2021001234', expiresAt: EXPIRES_AT } }))
    await page.route('**/api/ucloud/session', (route) => fulfill(route, UCLOUD_SESSION))
    await page.route('**/api/ucloud/assignments', (route) =>
      fulfill(route, { success: true, data: { assignments: [] } }),
    )

    await page.goto(APP_ORIGIN, { waitUntil: 'networkidle' })
    await page.fill(`${panel} input[type="text"]`, '2021001234')
    await page.fill(`${panel} input[type="password"]`, 'pw')
    await page.click(`${panel} button[type="submit"]`)

    // 登录后面板收起（v-if 不再渲染），顶栏出现姓名和退出
    await page.waitForFunction(() => document.querySelectorAll('.panel').length === 0)
    assert.match(await page.textContent('.topbar-auth'), /张三/)

    // 视图照常可切；已登录时作业视图走真实数据链路（mock 空列表 → 空态文案）
    await page.click('.tabs button:nth-child(2)')
    assert.equal(await page.textContent('.view h2'), '作业')
    await page.waitForFunction(() => document.querySelector('.view .empty')?.textContent.includes('没有作业记录'))
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

test('降级登录：教务不可达时登录仍成功，课表给黄条说明，作业照常', async () => {
  const page = await browser.newPage()
  try {
    await page.route('**/api/auth/login', (route) => fulfill(route, LOGIN_JWGL_UNAVAILABLE))
    await page.route('**/api/ucloud/session', (route) => fulfill(route, UCLOUD_SESSION))
    await page.route('**/api/ucloud/assignments', (route) =>
      fulfill(route, { success: true, data: { assignments: [] } }),
    )

    await page.goto(APP_ORIGIN, { waitUntil: 'networkidle' })
    await page.fill(`${panel} input[type="text"]`, '2021001234')
    await page.fill(`${panel} input[type="password"]`, 'pw')
    await page.click(`${panel} button[type="submit"]`)

    // 登录整体成功：面板收起，顶栏显示姓名
    await page.waitForFunction(() => document.querySelectorAll('.panel').length === 0)
    assert.match(await page.textContent('.topbar-auth'), /张三/)

    // 默认视图是课表：必须是「教务不可用」黄条，而不是误导性的未登录空态。
    // 补填教务密码入口常驻（网络不可达与密码不同的降级都从这里走）
    await page.waitForSelector('.view .notice-warn')
    const notice = await page.textContent('.view .notice-warn')
    assert.match(notice, /教务系统密码与统一身份密码不同|教务系统暂时不可用/)
    assert.match(notice, /作业功能不受影响/)
    assert.equal(await page.locator('.view .empty').count(), 0)
    await page.waitForSelector('.view .notice-warn .notice-action')

    // 切到作业视图：链路完全正常（mock 空列表 → 空态文案）
    await page.click('.tabs button:nth-child(2)')
    assert.equal(await page.textContent('.view h2'), '作业')
    await page.waitForFunction(() => document.querySelector('.view .empty')?.textContent.includes('没有作业记录'))

    // 本地只存云邮一侧；jwgl key 不能残留半套假会话
    // （作业缓存 bupt-week-assignments-v1 允许存在，那是数据加速器不是登录态）
    const stored = await page.evaluate(() => ({
      ucloud: localStorage.getItem('bupt-week-ucloud-auth'),
      jwgl: localStorage.getItem('bupt-week-jwgl-auth'),
    }))
    assert.ok(stored.ucloud, '云邮登录态应已保存')
    assert.equal(stored.jwgl, null, '教务侧降级时不能残留 jwgl 登录态')
  } finally {
    await page.close()
  }
})

test('降级登录后补填教务密码：验证成功建教务会话，课表开始渲染', async () => {
  const page = await browser.newPage()
  try {
    await page.route('**/api/auth/login', (route) => fulfill(route, LOGIN_JWGL_UNAVAILABLE))
    await page.route('**/api/ucloud/session', (route) => fulfill(route, UCLOUD_SESSION))
    await page.route('**/api/jwgl/session', (route) =>
      fulfill(route, { success: true, data: { sessionId: 'wx-sid', username: '2021001234', expiresAt: EXPIRES_AT } }),
    )
    await page.route('**/api/auth/jwglweixin/password', (route) => {
      // 补填必须走云邮会话（鉴权本人），密码不落浏览器存储由下方断言守
      const body = route.request().postDataJSON() || {}
      assert.equal(body.sessionId, 'uc-sid')
      return fulfill(route, { success: true, data: { sessionId: 'wx-sid', username: '2021001234', expiresAt: EXPIRES_AT } })
    })
    await page.route('**/api/jwgl/timetable', (route) => mockTimetable(route))

    await page.goto(APP_ORIGIN, { waitUntil: 'networkidle' })
    await page.fill(`${panel} input[type="text"]`, '2021001234')
    await page.fill(`${panel} input[type="password"]`, 'pw')
    await page.click(`${panel} button[type="submit"]`)
    await page.waitForFunction(() => document.querySelectorAll('.panel').length === 0)
    await page.waitForSelector('.view .notice-warn')

    // 点开补填表单，输入教务密码提交
    await page.click('.view .notice-warn .notice-action')
    await page.fill('.view .password-form input', 'jwgl-secret')
    await page.click('.view .password-form button[type="submit"]')

    // 黄条整块卸载（ready 变 true），课表网格开始渲染
    await page.waitForFunction(() => document.querySelector('.view .grid'))
    assert.equal(await page.locator('.view .notice-warn').count(), 0)

    // 教务登录态落库；教务密码本身绝不能出现在本地存储
    const stored = await page.evaluate(() => ({
      jwgl: localStorage.getItem('bupt-week-jwgl-auth'),
      all: Object.values(localStorage).join(' '),
    }))
    assert.ok(stored.jwgl, '补填成功后教务登录态应保存')
    assert.equal(stored.all.includes('jwgl-secret'), false, '教务密码绝不能落本地存储')
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

test('会话心跳：回到前台立即补一次云邮探活（续 token + 滑动有效期）', async () => {
  const page = await browser.newPage()
  try {
    let probes = 0
    page.on('request', (request) => {
      if (request.url().includes('/api/ucloud/session')) probes += 1
    })
    await page.route('**/api/auth/login', (route) => fulfill(route, LOGIN_OK))
    await page.route('**/api/ucloud/session', (route) => fulfill(route, UCLOUD_SESSION))

    await page.goto(APP_ORIGIN, { waitUntil: 'networkidle' })
    await page.fill(`${panel} input[type="text"]`, '2021001234')
    await page.fill(`${panel} input[type="password"]`, 'pw')
    await page.click(`${panel} button[type="submit"]`)
    await page.waitForFunction(() => document.querySelectorAll('.panel').length === 0)

    // 登录后没有主动探活（restore 只在挂载时跑）
    assert.equal(probes, 0)

    // 合成 visibilitychange（模拟用户切回标签页）：心跳立即补一次
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await page.waitForTimeout(800)
    assert.ok(probes >= 1, '回前台应触发一次云邮探活')

    // 探活成功，登录态保持
    assert.match(await page.textContent('.topbar-auth'), /张三/)
  } finally {
    await page.close()
  }
})

test('教务会话过期后刷新：降级黄条出现，补填教务密码可恢复课表', async () => {
  const page = await browser.newPage()
  try {
    await page.route('**/api/auth/login', (route) => fulfill(route, LOGIN_OK))
    await page.route('**/api/ucloud/session', (route) => fulfill(route, UCLOUD_SESSION))
    await page.route('**/api/auth/jwglweixin/password', (route) =>
      fulfill(route, { success: true, data: { sessionId: 'wx-sid', username: '2021001234', expiresAt: EXPIRES_AT } }),
    )
    await page.route('**/api/jwgl/timetable', (route) => mockTimetable(route))

    await page.goto(APP_ORIGIN, { waitUntil: 'networkidle' })
    await page.fill(`${panel} input[type="text"]`, '2021001234')
    await page.fill(`${panel} input[type="password"]`, 'pw')
    await page.click(`${panel} button[type="submit"]`)
    await page.waitForFunction(() => document.querySelectorAll('.panel').length === 0)

    // 教务会话上游过期（真实场景：jwglweixin token 失效）——刷新后探活 401
    await page.route('**/api/jwgl/session', (route) =>
      fulfill(route, { success: false, stage: 'jwgl-auth', msg: '教务登录已过期，请重新登录' }, 401),
    )
    await page.reload({ waitUntil: 'networkidle' })

    // 教务侧清掉、降级黄条出现；云邮侧（顶栏姓名）不受影响
    await page.waitForSelector('.view .notice-warn')
    assert.equal(await page.evaluate(() => localStorage.getItem('bupt-week-jwgl-auth')), null, '过期的教务登录态应清除')
    assert.match(await page.textContent('.topbar-auth'), /张三/)

    // 不必重新输统一身份密码：黄条里补填教务密码即可恢复
    await page.click('.view .notice-warn .notice-action')
    await page.fill('.view .password-form input', 'jwgl-secret')
    await page.click('.view .password-form button[type="submit"]')

    await page.waitForFunction(() => document.querySelector('.view .notice-warn') === null)
    assert.ok(await page.evaluate(() => localStorage.getItem('bupt-week-jwgl-auth')), '补填后教务登录态恢复')
  } finally {
    await page.close()
  }
})

// ── 企业微信回流落地 ────────────────────────────────────────────────────────

test('企微回流：hash 带回的 sessionId 经确认后落地成登录态，且 URL 被清干净', async () => {
  const page = await browser.newPage()
  try {
    await page.route('**/api/ucloud/session', (route) => fulfill(route, UCLOUD_SESSION))

    // 后端 callback 成功后的落地形态：fragment 里有路由路径 + 参数
    await page.goto(`${APP_ORIGIN}/#/login?wecom=ok&sessionId=uc-sid`, { waitUntil: 'networkidle' })

    // 确认步：先亮明身份，未确认前绝不落地（防登录 CSRF：别人塞会话链接）
    await page.waitForSelector('.wecom-confirm')
    assert.match(await page.textContent('.wecom-confirm'), /张三/)
    assert.equal(await page.evaluate(() => localStorage.getItem('bupt-week-ucloud-auth')), null)

    await page.click('.wecom-confirm .text-button')

    // 会话真的建立：面板收起、顶栏出姓名、localStorage 落下标准形状
    await page.waitForFunction(() => document.querySelectorAll('.panel').length === 0)
    assert.match(await page.textContent('.topbar-auth'), /张三/)
    assert.deepEqual(
      await page.evaluate(() => JSON.parse(localStorage.getItem('bupt-week-ucloud-auth'))),
      STORED_UCLOUD,
    )

    // 企微路径标记：课表黄条按「企微只建云邮会话」说话，而不是猜密码不同
    assert.equal(await page.evaluate(() => localStorage.getItem('bupt-week-via-wecom')), '1')
    await page.waitForSelector('.view .notice-warn')
    assert.match(await page.textContent('.view .notice-warn'), /企业微信识别只建立了云邮/)

    // 退出登录后标记一并清掉，下次学号密码登录黄条回到密码路径的文案
    await page.click('.topbar-auth .link-button')
    await page.waitForSelector(`${panel} .login-form`)
    assert.equal(await page.evaluate(() => localStorage.getItem('bupt-week-via-wecom')), null)

    // sessionId 不能留在地址栏/历史里
    assert.equal(page.url().includes('sessionId='), false, 'sessionId 不该留在地址栏')
  } finally {
    await page.close()
  }
})

test('企微回流：确认步里点「不是本人」不落地，可用学号密码登录', async () => {
  const page = await browser.newPage()
  try {
    await page.route('**/api/ucloud/session', (route) => fulfill(route, UCLOUD_SESSION))
    await page.route('**/api/auth/login', (route) => fulfill(route, LOGIN_OK))

    await page.goto(`${APP_ORIGIN}/#/login?wecom=ok&sessionId=uc-sid`, { waitUntil: 'networkidle' })
    await page.waitForSelector('.wecom-confirm')

    await page.click('.wecom-confirm .link-button')
    await page.waitForSelector('.wecom-confirm', { state: 'detached' })
    assert.equal(await page.evaluate(() => localStorage.getItem('bupt-week-ucloud-auth')), null)
    assert.match(await page.textContent('.topbar-auth'), /未登录/)

    // 婉拒后登录面板照常可用
    await page.fill(`${panel} input[type="text"]`, '2021001234')
    await page.fill(`${panel} input[type="password"]`, 'pw')
    await page.click(`${panel} button[type="submit"]`)
    await page.waitForFunction(() => document.querySelectorAll('.panel').length === 0)
    assert.match(await page.textContent('.topbar-auth'), /张三/)
  } finally {
    await page.close()
  }
})

test('企微回流：sessionId 无效时保持未登录，URL 同样被清掉', async () => {
  const page = await browser.newPage()
  try {
    await page.route('**/api/ucloud/session', (route) =>
      fulfill(route, { success: false, stage: 'ucloud-auth', msg: '云邮登录已过期，请重新登录' }, 401),
    )

    await page.goto(`${APP_ORIGIN}/#/login?wecom=ok&sessionId=uc-dead`, { waitUntil: 'networkidle' })
    await page.waitForSelector(`${panel} .login-form`)

    assert.match(await page.textContent('.topbar-auth'), /未登录/)
    assert.equal(await page.evaluate(() => localStorage.getItem('bupt-week-ucloud-auth')), null)
    assert.equal(page.url().includes('sessionId='), false)
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

test('对抗：登出后在途心跳不能把登录态写回（退出不复活）', async () => {
  const page = await browser.newPage()
  let releaseProbe = () => {}
  try {
    // 心跳探活的响应捏在闸里：等用户登出完成后再放行，模拟慢上游
    const probeGate = new Promise((resolve) => { releaseProbe = resolve })
    await page.route('**/api/auth/login', (route) => fulfill(route, LOGIN_OK))
    await page.route('**/api/jwgl/session', (route) => fulfill(route, { success: true, data: { sessionId: 'jw-sid', username: '2021001234', expiresAt: EXPIRES_AT } }))
    await page.route('**/api/ucloud/logout', (route) => fulfill(route, { success: true }))
    await page.route('**/api/jwgl/logout', (route) => fulfill(route, { success: true }))
    await page.route('**/api/ucloud/session', async (route) => {
      await probeGate
      fulfill(route, UCLOUD_SESSION)
    })

    await page.goto(APP_ORIGIN, { waitUntil: 'networkidle' })
    await page.fill(`${panel} input[type="text"]`, '2021001234')
    await page.fill(`${panel} input[type="password"]`, 'pw')
    await page.click(`${panel} button[type="submit"]`)
    await page.waitForFunction(() => document.querySelectorAll('.panel').length === 0)

    // 派 visibilitychange 触发心跳（间隔条件初始即满足），探活被闸挂起
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')))
    await page.waitForTimeout(300)

    await page.click('.topbar-auth button')
    await page.waitForFunction(() => document.querySelector('.topbar-auth .who')?.textContent === '未登录')

    // 放行迟到的 200 响应：修复前 heartbeat 会把 {...null, ...data} 写回本地
    releaseProbe()
    await page.waitForTimeout(400)

    assert.equal(
      await page.evaluate(() => localStorage.getItem('bupt-week-ucloud-auth')),
      null,
      '迟到的探活响应不得把登录态写回',
    )
    assert.match(await page.textContent('.topbar-auth'), /未登录/)
  } finally {
    releaseProbe()
    await page.close()
  }
})

test('对抗：登出在途的班级响应不能写回，换号后不得看到上一账号的班级', async () => {
  const page = await browser.newPage()
  let releaseList = () => {}
  let listCalls = 0
  try {
    // 第一次班级列表捏在闸里（A 的数据），放行要在登出之后；
    // 之后的调用（换号后的重新加载）返回空列表。
    const listGate = new Promise((resolve) => { releaseList = resolve })
    await page.route('**/api/auth/login', (route) => fulfill(route, LOGIN_OK))
    await page.route('**/api/ucloud/session', (route) => fulfill(route, UCLOUD_SESSION))
    await page.route('**/api/ucloud/logout', (route) => fulfill(route, { success: true }))
    await page.route('**/api/jwgl/logout', (route) => fulfill(route, { success: true }))
    await page.route('**/api/ucloud/assignments', (route) =>
      fulfill(route, { success: true, data: { assignments: [] } }))
    await page.route('**/api/classes/list', async (route) => {
      listCalls += 1
      if (listCalls === 1) {
        await listGate
        return fulfill(route, { success: true, data: { classes: [
          { classId: 'cls-a', code: '7XA4K2M9Q3', name: '软件 2301 班', createdBy: '2021001234', memberCount: 1, createdAt: Date.now() },
        ] } })
      }
      return fulfill(route, { success: true, data: { classes: [] } })
    })
    await page.route('**/api/classes/assignments', (route) => {
      // 修复前：迟到的列表响应会继续逐班拉作业；修复后不会发这次请求。
      return fulfill(route, { success: true, data: { assignments: [
        { id: 'ca-a', assignmentTitle: 'A 的班级作业', chapterName: '高等数学', siteId: 'class:cls-a',
          siteName: '软件 2301 班', assignmentEndTime: '', assignmentStatus: 99, content: 'A 的内容', createdBy: '2021001234' },
      ] } })
    })

    await page.goto(APP_ORIGIN, { waitUntil: 'networkidle' })
    await page.fill(`${panel} input[type="text"]`, '2021001234')
    await page.fill(`${panel} input[type="password"]`, 'pw')
    await page.click(`${panel} button[type="submit"]`)
    await page.waitForFunction(() => document.querySelectorAll('.panel').length === 0)

    // 作业 tab 触发班级加载，列表请求被闸挂起（必须确认真的在途再登出）
    const listPending = page.waitForRequest('**/api/classes/list')
    await page.click('.tabs button:nth-child(2)')
    await listPending

    // 在途时登出：reset 作废 revision，迟到的响应不允许写回
    await page.click('.topbar-auth button')
    await page.waitForSelector(`${panel} .login-form`)
    releaseList()
    await page.waitForTimeout(400)

    // 换号（同一 mock 会话）后打开班级与作业页：不得残留上一账号的班级与作业
    await page.fill(`${panel} input[type="text"]`, '2021001234')
    await page.fill(`${panel} input[type="password"]`, 'pw')
    await page.click(`${panel} button[type="submit"]`)
    await page.waitForFunction(() => document.querySelectorAll('.panel').length === 0)

    await page.click('.tabs button:has-text("班级")')
    await page.waitForTimeout(500)
    assert.equal(await page.locator('.view .class-card').count(), 0, '迟到的班级列表不得写回')

    await page.click('.tabs button:nth-child(2)')
    await page.waitForTimeout(500)
    const groupText = await page.locator('.view').textContent()
    assert.ok(!groupText.includes('A 的班级作业'), '换号后不得看到上一账号的班级作业')
    assert.equal(listCalls >= 2, true, '换号后班级列表应重新加载')
  } finally {
    releaseList()
    await page.close()
  }
})

test('对抗：登出在途的课件课程列表不能写回，换号后不得看到上一账号的课程', async () => {
  const page = await browser.newPage()
  let releaseCourses = () => {}
  let coursesCalls = 0
  try {
    const coursesGate = new Promise((resolve) => { releaseCourses = resolve })
    await page.route('**/api/auth/login', (route) => fulfill(route, LOGIN_OK))
    await page.route('**/api/ucloud/session', (route) => fulfill(route, UCLOUD_SESSION))
    await page.route('**/api/ucloud/logout', (route) => fulfill(route, { success: true }))
    await page.route('**/api/jwgl/logout', (route) => fulfill(route, { success: true }))
    await page.route('**/api/ucloud/courses', async (route) => {
      coursesCalls += 1
      if (coursesCalls === 1) {
        await coursesGate
        return fulfill(route, { success: true, data: { courses: [
          { id: 'site-a', name: 'A 的高等数学', teacher: 'A 的老师' },
        ] } })
      }
      return fulfill(route, { success: true, data: { courses: [] } })
    })

    await page.goto(APP_ORIGIN, { waitUntil: 'networkidle' })
    await page.fill(`${panel} input[type="text"]`, '2021001234')
    await page.fill(`${panel} input[type="password"]`, 'pw')
    await page.click(`${panel} button[type="submit"]`)
    await page.waitForFunction(() => document.querySelectorAll('.panel').length === 0)

    // 课件 tab 触发课程列表加载，请求被闸挂起（必须确认真的在途再登出）
    const coursesPending = page.waitForRequest('**/api/ucloud/courses')
    await page.click('.tabs button:has-text("课件")')
    await coursesPending

    await page.click('.topbar-auth button')
    await page.waitForSelector(`${panel} .login-form`)
    releaseCourses()
    await page.waitForTimeout(400)

    await page.fill(`${panel} input[type="text"]`, '2021001234')
    await page.fill(`${panel} input[type="password"]`, 'pw')
    await page.click(`${panel} button[type="submit"]`)
    await page.waitForFunction(() => document.querySelectorAll('.panel').length === 0)

    await page.click('.tabs button:has-text("课件")')
    await page.waitForTimeout(500)
    const text = await page.locator('.view').textContent()
    assert.ok(!text.includes('A 的高等数学'), '迟到的课程列表不得写回')
    assert.equal(coursesCalls >= 2, true, '换号后课程列表应重新加载')
  } finally {
    releaseCourses()
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

test('主题：首次跟随系统，亮暗变化会更新页面和浏览器颜色', async () => {
  const page = await browser.newPage({ colorScheme: 'dark' })
  try {
    await page.goto(APP_ORIGIN, { waitUntil: 'networkidle' })
    assert.equal(await page.locator('.brand-mark').count(), 0, '移除左上角的周标识')
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark')
    assert.equal(await page.locator('body').evaluate((el) => getComputedStyle(el).backgroundColor), 'rgb(18, 20, 23)')
    assert.equal(await page.locator('meta[name="theme-color"]').getAttribute('content'), '#121417')
    assert.equal(await page.locator('.login-form .button-primary').evaluate((el) => getComputedStyle(el).backgroundColor), 'rgb(126, 168, 239)')
    assert.ok(await page.getByRole('button', { name: '切换到亮色模式' }).isVisible())
    await page.emulateMedia({ colorScheme: 'light' })
    await page.waitForFunction(() => document.documentElement.dataset.theme === 'light')
    assert.equal(await page.locator('body').evaluate((el) => getComputedStyle(el).backgroundColor), 'rgb(247, 245, 240)')
    assert.equal(await page.locator('meta[name="theme-color"]').getAttribute('content'), '#f7f5f0')
  } finally {
    await page.close()
  }
})

test('主题：手动选择覆盖系统，课表随主题切换，刷新与退出后保留选择', async () => {
  const page = await browser.newPage({ colorScheme: 'dark', viewport: { width: 390, height: 844 } })
  try {
    await page.route('**/api/ucloud/logout', (route) => fulfill(route, { success: true }))
    await page.route('**/api/jwgl/logout', (route) => fulfill(route, { success: true }))
    await loginAndOpenTimetable(page)
    await page.waitForSelector('.course-item')
    const darkCourse = await page.locator('.course-item').first().evaluate((el) => getComputedStyle(el).backgroundColor)
    await page.getByRole('button', { name: '切换到亮色模式' }).click()
    const lightCourse = await page.locator('.course-item').first().evaluate((el) => getComputedStyle(el).backgroundColor)
    assert.notEqual(darkCourse, lightCourse, '课程卡颜色也应遵循手动主题')
    assert.equal(await page.evaluate(() => localStorage.getItem('bupt-week-theme')), 'light')
    await page.reload({ waitUntil: 'networkidle' })
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light', '刷新时不能被系统暗色覆盖')
    await page.click('.topbar-auth button')
    await page.waitForSelector('.login-form')
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light', '退出不应清掉主题偏好')
    await page.setViewportSize({ width: 320, height: 740 })
    assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), '320px 窄屏不应横向溢出')
    await page.getByRole('button', { name: '切换到暗色模式' }).click()
    await page.emulateMedia({ colorScheme: 'light' })
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark', '手动选择不应被系统变化覆盖')
  } finally {
    await page.close()
  }
})

test('主题：偏好存储无法读写时仍能切换', async () => {
  const page = await browser.newPage({ colorScheme: 'light' })
  const errors = []
  page.on('pageerror', (error) => errors.push(error.message))
  try {
    await page.addInitScript(() => {
      for (const name of ['getItem', 'setItem']) {
        const original = Storage.prototype[name]
        Storage.prototype[name] = function (key, ...args) {
          if (key === 'bupt-week-theme') throw new DOMException('Blocked', 'SecurityError')
          return original.call(this, key, ...args)
        }
      }
    })
    await page.goto(APP_ORIGIN, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: '切换到暗色模式' }).click()
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'dark')
    await page.getByRole('button', { name: '切换到亮色模式' }).click()
    assert.equal(await page.locator('html').getAttribute('data-theme'), 'light')
    assert.deepEqual(errors, [])
  } finally {
    await page.close()
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

test('企微回流失败：失败原因说人话显示，URL 清干净且可手动重试', async () => {
  const context = await browser.newContext({ userAgent: WECHAT_UA })
  const page = await context.newPage()

  // 打上防循环标记：这是「回流落地」那一刻的状态——首次自动识别已经发生过、
  // 失败回来了。没有标记的话页面会先被自动跳走，根本到不了错误展示。
  await context.addInitScript(() => {
    sessionStorage.setItem('bupt-week-auto-wecom-tried', '1')
  })

  // 模拟后端 callback 校验失败后的回流形态：#/login?error=wecom-no-ticket
  await page.goto(`${APP_ORIGIN}/#/login?error=wecom-no-ticket`, { waitUntil: 'networkidle' })

  // 黄条人话提示（含阶段名翻译与出路），而不是静默退回登录框
  await page.waitForSelector('.banner-warn')
  const banner = await page.textContent('.banner-warn')
  assert.match(banner, /登录凭证交换没有成功/)
  assert.match(banner, /学号密码/)

  // 错误参数不留在地址栏（history 里也不该有）
  assert.equal(page.url().includes('error='), false, '错误码不该留在地址栏')

  // 防循环标记已清：用户可以手动点企业微信登录再试一次
  assert.equal(await page.evaluate(() => sessionStorage.getItem('bupt-week-auto-wecom-tried')), null)
  await page.waitForSelector('.wecom')
  await context.close()
})

// ── 课表 ────────────────────────────────────────────────────────────────────

/** 课表接口的 mock：不带 week 返回第 18 周（当前），带 week=19 返回第 19 周。 */
function mockTimetable(route) {
  const body = route.request().postDataJSON() || {}
  const week = body.week ?? 18
  const monday = week === 18 ? '2026-10-26' : '2026-11-02'
  const dayDate = (i) => {
    const d = new Date(`${monday}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() + i)
    return d.toISOString().slice(0, 10)
  }
  return fulfill(route, {
    success: true,
    data: {
      timetable: {
        week,
        mode: 'A'.repeat(32),
        date: monday,
        weeks: [18, 19],
        modes: [],
        days: Array.from({ length: 7 }, (_, i) => ({ label: `星期${'一二三四五六日'[i]}`, date: dayDate(i) })),
        periods: [
          { number: 1, time: '08:00~08:45' },
          { number: 2, time: '08:55~09:40' },
        ],
        courses: [
          { name: '高等数学', day: 1, start: 1, end: 2, location: '教三-101', campus: '西土城', schedule: '[1-2]节', details: [] },
          { name: '大学英语', day: 3, start: 2, end: 2, location: '教四-202', campus: '西土城', schedule: '[2]节', details: [] },
        ],
      },
    },
  })
}

async function loginAndOpenTimetable(page) {
  await page.route('**/api/auth/login', (route) => fulfill(route, LOGIN_OK))
  await page.route('**/api/jwgl/session', (route) => fulfill(route, { success: true, data: { sessionId: 'jw-sid', username: '2021001234', expiresAt: EXPIRES_AT } }))
  await page.route('**/api/ucloud/session', (route) => fulfill(route, UCLOUD_SESSION))
  await page.route('**/api/jwgl/timetable', mockTimetable)

  await page.goto(APP_ORIGIN, { waitUntil: 'networkidle' })
  await page.fill(`${panel} input[type="text"]`, '2021001234')
  await page.fill(`${panel} input[type="password"]`, 'pw')
  await page.click(`${panel} button[type="submit"]`)
  await page.waitForFunction(() => document.querySelectorAll('.panel').length === 0)
}

test('课表：登录后渲染网格，课程落在正确的星期与节次，跨节课纵向铺满', async () => {
  const page = await browser.newPage()
  try {
    await loginAndOpenTimetable(page)
    await page.waitForSelector('.grid')

    // 第 1 节 · 星期一 有高等数学，且用 rowspan 铺满 1-2 节（不是只占一节）
    const mondayCell = page.locator('.grid tbody tr:nth-child(1) td:nth-child(2)')
    assert.match(await mondayCell.textContent(), /高等数学/)
    assert.equal(await mondayCell.getAttribute('rowspan'), '2', '跨节课程要纵向合并两节')

    // 第 2 行的周一列没有独立单元格（被上面的 rowspan 占据），该行只剩 6 格
    assert.equal(await page.locator('.grid tbody tr:nth-child(2) > td').count(), 6)

    // 第 2 节 · 星期三 是大学英语
    const wednesday = await page.textContent('.grid tbody tr:nth-child(2) td:nth-child(3)')
    assert.match(wednesday, /大学英语/)

    // 节次列双时刻：京行是教务的北京时刻，琼行是海南时刻（第 2 节两地不同）
    const times = await page.locator('.grid tbody tr:nth-child(2) .period-time').allTextContents()
    assert.equal(times.length, 2)
    assert.match(times[0], /京 08:55~09:40/)
    assert.match(times[1], /琼 08:50~09:35/)

    // 悬停气泡：两校区具体起止时刻（高数 [1-2]节 → 北京 08:00-09:35）
    const title = await mondayCell.locator('.course-item').getAttribute('title')
    assert.match(title, /高等数学 \[1-2\]节/)
    assert.match(title, /北京 08:00-09:35/)
    assert.match(title, /海南 08:00-09:35/)
    assert.match(title, /教三-101/)

    // 周次下拉有同步到的两周
    const options = await page.locator('.week-picker option').allTextContents()
    assert.equal(options.length, 2)

    // 校区切换：默认双显两行 → 切海南只剩一行（琼）→ 刷新后记忆保持
    await page.click('.time-mode button:nth-child(3)')
    await page.waitForFunction(() => document.querySelectorAll('.grid tbody tr:nth-child(2) .period-time').length === 1)
    const only = await page.textContent('.grid tbody tr:nth-child(2) .period-time')
    assert.match(only, /琼 08:50~09:35/)
    await page.reload({ waitUntil: 'networkidle' })
    await page.waitForSelector('.grid')
    assert.equal(await page.locator('.grid tbody tr:nth-child(2) .period-time').count(), 1, '刷新后仍保持海南模式')
  } finally {
    await page.close()
  }
})

test('课表：切换周次只读缓存，不再请求后端', async () => {
  const page = await browser.newPage()
  try {
    await loginAndOpenTimetable(page)
    await page.waitForSelector('.grid')
    // 等同步彻底结束（两周都拿到）
    await page.waitForFunction(() => document.querySelectorAll('.week-picker option').length === 2)

    let requests = 0
    page.on('request', (request) => {
      if (request.url().includes('/api/jwgl/timetable')) requests += 1
    })

    await page.selectOption('.week-picker select', '19')
    await page.waitForTimeout(500)

    assert.equal(requests, 0, '切周不该再发请求')
    // 第 19 周的周一日期变了
    const date = await page.textContent('.grid thead th:nth-child(2) .day-date')
    assert.equal(date, '11-02')
  } finally {
    await page.close()
  }
})

// ── 移动端质量 ────────────────────────────────────────────────────────────────

/** 把「今天」钉在周六的课表 mock：390px 视口下周六必然在横向滚动区外，
 *  今日列定位逻辑因此是确定性的。夹具日期与测试里 context.clock 钉住的
 *  浏览器时钟（2026-09-26，真实的周六）同源——「今天-5 天」这个构造只有
 *  在真实今天恰为周六/周日时才与 currentTimetableWeek 的真实日历对齐
 *  自洽（工作日会落在周窗口边界外，组件选中下一周，今天列直接消失），
 *  钉钟后任何真实日期跑都是同一几何。钉过去而不是未来：会话 expiresAt
 *  是按真实时钟发的，时钟拨到未来会被判成已过期。 */
const CLOCK_SATURDAY = '2026-09-26'
function mockTimetableTodayOnSaturday(route) {
  const body = route.request().postDataJSON() || {}
  const week = body.week ?? 18
  const today = new Date(`${CLOCK_SATURDAY}T00:00:00Z`)
  const monday = new Date(today)
  monday.setUTCDate(monday.getUTCDate() - 5 + (week === 18 ? 0 : 7))
  const dayDate = (i) => {
    const d = new Date(monday)
    d.setUTCDate(d.getUTCDate() + i)
    return d.toISOString().slice(0, 10)
  }
  return fulfill(route, {
    success: true,
    data: {
      timetable: {
        week,
        mode: 'A'.repeat(32),
        date: dayDate(0),
        weeks: [18, 19],
        modes: [],
        days: Array.from({ length: 7 }, (_, i) => ({ label: `星期${'一二三四五六日'[i]}`, date: dayDate(i) })),
        periods: [
          { number: 1, time: '08:00~08:45' },
          { number: 2, time: '08:55~09:40' },
          { number: 3, time: '10:00~10:45' },
          { number: 4, time: '10:55~11:40' },
          { number: 5, time: '14:00~14:45' },
          { number: 6, time: '14:55~15:40' },
        ],
        courses: [
          { name: '高等数学', day: 1, start: 1, end: 2, location: '教三-101', campus: '西土城', schedule: '[1-2]节', details: [] },
          { name: '数据结构', day: 2, start: 3, end: 4, location: '教二-305', campus: '西土城', schedule: '[3-4]节', details: [] },
          { name: '概率论', day: 6, start: 3, end: 3, location: '教三-210', campus: '西土城', schedule: '[3]节', details: [] },
        ],
      },
    },
  })
}

test('移动端：今日列自动定位、重挂载后仍在、无横向溢出、触摸目标达标', async () => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
  const page = await context.newPage()
  try {
    await context.clock.setFixedTime(new Date(`${CLOCK_SATURDAY}T04:00:00Z`))
    await page.route('**/api/auth/login', (route) => fulfill(route, LOGIN_OK))
    await page.route('**/api/jwgl/session', (route) => fulfill(route, { success: true, data: { sessionId: 'jw-sid', username: '2021001234', expiresAt: EXPIRES_AT } }))
    await page.route('**/api/ucloud/session', (route) => fulfill(route, UCLOUD_SESSION))
    await page.route('**/api/jwgl/timetable', mockTimetableTodayOnSaturday)
    await page.route('**/api/ucloud/assignments', (route) => fulfill(route, ASSIGNMENTS_FIXTURE()))
    await page.route('**/api/ucloud/assignment/detail', (route) =>
      fulfill(route, { success: true, data: { attachments: [{ resourceId: 'r1', resourceName: '实验一说明.pdf' }] } }))

    await page.goto(APP_ORIGIN, { waitUntil: 'networkidle' })

    // 微信 webview 聚焦输入框会放大页面：输入控件字号必须钉在 16px
    const inputFont = await page.evaluate(() => getComputedStyle(document.querySelector('.login-form input')).fontSize)
    assert.equal(inputFont, '16px', '输入框字号应保持 16px 防止 iOS 聚焦缩放')

    await page.fill(`${panel} input[type="text"]`, '2021001234')
    await page.fill(`${panel} input[type="password"]`, 'pw')
    await page.click(`${panel} button[type="submit"]`)
    await page.waitForFunction(() => document.querySelectorAll('.panel').length === 0)
    await page.waitForSelector('.grid')

    // 首次渲染：周六（今天）在滚动区外，应自动滚入并让表头进入视口
    await page.waitForFunction(() => document.querySelector('.grid-scroll')?.scrollLeft > 0, { timeout: 3000 })
    const todayVisible = await page.evaluate(() => {
      const th = document.querySelector('thead th.today')
      if (!th) return false
      const rect = th.getBoundingClientRect()
      return rect.left >= 0 && rect.right <= window.innerWidth
    })
    assert.ok(todayVisible, '今日列表头应在视口内')

    // 页面本身不允许横向溢出（横向滚动只发生在网格容器内部）
    const pageOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    assert.ok(pageOverflow <= 0, `页面横向溢出 ${pageOverflow}px`)

    // 触摸目标：所有可见 button/a/select 高度 ≥ 44px（浮点渲染留 0.5px 容差）
    const undersized = await page.evaluate(() => {
      const targets = [...document.querySelectorAll('button, a, select')]
      return targets
        .filter((el) => el.offsetParent !== null)
        .filter((el) => el.getBoundingClientRect().height < 43.5)
        .map((el) => el.className || el.tagName)
    })
    assert.deepEqual(undersized, [], `触摸目标不足 44px：${undersized.join(', ')}`)

    // 切到作业再切回（组件重挂载、activeWeek 不再变化），今日列定位必须仍然生效
    await page.click('.tabs button:nth-child(2)')
    await page.waitForSelector('.card')
    await page.locator('.card-main').first().click()
    await page.waitForSelector('.card-detail')

    // 展开态（附件/去交作业按钮可见）下触摸目标同样达标
    const undersizedOpen = await page.evaluate(() => {
      const targets = [...document.querySelectorAll('button, a, select')]
      return targets
        .filter((el) => el.offsetParent !== null)
        .filter((el) => el.getBoundingClientRect().height < 43.5)
        .map((el) => el.className || el.tagName)
    })
    assert.deepEqual(undersizedOpen, [], `展开态触摸目标不足 44px：${undersizedOpen.join(', ')}`)

    const assignmentOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    assert.ok(assignmentOverflow <= 0, `作业页横向溢出 ${assignmentOverflow}px`)

    // 全部态：头部同时摆着开关和计数徽标，窄屏也不允许溢出（默认过滤态上面量过了）
    await page.click('.filter-toggle')
    const allOverflow = await page.evaluate(
      () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
    )
    assert.ok(allOverflow <= 0, `全部态作业页横向溢出 ${allOverflow}px`)
    await page.click('.filter-toggle')

    await page.click('.tabs button:nth-child(1)')
    await page.waitForSelector('.grid')
    await page.waitForFunction(() => document.querySelector('.grid-scroll')?.scrollLeft > 0, { timeout: 3000 })

    // 周切换：第一周禁用「上一周」，点「下一周」落到第 19 周
    assert.ok(await page.locator('.week-step').first().isDisabled(), '第一周应禁用上一周')
    await page.locator('.week-step').nth(1).click()
    await page.waitForFunction(() => document.querySelector('.week-picker select')?.value === '19')
  } finally {
    await page.close()
    await context.close()
  }
})

// ── 作业 ────────────────────────────────────────────────────────────────────

/** 北京时间墙上钟字符串（学校接口的格式），相对当前时间偏移 offsetMs。 */
function beijingClockFromNow(offsetMs) {
  return new Date(Date.now() + offsetMs).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' })
}

const ASSIGNMENTS_FIXTURE = () => ({
  success: true,
  data: {
    assignments: [
      {
        id: 'hw-lab0',
        siteId: 's2',
        siteName: '操作系统',
        assignmentTitle: 'lab0 环境配置',
        assignmentEndTime: beijingClockFromNow(-24 * 3600_000),
        assignmentStatus: 99,
      },
      {
        id: 'hw-exp1',
        siteId: 's1',
        siteName: '数据结构',
        assignmentTitle: '实验一 线性表',
        assignmentEndTime: beijingClockFromNow(20 * 3600_000),
        assignmentStatus: 99,
      },
      {
        id: 'hw-exp2',
        siteId: 's1',
        siteName: '数据结构',
        assignmentTitle: '实验二 树',
        assignmentEndTime: beijingClockFromNow(-48 * 3600_000),
        assignmentStatus: 0,
        submitTime: beijingClockFromNow(-72 * 3600_000),
      },
    ],
  },
})

async function loginAndOpenAssignments(page, assignmentsFixture = ASSIGNMENTS_FIXTURE()) {
  await page.route('**/api/auth/login', (route) => fulfill(route, LOGIN_OK))
  await page.route('**/api/jwgl/session', (route) => fulfill(route, { success: true, data: { sessionId: 'jw-sid', username: '2021001234', expiresAt: EXPIRES_AT } }))
  await page.route('**/api/ucloud/session', (route) => fulfill(route, UCLOUD_SESSION))
  await page.route('**/api/ucloud/assignments', (route) => fulfill(route, assignmentsFixture))

  await page.goto(APP_ORIGIN, { waitUntil: 'networkidle' })
  await page.fill(`${panel} input[type="text"]`, '2021001234')
  await page.fill(`${panel} input[type="password"]`, 'pw')
  await page.click(`${panel} button[type="submit"]`)
  await page.waitForFunction(() => document.querySelectorAll('.panel').length === 0)
  await page.click('.tabs button:nth-child(2)')
}

test('作业：按紧急度排序、按课程分组、状态徽标正确', async () => {
  const page = await browser.newPage()
  try {
    await loginAndOpenAssignments(page)
    await page.waitForSelector('.card')

    // 默认只看未提交；这份断言看的是全量，先点「显示全部」
    await page.click('.filter-toggle')

    // 全局排序后分组：最紧急的逾期作业所在课程在最前
    const groupNames = await page.locator('.course-group h3').allTextContents()
    assert.match(groupNames[0], /操作系统/)
    assert.match(groupNames[1], /数据结构/)

    // 卡片顺序：逾期 lab0 → 今天截止 实验一 → 已提交 实验二
    const titles = await page.locator('.card-title').allTextContents()
    assert.deepEqual(titles, ['lab0 环境配置', '实验一 线性表', '实验二 树'])

    const badges = await page.locator('.card .badge').allTextContents()
    assert.equal(badges[0], '已截止未交')
    assert.equal(badges[1], '今天截止')
    assert.equal(badges[2], '已提交')

    // 顶栏按当前显示的作业分状态统计。
    const summary = await page.textContent('.status-summary')
    assert.match(summary, /已逾期\s*1/)
    assert.match(summary, /临近截止\s*1/)
    assert.doesNotMatch(summary, /已完成/)
  } finally {
    await page.close()
  }
})

test('作业：「只看未提交」默认开，点「显示全部」看全量再切回', async () => {
  const page = await browser.newPage()
  try {
    await loginAndOpenAssignments(page)
    await page.waitForSelector('.card')

    // 默认过滤态：已提交的「实验二 树」不出现，按钮文案是下一动作「显示全部」
    assert.deepEqual(
      await page.locator('.card-title').allTextContents(),
      ['lab0 环境配置', '实验一 线性表'],
    )
    assert.match(await page.textContent('.filter-toggle'), /显示全部/)

    // 切到全部：三张卡、两个分组都在，按钮文案切回「只看未提交」
    await page.click('.filter-toggle')
    assert.equal(await page.locator('.card').count(), 3)
    assert.equal(await page.locator('.course-group h3').count(), 2)
    assert.match(await page.textContent('.filter-toggle'), /只看未提交/)

    // 再切回默认过滤态
    await page.click('.filter-toggle')
    assert.deepEqual(
      await page.locator('.card-title').allTextContents(),
      ['lab0 环境配置', '实验一 线性表'],
    )
  } finally {
    await page.close()
  }
})

test('作业：右侧只统计待处理状态，临近截止合并今天与一周内，窄屏标签不溢出', async () => {
  const page = await browser.newPage({ viewport: { width: 320, height: 844 } })
  try {
    const fixture = ASSIGNMENTS_FIXTURE()
    fixture.data.assignments.push(
      { id: 'near', siteId: 's1', siteName: '数据结构', assignmentTitle: '三天后截止', assignmentStatus: 99, assignmentEndTime: beijingClockFromNow(72 * 3600_000) },
      { id: 'later', siteId: 's1', siteName: '数据结构', assignmentTitle: '两周后截止', assignmentStatus: 99, assignmentEndTime: beijingClockFromNow(14 * 24 * 3600_000) },
      { id: 'undated', siteId: 's1', siteName: '数据结构', assignmentTitle: '未设置截止', assignmentStatus: 99 },
    )
    await loginAndOpenAssignments(page, fixture)
    await page.waitForSelector('.status-tag')
    const summary = page.locator('.status-summary')
    assert.match(await summary.textContent(), /已逾期\s*1/)
    assert.match(await summary.textContent(), /临近截止\s*2/)
    assert.match(await summary.textContent(), /待完成\s*2/)
    assert.doesNotMatch(await summary.textContent(), /已完成|项未完成/)
    const before = await summary.textContent()
    await page.click('.filter-toggle')
    assert.equal(await summary.textContent(), before, '显示全部时也不统计已完成作业')
    for (const mode of ['light', 'dark']) {
      if (await page.locator('html').getAttribute('data-theme') !== mode) await page.locator('.theme-toggle').click()
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${mode} 主题下多个状态标签不应撑宽页面`)
    }
  } finally {
    await page.close()
  }
})

test('作业：全交了在默认过滤态直接落专门空态，可切「显示全部」看已提交', async () => {
  const page = await browser.newPage()
  try {
    const allSubmitted = ASSIGNMENTS_FIXTURE()
    allSubmitted.data.assignments = allSubmitted.data.assignments.map((item) => ({
      ...item,
      assignmentStatus: 0,
      submitTime: beijingClockFromNow(-72 * 3600_000),
    }))
    await loginAndOpenAssignments(page, allSubmitted)

    // 默认只看未提交 + 全交了：不用点开关，空态直接出现
    await page.waitForFunction(() => document.querySelector('.view .empty')?.textContent.includes('没有未提交的作业'))

    // 切「显示全部」：已提交的卡看得到；再切回，空态重现
    await page.click('.filter-toggle')
    await page.waitForSelector('.card')
    assert.equal(await page.locator('.card').count(), 3)
    await page.click('.filter-toggle')
    await page.waitForFunction(() => document.querySelector('.view .empty')?.textContent.includes('没有未提交的作业'))
  } finally {
    await page.close()
  }
})

test('作业：展开懒加载要求与附件，再次展开用缓存，提交链接仍指向该作业', async () => {
  const page = await browser.newPage()
  try {
    let detailRequests = 0
    await page.route('**/api/ucloud/assignment/detail', (route) => {
      detailRequests += 1
      const body = route.request().postDataJSON() || {}
      assert.equal(body.assignmentId, 'hw-lab0')
      return fulfill(route, {
        success: true,
        data: {
          content: '<p>完成环境配置，提交<strong>实验报告</strong>。</p><ol><li>安装工具链</li><li>附上运行截图</li></ol>',
          description: '请独立完成，并注明操作系统版本。',
          attachments: [{ resourceId: 'r1', resourceName: 'lab0-handout.pdf', resourceType: 'pdf' }],
        },
      })
    })
    await loginAndOpenAssignments(page)
    await page.waitForSelector('.card')
    assert.equal(detailRequests, 0, '列表阶段不应批量拉取正文详情')

    // 展开第一张卡（逾期作业）
    await page.click('.card:nth-child(2) .card-main')
    await page.waitForSelector('.attachment-list')

    const attachment = await page.textContent('.attachment-list li button')
    assert.match(attachment, /lab0-handout\.pdf/)
    assert.equal(await page.textContent('.assignment-requirements strong'), '实验报告')
    assert.equal(await page.locator('.assignment-requirements ol li').count(), 2)
    assert.match(await page.textContent('.assignment-requirements'), /请独立完成/)
    await page.click('.card:nth-child(2) .card-main')
    await page.click('.card:nth-child(2) .card-main')
    await page.waitForSelector('.assignment-requirements')
    assert.equal(detailRequests, 1, '正文和附件应共用一次详情请求与缓存')

    // 深链：§3.2 的裸详情页 URL。不经 CAS 中转——其桌面登录页对现代浏览器
    // 服务端故障（皮肤 400 白屏、dev=1 二次点击 400，见 api-reference §3.2.1）；
    // 有云邮会话的浏览器直达，没有的靠文案引导（微信内企微自动识别不受影响）
    const href = await page.getAttribute('.go-submit', 'href')
    assert.equal(
      href,
      'https://ucloud.bupt.edu.cn/uclass/course.html#/student/assignmentDetails_fullpage?activeTabName=first&assignmentId=hw-lab0',
    )
    assert.equal(href.includes('refresh_token'), false, '深链不该携带长效凭证')
    assert.equal(href.includes('auth.bupt.edu.cn'), false, '不经 CAS 中转')
    assert.equal(href.includes('studentAssignmentListPage'), false, '不能深链列表页（site-id cookie 缺口）')

    // 引导文案：白屏时给出路（微信重试 / 稍后再试）
    const hint = await page.textContent('.go-submit ~ .detail-hint')
    assert.match(hint, /微信/)
    assert.match(hint, /空白页/)
  } finally {
    await page.close()
  }
})

test('作业要求：纯文本保留换行，空正文给出查看附件的提示', async () => {
  const page = await browser.newPage()
  try {
    await page.route('**/api/ucloud/assignment/detail', (route) => fulfill(route, {
      success: true,
      data: route.request().postDataJSON().assignmentId === 'hw-lab0'
        ? { content: '第一步：安装工具链。\n第二步：提交截图。', description: '', attachments: [] }
        : { content: '<p>&nbsp;<br></p>', description: '', attachments: [] },
    }))
    await loginAndOpenAssignments(page)
    await page.locator('.card-main', { hasText: 'lab0 环境配置' }).click()
    assert.equal(await page.textContent('.requirements-plain'), '第一步：安装工具链。\n第二步：提交截图。')
    assert.equal(await page.locator('.requirements-plain').evaluate((el) => getComputedStyle(el).whiteSpace), 'pre-wrap')
    await page.locator('.card-main', { hasText: '实验一 线性表' }).click()
    await page.waitForSelector('.requirements-empty')
    assert.match(await page.textContent('.requirements-empty'), /请查看附件/)
  } finally {
    await page.close()
  }
})

test('作业要求：加载失败可重试，等待详情时仍可前往云邮提交', async () => {
  const page = await browser.newPage()
  try {
    let attempts = 0
    let release
    const pending = new Promise((resolve) => { release = resolve })
    await page.route('**/api/ucloud/assignment/detail', async (route) => {
      attempts += 1
      if (attempts === 1) {
        await pending
        return fulfill(route, { success: false, msg: '上游暂时不可达' }, 502)
      }
      return fulfill(route, { success: true, data: { content: '教材 P55 第 1—10 题', attachments: [] } })
    })
    await loginAndOpenAssignments(page)
    await page.locator('.card-main', { hasText: 'lab0 环境配置' }).click()
    await page.waitForSelector('.card-detail [role="status"]')
    assert.match(await page.textContent('.card-detail [role="status"]'), /正在加载作业要求和附件/)
    assert.ok(await page.locator('.go-submit').isVisible())
    release()
    await page.waitForSelector('.card-detail [role="alert"]')
    await page.getByRole('button', { name: '重试加载详情' }).click()
    await page.waitForSelector('.requirements-plain')
    assert.equal(await page.textContent('.requirements-plain'), '教材 P55 第 1—10 题')
    assert.equal(attempts, 2)
  } finally {
    await page.close()
  }
})

test('作业要求：保留富文本与学校图片，移除可执行内容，手机明暗主题均不溢出', async () => {
  const page = await browser.newPage({ viewport: { width: 390, height: 844 } })
  try {
    const unsafeRequests = []
    page.on('request', (request) => {
      if (request.url().includes('untrusted.example')) unsafeRequests.push(request.url())
    })
    await page.route('**/file/ucloud/requirements.png?signature=a%2Fb', (route) => route.fulfill({
      contentType: 'image/png',
      body: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl1sAAAAASUVORK5CYII=', 'base64'),
    }))
    await page.route('**/api/ucloud/assignment/detail', (route) => fulfill(route, {
      success: true,
      data: {
        content: '<h2>实验步骤</h2><p style="position:fixed" onclick="window.requirementsUnsafe = true">完成实验，保留<strong>运行截图</strong>。</p>'
          + '<ul><li>配置环境</li><li>提交报告</li></ul><table><tr><th>项目</th><th>要求</th></tr><tr><td>代码</td><td>独立完成</td></tr></table>'
          + '<p>' + 'long-unbroken-requirement-'.repeat(20) + '</p>'
          + '<a href="https://example.com/guide">参考资料</a><a href="java&#10;script:alert(1)">危险链接</a>'
          + '<img src="https://fileucloud.bupt.edu.cn/ucloud/requirements.png?signature=a%2Fb" onerror="window.requirementsUnsafe = true" style="width:2000px" alt="实验示意图">'
          + '<script>window.requirementsUnsafe = true</script><style>body { display:none }</style>'
          + '<iframe src="https://untrusted.example/frame"></iframe><svg onload="window.requirementsUnsafe = true"></svg>'
          + '<img src="https://untrusted.example/tracker" onerror="window.requirementsUnsafe = true"><form action="https://untrusted.example"><input autofocus></form>',
        attachments: [],
      },
    }))
    await loginAndOpenAssignments(page)
    await page.locator('.card-main', { hasText: 'lab0 环境配置' }).click()
    await page.waitForSelector('.assignment-requirements img')
    const requirements = page.locator('.assignment-requirements')
    assert.equal(await requirements.locator('strong').textContent(), '运行截图')
    assert.equal(await requirements.locator('table td').count(), 2)
    assert.equal(await requirements.locator('script, style, iframe, svg, form, input, [onclick], [onerror], [style]').count(), 0)
    assert.equal(await requirements.locator('a[href]').count(), 1)
    assert.equal(await requirements.locator('a[href]').getAttribute('rel'), 'noopener noreferrer')
    assert.equal(await requirements.locator('img').getAttribute('src'), '/file/ucloud/requirements.png?signature=a%2Fb')
    assert.equal(await page.evaluate(() => window.requirementsUnsafe), undefined)
    assert.deepEqual(unsafeRequests, [], '正文不应加载外站脚本、框架或追踪图片')
    for (const colorScheme of ['light', 'dark']) {
      await page.emulateMedia({ colorScheme })
      assert.ok(await requirements.isVisible())
      assert.ok(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `${colorScheme} 主题下正文不应撑宽手机页面`)
    }
  } finally {
    await page.close()
  }
})

test('作业：截止进度条按剩余时间填充、按紧急度着色，已提交不画', async () => {
  const page = await browser.newPage()
  try {
    await loginAndOpenAssignments(page)
    await page.waitForSelector('.card')

    // 只有未提交的卡有进度条：lab0（已逾期，铺满红色）+ 实验一（剩 20h，danger 色 88%）
    assert.equal(await page.locator('.deadline-track').count(), 2)

    const fills = await page.locator('.deadline-fill').all()
    const firstWidth = await fills[0].evaluate((el) => el.style.width)
    const secondWidth = await fills[1].evaluate((el) => el.style.width)
    // 逾期：夹到 100%
    assert.equal(firstWidth, '100%')
    assert.equal(await fills[0].getAttribute('class'), 'deadline-fill bar-overdue')
    // 7 天窗口回退：剩 20h → (168-20)/168 ≈ 88%
    assert.equal(secondWidth, '88%')
    assert.equal(await fills[1].getAttribute('class'), 'deadline-fill bar-danger')

    // 进度条在时间行下方、卡内（细长装饰条，读屏不可见）
    assert.equal(await page.locator('.deadline-track[aria-hidden="true"]').count(), 2)
  } finally {
    await page.close()
  }
})

// ── 缓存与出错提示 ───────────────────────────────────────────────────────────

/** 作业接口的 mock 控制器：mode 切换成功/失败/500，验证重试与兜底链路。 */
function assignmentsRouteHandler(mode = { fail: false }) {
  return (route) => {
    if (mode.fail) return fulfill(route, { success: false, msg: '云邮系统暂时无法访问' }, 502)
    return fulfill(route, ASSIGNMENTS_FIXTURE())
  }
}

test('作业：获取失败给人话和重试按钮，重试后恢复', async () => {
  const page = await browser.newPage()
  try {
    await page.route('**/api/auth/login', (route) => fulfill(route, LOGIN_OK))
    await page.route('**/api/jwgl/session', (route) => fulfill(route, { success: true, data: { sessionId: 'jw-sid', username: '2021001234', expiresAt: EXPIRES_AT } }))
    await page.route('**/api/ucloud/session', (route) => fulfill(route, UCLOUD_SESSION))
    const mode = { fail: true }
    await page.route('**/api/ucloud/assignments', assignmentsRouteHandler(mode))

    await page.goto(APP_ORIGIN, { waitUntil: 'networkidle' })
    await page.fill(`${panel} input[type="text"]`, '2021001234')
    await page.fill(`${panel} input[type="password"]`, 'pw')
    await page.click(`${panel} button[type="submit"]`)
    await page.waitForFunction(() => document.querySelectorAll('.panel').length === 0)
    await page.click('.tabs button:nth-child(2)')

    // 错误条：服务端人话 msg + 行动按钮，不是英文黑话也没有死胡同
    await page.waitForSelector('.notice-error')
    const notice = await page.textContent('.notice-error')
    assert.match(notice, /云邮系统暂时无法访问/, '应透传服务端人话 msg')
    assert.match(notice, /重试/, '必须给出重试出路')

    // 无缓存时不该有任何卡片混入
    assert.equal(await page.locator('.card').count(), 0)

    mode.fail = false
    await page.click('.notice-error .notice-action')
    await page.waitForSelector('.card')
    // 默认只看未提交；这里验证的是数据完整性，切「显示全部」看全量
    await page.click('.filter-toggle')
    const titles = await page.locator('.card-title').allTextContents()
    assert.deepEqual(titles, ['lab0 环境配置', '实验一 线性表', '实验二 树'])
  } finally {
    await page.close()
  }
})

test('作业：刷新失败兜底显示缓存数据（黄条说明，不再推给用户一张空列表）', async () => {
  const context = await browser.newContext()
  const page = await context.newPage()
  try {
    const mode = { fail: false }
    await page.route('**/api/auth/login', (route) => fulfill(route, LOGIN_OK))
    await page.route('**/api/jwgl/session', (route) => fulfill(route, { success: true, data: { sessionId: 'jw-sid', username: '2021001234', expiresAt: EXPIRES_AT } }))
    await page.route('**/api/ucloud/session', (route) => fulfill(route, UCLOUD_SESSION))
    await page.route('**/api/jwgl/timetable', mockTimetable)
    await page.route('**/api/ucloud/assignments', assignmentsRouteHandler(mode))

    // 第一轮：成功加载并落盘缓存
    await page.goto(APP_ORIGIN, { waitUntil: 'networkidle' })
    await page.fill(`${panel} input[type="text"]`, '2021001234')
    await page.fill(`${panel} input[type="password"]`, 'pw')
    await page.click(`${panel} button[type="submit"]`)
    await page.waitForFunction(() => document.querySelectorAll('.panel').length === 0)
    await page.click('.tabs button:nth-child(2)')
    await page.waitForSelector('.card')
    const cached = await page.evaluate(() => localStorage.getItem('bupt-week-assignments-v1'))
    assert.ok(cached, '成功加载后应写入本地缓存')

    // 第二轮：断网式失败 + 整页刷新——数据还在，只是挂了条说明
    mode.fail = true
    await page.reload({ waitUntil: 'networkidle' })
    await page.click('.tabs button:nth-child(2)')
    await page.waitForSelector('.notice-warn')
    const warn = await page.textContent('.notice-warn')
    assert.match(warn, /缓存/, '黄条应说明数据来自缓存')
    assert.match(warn, /云邮系统暂时无法访问/, '失败原因要能看懂')

    // 刷新重开过滤态回到默认；缓存数据完整性切「显示全部」验证
    await page.click('.filter-toggle')
    const titles = await page.locator('.card-title').allTextContents()
    assert.deepEqual(titles, ['lab0 环境配置', '实验一 线性表', '实验二 树'], '缓存数据应照常渲染')

    // 网络恢复后从黄条一键刷新
    mode.fail = false
    await page.click('.notice-warn .notice-action')
    await page.waitForSelector('.notice-warn', { state: 'hidden' })
    assert.equal(await page.locator('.card-title').count(), 3)
  } finally {
    await page.close()
    await context.close()
  }
})

test('课表：partial 后可补齐缺失周次，不必刷新整页', async () => {
  const page = await browser.newPage()
  try {
    const week19Fails = { fail: true }
    await page.route('**/api/auth/login', (route) => fulfill(route, LOGIN_OK))
    await page.route('**/api/jwgl/session', (route) => fulfill(route, { success: true, data: { sessionId: 'jw-sid', username: '2021001234', expiresAt: EXPIRES_AT } }))
    await page.route('**/api/ucloud/session', (route) => fulfill(route, UCLOUD_SESSION))
    await page.route('**/api/jwgl/timetable', (route) => {
      const body = route.request().postDataJSON() || {}
      if (body.week === 19 && week19Fails.fail) {
        return fulfill(route, { success: false, msg: '教务系统暂时无法访问' }, 502)
      }
      return mockTimetable(route)
    })

    await page.goto(APP_ORIGIN, { waitUntil: 'networkidle' })
    await page.fill(`${panel} input[type="text"]`, '2021001234')
    await page.fill(`${panel} input[type="password"]`, 'pw')
    await page.click(`${panel} button[type="submit"]`)
    await page.waitForFunction(() => document.querySelectorAll('.panel').length === 0)

    // 第 18 周成功、第 19 周失败 → partial：现状说清 + 补齐出路
    await page.waitForSelector('.notice-warn')
    const warn = await page.textContent('.notice-warn')
    assert.match(warn, /1\/2 周/, '应说明已同步 1/2 周')
    assert.match(warn, /补齐/, '必须给出补齐按钮')

    // 补齐：已缓存的第 18 周不重拉（只有一次 week=19 请求），成功后黄条消失
    let week19Requests = 0
    page.on('request', (request) => {
      if (request.url().includes('/api/jwgl/timetable') && request.postData()?.includes('"week":19')) week19Requests += 1
    })
    week19Fails.fail = false
    await page.click('.notice-warn .notice-action')
    // 点完先是 syncing（黄条换成转圈），等同步真正收尾：两周都出现才算补齐成功
    await page.waitForFunction(() => document.querySelectorAll('.week-picker option').length === 2, { timeout: 5000 })
    await page.waitForSelector('.notice-warn', { state: 'hidden', timeout: 5000 })

    await page.waitForTimeout(300)
    assert.equal(week19Requests, 1, '补齐只该请求缺失的那一周')
  } finally {
    await page.close()
  }
})

test('对抗：快速连点重试不会叠加请求（loading 早退 + revision 守卫）', async () => {
  const page = await browser.newPage()
  try {
    const mode = { fail: true, slow: false }
    let assignmentRequests = 0
    let heldRoute = null
    await page.route('**/api/auth/login', (route) => fulfill(route, LOGIN_OK))
    await page.route('**/api/jwgl/session', (route) => fulfill(route, { success: true, data: { sessionId: 'jw-sid', username: '2021001234', expiresAt: EXPIRES_AT } }))
    await page.route('**/api/ucloud/session', (route) => fulfill(route, UCLOUD_SESSION))
    await page.route('**/api/jwgl/timetable', mockTimetable)
    await page.route('**/api/ucloud/assignments', (route) => {
      assignmentRequests += 1
      if (mode.slow) {
        // 挂起响应：制造 loading 窗口，让连点落在请求在途时
        heldRoute = route
        return undefined
      }
      if (mode.fail) return fulfill(route, { success: false, msg: '云邮系统暂时无法访问' }, 502)
      return fulfill(route, ASSIGNMENTS_FIXTURE())
    })

    await page.goto(APP_ORIGIN, { waitUntil: 'networkidle' })
    await page.fill(`${panel} input[type="text"]`, '2021001234')
    await page.fill(`${panel} input[type="password"]`, 'pw')
    await page.click(`${panel} button[type="submit"]`)
    await page.waitForFunction(() => document.querySelectorAll('.panel').length === 0)
    await page.click('.tabs button:nth-child(2)')
    await page.waitForSelector('.notice-error')

    // 慢响应窗口内对同一按钮同步三连击（在 Vue 渲染移除按钮前全部进事件队列）
    mode.slow = true
    assignmentRequests = 0
    await page.$eval('.notice-error .notice-action', (el) => {
      el.click()
      el.click()
      el.click()
    })
    await page.waitForTimeout(300)
    assert.equal(assignmentRequests, 1, `连点重试只该发 1 个请求，实际 ${assignmentRequests}`)

    // 放行挂起的响应，链路照常收尾
    await fulfill(heldRoute, ASSIGNMENTS_FIXTURE())
    await page.waitForSelector('.card')
  } finally {
    await page.close()
  }
})

// ── 部署形态：Pages + 独立后端 ───────────────────────────────────────────────

/**
 * 这一组验的是**真实部署形态**（Pages + Workers 分离）下的行为。
 *
 * 之前在这里栽过：企微登录按钮写的是相对路径 `/api/auth/wecom/start`，
 * 本机能跑（Vite 把 /api 代理到后端），部署到 Pages 后解析到
 * white-sand-grand.github.io/api/... 直接 404。本地一切正常，压根发现不了。
 *
 * 所以要把 VITE_BACKEND_URL 设成一个哨兵值，构建出 dist/，
 * 起静态服务器 Serve 它，再用真浏览器打开——和线上唯一的差别是域名。
 */
const SENTINEL = 'https://backend.example.invalid'
const STATIC_PORT = 4173
const STATIC_ORIGIN = `http://127.0.0.1:${STATIC_PORT}`

async function serveDist() {
  const dist = resolve(process.cwd(), 'dist')
  const types = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css' }
  const server = createServer((request, response) => {
    const path = request.url === '/' ? '/index.html' : request.url.split('?')[0]
    const file = resolve(dist, `.${path}`)
    if (!file.startsWith(dist) || !existsSync(file)) {
      response.writeHead(404).end('not found')
      return
    }
    response.writeHead(200, { 'Content-Type': types[extname(file)] || 'application/octet-stream' })
    response.end(readFileSync(file))
  })
  staticServers.push(server)
  await listen(server, STATIC_PORT)
}

test('部署形态下企微登录指向后端域名，不是 Pages 自己的', async () => {
  // 用哨兵后端地址构建，模拟线上 Pages + Workers 分离。
  // shell 只在 Windows 下需要（npm 是 npm.cmd）。
  execFileSync('npm', ['run', 'build'], {
    cwd: process.cwd(),
    // Vite dev server 会把当前进程设为 development；部署构建必须显式使用生产环境。
    env: { ...process.env, NODE_ENV: 'production', VITE_BACKEND_URL: SENTINEL },
    stdio: 'pipe',
    shell: process.platform === 'win32',
  })
  await serveDist()

  const context = await browser.newContext({ userAgent: WECHAT_UA })
  const page = await context.newPage()
  try {
    await context.addInitScript(() => {
      // 避免自动跳转把页面带走，才能断言 href
      sessionStorage.setItem('bupt-week-auto-wecom-tried', '1')
    })

    await page.goto(STATIC_ORIGIN, { waitUntil: 'networkidle' })

    const href = await page.getAttribute('.wecom', 'href')
    assert.ok(href, '企微登录按钮应存在')
    assert.equal(
      href,
      `${SENTINEL}/api/auth/wecom/start`,
      '必须指向后端域名——相对路径在 Pages 上会 404',
    )
    assert.notEqual(href.startsWith('/'), true, '不能是相对路径')
  } finally {
    await context.close()
  }
})

test('部署形态下接口请求也打到后端域名', async () => {
  const page = await browser.newPage()
  try {
    const requested = []
    page.on('request', (request) => {
      if (request.url().includes('/api/')) requested.push(request.url())
    })

    await page.goto(STATIC_ORIGIN, { waitUntil: 'networkidle' })
    await page.waitForTimeout(1500)

    assert.ok(requested.length > 0, '应当有 /api 请求')
    for (const url of requested) {
      assert.ok(
        url.startsWith(SENTINEL),
        `请求打到了别的域名：${url}（相对路径在 Pages 上会 404）`,
      )
    }
  } finally {
    await page.close()
  }
})

// ── 课件 ────────────────────────────────────────────────────────────────────

/** 一门课的资料树 mock：目录 + 两份文件 + 一个外部链接，children 递归一层。 */
const COURSEWARE_TREE = [
  {
    id: 'node-1',
    resourceName: '第一章 函数与极限',
    resourceTypeName: '章节',
    children: [
      {
        id: 'node-1-1',
        resourceName: '习题课',
        children: [],
        attachmentVOs: [
          { type: '1', resource: { id: 'res-exercise', name: '习题答案.pdf', ext: 'pdf', fileSizeUnit: '1.2MB' } },
        ],
      },
    ],
    attachmentVOs: [
      { type: '1', resource: { id: 'res-lec', name: '讲义.pdf', ext: 'pdf', fileSizeUnit: '2.5MB' } },
      { type: '2', siteResourceLink: { title: '国家精品课链接', link: 'https://example.com/course' } },
    ],
  },
]

test('课件：选课程 → 一页铺开多份资料 → 点文件名下载落盘（文件名是课件名）', async () => {
  const page = await browser.newPage({ viewport: { width: 1280, height: 900 } })
  try {
    await page.route('**/api/auth/login', (route) => fulfill(route, LOGIN_OK))
    await page.route('**/api/jwgl/session', (route) => fulfill(route, { success: true, data: { sessionId: 'jw-sid', username: '2021001234', expiresAt: EXPIRES_AT } }))
    await page.route('**/api/ucloud/session', (route) => fulfill(route, UCLOUD_SESSION))
    await page.route('**/api/ucloud/courses', (route) =>
      fulfill(route, { success: true, data: { courses: [
        { id: 'site-1', name: '高等数学', teacher: '张老师、李老师' },
        { id: 'site-2', name: '大学物理', teacher: '' },
        { id: 'site-3', name: '可再生能源与低碳社会（在线课程）', teacher: '王老师' },
      ] } }),
    )
    await page.route('**/api/ucloud/courseware', (route) => {
      const { siteId } = route.request().postDataJSON()
      return fulfill(route, { success: true, data: { tree: siteId === 'site-1' ? COURSEWARE_TREE : [] } })
    })
    await page.route('**/api/ucloud/resource/download', (route) =>
      fulfill(route, { success: true, data: { fileUrl: '/file/ucloud/document/lec.pdf?sig=1' } }),
    )
    const pdf = readFileSync(new URL('./fixtures/sample.pdf', import.meta.url))
    await page.route('**/file/**', (route) =>
      route.fulfill({
        status: 200,
        headers: { 'Content-Type': 'application/pdf', 'Content-Length': String(pdf.length) },
        body: pdf,
      }),
    )

    await page.goto(APP_ORIGIN, { waitUntil: 'networkidle' })
    await page.fill(`${panel} input[type="text"]`, '2021001234')
    await page.fill(`${panel} input[type="password"]`, 'pw')
    await page.click(`${panel} button[type="submit"]`)
    await page.waitForFunction(() => document.querySelectorAll('.panel').length === 0)

    // 课件 tab（按文本定位，位置随 tab 增减会漂）
    await page.click('.tabs button:has-text("课件")')
    assert.equal(await page.textContent('.view h2'), '课件')

    // 课程卡片带教师姓名；桌面左右分栏，默认选第一门。
    await page.waitForFunction(() => document.querySelector('.chip-active .course-name')?.textContent === '高等数学')
    assert.match(await page.textContent('.course-chips'), /大学物理/)
    assert.match(await page.textContent('.chip-active .course-teacher'), /张老师、李老师/)
    assert.match(await page.textContent('.files-head'), /高等数学.*任课老师：张老师、李老师/s)
    const sidebar = await page.locator('.course-sidebar').boundingBox()
    const files = await page.getByRole('tabpanel').boundingBox()
    assert.ok(sidebar.x + sidebar.width < files.x, '课程在左，课件在右')
    await page.waitForFunction(() => document.querySelector('.resource-list')?.textContent.includes('习题答案.pdf'))

    const listText = await page.textContent('.resource-list')
    assert.match(listText, /第一章 函数与极限/)
    assert.match(listText, /习题课/)
    assert.match(listText, /讲义\.pdf/)
    assert.match(listText, /国家精品课链接/)

    // 外部链接是新标签锚点，不是下载按钮
    const link = page.locator('.resource-list a[href="https://example.com/course"]')
    assert.equal(await link.count(), 1)

    // 点课件名下载：走 resource/download 换链 + /file 代理，落盘文件名是课件名
    const downloadPromise = page.waitForEvent('download')
    await page.click('.resource-list button:has-text("讲义.pdf")')
    const download = await downloadPromise
    assert.equal(download.suggestedFilename(), '讲义.pdf')

    // 换一门没有资料的课：空态文案
    await page.click('.chip:has-text("大学物理")')
    await page.waitForFunction(() => document.querySelector('.view .empty')?.textContent.includes('还没有上传过课件'))
    assert.match(await page.textContent('.chip-active'), /任课老师：暂未提供/)
    assert.match(await page.textContent('.files-head h3'), /大学物理/)

    // 纵向课程列表支持方向键切换，Tab 只停留在所选课程。
    await page.getByRole('tab', { name: /大学物理/ }).press('ArrowDown')
    await page.waitForFunction(() => document.querySelector('.files-head h3')?.textContent.includes('可再生能源'))
    assert.equal(await page.getByRole('tab', { selected: true }).evaluate((el) => el === document.activeElement), true)
    assert.equal(await page.locator('.course-chips [tabindex="0"]').count(), 1)
    await page.getByRole('tab', { selected: true }).press('Home')
    await page.waitForSelector('.resource-list')

    // 手机上下排列、长课程名完整换行；明暗主题均无横向溢出。
    await page.setViewportSize({ width: 390, height: 844 })
    const mobileSidebar = await page.locator('.course-sidebar').boundingBox()
    const mobileFiles = await page.getByRole('tabpanel').boundingBox()
    assert.ok(mobileSidebar.y + mobileSidebar.height <= mobileFiles.y)
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await page.locator('.theme-toggle').click()
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    await page.getByRole('tab', { name: /可再生能源/ }).click()
    assert.match(await page.textContent('.files-head h3'), /可再生能源与低碳社会（在线课程）/)
  } finally {
    await page.close()
  }
})

// ── 班级 ────────────────────────────────────────────────────────────────────

/** 班级接口的 mock：列表固定返回一个班，作业列表可动态追加。 */
function mockClassesApi(page) {
  const created = { classId: 'cls-1', code: '7XA4K2M9Q3', name: '软件 2301 班' }
  const assignments = []
  let classExists = false
  page.route('**/api/classes/create', (route) => {
    const body = route.request().postDataJSON() || {}
    assert.equal(body.sessionId, 'uc-sid')
    assert.equal(body.password, 'class-pw')
    classExists = true
    return fulfill(route, { success: true, data: created })
  })
  page.route('**/api/classes/list', (route) =>
    fulfill(route, {
      success: true,
      data: { classes: classExists
        ? [{ ...created, createdBy: '2021001234', memberCount: 1, createdAt: Date.now() }]
        : [] },
    }))
  page.route('**/api/classes/assignments', (route) =>
    fulfill(route, {
      success: true,
      data: {
        assignments: assignments.map((item) => ({
          id: item.id,
          assignmentTitle: item.title,
          chapterName: item.subject,
          siteId: 'class:cls-1',
          siteName: created.name,
          assignmentEndTime: item.deadline || '',
          assignmentStatus: 99,
          content: item.content,
          createdBy: '2021001234',
        })),
      },
    }))
  page.route('**/api/classes/assignment/add', (route) => {
    const body = route.request().postDataJSON() || {}
    assert.equal(body.title, '第三章课后习题')
    assert.equal(body.subject, '高等数学')
    assert.ok(body.content.includes('P55'))
    assert.equal(body.deadline, '2026-11-01T23:59', 'datetime-local 原样上送，归一在后端')
    assignments.push({ id: 'ca-1', ...body })
    return fulfill(route, { success: true, data: { assignmentId: 'ca-1' } })
  })
  return created
}

test('班级：创建班级 → 录入作业 → 班级列表与作业 tab 合并展示', async () => {
  const page = await browser.newPage()
  try {
    await page.route('**/api/auth/login', (route) => fulfill(route, LOGIN_OK))
    await page.route('**/api/ucloud/session', (route) => fulfill(route, UCLOUD_SESSION))
    await page.route('**/api/ucloud/assignments', (route) =>
      fulfill(route, { success: true, data: { assignments: [] } }))
    const created = mockClassesApi(page)

    await page.goto(APP_ORIGIN, { waitUntil: 'networkidle' })
    await page.fill(`${panel} input[type="text"]`, '2021001234')
    await page.fill(`${panel} input[type="password"]`, 'pw')
    await page.click(`${panel} button[type="submit"]`)
    await page.waitForFunction(() => document.querySelectorAll('.panel').length === 0)

    // 班级 tab：空态双入口 → 创建班级
    await page.click('.tabs button:has-text("班级")')
    assert.equal(await page.textContent('.view h2'), '班级')
    await page.waitForSelector('.view .entry-toggle')
    assert.match(await page.textContent('.view .empty'), /还没有加入任何班级/)

    await page.click('.view .entry:nth-of-type(1) .entry-toggle')
    await page.fill('.view .entry:nth-of-type(1) input[type="text"]', '软件 2301 班')
    await page.fill('.view .entry:nth-of-type(1) input[type="password"]', 'class-pw')
    await page.click('.view .entry:nth-of-type(1) button[type="submit"]')

    // 创建成功：班级卡出现（mock 的 list 返回了这个班）
    await page.waitForSelector('.view .class-card')
    assert.match(await page.textContent('.view .class-card'), new RegExp(created.code))
    assert.match(await page.textContent('.view .class-card'), /加入密码\s*class-pw/)
    assert.equal(await page.locator('.view .password-chip').count(), 1, '创建者应看到班级加入密码')

    // 录入作业（标题/科目/内容必填，截止 datetime-local）。
    // 视图里还有「加入或创建班级」折叠入口，必须按文案精确匹配。
    await page.click('.view .entry-toggle:has-text("录入作业")')
    await page.fill('.view .entry-form input[maxlength="100"]', '第三章课后习题')
    await page.fill('.view .entry-form input[maxlength="40"]', '高等数学')
    await page.fill('.view .entry-form textarea', '完成教材 P55 1-10 题')
    await page.fill('.view .entry-form input[type="datetime-local"]', '2026-11-01T23:59')
    await page.click('.view .entry-form button[type="submit"]')
    await page.waitForSelector('.view .assignment-card')

    // 作业 tab：班级作业按科目分组（组标题=科目），卡片带来源班级 chip
    await page.click('.tabs button:nth-child(2)')
    await page.waitForSelector('.view .course-group')
    assert.match(await page.textContent('.view .course-group h3'), /高等数学/)
    const groupText = await page.textContent('.view .course-group')
    assert.match(groupText, /第三章课后习题/)
    assert.match(groupText, /软件 2301 班/, '来源班级 chip')
  } finally {
    await page.close()
  }
})

test('班级：可继续加入第二个班、作业按科目分组呈现、创建者可解散班级', async () => {
  const page = await browser.newPage()
  try {
    await page.route('**/api/auth/login', (route) => fulfill(route, LOGIN_OK))
    await page.route('**/api/ucloud/session', (route) => fulfill(route, UCLOUD_SESSION))
    await page.route('**/api/ucloud/assignments', (route) =>
      fulfill(route, { success: true, data: { assignments: [] } }))

    const classes = [
      { classId: 'cls-1', code: '7XA4K2M9Q3', name: '软件 2301 班', createdBy: '2021001234', memberCount: 2, createdAt: Date.now() },
    ]
    const assignments = {
      'cls-1': [
        { id: 'ca-1', title: '第三章习题', subject: '高等数学', content: 'P55 1-10 题', deadline: '2026-11-01 23:59', createdBy: '2021001234' },
        { id: 'ca-2', title: '实验二', subject: '数据结构', content: '链表实现', deadline: '', createdBy: '2021567890' },
      ],
    }
    page.route('**/api/classes/list', (route) => fulfill(route, { success: true, data: { classes } }))
    page.route('**/api/classes/assignments', (route) => {
      const body = route.request().postDataJSON() || {}
      const items = assignments[body.classId] || []
      const cls = classes.find((item) => item.classId === body.classId)
      return fulfill(route, {
        success: true,
        data: {
          assignments: items.map((item) => ({
            id: item.id,
            assignmentTitle: item.title,
            chapterName: item.subject,
            siteId: `class:${body.classId}`,
            siteName: cls?.name || '',
            assignmentEndTime: item.deadline || '',
            assignmentStatus: 99,
            content: item.content,
            createdBy: item.createdBy,
          })),
        },
      })
    })
    page.route('**/api/classes/join', (route) => {
      const body = route.request().postDataJSON() || {}
      assert.equal(body.code, 'Q2W3E4R5T7')
      classes.push({ classId: 'cls-2', code: body.code, name: '物联网 2301 班', createdBy: '2021999888', memberCount: 5, createdAt: Date.now() })
      assignments['cls-2'] = []
      return fulfill(route, { success: true, data: { classId: 'cls-2', name: '物联网 2301 班' } })
    })
    page.route('**/api/classes/password', (route) => {
      const body = route.request().postDataJSON() || {}
      assert.equal(body.classId, 'cls-1')
      assert.equal(body.password, 'reset-pw')
      return fulfill(route, { success: true, data: { classId: body.classId } })
    })
    page.route('**/api/classes/dissolve', (route) => {
      const body = route.request().postDataJSON() || {}
      const index = classes.findIndex((item) => item.classId === body.classId)
      assert.ok(index >= 0, '解散的班级应存在')
      classes.splice(index, 1)
      return fulfill(route, { success: true, data: {} })
    })

    await page.goto(APP_ORIGIN, { waitUntil: 'networkidle' })
    await page.fill(`${panel} input[type="text"]`, '2021001234')
    await page.fill(`${panel} input[type="password"]`, 'pw')
    await page.click(`${panel} button[type="submit"]`)
    await page.waitForFunction(() => document.querySelectorAll('.panel').length === 0)

    // 已有一个班时，「加入或创建班级」入口仍在——可以继续加入
    await page.click('.tabs button:has-text("班级")')
    await page.waitForSelector('.view .class-card')
    assert.equal(await page.locator('.view .password-chip').count(), 0, '旧班级初始没有可恢复的明文密码')
    await page.click('.view .password-manage')
    await page.fill('.view .password-form input[type="password"]', 'reset-pw')
    await page.click('.view .password-form button[type="submit"]')
    await page.waitForFunction(() => document.querySelector('.view .class-card')?.textContent.includes('reset-pw'))
    assert.equal(await page.locator('.view .password-chip').count(), 1, '重设后创建者应看到新加入密码')
    await page.click('.view .entry-toggle:has-text("加入或创建班级")')

    const joinForm = page.locator('.view .entry-form').first()
    await joinForm.locator('input[maxlength="10"]').fill('Q2W3E4R5T7')
    await joinForm.locator('input[type="password"]').fill('join-pw')
    await joinForm.locator('button[type="submit"]').click()

    // 加入成功：出现班级切换器（两个班）
    await page.waitForSelector('.view .class-picker select')

    // 作业 tab：班级作业按科目分组（高等数学 / 数据结构两组），卡片带来源班级 chip
    await page.click('.tabs button:nth-child(2)')
    await page.waitForSelector('.view .course-group')
    const groupTitles = await page.locator('.view .course-group h3').allTextContents()
    assert.ok(groupTitles.some((title) => title.includes('高等数学')), groupTitles.join(' | '))
    assert.ok(groupTitles.some((title) => title.includes('数据结构')), groupTitles.join(' | '))
    assert.match(await page.textContent('.view .class-source'), /软件 2301 班/)

    // 解散：两步确认后当前班消失。剩下一个班（别人创建的）——切换器消失、
    // 且没有解散按钮（解散是创建者专属，非创建班看不到）
    await page.click('.tabs button:has-text("班级")')
    await page.waitForSelector('.view .dissolve-button')
    await page.click('.view .dissolve-button')
    assert.match(await page.textContent('.view .dissolve-button'), /确认解散/)
    await page.click('.view .dissolve-button')

    await page.waitForFunction(() => document.querySelector('.view .class-card')?.textContent.includes('物联网 2301 班'))
    assert.equal(await page.locator('.view .class-picker').count(), 0, '只剩一个班，不需要切换器')
    assert.equal(await page.locator('.view .dissolve-button').count(), 0, '非创建者看不到解散按钮')
  } finally {
    await page.close()
  }
})

test('班级：确认完成移出未提交列表，刷新保留、按账号隔离且可撤销', async () => {
  const page = await browser.newPage()
  try {
    let username = '2021001234'
    await page.route('**/api/auth/login', (route) => fulfill(route, {
      ...LOGIN_OK,
      data: {
        ...LOGIN_OK.data,
        ucloud: { ...LOGIN_OK.data.ucloud, username },
        jwgl: { ...LOGIN_OK.data.jwgl, username },
      },
    }))
    await page.route('**/api/ucloud/session', (route) => fulfill(route, {
      ...UCLOUD_SESSION,
      data: { ...UCLOUD_SESSION.data, username },
    }))
    await page.route('**/api/ucloud/assignments', (route) =>
      fulfill(route, { success: true, data: { assignments: [] } }))
    page.route('**/api/classes/list', (route) =>
      fulfill(route, {
        success: true,
        data: {
          classes: [{ classId: 'cls-1', code: '7XA4K2M9Q3', name: '软件 2301 班', createdBy: '2021999888', memberCount: 3, createdAt: Date.now() }],
        },
      }))
    page.route('**/api/classes/assignments', (route) =>
      fulfill(route, {
        success: true,
        data: {
          assignments: [{
            id: 'ca-1',
            assignmentTitle: '第三章习题',
            chapterName: '高等数学',
            siteId: 'class:cls-1',
            siteName: '软件 2301 班',
            assignmentEndTime: beijingClockFromNow(20 * 3600_000),
            assignmentStatus: 99,
            content: 'P55 1-10 题，交到学委邮箱。',
            createdBy: '2021999888',
          }],
        },
      }))
    let detailAsked = false
    let sharedAssignmentDeleted = false
    page.route('**/api/classes/assignment/delete', (route) => {
      sharedAssignmentDeleted = true
      return fulfill(route, { success: true })
    })
    page.route('**/api/ucloud/assignment/detail', (route) => {
      detailAsked = true
      return fulfill(route, { success: true, data: { attachments: [] } })
    })

    await page.goto(APP_ORIGIN, { waitUntil: 'networkidle' })
    await page.fill(`${panel} input[type="text"]`, '2021001234')
    await page.fill(`${panel} input[type="password"]`, 'pw')
    await page.click(`${panel} button[type="submit"]`)
    await page.waitForFunction(() => document.querySelectorAll('.panel').length === 0)
    await page.click('.tabs button:nth-child(2)')
    await page.waitForSelector('.view .card')

    // 班级作业可以确认完成，不再保留灰色的「去交作业」占位。
    await page.click('.view .card-main')
    await page.waitForSelector('.view .go-submit')
    assert.ok(await page.locator('.view .go-submit').isEnabled())
    assert.equal(await page.textContent('.view .go-submit'), '确认完成')
    assert.equal(await page.getAttribute('.view .go-submit', 'href'), null, '不应带跳转地址')
    assert.match(await page.textContent('.view .status-summary'), /临近截止\s*1/)

    // 附件区空手落定显示「没有附件」，而不是拿 UUID 去打云邮详情接口吃假报错
    await page.waitForFunction(() => document.querySelector('.view .detail-hint')?.textContent.includes('没有附件'))
    assert.equal(detailAsked, false, '班级作业不该请求云邮附件详情')

    await page.click('.view .go-submit')
    await page.waitForFunction(() => document.querySelector('.view .empty')?.textContent.includes('没有未提交的作业'))
    assert.equal(await page.locator('.view .card').count(), 0)
    assert.equal(await page.locator('.view .status-tag').count(), 0)

    // 完成的卡片仍保留在全量列表，状态与倒计时同步更新。
    await page.click('.filter-toggle')
    await page.waitForSelector('.view .card-done')
    assert.equal(await page.textContent('.view .badge'), '已完成')
    assert.equal(await page.locator('.view .status-tag').count(), 0, '已完成的班级作业也不参与统计')
    assert.equal(await page.locator('.view .countdown, .view .deadline-track').count(), 0)
    assert.equal(await page.textContent('.view .go-submit'), '标为未完成')

    await page.reload({ waitUntil: 'networkidle' })
    await page.click('.tabs button:nth-child(2)')
    await page.waitForFunction(() => document.querySelector('.view .empty')?.textContent.includes('没有未提交的作业'))

    // 同一浏览器换号不能继承本人的完成标记，换回来仍保留。
    for (const account of ['2021567890', '2021001234']) {
      await page.click('.topbar-auth button:has-text("退出")')
      await page.waitForSelector(panel)
      username = account
      await page.fill(`${panel} input[type="text"]`, username)
      await page.fill(`${panel} input[type="password"]`, 'pw')
      await page.click(`${panel} button[type="submit"]`)
      await page.waitForFunction(() => document.querySelectorAll('.panel').length === 0)
      if (account === '2021567890') {
        await page.waitForSelector('.view .card')
        assert.equal(await page.locator('.view .card-done').count(), 0)
      } else {
        await page.waitForFunction(() => document.querySelector('.view .empty')?.textContent.includes('没有未提交的作业'))
      }
    }

    await page.click('.filter-toggle')
    await page.waitForSelector('.view .card-done')
    await page.click('.view .card-main')
    await page.click('.view .go-submit:has-text("标为未完成")')
    await page.click('.filter-toggle')
    await page.waitForSelector('.view .card')
    assert.equal(await page.locator('.view .card-done').count(), 0)
    assert.match(await page.textContent('.view .status-summary'), /临近截止\s*1/)
    assert.equal(await page.textContent('.view .go-submit'), '确认完成')
    assert.equal(sharedAssignmentDeleted, false, '确认完成不能删除全班共享的作业')
  } finally {
    await page.close()
  }
})

// ── 添加源 ─────────────────────────────────────────────────────────────────

async function agentBrowserFixture(page) {
  const sessions = new MemorySessionStore()
  const records = new MemorySessionStore()
  await sessions.set('uc-sid', { kind: 'ucloud', username: STORED_UCLOUD.username, expiresAt: EXPIRES_AT })
  const app = createBackend({ getSessionStore: () => sessions, getClassStore: () => records })
  async function post(path, input = {}) {
    const response = await app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: 'uc-sid', ...input }) })
    assert.equal(response.status, 200)
    return (await response.json()).data
  }
  const cls = await post('/api/classes/create', { name: 'Agent 测试班', password: 'class-test-pass' })
  const proxy = async (route) => {
    const request = route.request()
    const response = await app.request(new URL(request.url()).pathname, { method: request.method(),
      headers: request.headers(), ...(request.method() === 'GET' ? {} : { body: request.postData() }) })
    await route.fulfill({ status: response.status, headers: Object.fromEntries(response.headers), body: await response.text() })
  }
  await page.route('**/api/classes/**', proxy)
  await page.route('**/api/agent/**', proxy)
  await page.route('**/api/ucloud/session', (route) => fulfill(route, UCLOUD_SESSION))
  await page.route('**/api/ucloud/logout', (route) => fulfill(route, { success: true }))
  await page.route('**/api/sources/byrdocs/status', (route) => fulfill(route, { success: true, data: { ready: false } }))
  await page.addInitScript((auth) => localStorage.setItem('bupt-week-ucloud-auth', JSON.stringify(auth)), STORED_UCLOUD)
  return { app, records, cls, post }
}

test('Agent 接入：实际生成 Key、关闭后不再显示、不进浏览器存储，网页撤销立即生效', async () => {
  const page = await browser.newPage({ viewport: { width: 320, height: 800 } })
  try {
    const { app } = await agentBrowserFixture(page)
    await page.goto(APP_ORIGIN, { waitUntil: 'networkidle' })
    await page.locator('.tabs button:has-text("班级")').click()
    await page.locator('.class-card').waitFor()
    await page.getByRole('button', { name: /^Agent 接入/ }).click()
    await page.getByRole('button', { name: '生成 Agent Key', exact: true }).click()
    const result = page.getByLabel('新生成的 Agent Key（只显示这一次）')
    await result.waitFor()
    const key = await result.inputValue()
    assert.ok(key.startsWith('bwk_'))
    assert.equal(await page.evaluate((secret) => JSON.stringify({ ...localStorage, ...sessionStorage }).includes(secret), key), false)
    await page.getByRole('button', { name: /^Agent 接入/ }).click()
    await page.getByRole('button', { name: /^Agent 接入/ }).click()
    assert.equal(await result.count(), 0)
    await page.getByRole('button', { name: '撤销 我的作业助手', exact: true }).waitFor()
    for (const mode of ['dark', 'light']) {
      if (await page.locator('html').getAttribute('data-theme') !== mode) await page.locator('.theme-toggle').click()
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${mode} 授权表单不能溢出`)
    }
    await page.getByRole('button', { name: '撤销 我的作业助手', exact: true }).click()
    await page.getByText('暂无有效授权。', { exact: true }).waitFor()
    const denied = await app.request('/api/agent/v1/me', { headers: { Authorization: `Bearer ${key}` } })
    assert.equal(denied.status, 401)
    assert.equal(await page.locator('.agent-access input[type=password]').count(), 0)
  } finally { await page.close() }
})

test('班级资料源：Agent 写入后刷新可见，网页可添加、移除；退出清空共享数据并保留本机列表', async () => {
  const page = await browser.newPage({ viewport: { width: 320, height: 800 } })
  try {
    const { app, cls, post } = await agentBrowserFixture(page)
    await page.addInitScript(() => localStorage.setItem('bupt-week-github-sources-v1', JSON.stringify([
      { owner: 'teacher', repo: 'local-only', ref: 'main', url: 'https://github.com/teacher/local-only' },
    ])))
    await page.goto(APP_ORIGIN, { waitUntil: 'networkidle' })
    await page.locator('.tabs button:has-text("添加源")').click()
    await page.getByRole('button', { name: '添加到班级', exact: true }).waitFor()
    const { key } = await post('/api/agent/keys/create', { name: '资料助手', classIds: [cls.classId], scopes: ['sources:create'] })
    const saved = await app.request(`/api/agent/v1/classes/${cls.classId}/sources`, { method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', 'Idempotency-Key': 'browser-source' },
      body: JSON.stringify({ type: 'link', url: 'https://example.org/lecture', name: '老师的课程主页' }) })
    assert.equal(saved.status, 201)
    await page.getByRole('button', { name: '刷新班级资料源', exact: true }).click()
    await page.getByRole('link', { name: '老师的课程主页 ↗', exact: true }).waitFor()
    await page.getByLabel('资料源类型', { exact: true }).selectOption('link')
    await page.getByLabel('资料源名称（可选）', { exact: true }).fill('补充阅读')
    await page.getByLabel('资料源地址', { exact: true }).fill('https://example.org/reading')
    await page.getByRole('button', { name: '添加到班级', exact: true }).click()
    await page.getByRole('link', { name: '补充阅读 ↗', exact: true }).waitFor()
    await page.getByRole('button', { name: '移除 补充阅读', exact: true }).click()
    await page.getByRole('link', { name: '补充阅读 ↗', exact: true }).waitFor({ state: 'detached' })
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true)
    assert.equal(await page.evaluate(() => JSON.parse(localStorage.getItem('bupt-week-github-sources-v1')).length), 1)
    await page.locator('.topbar-auth').getByRole('button', { name: '退出', exact: true }).click()
    await page.locator('.shared-sources').waitFor({ state: 'detached' })
    assert.equal(await page.getByRole('link', { name: '老师的课程主页 ↗', exact: true }).count(), 0)
    assert.equal(await page.locator('.repository').count(), 1)
  } finally { await page.close() }
})

const BYRDOCS_FILE = { key: `${'a'.repeat(32)}.pdf`, title: '概率论期末试题', filename: '概率论期末试题.pdf', type: 'test', size: 455, url: 'https://byrdocs.org/?q=test' }

test('ByrDocs：本站登录后直接搜索下载，凭证不进前端存储，刷新后保留连接、退出后禁用下载', async () => {
  const page = await browser.newPage()
  try {
    await page.route('**/api/auth/login', (route) => fulfill(route, LOGIN_OK))
    await page.route('**/api/ucloud/session', (route) => fulfill(route, UCLOUD_SESSION))
    await page.route('**/api/jwgl/session', (route) => fulfill(route, { success: true, data: { sessionId: 'jw-sid', username: '2021001234', expiresAt: EXPIRES_AT } }))
    await page.route('**/api/jwgl/timetable', mockTimetable)
    await page.route('**/api/sources/byrdocs/status', (route) => fulfill(route, { success: true, data: { ready: true } }))
    await page.route('**/api/sources/byrdocs/search', (route) => {
      assert.deepEqual(route.request().postDataJSON(), { keyword: '概率论', type: 'test' })
      return fulfill(route, { success: true, data: { results: [BYRDOCS_FILE] } })
    })
    let requestedDownload = false
    await page.route('**/api/sources/byrdocs/download', (route) => {
      const request = route.request()
      assert.equal(request.method(), 'POST')
      assert.equal(request.url().includes('sessionId'), false)
      assert.deepEqual(request.postDataJSON(), { sessionId: 'uc-sid', key: BYRDOCS_FILE.key, filename: BYRDOCS_FILE.filename })
      requestedDownload = true
      return route.fulfill({ contentType: 'application/pdf', body: readFileSync(resolve('tests/browser/fixtures/sample.pdf')) })
    })
    await page.goto(APP_ORIGIN, { waitUntil: 'networkidle' })
    await page.fill(`${panel} input[type="text"]`, '2021001234')
    await page.fill(`${panel} input[type="password"]`, 'password-probe')
    await page.click(`${panel} button[type="submit"]`)
    await page.waitForFunction(() => document.querySelectorAll('.panel').length === 0)
    await page.click('.tabs button:has-text("添加源")')
    await page.getByText('已连接，可直接下载', { exact: true }).waitFor()
    assert.equal(await page.locator('#byrdocs-password').count(), 0)
    await page.getByLabel('资料关键词').fill('概率论')
    await page.getByRole('button', { name: '搜索资料', exact: true }).click()
    await page.getByText(BYRDOCS_FILE.title, { exact: true }).waitFor()
    const downloadPromise = page.waitForEvent('download')
    await page.locator('.byrdocs-results').getByRole('button', { name: '下载', exact: true }).click()
    const download = await downloadPromise
    assert.equal(download.suggestedFilename(), BYRDOCS_FILE.filename)
    assert.ok(readFileSync(await download.path()).equals(readFileSync(resolve('tests/browser/fixtures/sample.pdf'))))
    assert.equal(requestedDownload, true)
    assert.equal(await page.evaluate(() => JSON.stringify(localStorage).includes('password-probe')), false)
    assert.deepEqual(Object.keys(await page.evaluate(() => JSON.parse(localStorage.getItem('bupt-week-ucloud-auth')))).sort(), ['expiresAt', 'realName', 'sessionId', 'username'])
    await page.reload({ waitUntil: 'networkidle' })
    await page.click('.tabs button:has-text("添加源")')
    await page.getByText('已连接，可直接下载', { exact: true }).waitFor()
    await page.click('.topbar-auth button:has-text("退出")')
    await page.getByText('登录后可连接下载', { exact: true }).waitFor()
    assert.equal(await page.locator('#byrdocs-password').count(), 0)
  } finally {
    await page.close()
  }
})

test('ByrDocs：旧会话补连、失败清空密码、下载凭证过期只断开 ByrDocs，窄屏明暗主题不溢出', async () => {
  const page = await browser.newPage({ viewport: { width: 320, height: 800 } })
  try {
    await page.addInitScript((auth) => localStorage.setItem('bupt-week-ucloud-auth', JSON.stringify(auth)), STORED_UCLOUD)
    await page.route('**/api/ucloud/session', (route) => fulfill(route, UCLOUD_SESSION))
    let connected = false
    let attempts = 0
    await page.route('**/api/sources/byrdocs/status', (route) => fulfill(route, { success: true, data: { ready: connected } }))
    await page.route('**/api/sources/byrdocs/connect', (route) => {
      assert.equal(route.request().postDataJSON().sessionId, 'uc-sid')
      attempts += 1
      if (attempts === 1) return fulfill(route, { success: false, stage: 'byrdocs-auth', msg: 'BYR Docs 认证未通过，请检查统一身份认证密码' }, 401)
      connected = true
      return fulfill(route, { success: true, data: { ready: true } })
    })
    await page.route('**/api/sources/byrdocs/search', (route) => fulfill(route, { success: true, data: { results: [BYRDOCS_FILE] } }))
    await page.route('**/api/sources/byrdocs/download', (route) => {
      connected = false
      return fulfill(route, { success: false, stage: 'byrdocs-auth', msg: 'BYR Docs 下载认证已失效，请重新连接；课表和作业不受影响' }, 401)
    })
    await page.goto(APP_ORIGIN, { waitUntil: 'networkidle' })
    await page.click('.tabs button:has-text("添加源")')
    await page.getByLabel('统一身份认证密码', { exact: true }).fill('wrong-probe')
    await page.getByRole('button', { name: '连接 BYR Docs', exact: true }).click()
    await page.getByText('BYR Docs 认证未通过，请检查统一身份认证密码', { exact: true }).waitFor()
    assert.equal(await page.locator('#byrdocs-password').inputValue(), '')
    await page.getByLabel('统一身份认证密码', { exact: true }).fill('correct-probe')
    await page.getByRole('button', { name: '连接 BYR Docs', exact: true }).click()
    await page.getByText('已连接，可直接下载', { exact: true }).waitFor()
    await page.getByLabel('资料关键词').fill('概率论')
    await page.getByRole('button', { name: '搜索资料', exact: true }).click()
    await page.locator('.byrdocs-results').getByRole('button', { name: '下载', exact: true }).click()
    await page.getByText('BYR Docs 下载认证已失效，请重新连接；课表和作业不受影响', { exact: true }).waitFor()
    await page.locator('#byrdocs-password').waitFor()
    assert.ok(await page.evaluate(() => JSON.parse(localStorage.getItem('bupt-week-ucloud-auth')).sessionId))
    for (const mode of ['light', 'dark']) {
      if (await page.locator('html').getAttribute('data-theme') !== mode) await page.locator('.theme-toggle').click()
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, mode)
    }
  } finally {
    await page.close()
  }
})

const SOURCE_REPOSITORY = { owner: 'teacher', repo: 'homework', ref: 'course/main', url: 'https://github.com/teacher/homework' }

async function mockSources(page, { failDirectory = false, failDownload = false } = {}) {
  const paths = []
  const credentials = []
  let directoryFailed = false
  await page.route('**/api/sources/github**', async (route) => {
    const request = route.request()
    const url = new URL(request.url())
    credentials.push({ body: request.postDataJSON(), authorization: request.headers().authorization })
    if (url.pathname.endsWith('/download')) {
      if (failDownload) return fulfill(route, { success: false, msg: '该文件使用 Git LFS 存储，请前往原仓库下载完整文件' }, 422)
      return route.fulfill({ contentType: 'application/octet-stream', body: readFileSync(resolve('tests/browser/fixtures/sample.pdf')) })
    }
    if (url.pathname.endsWith('/contents')) {
      const path = url.searchParams.get('path') || ''
      paths.push(path)
      assert.equal(url.searchParams.get('ref'), 'course/main')
      if (failDirectory && !directoryFailed) {
        directoryFailed = true
        return fulfill(route, { success: false, msg: 'GitHub 暂时限制了访问频率，请稍后重试' }, 429)
      }
      const entries = path === ''
        ? [{ name: '第一章', path: '第一章', type: 'dir', size: 0 }, { name: 'constructor', path: 'constructor', type: 'dir', size: 0 }]
        : path === '第一章'
          ? [{ name: '作业', path: '第一章/作业', type: 'dir', size: 0 }]
          : path === 'constructor' ? [] : [{ name: '练习 #1.pdf', path: '第一章/作业/练习 #1.pdf', type: 'file', size: 455 }]
      return fulfill(route, { success: true, data: { entries, limited: false } })
    }
    return fulfill(route, { success: true, data: { repository: SOURCE_REPOSITORY } })
  })
  return { paths, credentials }
}

test('添加源：未登录添加 → 展开 → 多级目录 → 文件落盘 → 返回与切页缓存 → 保存与移除', async () => {
  const page = await browser.newPage()
  try {
    const { paths, credentials } = await mockSources(page)
    await page.goto(APP_ORIGIN, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: /添加源/ }).click()
    assert.equal(await page.locator('.tabs button').count(), 5)
    assert.equal(await page.locator('.topbar-auth').innerText(), '未登录')
    const byrdocs = page.getByRole('link', { name: '进入 byrdocs.org' })
    assert.equal(await byrdocs.getAttribute('href'), 'https://byrdocs.org/')
    assert.equal(await byrdocs.getAttribute('target'), '_blank')
    assert.match(await byrdocs.getAttribute('rel'), /noreferrer/)

    await page.getByLabel('GitHub 仓库地址').fill(SOURCE_REPOSITORY.url)
    await page.getByRole('button', { name: '添加仓库', exact: true }).click()
    await page.waitForSelector('.repository-toggle')
    assert.deepEqual(paths, [], '未展开前不遍历仓库目录')
    await page.locator('.repository-toggle').click()
    await page.getByRole('button', { name: '第一章', exact: true }).click()
    await page.getByRole('button', { name: '作业', exact: true }).click()
    await page.waitForSelector('.entry-button:has-text("练习 #1.pdf")')
    assert.match(await page.locator('.directory-path').innerText(), /第一章\/作业/)

    const downloadPromise = page.waitForEvent('download')
    await page.getByRole('button', { name: /练习 #1\.pdf/ }).click()
    const download = await downloadPromise
    assert.equal(download.suggestedFilename(), '练习 #1.pdf')
    assert.ok(readFileSync(await download.path()).equals(readFileSync(resolve('tests/browser/fixtures/sample.pdf'))))
    assert.ok(credentials.every((item) => !item.authorization && !item.body?.sessionId && !item.body?.password))

    await page.getByRole('button', { name: /课表/ }).click()
    await page.getByRole('button', { name: /添加源/ }).click()
    assert.match(await page.locator('.directory-path').innerText(), /第一章\/作业/)
    await page.getByRole('button', { name: '返回上级' }).click()
    await page.getByRole('button', { name: '返回上级' }).click()
    assert.match(await page.locator('.directory-path').innerText(), /仓库根目录/)
    assert.deepEqual(paths, ['', '第一章', '第一章/作业'], '返回上级和切页应使用已有目录缓存')
    assert.equal(await page.getByRole('button', { name: '返回上级' }).isDisabled(), true)
    await page.getByRole('button', { name: 'constructor', exact: true }).click()
    await page.waitForFunction(() => document.querySelector('.repository .empty')?.textContent.includes('空的'))
    assert.equal(paths.at(-1), 'constructor', '目录名称不能与缓存对象的内置属性冲突')
    await page.getByRole('button', { name: '返回上级' }).click()

    await page.getByLabel('GitHub 仓库地址').fill(SOURCE_REPOSITORY.url)
    await page.getByRole('button', { name: '添加仓库', exact: true }).click()
    await page.waitForSelector('.source-form [role="alert"]')
    assert.match(await page.locator('.source-form [role="alert"]').innerText(), /已经添加/)
    assert.equal(await page.locator('.repository').count(), 1)

    await page.reload({ waitUntil: 'networkidle' })
    await page.getByRole('button', { name: /添加源/ }).click()
    assert.equal(await page.locator('.repository').count(), 1)
    await page.getByRole('button', { name: '移除 teacher/homework' }).click()
    assert.equal(await page.locator('.repository').count(), 0)
    assert.deepEqual(await page.evaluate(() => JSON.parse(localStorage.getItem('bupt-week-github-sources-v1'))), [])
  } finally {
    await page.close()
  }
})

test('添加源：限流可重试，下载失败展示服务端原因而不保存错误文件', async () => {
  const page = await browser.newPage()
  try {
    await mockSources(page, { failDirectory: true, failDownload: true })
    await page.goto(APP_ORIGIN, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: /添加源/ }).click()
    await page.getByLabel('GitHub 仓库地址').fill(SOURCE_REPOSITORY.url)
    await page.getByRole('button', { name: '添加仓库', exact: true }).click()
    await page.locator('.repository-toggle').click()
    await page.waitForSelector('.repository [role="alert"]')
    assert.match(await page.locator('.repository [role="alert"]').innerText(), /频率/)
    await page.getByRole('button', { name: '重试', exact: true }).click()
    await page.getByRole('button', { name: '第一章', exact: true }).click()
    await page.getByRole('button', { name: '作业', exact: true }).click()
    let downloaded = false
    page.on('download', () => { downloaded = true })
    await page.getByRole('button', { name: /练习 #1\.pdf/ }).click()
    await page.waitForFunction(() => document.querySelector('.download-hint')?.textContent.includes('Git LFS'))
    assert.equal(downloaded, false)
    assert.equal(await page.getByRole('button', { name: /练习 #1\.pdf/ }).isDisabled(), false)
  } finally {
    await page.close()
  }
})

test('添加源：窄屏亮暗主题没有横向溢出，非法本地仓库记录不生成外站链接', async () => {
  const page = await browser.newPage({ viewport: { width: 320, height: 800 } })
  try {
    await page.addInitScript((repository) => {
      localStorage.setItem('bupt-week-github-sources-v1', JSON.stringify([
        repository,
        { ...repository, url: 'javascript:alert(1)' },
        { ...repository, owner: '../evil' },
      ]))
    }, SOURCE_REPOSITORY)
    await mockSources(page)
    await page.goto(APP_ORIGIN, { waitUntil: 'networkidle' })
    await page.getByRole('button', { name: /添加源/ }).click()
    assert.equal(await page.locator('.repository').count(), 1)
    await page.locator('.repository-toggle').click()
    await page.getByRole('button', { name: '第一章', exact: true }).click()
    for (const mode of ['dark', 'light']) {
      if (await page.locator('html').getAttribute('data-theme') !== mode) await page.locator('.theme-toggle').click()
      assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true, `${mode} 窄屏不能横向溢出`)
      const rectangles = await page.locator('.tabs button').evaluateAll((tabs) => tabs.map((tab) => {
        const rect = tab.getBoundingClientRect()
        return { width: rect.width, content: tab.scrollWidth, height: rect.height }
      }))
      assert.ok(rectangles.every((rect) => rect.height >= 44 && rect.content <= Math.ceil(rect.width)), '五个标签文字完整、触摸高度至少 44px')
    }
  } finally {
    await page.close()
  }
})
