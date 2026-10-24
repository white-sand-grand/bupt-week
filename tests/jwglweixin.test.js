import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  buildWeekIndex,
  collectCourseItems,
  fetchTimetableWeixin,
  inferCurrentWeek,
  inferTermStartDate,
  loginJwglweixin,
  parseClassTimeSlots,
  parseWeekNumbers,
  __clearSemesterCache,
} from '../server/services/jwglweixin.js'

/**
 * 移动教务（jwglweixin）服务与解析器。协议逐字对照 where_to_study
 * （docs/jwglweixin-source.md），fail-loud 语义与桌面教务解析器一致：
 * 垃圾输入宁可抛错，不出半份错课表。
 */

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

// ── 登录 ────────────────────────────────────────────────────────────────────

test('loginJwglweixin：表单换 token，头带 Origin/Referer', async (t) => {
  let seen = {}
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    seen = { url: String(url), method: options.method, body: options.body, headers: options.headers }
    return json({ code: 1, data: { token: 'wx-token', expires_in: 7200 } })
  })

  const result = await loginJwglweixin({ username: '2021001234', password: 'pw' })

  assert.equal(result.token, 'wx-token')
  assert.equal(result.username, '2021001234')
  assert.ok(seen.url.includes('/bjyddx/login'))
  assert.equal(seen.method, 'POST')
  assert.equal(seen.body, 'userNo=2021001234&pwd=pw')
  assert.equal(seen.headers.Referer, 'https://jwglweixin.bupt.edu.cn/sjd/#/login')
  assert.equal(seen.headers.Origin, 'https://jwglweixin.bupt.edu.cn')
})

test('loginJwglweixin：code!=1 报 401（密码错要和失败分开）', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => json({ code: 0, Msg: '用户名或密码错误' }))
  await assert.rejects(
    () => loginJwglweixin({ username: 'u', password: 'bad' }),
    (error) => error.status === 401 && error.stage === 'jwglweixin-login' && /用户名或密码错误/.test(error.message),
  )
})

test('loginJwglweixin：网络失败报 502 jwglweixin-connect，不是 401', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => { throw new Error('fetch failed') })
  await assert.rejects(
    () => loginJwglweixin({ username: 'u', password: 'p' }),
    (error) => error.status === 502 && error.stage === 'jwglweixin-connect',
  )
})

test('loginJwglweixin：code 是字符串 "1" 也算成功；没 token 按上游异常报 502', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => json({ code: '1', data: {} }))
  await assert.rejects(
    () => loginJwglweixin({ username: 'u', password: 'p' }),
    (error) => error.status === 502 && error.stage === 'jwglweixin-login',
  )
})

// ── 解析器 ──────────────────────────────────────────────────────────────────

test('parseClassTimeSlots：首字符丢弃，每两位一个 1-based 节次节点', () => {
  // "1" + "03" "04" "05" → 3-5 节（where_to_study parse_sjd_slots 的 1030405 样例）
  assert.deepEqual(parseClassTimeSlots('1030405'), { start: 3, end: 5 })
  assert.deepEqual(parseClassTimeSlots('201'), { start: 1, end: 1 })
  // 非数字/单字符/超界节点识别不了
  assert.equal(parseClassTimeSlots(''), null)
  assert.equal(parseClassTimeSlots('abc'), null)
  assert.equal(parseClassTimeSlots('199'), null)
})

test('parseWeekNumbers：区间、单周、全角逗号、单双周、括号注记', () => {
  assert.deepEqual(parseWeekNumbers('1-17周', ''), [1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17])
  assert.deepEqual(parseWeekNumbers('1，3，5', ''), [1, 3, 5])
  assert.deepEqual(parseWeekNumbers('1-10周(单)', ''), [1, 3, 5, 7, 9])
  assert.deepEqual(parseWeekNumbers('2-10周(双)', ''), [2, 4, 6, 8, 10])
  assert.deepEqual(parseWeekNumbers('[第1-3周]第2-4周', ''), [2, 3, 4])
  assert.deepEqual(parseWeekNumbers('', '第3周 第5周'), [3, 5])
  assert.deepEqual(parseWeekNumbers('', ''), [])
  // 越界与倒序区间丢弃，不给垃圾
  assert.deepEqual(parseWeekNumbers('99', ''), [])
  assert.deepEqual(parseWeekNumbers('5-3', ''), [])
})

test('collectCourseItems：含 courseName/jx0408id 的对象才算课程项，深度受限', () => {
  const payload = {
    data: [{
      item: [
        { courseName: '高等数学', classTime: '1030405' },
        { jx0408id: 'JX-001', courseName: '' },
        { nested: { deep: { deeper: { courseName: '深处课程' } } } },
        '不是对象',
        42,
      ],
    }],
  }
  const items = collectCourseItems(payload)
  assert.equal(items.length, 3)
  assert.deepEqual(items.map((item) => item.courseName).sort(), ['', '深处课程', '高等数学'])
})

test('inferTermStartDate/inferCurrentWeek：从当前周 payload 推学期起点', () => {
  const payload = {
    data: [{
      date: [
        { mxrq: '2026-10-26', xqid: '1', zc: '8' },  // 第 8 周周一
        { zc: 'all' },
      ],
    }],
  }
  const termStart = inferTermStartDate(payload)
  assert.equal(termStart.toISOString().slice(0, 10), '2026-09-07')  // 10-26 减 7 周
  assert.equal(inferCurrentWeek(payload), 8)
  // xqid 缺失时用日期本身的星期（2026-10-28 是周三 → 周一 10-26）
  const noXqid = { data: [{ date: [{ mxrq: '2026-10-28', zc: '8' }] }] }
  assert.equal(inferTermStartDate(noXqid).toISOString().slice(0, 10), '2026-09-07')
  // 周日 xqid=0 映射为 7：09-07 起点的日历里 10-25 是第 7 周的周日
  const sunday = { data: [{ date: [{ mxrq: '2026-10-25', xqid: '0', zc: '7' }] }] }
  assert.equal(inferTermStartDate(sunday).toISOString().slice(0, 10), '2026-09-07')
})

// ── 周索引与切片 ─────────────────────────────────────────────────────────────

const CURRENT_PAYLOAD = {
  code: 1,
  data: [{ date: [{ mxrq: '2026-10-26', xqid: '1', zc: '2' }], semesterId: '2026-2027-1' }],
}

const ALL_PAYLOAD = {
  code: 1,
  data: [{
    courses: [
      { courseName: '高等数学', weekDay: '1', classTime: '1010203', classWeek: '1-3周', buildingName: '教三', classroomName: '101', teacherName: '张三' },
      { courseName: '大学英语', weekDay: '3', classTime: '306', classWeek: '2周', buildingName: '', classroomName: '教四-202' },
      { courseName: '坏数据', weekDay: 'x', classTime: '', classWeek: '' },
      { courseName: '无周次', weekDay: '2', classTime: '202', classWeek: '' },
    ],
  }],
}

test('buildWeekIndex：周对象对齐桌面教务形状，坏条目被丢弃', () => {
  const { weeks, weekNumbers, currentWeek } = buildWeekIndex(ALL_PAYLOAD, CURRENT_PAYLOAD)

  assert.equal(currentWeek, 2)
  assert.deepEqual(weekNumbers, [1, 2, 3])  // 课程周次并集 1-3 补齐连续

  const week1 = weeks.get(1)
  assert.equal(week1.week, 1)
  assert.equal(week1.mode, 'jwglweixin')
  assert.equal(week1.date, '2026-10-19')  // 学期起点（第 2 周是 10-26）
  assert.deepEqual(week1.weeks, [1, 2, 3])
  assert.equal(week1.days.length, 7)
  assert.equal(week1.days[0].label, '星期一')
  assert.equal(week1.days[0].date, '10-19')
  assert.equal(week1.periods.length, 14)
  assert.equal(week1.periods[0].time, '08:00~08:45')

  // 高数 1-3 节 day1；week1 只有它（大学英语仅第 2 周）
  assert.equal(week1.courses.length, 1)
  const course = week1.courses[0]
  assert.equal(course.name, '高等数学')
  assert.equal(course.day, 1)
  assert.equal(course.start, 1)
  assert.equal(course.end, 3)
  assert.equal(course.location, '教三-101')
  assert.equal(course.schedule, '[1-3]节')
  assert.ok(course.details.includes('张三'))

  const week2 = weeks.get(2)
  assert.equal(week2.courses.length, 2, '第 2 周：高数 + 大学英语')
  assert.ok(week2.courses.some((item) => item.name === '大学英语' && item.day === 3 && item.end === 6))
})

test('buildWeekIndex：缺学期日期或当前周直接抛错，不出半份数据', () => {
  const empty = { code: 1, data: [{}] }
  assert.throws(() => buildWeekIndex(empty, empty), /学期日期|当前周次/)
})

test('fetchTimetableWeixin：按周切片，带缓存（一次上游往返供多次切片）', async (t) => {
  __clearSemesterCache()
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url) => {
    calls.push(String(url))
    const week = new URL(String(url)).searchParams.get('week')
    if (week === 'all') return json(ALL_PAYLOAD)
    return json(CURRENT_PAYLOAD)
  })

  const first = await fetchTimetableWeixin({ token: 'tk' })
  assert.equal(first.timetable.week, 2)
  assert.ok(first.timetable.courses.length >= 1)

  const week1 = await fetchTimetableWeixin({ token: 'tk', week: 1 })
  assert.equal(week1.timetable.week, 1)
  assert.equal(week1.timetable.date, '2026-10-19')

  // 两次切片共享一次整学期加载：只有 week= 和 week=all 各一次
  assert.equal(calls.length, 2)

  await assert.rejects(
    () => fetchTimetableWeixin({ token: 'tk', week: 99 }),
    (error) => error.status === 400,
  )
})

test('fetchTimetableWeixin：token 失效（500+JSON 或 code!=1 提示 token）报 401', async (t) => {
  __clearSemesterCache()
  t.mock.method(globalThis, 'fetch', async () => json({ code: 0, msg: 'token失效' }, 500))
  await assert.rejects(
    () => fetchTimetableWeixin({ token: 'bad' }),
    (error) => error.status === 401 && error.stage === 'jwglweixin-auth',
  )
})
