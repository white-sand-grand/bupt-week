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

async function seedSession(store) {
  await store.set('sid-1', {
    kind: 'ucloud',
    accessToken: 'blade-token',
    userId: '2021001234',
    expiresAt: Date.now() + TTL,
  })
}

function mockUpstream(t, handler) {
  t.mock.method(globalThis, 'fetch', handler)
}

test('POST /api/ucloud/courses：返回课程列表', async (t) => {
  const { app, store } = makeApp()
  await seedSession(store)

  mockUpstream(t, async () =>
    new Response(
      JSON.stringify({
        code: 200,
        success: true,
        data: { records: [{ id: 101, siteName: '高等数学' }, { id: 102, siteName: '大学物理' }] },
      }),
      { headers: { 'Content-Type': 'application/json' } },
    ),
  )

  const response = await app.request('/api/ucloud/courses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'sid-1' }),
  })

  assert.equal(response.status, 200)
  const body = await response.json()
  assert.deepEqual(body.data.courses, [
    { id: '101', name: '高等数学' },
    { id: '102', name: '大学物理' },
  ])
})

test('POST /api/ucloud/courses：无会话 401', async () => {
  const { app } = makeApp()
  const response = await app.request('/api/ucloud/courses', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'nope' }),
  })
  assert.equal(response.status, 401)
})

test('POST /api/ucloud/courseware：userId 从会话取，不信任前端传值', async (t) => {
  const { app, store } = makeApp()
  await seedSession(store)

  let upstreamUrl = ''
  mockUpstream(t, async (target) => {
    upstreamUrl = typeof target === 'string' ? target : target.url
    return new Response(JSON.stringify({ code: 200, success: true, data: [] }), {
      headers: { 'Content-Type': 'application/json' },
    })
  })

  const response = await app.request('/api/ucloud/courseware', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    // 故意带一个伪造的 userId：必须被忽略，用会话里的 2021001234
    body: JSON.stringify({ sessionId: 'sid-1', siteId: 'site-9', userId: 'hacker' }),
  })

  assert.equal(response.status, 200)
  const body = await response.json()
  assert.deepEqual(body.data.tree, [])
  assert.match(upstreamUrl, /userId=2021001234/)
  assert.doesNotMatch(upstreamUrl, /hacker/)
})

test('POST /api/ucloud/courseware：缺 siteId 报 400', async () => {
  const { app, store } = makeApp()
  await seedSession(store)

  const response = await app.request('/api/ucloud/courseware', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'sid-1' }),
  })
  assert.equal(response.status, 400)
})

test('POST /api/ucloud/courseware：无会话 401 且带 stage', async () => {
  const { app } = makeApp()
  const response = await app.request('/api/ucloud/courseware', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'nope', siteId: 's' }),
  })
  assert.equal(response.status, 401)
  assert.equal((await response.json()).stage, 'ucloud-auth')
})
