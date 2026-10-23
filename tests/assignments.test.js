import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBackend } from '../server/app.js'
import { MemorySessionStore } from '../server/storage/memory.js'
import { getAssignmentDetail, listAssignments } from '../server/services/assignments.js'

/**
 * 作业服务与路由。接口形状按 docs/api-reference.md §2.3–2.4（【实测】）mock。
 */

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function makeApp() {
  const store = new MemorySessionStore()
  const app = createBackend({ getSessionStore: () => store, allowedOrigins: [] })
  return { app, store }
}

function post(app, path, body) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// ── 服务层 ──────────────────────────────────────────────────────────────────

test('listAssignments：POST student/list，不带 siteId，透传 records', async (t) => {
  let seen = {}
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    seen = { url: String(url), method: options.method, body: options.body, headers: options.headers }
    return json({ code: 200, success: true, data: { records: [{ id: 'a1' }, { id: 'a2' }] } })
  })

  const records = await listAssignments({ token: 'tk' })

  assert.deepEqual(records, [{ id: 'a1' }, { id: 'a2' }])
  assert.ok(seen.url.includes('/ykt-site/work/student/list'))
  assert.equal(seen.method, 'POST')
  assert.equal(JSON.parse(seen.body).siteId, undefined, '不传 siteId 才是全量')
  assert.equal(seen.headers['Blade-Auth'], 'tk')
})

test('getAssignmentDetail：参数名是单数 assignmentId，附件元数据被提取', async (t) => {
  let seenUrl = ''
  t.mock.method(globalThis, 'fetch', async (url) => {
    seenUrl = String(url)
    return json({
      code: 200,
      success: true,
      data: {
        assignmentResource: [
          { resourceId: 'r1', resourceName: '实验指导书.pdf', resourceType: 'pdf' },
          { resourceId: '', resourceName: '坏的' },
          { resourceName: '没有 ID 的' },
        ],
      },
    })
  })

  const detail = await getAssignmentDetail({ token: 'tk', assignmentId: 'A-99' })

  assert.ok(seenUrl.includes('work/detail?assignmentId=A-99'), seenUrl)
  assert.deepEqual(detail.attachments, [
    { resourceId: 'r1', resourceName: '实验指导书.pdf', resourceType: 'pdf' },
    { resourceId: '', resourceName: '坏的', resourceType: '' },
  ].filter((item) => item.resourceId))
  assert.equal(detail.attachments.length, 1, '空 resourceId 应被过滤')
})

test('上游 401 映射为会话过期，而不是 502', async (t) => {
  t.mock.method(globalThis, 'fetch', async () => json({ msg: 'token 过期' }, 401))
  await assert.rejects(
    () => listAssignments({ token: 'expired' }),
    (error) => error.status === 401 && error.stage === 'ucloud-auth',
  )
})

// ── 路由 ────────────────────────────────────────────────────────────────────

test('POST /api/ucloud/assignments：返回全量列表', async (t) => {
  const { app, store } = makeApp()
  await store.set('uc', { kind: 'ucloud', accessToken: 'tk', expiresAt: Date.now() + 86400000 })
  t.mock.method(globalThis, 'fetch', async () =>
    json({ code: 200, success: true, data: { records: [{ id: 'a1', assignmentTitle: '第一次作业' }] } }),
  )

  const response = await post(app, '/api/ucloud/assignments', { sessionId: 'uc' })
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(body.data.assignments[0].assignmentTitle, '第一次作业')
})

test('POST /api/ucloud/assignments：教务会话/无会话都返回 401', async () => {
  const { app, store } = makeApp()
  await store.set('jw', { kind: 'jwgl', cookies: 'x', expiresAt: Date.now() + 86400000 })

  assert.equal((await post(app, '/api/ucloud/assignments', { sessionId: 'jw' })).status, 401)
  assert.equal((await post(app, '/api/ucloud/assignments', { sessionId: 'nope' })).status, 401)
})

test('POST /api/ucloud/assignment/detail：缺 assignmentId 报 400', async () => {
  const { app, store } = makeApp()
  await store.set('uc', { kind: 'ucloud', accessToken: 'tk', expiresAt: Date.now() + 86400000 })
  assert.equal((await post(app, '/api/ucloud/assignment/detail', { sessionId: 'uc' })).status, 400)
})
