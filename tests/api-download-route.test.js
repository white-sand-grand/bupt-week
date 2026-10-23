import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBackend } from '../server/app.js'
import { MemorySessionStore } from '../server/storage/memory.js'

const TTL = 7 * 86400000

function makeApp() {
  const store = new MemorySessionStore()
  const app = createBackend({ getSessionStore: () => store, allowedOrigins: [] })
  return { app, store }
}

test('POST /api/ucloud/resource/download：解析成功并返回 /file 路径', async (t) => {
  const { app, store } = makeApp()
  await store.set('sid-1', {
    kind: 'ucloud',
    accessToken: 'blade-token',
    expiresAt: Date.now() + TTL,
  })

  t.mock.method(globalThis, 'fetch', async (request) =>
    new Response(
      JSON.stringify({
        code: 200,
        success: true,
        data: { previewUrl: 'https://fileucloud.bupt.edu.cn/ucloud/document/a.pdf?sig=1' },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    ),
  )

  const response = await app.request('/api/ucloud/resource/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'sid-1', resourceId: 'res-1' }),
  })

  assert.equal(response.status, 200)
  const body = await response.json()
  assert.equal(body.success, true)
  assert.equal(body.data.fileUrl, '/file/ucloud/document/a.pdf?sig=1')
})

test('POST /api/ucloud/resource/download：没有会话时 401', async () => {
  const { app } = makeApp()

  const response = await app.request('/api/ucloud/resource/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'nope', resourceId: 'res-1' }),
  })

  assert.equal(response.status, 401)
  const body = await response.json()
  assert.equal(body.success, false)
  assert.equal(body.stage, 'ucloud-auth')
})

test('POST /api/ucloud/resource/download：会话过期时 401', async () => {
  const { app, store } = makeApp()
  await store.set('sid-1', { accessToken: 't', expiresAt: Date.now() - 1 })

  const response = await app.request('/api/ucloud/resource/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'sid-1', resourceId: 'res-1' }),
  })

  assert.equal(response.status, 401)
})

test('POST /api/ucloud/resource/download：sessionId 走请求体，不进 URL', async (t) => {
  const { app, store } = makeApp()
  await store.set('sid-1', { accessToken: 't', expiresAt: Date.now() + TTL })

  let upstreamUrl = ''
  t.mock.method(globalThis, 'fetch', async (target) => {
    upstreamUrl = typeof target === 'string' ? target : target.url
    return new Response(JSON.stringify({ code: 200, data: { previewUrl: 'https://fileucloud.bupt.edu.cn/x.pdf' } }), {
      headers: { 'Content-Type': 'application/json' },
    })
  })

  await app.request('/api/ucloud/resource/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'sid-1', resourceId: 'res-1' }),
  })

  assert.equal(upstreamUrl.includes('sid-1'), false, 'sessionId 不应出现在上游 URL 里')
})

test('未注入会话存储时不挂业务接口，而不是挂上去永远 401', async () => {
  const app = createBackend({ allowedOrigins: [] })
  const response = await app.request('/api/ucloud/resource/download', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'x', resourceId: 'y' }),
  })
  assert.equal(response.status, 404)
})

test('接口响应不缓存', async () => {
  const { app } = makeApp()
  const response = await app.request('/api/health')
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
})
