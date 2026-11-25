import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBackend } from '../server/app.js'
import { MemorySessionStore } from '../server/storage/memory.js'

test('网页并发录入：每个返回成功的作业都保留', async () => {
  const sessions = new MemorySessionStore()
  const classes = new MemorySessionStore()
  await sessions.set('member', { kind: 'ucloud', username: 'test-member', expiresAt: Date.now() + 60_000 })
  const app = createBackend({ getSessionStore: () => sessions, getClassStore: () => classes })
  const post = (path, body) => app.request(path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ sessionId: 'member', ...body }),
  })
  const created = await (await post('/api/classes/create', { name: '并发测试班', password: 'test-pass' })).json()
  const classId = created.data.classId
  const results = await Promise.all(Array.from({ length: 6 }, (_, i) => post('/api/classes/assignment/add', {
    classId, title: `作业 ${i}`, subject: '数学', content: '完成习题',
  })))
  assert.ok(results.every((result) => result.status === 200))
  const listed = await (await post('/api/classes/assignments', { classId })).json()
  assert.equal(listed.data.assignments.length, 6)
})
