// 改版视觉验证专用：起 vite + Edge，route mock 数据，多视口/主题截图。
// 不进测试基线，跑完即弃（产物在 .screenshots/）。
import { createServer as createViteServer } from 'vite'
import { chromium } from 'playwright'
import { mkdir } from 'node:fs/promises'

const OUT_DIR = new URL('./.screenshots/', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')
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
const UCLOUD_SESSION = {
  success: true,
  data: { sessionId: 'uc-sid', username: '2021001234', realName: '张三', expiresAt: EXPIRES_AT },
}

// 本周周一取 2026-10-19，让「今天」(10-24 周六) 落在网格里，验证今日高亮。
function timetableBody(week) {
  const monday = week === 18 ? '2026-10-19' : '2026-10-26'
  const dayDate = (i) => {
    const d = new Date(`${monday}T00:00:00Z`)
    d.setUTCDate(d.getUTCDate() + i)
    return d.toISOString().slice(0, 10)
  }
  return {
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
          { number: 3, time: '10:00~10:45' },
          { number: 4, time: '10:55~11:40' },
          { number: 5, time: '14:00~14:45' },
          { number: 6, time: '14:55~15:40' },
        ],
        courses: [
          { name: '高等数学', day: 1, start: 1, end: 2, location: '教三-101', campus: '西土城', schedule: '[1-2]节', details: [] },
          { name: '大学英语', day: 3, start: 2, end: 2, location: '教四-202', campus: '西土城', schedule: '[2]节', details: [] },
          { name: '数据结构', day: 2, start: 3, end: 4, location: '教二-305', campus: '西土城', schedule: '[3-4]节', details: [] },
          { name: '操作系统', day: 1, start: 5, end: 6, location: '教三-408', campus: '西土城', schedule: '[5-6]节', details: [] },
          { name: '计算机网络', day: 4, start: 1, end: 2, location: '教四-110', campus: '沙河', schedule: '[1-2]节', details: [] },
          { name: '概率论', day: 5, start: 3, end: 3, location: '教三-210', campus: '西土城', schedule: '[3]节', details: [] },
        ],
      },
    },
  }
}

const beijingClockFromNow = (offsetMs) =>
  new Date(Date.now() + offsetMs).toLocaleString('sv-SE', { timeZone: 'Asia/Shanghai' })

const ASSIGNMENTS = {
  success: true,
  data: {
    assignments: [
      { id: 'hw-lab0', siteId: 's2', siteName: '操作系统', assignmentTitle: 'lab0 环境配置', assignmentEndTime: beijingClockFromNow(-24 * 3600_000), assignmentStatus: 99 },
      { id: 'hw-exp1', siteId: 's1', siteName: '数据结构', assignmentTitle: '实验一 线性表', assignmentEndTime: beijingClockFromNow(20 * 3600_000), assignmentStatus: 99 },
      { id: 'hw-net', siteId: 's3', siteName: '计算机网络', assignmentTitle: '第4章课后作业', assignmentEndTime: beijingClockFromNow(3 * 24 * 3600_000), assignmentStatus: 99 },
      { id: 'hw-exp2', siteId: 's1', siteName: '数据结构', assignmentTitle: '实验二 树', assignmentEndTime: beijingClockFromNow(-48 * 3600_000), assignmentStatus: 0, submitTime: beijingClockFromNow(-72 * 3600_000) },
    ],
  },
}

const fulfill = (route, body, status = 200) =>
  route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) })

async function loginAndOpen(page, view) {
  await page.route('**/api/health', (route) => fulfill(route, { success: true }))
  await page.route('**/api/auth/login', (route) => fulfill(route, LOGIN_OK))
  await page.route('**/api/jwgl/session', (route) => fulfill(route, { success: true, data: { sessionId: 'jw-sid', username: '2021001234', expiresAt: EXPIRES_AT } }))
  await page.route('**/api/ucloud/session', (route) => fulfill(route, UCLOUD_SESSION))
  await page.route('**/api/jwgl/timetable', (route) => {
    const body = route.request().postDataJSON() || {}
    fulfill(route, timetableBody(body.week ?? 18))
  })
  await page.route('**/api/ucloud/assignments', (route) => fulfill(route, ASSIGNMENTS))
  await page.route('**/api/ucloud/assignment/detail', (route) =>
    fulfill(route, { success: true, data: { attachments: [{ resourceId: 'r1', resourceName: '实验一说明.pdf' }, { resourceId: 'r2', resourceName: '样例代码.zip' }] } }))

  await page.goto('http://localhost:5173', { waitUntil: 'networkidle' })
  await page.fill('.login-form input[type="text"]', '2021001234')
  await page.fill('.login-form input[type="password"]', 'pw')
  await page.click('.login-form button[type="submit"]')
  await page.waitForFunction(() => document.querySelectorAll('.panel').length === 0)
  if (view === 'assignments') {
    await page.click('.tabs button:nth-child(2)')
    await page.waitForSelector('.card')
    await page.click('.card >> nth=0') // 展开最紧急的一张，看详情态
  } else {
    await page.waitForSelector('.grid')
  }
  await page.waitForTimeout(400)
}

const SHOTS = [
  { name: 'mobile-light-timetable', viewport: { width: 390, height: 844 }, scheme: 'light', view: 'timetable' },
  { name: 'mobile-light-assignments', viewport: { width: 390, height: 844 }, scheme: 'light', view: 'assignments' },
  { name: 'mobile-dark-timetable', viewport: { width: 390, height: 844 }, scheme: 'dark', view: 'timetable' },
  { name: 'mobile-dark-assignments', viewport: { width: 390, height: 844 }, scheme: 'dark', view: 'assignments' },
  { name: 'desktop-light-timetable', viewport: { width: 1280, height: 800 }, scheme: 'light', view: 'timetable' },
  { name: 'desktop-light-assignments', viewport: { width: 1280, height: 800 }, scheme: 'light', view: 'assignments' },
]

const vite = await createViteServer({ configFile: './vite.config.js', root: process.cwd(), logLevel: 'error' })
await vite.listen(5173)

const browser = await chromium.launch({
  executablePath: 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
})
try {
  await mkdir(OUT_DIR, { recursive: true })
  for (const shot of SHOTS) {
    const context = await browser.newContext({
      viewport: shot.viewport,
      colorScheme: shot.scheme,
      deviceScaleFactor: 2,
    })
    const page = await context.newPage()
    await loginAndOpen(page, shot.view)
    await page.screenshot({ path: `${OUT_DIR}/${shot.name}.png`, fullPage: true })
    await context.close()
    console.log(`saved ${shot.name}`)
  }

  // 未登录首屏（移动端）
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, colorScheme: 'light', deviceScaleFactor: 2 })
  const page = await context.newPage()
  await page.route('**/api/health', (route) => fulfill(route, { success: true }))
  await page.goto('http://localhost:5173', { waitUntil: 'networkidle' })
  await page.waitForTimeout(500)
  await page.screenshot({ path: `${OUT_DIR}/mobile-light-login.png`, fullPage: true })
  await context.close()
  console.log('saved mobile-light-login')
} finally {
  await browser.close()
  await vite.close()
}
