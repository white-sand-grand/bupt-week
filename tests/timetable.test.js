import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBackend } from '../server/app.js'
import { MemorySessionStore } from '../server/storage/memory.js'
import { parseTimetable } from '../server/services/timetable.js'

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/**
 * 课表解析器与路由。
 *
 * fixture 按 docs/api-reference.md §4.2 的 DOM 结构构造（该节为【实测】）。
 * 解析器是从 MYUCLOUD 原样移植的，fail-loud 语义必须有测试钉住。
 */

const MODE = 'ABCDEF0123456789ABCDEF0123456789'

function timetablePage({ week = 18, withWeek = true, days = 7, periods = [1, 2, 3], courses = '' } = {}) {
  const dayHeader = ['<li><span>节次/日期</span></li>']
  const dayNames = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日']
  for (let i = 0; i < days; i += 1) {
    dayHeader.push(`<li><span>${dayNames[i]}</span><span>10-2${i + 1}</span></li>`)
  }
  const weekOptions = withWeek
    ? Array.from({ length: 20 }, (_, i) => `<option value="${i + 1}">第${i + 1}周</option>`).join('')
    : ''
  const periodRows = periods
    .map((n, i) => `<li class="row-one"><h5>${n}</h5>${String(8 + i).padStart(2, '0')}:00~${String(9 + i).padStart(2, '0')}:45</li>`)
    .join('')

  return `<html><body>
    <script>var dqzc = '${week}'; var kbjcmsid = '${MODE}';</script>
    <input id="xzrq" value="2026-10-26" />
    <select id="xkzc">${weekOptions}</select>
    <select id="kbjcmsid"><option value="${MODE}">默认</option></select>
    <ul class="table-header">${dayHeader.join('')}</ul>
    <ul>${periodRows}</ul>
    ${courses}
  </body></html>`
}

const COURSE_HTML = `
  <div class="table-class day0"><h4>高等数学</h4><ul>
    <li>上课时间：[1-2]节</li><li>上课地点：教三-101</li><li>上课校区：西土城路校区</li>
  </ul></div>
  <div class="table-class day2"><h4>大学英语</h4><ul>
    <li>上课时间：[3]节</li><li>上课地点：教四-202</li><li>上课校区：西土城路校区</li>
  </ul></div>`

// ── 解析器 ──────────────────────────────────────────────────────────────────

test('parseTimetable：完整页面解析出周次/星期/节次/课程', () => {
  const timetable = parseTimetable(timetablePage({ courses: COURSE_HTML }))

  assert.equal(timetable.week, 18)
  assert.equal(timetable.mode, MODE)
  assert.equal(timetable.date, '2026-10-26')
  assert.equal(timetable.weeks.length, 20)
  assert.deepEqual(timetable.modes, [{ value: MODE, label: '默认' }])
  assert.equal(timetable.days.length, 7)
  assert.equal(timetable.days[0].label, '星期一')
  assert.equal(timetable.periods.length, 3)
  assert.equal(timetable.periods[0].number, 1)
  assert.match(timetable.periods[0].time, /08:00~09:45/)

  assert.equal(timetable.courses.length, 2)
  const math = timetable.courses[0]
  assert.equal(math.name, '高等数学')
  assert.equal(math.day, 1, 'day0 应映射为星期一（day = N + 1）')
  assert.equal(math.start, 1)
  assert.equal(math.end, 2)
  assert.equal(math.location, '教三-101')
  assert.equal(math.campus, '西土城路校区')
  assert.equal(timetable.courses[1].day, 3)
})

test('parseTimetable：不是课表页（如登录页）时抛错，不返回半份数据', () => {
  assert.throws(() => parseTimetable('<title>登录</title>'), /未找到课表/)
})

test('parseTimetable：缺周次变量时抛错（fail-loud）', () => {
  const html = timetablePage({ courses: COURSE_HTML }).replace(/var dqzc = '18';/, '')
  assert.throws(() => parseTimetable(html), /缺少周次/)
})

test('parseTimetable：星期不足 7 天时抛错（fail-loud）', () => {
  assert.throws(() => parseTimetable(timetablePage({ days: 6, courses: COURSE_HTML })), /缺少周次/)
})

test('parseTimetable：课程节次对不上节次表时抛错（fail-loud）', () => {
  const badCourse = `<div class="table-class day0"><h4>幽灵课</h4><ul>
    <li>上课时间：[9]节</li><li>上课地点：未知</li>
  </ul></div>`
  assert.throws(() => parseTimetable(timetablePage({ courses: badCourse })), /时间格式无法识别/)
})

test('parseTimetable：HTML 实体与多空格被清洗', () => {
  const entityCourse = `<div class="table-class day0"><h4>概率论&nbsp;&amp;&nbsp;数理统计</h4><ul>
    <li>上课时间：[1]节</li><li>上课地点：教三&nbsp;201</li>
  </ul></div>`
  const timetable = parseTimetable(timetablePage({ courses: entityCourse }))
  assert.equal(timetable.courses[0].name, '概率论 & 数理统计')
  assert.equal(timetable.courses[0].location, '教三 201')
})

// ── 路由 ────────────────────────────────────────────────────────────────────

function makeApp() {
  const store = new MemorySessionStore()
  const app = createBackend({ getSessionStore: () => store, allowedOrigins: [] })
  return { app, store }
}

function post(app, path, body) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('POST /api/jwgl/timetable：返回解析后的课表并回写 Cookie', async (t) => {
  const { app, store } = makeApp()
  await store.set('jw', { kind: 'jwgl', cookies: 'JSESSIONID=old', username: 'u', expiresAt: Date.now() + 86400000 })

  let seenUrl = ''
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    seenUrl = String(url)
    return new Response(timetablePage({ courses: COURSE_HTML }), {
      headers: { 'set-cookie': 'JSESSIONID=fresh; Path=/' },
    })
  })

  const response = await post(app, '/api/jwgl/timetable', { sessionId: 'jw' })
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(body.data.timetable.week, 18)
  assert.equal(body.data.timetable.courses.length, 2)
  assert.equal((await store.get('jw')).cookies, 'JSESSIONID=fresh', '新 Cookie 应写回会话')
  assert.ok(seenUrl.includes('xsdPerson.jsp'), seenUrl)
})

test('POST /api/jwgl/timetable：jwglweixin 会话走移动教务，mode 被忽略', async (t) => {
  const { app, store } = makeApp()
  await store.set('wx', { kind: 'jwglweixin', token: 'tk', username: 'u', expiresAt: Date.now() + 86400000 })

  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    calls.push({ url: String(url), token: options.headers?.token })
    const week = new URL(String(url)).searchParams.get('week')
    if (week === 'all') {
      return json({ code: 1, data: [{ courses: [
        { courseName: '高等数学', weekDay: '1', classTime: '10102', classWeek: '1-2周', buildingName: '教三', classroomName: '101' },
      ] }] })
    }
    return json({ code: 1, data: [{ date: [{ mxrq: '2026-10-26', xqid: '1', zc: '2' }] }] })
  })

  // 前端会带上 jwgl 的 mode 参数（固定值 'jwglweixin'）——路由要忽略它
  const response = await post(app, '/api/jwgl/timetable', { sessionId: 'wx', week: 1, mode: 'jwglweixin' })
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(body.data.timetable.week, 1)
  assert.equal(body.data.timetable.courses[0].name, '高等数学')
  assert.equal(body.data.timetable.mode, 'jwglweixin')
  for (const call of calls) assert.equal(call.token, 'tk', 'token 头必须带上')
})

test('POST /api/jwgl/timetable：jwglweixin token 失效 401 并删会话', async (t) => {
  const { app, store } = makeApp()
  await store.set('wx', { kind: 'jwglweixin', token: 'stale', username: 'u', expiresAt: Date.now() + 86400000 })
  t.mock.method(globalThis, 'fetch', async () => json({ code: 0, msg: 'token失效' }, 500))

  const response = await post(app, '/api/jwgl/timetable', { sessionId: 'wx' })
  assert.equal(response.status, 401)
  assert.equal(await store.get('wx'), undefined, '失效会话应删除')
})

test('POST /api/jwgl/timetable：带 week 请求时校验教务往返一致', async (t) => {
  const { app, store } = makeApp()
  await store.set('jw', { kind: 'jwgl', cookies: 'JSESSIONID=x', username: 'u', expiresAt: Date.now() + 86400000 })

  // 请求第 3 周，教务静默回了当前周（第 18 周）——必须报错，防止缓存错周
  t.mock.method(globalThis, 'fetch', async () =>
    new Response(timetablePage({ week: 18, courses: COURSE_HTML })),
  )

  const response = await post(app, '/api/jwgl/timetable', { sessionId: 'jw', week: 3 })
  const body = await response.json()

  assert.equal(response.status, 502)
  assert.equal(body.stage, 'jwgl-timetable')
})

test('POST /api/jwgl/timetable：week 请求真的带上了 xkzc 参数', async (t) => {
  const { app, store } = makeApp()
  await store.set('jw', { kind: 'jwgl', cookies: 'x=1', username: 'u', expiresAt: Date.now() + 86400000 })

  let seenUrl = ''
  t.mock.method(globalThis, 'fetch', async (url) => {
    seenUrl = String(url)
    return new Response(timetablePage({ week: 3, courses: COURSE_HTML }))
  })

  await post(app, '/api/jwgl/timetable', { sessionId: 'jw', week: 3 })
  assert.match(seenUrl, /xkzc=3/)
})

test('POST /api/jwgl/timetable：会话失效返回 401 并删除会话', async (t) => {
  const { app, store } = makeApp()
  await store.set('jw', { kind: 'jwgl', cookies: 'x=1', username: 'u', expiresAt: Date.now() + 86400000 })

  t.mock.method(globalThis, 'fetch', async () =>
    new Response('<title>登录</title><form id="userAccount"></form>'),
  )

  const response = await post(app, '/api/jwgl/timetable', { sessionId: 'jw' })
  assert.equal(response.status, 401)
  assert.equal((await response.json()).stage, 'jwgl-auth')
  assert.equal(await store.get('jw'), undefined)
})

test('POST /api/jwgl/timetable：云邮会话来调返回 401（kind 校验）', async () => {
  const { app, store } = makeApp()
  await store.set('uc', { kind: 'ucloud', accessToken: 't', expiresAt: Date.now() + 86400000 })

  const response = await post(app, '/api/jwgl/timetable', { sessionId: 'uc' })
  assert.equal(response.status, 401)
})

test('POST /api/jwgl/timetable：非法 week 返回 400', async () => {
  const { app, store } = makeApp()
  await store.set('jw', { kind: 'jwgl', cookies: 'x=1', username: 'u', expiresAt: Date.now() + 86400000 })

  const response = await post(app, '/api/jwgl/timetable', { sessionId: 'jw', week: 99 })
  assert.equal(response.status, 400)
})
