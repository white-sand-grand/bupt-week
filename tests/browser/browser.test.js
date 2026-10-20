import { test, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import { readFileSync } from 'node:fs'
import { chromium } from 'playwright'
import { serve } from '@hono/node-server'
import { createServer as createViteServer } from 'vite'
import { createBackend } from '../../server/app.js'
import { MemorySessionStore } from '../../server/storage/memory.js'

/**
 * 浏览器端验证。
 *
 * 单独一个脚本（npm run test:browser），不并进 npm test：
 * 需要先装 chromium，而且比接口测试慢一个量级。
 *
 * 这里只验单元测试做不到的事：
 *   1. Vue 应用真的挂载并渲染（dev server 有模块缓存，200 不代表编译成功）
 *   2. 下载链路：fetch → blob → <a download> → 落盘，文件名是附件名
 *   3. CORS 在真实浏览器里的行为（允许的来源能过，不允许的被拦）
 */

const BACKEND_PORT = 8787
const APP_PORT = 5173
const ALLOWED_ORIGIN = 'http://127.0.0.1:9911' // 模拟 GitHub Pages 域名（已放行）
const BLOCKED_ORIGIN = 'http://127.0.0.1:9912' // 未放行的来源
const APP_ORIGIN = `http://127.0.0.1:${APP_PORT}`
const BACKEND_ORIGIN = `http://127.0.0.1:${BACKEND_PORT}`

// chrome-headless-shell 没装成（CDN 连接被重置），用完整的 chromium 构建顶上。
const LAUNCH_OPTIONS = { channel: 'chromium' }

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

test('应用真的挂载，并显示后端已连接', async () => {
  const page = await browser.newPage()
  try {
    await page.goto(APP_ORIGIN, { waitUntil: 'networkidle' })

    // 挂载了：#app 里有真实 DOM，而不是空壳
    const heading = await page.textContent('h1')
    assert.equal(heading, 'BUPT-week')

    // 链路通了：前端 → Vite 代理 → 后端 → JSON 形状 → Vue 渲染
    await page.waitForSelector('.status-ok', { timeout: 10000 })
    assert.match(await page.textContent('.status'), /后端已连接/)
  } finally {
    await page.close()
  }
})

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

    // 内容真的落盘了，不是空文件
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
    await page.waitForFunction(
      () => document.getElementById('result').textContent.startsWith('error:'),
      { timeout: 10000 },
    )

    const message = await page.textContent('#result')
    assert.match(message, /error: 下载失败（HTTP 404）/)
  } finally {
    await page.close()
  }
})

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
