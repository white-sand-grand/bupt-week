import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  BEIJING_SLOT_TIMES,
  HAINAN_SLOT_TIMES,
  hainanPeriodTime,
  periodRange,
} from '../src/utils/period-times.js'

/** 海南作息是用户口述 + 截图给的（2026-10-24），教务接口里没有——
 *  这里把关键事实固化：15 节制、上午与北京一致、下午起后移。 */
test('HAINAN_SLOT_TIMES：15 节、HH:MM 格式、节内结束晚于开始', () => {
  assert.equal(HAINAN_SLOT_TIMES.length, 15, '海南共 15 节（北京 14 节）')
  for (const [from, to] of HAINAN_SLOT_TIMES) {
    assert.match(`${from}~${to}`, /^\d{2}:\d{2}~\d{2}:\d{2}$/)
    assert.ok(from < to, `${from} 应早于 ${to}`)
  }
})

test('hainanPeriodTime：节次号查表，越界返回空串', () => {
  assert.equal(hainanPeriodTime(1), '08:00~08:45', '第 1 节与北京一致')
  assert.equal(hainanPeriodTime(7), '14:00~14:45', '第 7 节海南 14:00 开课（北京 13:50）')
  assert.equal(hainanPeriodTime(15), '21:10~21:55', '第 15 节是海南特有')
  assert.equal(hainanPeriodTime(16), '')
  assert.equal(hainanPeriodTime(0), '')
})

test('BEIJING_SLOT_TIMES：14 节，与后端 SLOT_TIMES 同源', () => {
  assert.equal(BEIJING_SLOT_TIMES.length, 14)
  assert.deepEqual(BEIJING_SLOT_TIMES[0], ['08:00', '08:45'])
  assert.deepEqual(BEIJING_SLOT_TIMES[6], ['13:50', '14:35'], '第 7 节北京 13:50')
  assert.deepEqual(BEIJING_SLOT_TIMES[13], ['20:10', '20:55'])
})

test('periodRange：首节上课到末节下课，两校区分开；越界侧降级空串', () => {
  // 第 3-5 节：两地上午相同（09:50 上课，第 5 节 12:15 下课）
  assert.deepEqual(periodRange(3, 5), { bj: '09:50-12:15', hn: '09:50-12:15' })
  // 第 7 节单节：北京 13:50-14:35，海南 14:00-14:45
  assert.deepEqual(periodRange(7, 7), { bj: '13:50-14:35', hn: '14:00-14:45' })
  // 第 10-12 节晚课：区间两端都取正确
  assert.deepEqual(periodRange(10, 12), { bj: '16:35-19:15', hn: '16:40-19:05' })
  // 第 15 节只有海南有；第 0/16 节两侧都空
  assert.deepEqual(periodRange(15, 15), { bj: '', hn: '21:10-21:55' })
  assert.deepEqual(periodRange(0, 2), { bj: '', hn: '' })
  assert.deepEqual(periodRange(16, 16), { bj: '', hn: '' })
})
