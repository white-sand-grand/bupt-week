import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBackend } from '../server/app.js'
import { MemorySessionStore } from '../server/storage/memory.js'
import { getAssignmentDetail, listAssignments, listAssignmentsWithCourses } from '../server/services/assignments.js'

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

// ── 课程名映射（列表接口实测不带 siteId/siteName，见 docs/api-reference §2.3）──

/** 按 URL 特征分流的作业上游 mock：全量列表 / 课程列表 / 按课程列表。 */
function mockCourseUpstream({ coursesFail = false, oneCourseFails = false } = {}) {
  return async (url, options = {}) => {
    const target = String(url)
    const body = options.body ? JSON.parse(options.body) : {}
    if (target.includes('/work/student/list')) {
      if (!body.siteId) {
        return json({ code: 200, success: true, data: { records: [{ id: 'a1' }, { id: 'a2' }, { id: 'a3' }] } })
      }
      if (body.siteId === 'c1' && oneCourseFails) return json({ msg: 'boom' }, 500)
      const byCourse = {
        c1: [{ id: 'a1' }, { id: 'a9' }],
        c2: [{ id: 'a2' }],
      }
      return json({ code: 200, success: true, data: { records: byCourse[body.siteId] || [] } })
    }
    if (target.includes('/site/list/student')) {
      if (coursesFail) return json({ msg: 'course list boom' }, 500)
      return json({
        code: 200,
        success: true,
        data: { records: [{ id: 'c1', siteName: '设计思维' }, { id: 'c2', name: '数据结构' }] },
      })
    }
    return json({ code: 200, success: true, data: {} })
  }
}

test('listAssignmentsWithCourses：按课程回填 siteId/siteName，全量记录保底', async (t) => {
  t.mock.method(globalThis, 'fetch', mockCourseUpstream())

  const records = await listAssignmentsWithCourses({ token: 'tk', userId: 'u1' })

  const byId = new Map(records.map((record) => [String(record.id), record]))
  assert.equal(byId.get('a1').siteId, 'c1')
  assert.equal(byId.get('a1').siteName, '设计思维')
  assert.equal(byId.get('a2').siteId, 'c2')
  assert.equal(byId.get('a2').siteName, '数据结构')
  // a3 不属于任何当前课程：保留全量记录，课程信息留空（退化为未知课程）
  assert.equal(byId.get('a3').siteId, undefined)
  // a9 只在按课程列表里出现，不混进全量结果
  assert.equal(byId.has('a9'), false)
})

test('listAssignmentsWithCourses：课程列表失败时退化为无课程名，不整体失败', async (t) => {
  t.mock.method(globalThis, 'fetch', mockCourseUpstream({ coursesFail: true }))

  const records = await listAssignmentsWithCourses({ token: 'tk', userId: 'u1' })

  assert.equal(records.length, 3)
  assert.equal(records[0].siteId, undefined)
})

test('listAssignmentsWithCourses：单课程失败只丢那一门的名字', async (t) => {
  t.mock.method(globalThis, 'fetch', mockCourseUpstream({ oneCourseFails: true }))

  const records = await listAssignmentsWithCourses({ token: 'tk', userId: 'u1' })

  const byId = new Map(records.map((record) => [String(record.id), record]))
  assert.equal(byId.get('a2').siteName, '数据结构')
  assert.equal(byId.get('a1').siteId, undefined, 'c1 失败，a1 拿不到课程名')
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
