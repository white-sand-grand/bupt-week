import { test } from 'node:test'
import assert from 'node:assert/strict'
import { friendlyError } from '../src/utils/errors.js'

/** 后端约定：ApiError 带 status，msg 是给人看的中文。
 *  client.js 顶层读 import.meta.env（Vite 专属），node 里导不进来；
 *  映射逻辑只认 name/status/message，本地造同形状的类即可。 */
class ApiError extends Error {
  constructor(message, { status } = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
  }
}

test('网络层 TypeError → 人话（不透 Failed to fetch）', () => {
  assert.equal(
    friendlyError(new TypeError('Failed to fetch'), { online: true }),
    '网络连接失败，请检查网络后重试',
  )
  assert.equal(
    friendlyError(new TypeError('fetch failed'), { online: true }),
    '网络连接失败，请检查网络后重试',
  )
})

test('离线优先：即使异常是别的，也如实说离线', () => {
  assert.equal(
    friendlyError(new ApiError('请求失败（HTTP 500）', { status: 500 }), { online: false }),
    '当前处于离线状态，联网后即可获取最新数据',
  )
})

test('ApiError 401 → 提示重新登录', () => {
  assert.equal(
    friendlyError(new ApiError('云邮登录已过期，请重新登录', { status: 401 }), { online: true }),
    '登录已过期，请退出后重新登录',
  )
})

test('服务端给了人话 msg 就透传（含 5xx），不被泛化覆盖', () => {
  assert.equal(
    friendlyError(new ApiError('教务系统暂时无法访问', { status: 502 }), { online: true }),
    '教务系统暂时无法访问',
  )
})

test('client.js 的兜底拼接「请求失败（HTTP xxx）」补上行动建议', () => {
  assert.equal(
    friendlyError(new ApiError('请求失败（HTTP 503）', { status: 503 }), { online: true }),
    '请求失败（HTTP 503），请稍后重试',
  )
  assert.equal(
    friendlyError(new ApiError('', { status: 500 }), { online: true }),
    '请求失败（HTTP 500），请稍后重试',
  )
})

test('取消与未知异常的兜底', () => {
  const abort = new Error('signal is aborted without reason')
  abort.name = 'AbortError'
  assert.equal(friendlyError(abort, { online: true }), '请求已取消，请重试')

  assert.equal(friendlyError(new Error('云邮返回了空数据'), { online: true }), '云邮返回了空数据')
  assert.equal(friendlyError({}, { online: true }), '出了点问题，请稍后重试')
  assert.equal(friendlyError(null, { online: true }), '出了点问题，请稍后重试')
})
