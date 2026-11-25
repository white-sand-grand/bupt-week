import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBackend } from '../server/app.js'
import { MemorySessionStore } from '../server/storage/memory.js'

const ALL_SCOPES = ['classes:read', 'classes:create', 'classes:join', 'assignments:read', 'assignments:create', 'sources:read', 'sources:create']
const ASSIGNMENT = { title: '第三次作业', subject: '概率论', content: '完成课后第 1、4、8 题', deadline: '2026-11-29T23:59:00+08:00' }

async function setup() {
  const sessions = new MemorySessionStore()
  const records = new MemorySessionStore()
  for (const user of ['alice', 'bob', 'mallory']) await sessions.set(user, { kind: 'ucloud', username: user, expiresAt: Date.now() + 3600000 })
  const app = createBackend({ getSessionStore: () => sessions, getClassStore: () => records, allowedOrigins: ['https://example.org'] })
  const web = async (path, input = {}, user = 'alice') => {
    const response = await app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ sessionId: user, ...input }) })
    return { status: response.status, body: await response.json() }
  }
  const create = await web('/api/classes/create', { name: '测试班级', password: 'class-test-pass' })
  const cls = create.body.data
  const mint = async (input = {}, user = 'alice') => {
    const result = await web('/api/agent/keys/create', { name: '通知助手', classIds: [cls.classId], days: 30,
      scopes: ['classes:read', 'assignments:read', 'assignments:create', 'sources:read', 'sources:create'], ...input }, user)
    assert.equal(result.status, 200, JSON.stringify(result.body))
    return result.body.data
  }
  const call = async (key, path = '/me', input, id = crypto.randomUUID()) => {
    const response = await app.request(`/api/agent/v1${path}`, { method: input === undefined ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json', ...(id ? { 'Idempotency-Key': id } : {}) },
      ...(input === undefined ? {} : { body: JSON.stringify(input) }),
    })
    return { status: response.status, body: await response.json(), headers: response.headers }
  }
  return { app, sessions, records, web, mint, call, cls, assignmentsPath: `/classes/${cls.classId}/assignments` }
}

test('Key：只生成时回传完整密钥，存摘要；签发与撤销必须属于已登录本人', async () => {
  const { records, mint, web, call } = await setup()
  const { key, grant } = await mint()
  assert.match(key, /^bwk_[0-9a-f-]{36}\.[0-9a-f]{64}$/)
  const stored = await records.get(`agent:key:${grant.id}`)
  assert.equal(stored.hash.length, 64)
  assert.equal(JSON.stringify([...records.map]).includes(key), false)
  assert.equal(JSON.stringify([...records.map]).includes('class-test-pass'), false)
  const listed = await web('/api/agent/keys/list')
  assert.equal(JSON.stringify(listed.body).includes('hash'), false)
  assert.equal(JSON.stringify(listed.body).includes(key), false)
  assert.equal((await web('/api/agent/keys/create', { name: 'x' }, 'not-logged-in')).status, 401)
  assert.equal((await web('/api/agent/keys/revoke', { id: grant.id }, 'bob')).status, 404)
  assert.equal((await call(key)).status, 200)
  assert.equal((await call(key.slice(0, -1) + (key.endsWith('0') ? '1' : '0'))).status, 401)
  assert.equal((await web('/api/agent/keys/revoke', { id: grant.id })).status, 200)
  assert.equal((await call(key)).status, 401)
})

test('API 不接受学校账号密码，不可用 Agent Key 签发新 Key 或读取学校接口', async () => {
  const { mint, call, app } = await setup()
  const { key } = await mint()
  const invalid = await call(key, '/classes', { username: 'someone', password: 'school-password', name: 'x' })
  assert.equal(invalid.status, 400)
  const denied = await app.request('/api/agent/keys/create', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: JSON.stringify({ name: 'x' }) })
  assert.equal(denied.status, 401)
  const upstream = await app.request('/api/ucloud/courses', { method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' }, body: '{}' })
  assert.equal(upstream.status, 401)
})

test('指定班级：列表过滤，不能越权到其他班级，权限与成员身份取交集', async () => {
  const { mint, web, call, records, cls, assignmentsPath } = await setup()
  const other = (await web('/api/classes/create', { name: '另一个班', password: 'class-test-pass' })).body.data
  const { key } = await mint()
  assert.equal((await call(key, '/classes')).body.data.classes.length, 1)
  assert.equal((await call(key, `/classes/${other.classId}/assignments`)).status, 404)
  assert.equal((await call(key, '/classes', { name: '越权', password: 'test-pass' })).status, 403)
  const readOnly = await mint({ scopes: ['assignments:read'] })
  assert.equal((await call(readOnly.key, assignmentsPath, ASSIGNMENT)).status, 403)
  await records.set(`class:${cls.classId}:members`, { members: ['bob'], expiresAt: Date.now() + 3600000 })
  assert.equal((await call(key, assignmentsPath)).status, 403)
})

test('账号范围：Agent 可创建和加入班级；建班幂等，不落密码明文', async () => {
  const { mint, call, records, web } = await setup()
  const { key } = await mint({ classIds: null, scopes: ALL_SCOPES })
  const body = { name: '由 Agent 创建', password: 'another-class-pass' }
  const first = await call(key, '/classes', body, 'create-once')
  const repeated = await call(key, '/classes', body, 'create-once')
  assert.equal(first.status, 201)
  assert.equal(repeated.status, 200)
  assert.equal(first.body.data.classId, repeated.body.data.classId)
  assert.equal(JSON.stringify([...records.map]).includes(body.password), false)
  const other = (await web('/api/classes/create', { name: 'Bob 的班', password: 'bob-class-pass' }, 'bob')).body.data
  const bad = await call(key, '/classes/join', { code: other.code, password: 'wrong-pass' })
  assert.equal(bad.status, 403)
  assert.equal(bad.body.code, 'CLASS_JOIN_DENIED')
  const joined = await call(key, '/classes/join', { code: other.code.toLowerCase(), password: 'bob-class-pass' })
  assert.equal(joined.status, 201)
  assert.equal((await call(key, '/classes')).body.data.classes.length, 3)
})

test('预览不创建作业、不消费幂等键；时间换算与网页数据一致，显示 Agent 来源', async () => {
  const { mint, call, web, cls, assignmentsPath, records } = await setup()
  const { key, grant } = await mint()
  const preview = await call(key, assignmentsPath, { ...ASSIGNMENT, deadline: '2026-11-29T15:59:00Z', dryRun: true }, 'one')
  assert.equal(preview.status, 200)
  assert.equal(preview.body.data.deadline, ASSIGNMENT.deadline)
  assert.equal((await call(key, assignmentsPath)).body.data.assignments.length, 0)
  const saved = await call(key, assignmentsPath, ASSIGNMENT, 'one')
  assert.equal(saved.status, 201)
  const listed = await web('/api/classes/assignments', { classId: cls.classId })
  assert.equal(listed.body.data.assignments[0].assignmentEndTime, '2026-11-29 23:59')
  assert.equal(listed.body.data.assignments[0].createdVia, 'agent')
  assert.equal(listed.body.data.assignments[0].automationName, grant.name)
  const audit = await records.get('agent:audit:alice')
  assert.equal(JSON.stringify(audit).includes(ASSIGNMENT.content), false)
  assert.equal(JSON.stringify(audit).includes(key), false)
})

test('截止时间：拒绝无时区、不存在的日期、非法时分及秒；允许留空', async () => {
  const { mint, call, assignmentsPath } = await setup()
  const { key } = await mint()
  for (const deadline of ['2026-02-30T12:00:00+08:00', '2026-11-29 23:59', '2026-11-29T24:00:00Z', '2026-11-29T23:59:01Z', '2026-11-29T12:00:00+14:30']) {
    assert.equal((await call(key, assignmentsPath, { ...ASSIGNMENT, deadline, dryRun: true })).status, 400, deadline)
  }
  assert.equal((await call(key, assignmentsPath, { ...ASSIGNMENT, deadline: null })).body.data.deadline, null)
})

test('重试：并发同键只创建一条，键冲突 409，externalId 跨 Key 去重', async () => {
  const { mint, call, assignmentsPath } = await setup()
  const { key } = await mint()
  const body = { ...ASSIGNMENT, externalId: 'notice-123' }
  const replies = await Promise.all(Array.from({ length: 6 }, () => call(key, assignmentsPath, body, 'same-operation')))
  assert.equal(replies.filter((reply) => reply.status === 201).length, 1)
  assert.equal(new Set(replies.map((reply) => reply.body.data.assignmentId)).size, 1)
  assert.equal((await call(key, assignmentsPath, { ...body, title: '内容变了' }, 'same-operation')).status, 409)
  const another = await mint()
  const replay = await call(another.key, assignmentsPath, body, 'new-key')
  assert.equal(replay.status, 200)
  assert.equal((await call(another.key, assignmentsPath, { ...body, content: '变更内容' }, 'external-conflict')).body.code, 'EXTERNAL_ID_CONFLICT')
  assert.equal((await call(key, assignmentsPath)).body.data.assignments.length, 1)
})

test('网页和 Agent 并发写入，不互相覆盖；撤销后不能重放成功响应', async () => {
  const { mint, call, web, cls, assignmentsPath } = await setup()
  const { key, grant } = await mint()
  await Promise.all([
    call(key, assignmentsPath, ASSIGNMENT, 'saved'),
    web('/api/classes/assignment/add', { classId: cls.classId, title: '网页作业', subject: '物理', content: '完成习题' }),
    call(key, assignmentsPath, { ...ASSIGNMENT, title: '另一条通知' }),
  ])
  assert.equal((await call(key, assignmentsPath)).body.data.assignments.length, 3)
  await web('/api/agent/keys/revoke', { id: grant.id })
  assert.equal((await call(key, assignmentsPath, ASSIGNMENT, 'saved')).status, 401)
})

test('Key 过期、撤销全部、浏览器会话失效互不混淆', async () => {
  const { mint, records, sessions, call, web } = await setup()
  const expired = await mint()
  const record = await records.get(`agent:key:${expired.grant.id}`)
  await records.set(`agent:key:${expired.grant.id}`, { ...record, expiresAt: Date.now() - 1 })
  assert.equal((await call(expired.key)).status, 401)
  const active = await mint()
  await sessions.delete('alice')
  assert.equal((await call(active.key)).status, 200)
  await sessions.set('alice', { kind: 'ucloud', username: 'alice', expiresAt: Date.now() + 60_000 })
  await web('/api/agent/keys/revoke', { id: 'all' })
  assert.equal((await call(active.key)).status, 401)
})

test('班级链接源：Agent 保存后网页可见，不访问上游；去重和移除权限正确', async () => {
  const { mint, call, web, cls } = await setup()
  const { key } = await mint()
  const path = `/classes/${cls.classId}/sources`
  const originalFetch = globalThis.fetch
  globalThis.fetch = () => { throw new Error('普通链接不应请求网络') }
  try {
    const input = { type: 'link', url: 'https://example.org/course?a=1#notes', name: '课程资料' }
    const first = await call(key, path, input, 'source-once')
    assert.equal(first.status, 201)
    assert.equal(first.body.data.source.url, 'https://example.org/course?a=1')
    const repeated = await call(key, path, { ...input, url: 'https://EXAMPLE.org/course?a=1' })
    assert.equal(repeated.body.data.source.id, first.body.data.source.id)
    assert.equal((await call(key, path, { ...input, url: 'https://example.org/course?a=2' })).status, 201)
    const listed = await web('/api/classes/sources', { classId: cls.classId })
    assert.equal(listed.body.data.sources.length, 2)
    await web('/api/classes/join', { code: cls.code, password: 'class-test-pass' }, 'bob')
    assert.equal((await web('/api/classes/source/remove', { classId: cls.classId, sourceId: first.body.data.source.id }, 'bob')).status, 403)
    assert.equal((await web('/api/classes/source/remove', { classId: cls.classId, sourceId: first.body.data.source.id })).status, 200)
  } finally { globalThis.fetch = originalFetch }
})

test('危险链接拒绝；GitHub 在鉴权、幂等检查之后验证，重试不再请求上游', async () => {
  const { mint, call, cls } = await setup()
  const { key } = await mint()
  const path = `/classes/${cls.classId}/sources`
  for (const url of ['http://example.org', 'https://user:pass@example.org', 'https://127.0.0.1', 'https://[::1]', 'https://service.local', 'javascript:alert(1)']) {
    assert.equal((await call(key, path, { type: 'link', url, dryRun: true })).status, 400, url)
  }
  const originalFetch = globalThis.fetch
  let networkCalls = 0
  globalThis.fetch = async (url) => {
    networkCalls += 1
    assert.equal(new URL(url).hostname, 'api.github.com')
    return Response.json({ name: 'materials', full_name: 'teacher/materials', owner: { login: 'teacher' }, default_branch: 'main', private: false })
  }
  try {
    const input = { type: 'github', url: 'https://github.com/teacher/materials' }
    assert.equal((await call('invalid', path, input)).status, 401)
    assert.equal(networkCalls, 0)
    assert.equal((await call(key, path, input, 'github-once')).status, 201)
    assert.equal((await call(key, path, input, 'github-once')).status, 200)
    assert.equal(networkCalls, 1)
    const sameUrlLink = await call(key, path, { type: 'link', url: input.url })
    assert.equal(sameUrlLink.status, 201)
    assert.equal(sameUrlLink.body.data.source.type, 'link', '相同 URL 的不同源类型分别保存')
  } finally { globalThis.fetch = originalFetch }
})

test('全局限流：多个 Key 共用账号计数，429 含 Retry-After', async () => {
  const { mint, call, assignmentsPath } = await setup()
  const a = await mint()
  const b = await mint()
  for (let i = 0; i < 20; i += 1) assert.equal((await call(i % 2 ? a.key : b.key, assignmentsPath, { ...ASSIGNMENT, title: `通知 ${i}` })).status, 201)
  const limited = await call(b.key, assignmentsPath, ASSIGNMENT)
  assert.equal(limited.status, 429)
  assert.ok(Number(limited.headers.get('Retry-After')) > 0)
})

test('OpenAPI 可公开读取，接口响应 no-store，CORS 仅对新 API 放行鉴权头', async () => {
  const { app } = await setup()
  const spec = await app.request('/api/agent/v1/openapi.json')
  assert.equal(spec.status, 200)
  assert.equal(spec.headers.get('Cache-Control'), 'no-store')
  const document = await spec.json()
  assert.equal(document.openapi, '3.1.0')
  assert.ok(document.paths['/api/agent/v1/classes/{classId}/assignments'])
  for (const [path, expected] of [['/api/agent/v1/classes', true], ['/api/classes/list', false]]) {
    const result = await app.request(path, { method: 'OPTIONS', headers: { Origin: 'https://example.org', 'Access-Control-Request-Headers': 'Authorization, Idempotency-Key' } })
    assert.equal(result.status, 204)
    assert.equal(result.headers.get('Access-Control-Allow-Headers').includes('Authorization'), expected)
  }
})
