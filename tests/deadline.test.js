import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  beijingTimestamp,
  deadlineProgress,
  formatCountdown,
  getDaysLeft,
  groupByCourse,
  isCurrentTerm,
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

test('deadlineProgress：有发布时间时按真实区间算，夹在 0..1', () => {
  // 10-18 12:00 发布 → 10-24 12:00 截止，正好走了 6/7 天 = 6/7
  assert.ok(Math.abs(deadlineProgress('2026-10-18 12:00:00', '2026-10-25 12:00:00', NOW) - 6 / 7) < 1e-9)
  // 发布在将来：夹到 0
  assert.equal(deadlineProgress('2026-10-30 12:00:00', '2026-11-06 12:00:00', NOW), 0)
  // 已过期：夹到 1
  assert.equal(deadlineProgress('2026-10-10 12:00:00', '2026-10-12 12:00:00', NOW), 1)
})

test('deadlineProgress：发布时间缺失时回退 7 天窗口（实测 38/38 条 beginTime 为空）', () => {
  // 截止 7 天后 → 0（还没进入临近截止带）
  assert.equal(deadlineProgress('', '2026-10-31 12:00:00', NOW), 0)
  // 截止 3 天后 → 已填 4/7
  assert.ok(Math.abs(deadlineProgress(undefined, '2026-10-27 12:00:00', NOW) - 4 / 7) < 1e-9)
  // 截止就是现在 → 1
  assert.equal(deadlineProgress(undefined, '2026-10-24 12:00:00', NOW), 1)
})

test('deadlineProgress：垃圾输入返回 null，不画条', () => {
  assert.equal(deadlineProgress('', '', NOW), null)
  assert.equal(deadlineProgress('2026-10-01 12:00:00', 'not a date', NOW), null)
  // 截止早于发布：区间不合法
  assert.equal(deadlineProgress('2026-10-10 12:00:00', '2026-10-09 12:00:00', NOW), null)
  // 日历上不存在的截止日期（2 月 30 日，beijingTimestamp 显式拒收）→ 不画；
  // 但垃圾「发布时间」走 7 天回退是设计行为，不算垃圾输入
  assert.equal(deadlineProgress('2026-10-01 12:00:00', '2026-02-30 12:00:00', NOW), null)
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

test('formatCountdown：距截止精确到分钟，零值单位不拼接', () => {
  // NOW = 2026-10-24 12:00 北京时间
  assert.equal(formatCountdown('2026-10-26 15:15:00', NOW), '距截止 2天3小时15分')
  assert.equal(formatCountdown('2026-10-24 15:00:00', NOW), '距截止 3小时')
  assert.equal(formatCountdown('2026-10-24 12:30:00', NOW), '距截止 30分')
  // 不足 1 分钟也有说法，不出空串也不出「距截止 」
  assert.equal(formatCountdown('2026-10-24 12:00:30', NOW), '距截止 不足1分钟')
  // 已过截止 / 解析不了：不显示
  assert.equal(formatCountdown('2026-10-24 11:00:00', NOW), '')
  assert.equal(formatCountdown('', NOW), '')
  assert.equal(formatCountdown('garbage', NOW), '')
})

test('isCurrentTerm：截止过宽限期 60 天算往期，解析不了的一律保留', () => {
  // NOW = 2026-10-24；过 60 天 ≈ 2026-08-25 之前
  assert.equal(isCurrentTerm(normalizeAssignment({ assignmentEndTime: '2026-10-28 23:59:00' }, NOW)), true)
  assert.equal(isCurrentTerm(normalizeAssignment({ assignmentEndTime: '2026-08-26 23:59:00' }, NOW)), true, '宽限期内保留')
  assert.equal(isCurrentTerm(normalizeAssignment({ assignmentEndTime: '2026-06-01 23:59:00' }, NOW)), false, '超宽限期滤掉')
  assert.equal(isCurrentTerm(normalizeAssignment({ assignmentEndTime: 'garbage' }, NOW)), true, '解析不了不误杀')
})
