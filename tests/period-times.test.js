import { test } from 'node:test'
import assert from 'node:assert/strict'
import { HAINAN_SLOT_TIMES, hainanPeriodTime } from '../src/utils/period-times.js'

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
