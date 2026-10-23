import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  currentTimetableWeek,
  groupTimetableCourses,
  mergeTimetableWeek,
  validateTimetableCache,
} from '../src/utils/timetable-cache.js'

const MODE = 'A'.repeat(32)

function weekData(week, date, courses = []) {
  return {
    week,
    mode: MODE,
    date,
    weeks: [1, 2, week],
    modes: [{ value: MODE, label: '默认' }],
    days: Array.from({ length: 7 }, (_, i) => ({ label: `星期${'一二三四五六日'[i]}`, date: '' })),
    periods: [{ number: 1, time: '08:00~08:45' }],
    courses,
  }
}

const COURSE = { name: '高等数学', day: 1, start: 1, end: 2, location: '教三-101', campus: '', schedule: '[1-2]节', details: [] }

test('validateTimetableCache：合法缓存通过，残缺缓存拒绝', () => {
  const cache = mergeTimetableWeek(null, '2021001234', weekData(1, '2026-09-07', [COURSE]))
  assert.equal(validateTimetableCache(cache), true)

  assert.equal(validateTimetableCache({ ...cache, weeks: [] }), false)
  assert.equal(validateTimetableCache({ ...cache, username: 123 }), false)
  assert.equal(
    validateTimetableCache({ ...cache, weeks: [{ ...cache.weeks[0], days: cache.weeks[0].days.slice(0, 6) }] }),
    false,
  )
})

test('mergeTimetableWeek：同学期逐周合并，未覆盖周次保留', () => {
  let cache = mergeTimetableWeek(null, 'u', weekData(1, '2026-09-07'))
  cache = mergeTimetableWeek(cache, 'u', weekData(3, '2026-09-21'))
  cache = mergeTimetableWeek(cache, 'u', weekData(2, '2026-09-14'))

  assert.deepEqual(cache.weeks.map((w) => w.week), [1, 2, 3])
  // 重复同步第 2 周不产生重复条目
  cache = mergeTimetableWeek(cache, 'u', weekData(2, '2026-09-14'))
  assert.deepEqual(cache.weeks.map((w) => w.week), [1, 2, 3])
})

test('mergeTimetableWeek：换账号或换学期时整体重建，不混存', () => {
  let cache = mergeTimetableWeek(null, 'u1', weekData(1, '2026-09-07'))
  cache = mergeTimetableWeek(cache, 'u2', weekData(2, '2026-09-14'))
  assert.deepEqual(cache.weeks.map((w) => w.week), [2], '换账号应重建')
  assert.equal(cache.username, 'u2')

  cache = mergeTimetableWeek(cache, 'u2', weekData(2, '2027-03-02'))
  assert.deepEqual(cache.weeks.map((w) => w.week), [2], '换学期应重建')

  const otherMode = weekData(3, '2026-09-21')
  otherMode.mode = 'B'.repeat(32)
  cache = mergeTimetableWeek(mergeTimetableWeek(null, 'u2', weekData(1, '2026-09-07')), 'u2', otherMode)
  assert.deepEqual(cache.weeks.map((w) => w.week), [3], '换节次模式应重建')
})

test('currentTimetableWeek：按日期定位本周，不在范围内返回 undefined', () => {
  const weeks = [weekData(1, '2026-09-07'), weekData(2, '2026-09-14')]
  assert.equal(currentTimetableWeek(weeks, new Date('2026-09-16T12:00:00')), 2)
  assert.equal(currentTimetableWeek(weeks, new Date('2026-09-07T00:00:00')), 1)
  assert.equal(currentTimetableWeek(weeks, new Date('2026-12-31T00:00:00')), undefined)
})

test('groupTimetableCourses：重叠课程同组、独立课程分组、按天过滤', () => {
  const courses = [
    { ...COURSE, day: 1, start: 1, end: 2 },
    { ...COURSE, name: '大学英语', day: 1, start: 2, end: 3 },
    { ...COURSE, name: '体育', day: 3, start: 3, end: 4 },
  ]
  const monday = groupTimetableCourses(courses, 1)
  assert.equal(monday.length, 1, '节次衔接重叠的课程应同组')
  assert.equal(monday[0].end, 3)
  assert.equal(monday[0].courses.length, 2)

  const wednesday = groupTimetableCourses(courses, 3)
  assert.equal(wednesday.length, 1)
  assert.equal(wednesday[0].courses[0].name, '体育')

  assert.deepEqual(groupTimetableCourses(courses, 5), [])
})
