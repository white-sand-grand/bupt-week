// 性能门禁：① 构建产物体积预算（gzip 实测）② 生产构建运行时冒烟。
// 由 scripts/gate/run.mjs 编排（会先跑 vite build），单独跑需已有 dist/：
//   node scripts/gate/performance.mjs
// 本机用系统 Edge（chromium 下不动）；CI 用默认 chromium channel。
import { readdirSync, statSync, readFileSync } from 'node:fs'
import { gzipSync } from 'node:zlib'
import { preview as createPreviewServer } from 'vite'
import { chromium } from 'playwright'

const PREVIEW_PORT = 4173
const PREVIEW_ORIGIN = `http://localhost:${PREVIEW_PORT}`

const failures = []
const ok = (name) => console.log(`  ✓ ${name}`)
const fail = (name, detail) => {
  failures.push(name)
  console.log(`  ✗ ${name}\n    ${detail}`)
}

// ── 1. 体积预算 ──────────────────────────────────────────────────────────────
// 预算按当前实测 + ~30% 余量设定，防的是“不知不觉长成大包子”：
// 引入大依赖/忘记 tree-shake 时在这里被拦下，而不是上线后被用户感知。
// 有意放宽预算时请连同理由一起改这里。

const BUDGETS = [
  { kind: 'js', gzipLimitKB: 60, rawLimitKB: 200 },
  { kind: 'css', gzipLimitKB: 10, rawLimitKB: 40 },
]
const HTML_LIMIT_KB = 6

function walkFiles(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`
    return entry.isDirectory() ? walkFiles(path) : [path]
  })
}

function sizeBudgetGate() {
  console.log('\n[1/2] 构建产物体积预算（dist/，gzip 实测）')
  const files = walkFiles('dist')
  const kb = (n) => `${(n / 1024).toFixed(1)}KB`

  let allGood = true
  for (const { kind, gzipLimitKB, rawLimitKB } of BUDGETS) {
    const bucket = files.filter((path) => path.endsWith(`.${kind}`))
    const raw = bucket.reduce((sum, path) => sum + statSync(path).size, 0)
    const gzip = bucket.reduce((sum, path) => sum + gzipSync(readFileSync(path)).length, 0)
    const gzipKB = gzip / 1024
    const rawKB = raw / 1024
    console.log(`    .${kind}: gzip ${kb(gzip)} / 原始 ${kb(raw)}（预算 gzip ${gzipLimitKB}KB / 原始 ${rawLimitKB}KB）`)
    if (gzipKB > gzipLimitKB || rawKB > rawLimitKB) {
      allGood = false
      fail(`.${kind} 超预算`, `gzip ${kb(gzip)} / 原始 ${kb(raw)}，预算 ${gzipLimitKB}KB / ${rawLimitKB}KB`)
    }
  }

  const htmlFiles = files.filter((path) => path.endsWith('.html'))
  const htmlKB = htmlFiles.reduce((sum, path) => sum + statSync(path).size, 0) / 1024
  if (htmlKB > HTML_LIMIT_KB) {
    allGood = false
    fail('HTML 超预算', `${htmlKB.toFixed(1)}KB > ${HTML_LIMIT_KB}KB（不该往模板里塞大段内联内容）`)
  }
  if (allGood) ok(`体积在预算内（HTML ${htmlKB.toFixed(1)}KB）`)
}

// ── 2. 运行时冒烟（生产构建 + preview + mock 后端） ──────────────────────────
// 阈值给得宽松（本机/Cold Runner 都该轻松过）：目的是拦“数量级恶化”，
// 不是精确基准测试。抖动敏感的精确数字不适合进门禁。

const TIMING_BUDGETS = {
  domContentLoadedMs: 1500,
  loadEventMs: 3000,
  gridAfterLoginMs: 1500,
  firstLoadResources: 6,
}

const EXPIRES_AT = Date.now() + 3600_000
const LOGIN_OK = {
  success: true,
  data: {
    ucloud: { sessionId: 'uc-sid', username: '2021001234', realName: '张三' },
    jwgl: { sessionId: 'jw-sid', username: '2021001234' },
    jwglVia: 'cas',
    expiresAt: EXPIRES_AT,
  },
}
const UCLOUD_SESSION = { success: true, data: { sessionId: 'uc-sid', username: '2021001234', realName: '张三', expiresAt: EXPIRES_AT } }

function timetableBody() {
  const dayDate = (i) => {
    const d = new Date('2026-10-19T00:00:00Z')
    d.setUTCDate(d.getUTCDate() + i)
    return d.toISOString().slice(0, 10)
  }
  return {
    success: true,
    data: {
      timetable: {
        week: 18, mode: 'A'.repeat(32), date: dayDate(0), weeks: [18], modes: [],
        days: Array.from({ length: 7 }, (_, i) => ({ label: `星期${'一二三四五六日'[i]}`, date: dayDate(i) })),
        periods: Array.from({ length: 6 }, (_, i) => ({ number: i + 1, time: `08:0${i}~08:4${i}` })),
        courses: Array.from({ length: 6 }, (_, i) => ({
          name: `课程${i + 1}`, day: (i % 7) + 1, start: (i % 6) + 1, end: (i % 6) + 1,
          location: `教三-10${i}`, campus: '西土城', schedule: '[1]节', details: [],
        })),
      },
    },
  }
}

const fulfill = (route, body, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

async function runtimeSmokeGate() {
  console.log('\n[2/2] 运行时冒烟（vite preview + mock 后端，Edge/Chromium）')

  // preview 服务的是 dist/ 生产构建（不是 dev server）；API 全部 route mock，无需代理
  const vite = await createPreviewServer({
    configFile: './vite.config.js',
    root: process.cwd(),
    preview: { port: PREVIEW_PORT, strictPort: true },
  })

  const launchOptions = process.env.BROWSER_EXECUTABLE
    ? { executablePath: process.env.BROWSER_EXECUTABLE }
    : { channel: 'chromium' }
  const browser = await chromium.launch(launchOptions)

  let allGood = true
  try {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 } })
    await context.route('**/api/**', (route) => {
      const path = new URL(route.request().url()).pathname
      if (path === '/api/health') return fulfill(route, { success: true, data: { ok: true } })
      if (path === '/api/auth/login') return fulfill(route, LOGIN_OK)
      if (path === '/api/jwgl/session' || path === '/api/ucloud/session') {
        return fulfill(route, path.startsWith('/api/jwgl')
          ? { success: true, data: { sessionId: 'jw-sid', username: '2021001234', expiresAt: EXPIRES_AT } }
          : UCLOUD_SESSION)
      }
      if (path === '/api/jwgl/timetable') return fulfill(route, timetableBody())
      return fulfill(route, { success: true, data: {} })
    })

    const page = await context.newPage()
    await page.goto(PREVIEW_ORIGIN, { waitUntil: 'load' })
    await page.waitForFunction(() => /后端已连接/.test(document.querySelector('.footnote')?.textContent || ''), null, { timeout: 5000 })

    const timings = await page.evaluate(() => {
      const navigation = performance.getEntriesByType('navigation')[0] || {}
      const sameOrigin = performance.getEntriesByType('resource')
        .filter((entry) => new URL(entry.name).origin === location.origin)
        .filter((entry) => /\.(js|css)(\?|$)/.test(new URL(entry.name).pathname))
      return {
        domContentLoadedMs: navigation.domContentLoadedEventEnd || 0,
        loadEventMs: navigation.loadEventEnd || 0,
        firstLoadResources: sameOrigin.length,
      }
    })
    console.log(`    冷启动 DCL ${timings.domContentLoadedMs.toFixed(0)}ms / load ${timings.loadEventMs.toFixed(0)}ms / JS+CSS 请求 ${timings.firstLoadResources} 个`)

    if (timings.domContentLoadedMs > TIMING_BUDGETS.domContentLoadedMs) {
      allGood = false
      fail('冷启动 DOMContentLoaded 超预算', `${timings.domContentLoadedMs.toFixed(0)}ms > ${TIMING_BUDGETS.domContentLoadedMs}ms`)
    }
    if (timings.loadEventMs > TIMING_BUDGETS.loadEventMs) {
      allGood = false
      fail('冷启动 load 超预算', `${timings.loadEventMs.toFixed(0)}ms > ${TIMING_BUDGETS.loadEventMs}ms`)
    }
    if (timings.firstLoadResources > TIMING_BUDGETS.firstLoadResources) {
      allGood = false
      fail('首屏 JS/CSS 请求超预算', `${timings.firstLoadResources} 个 > ${TIMING_BUDGETS.firstLoadResources} 个（chunk 碎了或漏了 tree-shake）`)
    }

    // 交互路径：登录提交 → 课表网格渲染完成（6 节次 × 7 天 + 课程着色）
    const gridStart = Date.now()
    await page.fill('.login-form input[type="text"]', '2021001234')
    await page.fill('.login-form input[type="password"]', 'pw')
    await page.click('.login-form button[type="submit"]')
    await page.waitForFunction(() => document.querySelectorAll('.panel').length === 0, null, { timeout: 5000 })
    await page.waitForSelector('.grid', { timeout: 5000 })
    const gridMs = Date.now() - gridStart
    console.log(`    登录→课表网格渲染 ${gridMs}ms（预算 ${TIMING_BUDGETS.gridAfterLoginMs}ms）`)
    if (gridMs > TIMING_BUDGETS.gridAfterLoginMs) {
      allGood = false
      fail('登录→网格渲染超预算', `${gridMs}ms > ${TIMING_BUDGETS.gridAfterLoginMs}ms`)
    }

    // 渲染正确性顺带把关：网格里 6 门课都在
    const courseCount = await page.locator('.course-item').count()
    if (courseCount !== 6) {
      allGood = false
      fail('网格课程块数量不对', `期望 6，实际 ${courseCount}`)
    }

    await context.close()
  } finally {
    await browser.close()
    await new Promise((resolve) => vite.httpServer.close(resolve))
  }
  if (allGood) ok('冷启动、交互渲染、请求数均在预算内')
}

// ── 汇总 ────────────────────────────────────────────────────────────────────

sizeBudgetGate()
await runtimeSmokeGate()

console.log(`\n性能门禁：${failures.length === 0 ? '通过' : `${failures.length} 项失败`}`)
process.exit(failures.length === 0 ? 0 : 1)
