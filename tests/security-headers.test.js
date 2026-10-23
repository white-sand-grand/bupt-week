import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBackend } from '../server/app.js'
import { MemorySessionStore } from '../server/storage/memory.js'

/**
 * 响应头安全基线。这些断言是门禁（npm run gate → security）里
 * 「起真实应用探响应头」那条的单元层快照，改这里要同步改门禁脚本。
 */

function makeApp() {
  const store = new MemorySessionStore()
  const app = createBackend({ getSessionStore: () => store, allowedOrigins: [] })
  return app
}

test('API 响应头基线：no-store + nosniff + no-referrer，不带 X-Powered-By', async () => {
  const app = makeApp()
  const response = await app.request('/api/health')
  assert.equal(response.status, 200)
  assert.equal(response.headers.get('Cache-Control'), 'no-store', '接口不得被任何代理层缓存')
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff', '关闭 MIME 嗅探')
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer', '接口域名不外泄到下游 Referer')
  assert.equal(response.headers.get('X-Powered-By'), null, '不暴露实现栈')
  assert.equal(response.headers.get('Server'), null)
})

test('404 与 500 路径同样带头（中间件对所有 /api/* 生效）', async () => {
  const app = makeApp()
  const notFound = await app.request('/api/not-exist')
  assert.equal(notFound.status, 404)
  assert.equal(notFound.headers.get('Cache-Control'), 'no-store')
  assert.equal(notFound.headers.get('X-Content-Type-Options'), 'nosniff')
  assert.equal(notFound.headers.get('Referrer-Policy'), 'no-referrer')

  const body = await notFound.json()
  assert.deepEqual(body, { success: false, msg: '接口不存在' })
})
