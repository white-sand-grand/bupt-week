import { test } from 'node:test'
import assert from 'node:assert/strict'
import { formatUpdatedAt, formatBytes } from '../src/utils/format.js'

// 北京时间 2026-10-24 21:00（UTC 13:00）作为「现在」
const NOW = new Date('2026-10-24T13:00:00Z')

function iso(beijingWallClock) {
  // 北京墙上钟（无时区）→ ISO：北京 = UTC+8
  return `${beijingWallClock}:00+08:00`
}

test('今天内 → 「今天 HH:mm」', () => {
  assert.equal(formatUpdatedAt(iso('2026-10-24T08:05'), NOW), '今天 08:05')
  assert.equal(formatUpdatedAt(iso('2026-10-24T23:59'), NOW), '今天 23:59')
})

test('昨天 → 「昨天 HH:mm」；更早 → 「M月D日 HH:mm」', () => {
  assert.equal(formatUpdatedAt(iso('2026-10-23T22:30'), NOW), '昨天 22:30')
  assert.equal(formatUpdatedAt(iso('2026-10-20T09:15'), NOW), '10月20日 09:15')
  // 跨月、跨年的往年日期
  assert.equal(formatUpdatedAt(iso('2025-12-30T11:00'), NOW), '12月30日 11:00')
})

test('空值/非法值返回空串（宁可不显示，不显示垃圾）', () => {
  assert.equal(formatUpdatedAt(null, NOW), '')
  assert.equal(formatUpdatedAt('', NOW), '')
  assert.equal(formatUpdatedAt('not-a-date', NOW), '')
})

test('设备在别的时区也不影响：一律按北京时间展示', () => {
  // UTC 2026-10-24 17:30 = 北京 10-25 01:30，对 NOW（北京 10-24 21:00）来说是「明天」→ 落日期格式
  assert.equal(formatUpdatedAt('2026-10-24T17:30:00Z', NOW), '10月25日 01:30')
})

test('formatBytes：进制与位数', () => {
  assert.equal(formatBytes(0), '0 B')
  assert.equal(formatBytes(1023), '1023 B')
  assert.equal(formatBytes(1024), '1.0 KB')
  assert.equal(formatBytes(1536), '1.5 KB')
  assert.equal(formatBytes(7.25 * 1024 * 1024), '7.3 MB')
  assert.equal(formatBytes(75 * 1024 * 1024), '75 MB')
  assert.equal(formatBytes(2.5 * 1024 ** 3), '2.5 GB')
})

test('formatBytes：非法值返回空串', () => {
  assert.equal(formatBytes(undefined), '')
  assert.equal(formatBytes(-1), '')
  assert.equal(formatBytes(Number.NaN), '')
})
