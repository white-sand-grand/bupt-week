import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  beijingTimestamp,
  getDaysLeft,
  groupByCourse,
  isRecordCompleted,
  normalizeAssignment,
  sortAssignments,
} from '../src/utils/deadline.js'

/**
 * 截止时间分级、北京时间解释、排序语义。
 * 无论测试进程跑在哪个时区，结果都必须一致——这就是时区规范化的意义。
 */

const NOW = Date.parse('2026-10-24T12:00:00+08:00')

test('beijingTimestamp：无时区串按 +08:00 解释，不随设备时区漂移', () => {
  // 2026-10-24 23:59:00 北京时间，无论进程 TZ 是什么都应是同一个时刻
  assert.equal(beijingTimestamp('2026-10-24 23:59:00'), Date.parse('2026-10-24T23:59:00+08:00'))
  assert.equal(beijingTimestamp('2026-10-24T23:59'), Date.parse('2026-10-24T23:59:00+08:00'))
  assert.equal(beijingTimestamp('2026-10-24T23:59:30'), Date.parse('2026-10-24T23:59:30+08:00'))
  // 带时区的串原样解析
  assert.equal(beijingTimestamp('2026-10-24T23:59:00Z'), Date.parse('2026-10-24T23:59:00Z'))
  assert.ok(Number.isNaN(beijingTimestamp('not a date')))
})

test('getDaysLeft：以北京时间为基准的天数差', () => {
  assert.equal(getDaysLeft('2026-10-24 23:59:00', NOW), 0)
  assert.equal(getDaysLeft('2026-10-25 23:59:00', NOW), 1)
  assert.equal(getDaysLeft('2026-10-23 23:59:00', NOW), -1)
  assert.equal(getDaysLeft('', NOW), null)
})

test('isRecordCompleted：submitTime 优先，assignmentStatus 次之（99=未提交）', () => {
  assert.equal(isRecordCompleted({ submitTime: '2026-10-20 10:00:00' }), true)
  assert.equal(isRecordCompleted({ assignmentStatus: 99 }), false)
  assert.equal(isRecordCompleted({ assignmentStatus: 0 }), true)
  assert.equal(isRecordCompleted({ assignmentStatus: 1 }), true)
  assert.equal(isRecordCompleted({}), false)
})

test('normalizeAssignment：分级与状态文案', () => {
  const base = { id: 'a1', siteId: 's1', siteName: '数据结构', assignmentTitle: '实验一' }

  const danger = normalizeAssignment({ ...base, assignmentEndTime: '2026-10-24 23:59:00' }, NOW)
  assert.equal(danger.level, 'danger')
  assert.equal(danger.status, '今天截止')

  const overdue = normalizeAssignment({ ...base, assignmentEndTime: '2026-10-20 23:59:00' }, NOW)
  assert.equal(overdue.level, 'overdue')
  assert.equal(overdue.status, '已截止未交')

  const submitted = normalizeAssignment({ ...base, assignmentEndTime: '2026-10-20 23:59:00', submitTime: '2026-10-19 09:00:00' }, NOW)
  assert.equal(submitted.level, 'submitted')
  assert.equal(submitted.status, '已提交')

  // 无课程归属且截止超过 60 天 → 往期未交，不催促
  const missed = normalizeAssignment({ assignmentEndTime: '2026-06-01 23:59:00' }, NOW)
  assert.equal(missed.level, 'missed')
  assert.equal(missed.status, '往期未交')
})

test('sortAssignments：逾期 → 紧急 → 一周内 → 待完成 → 已提交 → 往期未交', () => {
  const items = [
    { id: 'normal', assignmentEndTime: '2026-12-30 23:59:00' },
    { id: 'missed', assignmentEndTime: '2026-05-01 23:59:00' },
    { id: 'danger', assignmentEndTime: '2026-10-24 23:59:00' },
    { id: 'done', assignmentEndTime: '2026-10-20 23:59:00', submitTime: '2026-10-19 09:00:00' },
    { id: 'overdue-new', assignmentEndTime: '2026-10-23 23:59:00' },
    { id: 'overdue-old', assignmentEndTime: '2026-10-01 23:59:00' },
    { id: 'warning', assignmentEndTime: '2026-10-28 23:59:00' },
  ].map((record) => normalizeAssignment(record, NOW))

  const ordered = sortAssignments(items).map((item) => item.id)

  // 已逾期的倒序：刚过期的在前
  assert.deepEqual(ordered, ['overdue-new', 'overdue-old', 'danger', 'warning', 'normal', 'done', 'missed'])
})

test('groupByCourse：按课程分组并保持顺序', () => {
  const items = [
    { courseId: 's1', courseName: '数据结构' },
    { courseId: 's2', courseName: '操作系统' },
    { courseId: 's1', courseName: '数据结构' },
  ]

  const groups = groupByCourse(items)
  assert.deepEqual(groups.map((g) => g.courseName), ['数据结构', '操作系统'])
  assert.equal(groups[0].items.length, 2)
})
