import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FileBusinessStore, FileSessionStore } from '../server/storage/file.js'
import { MemorySessionStore } from '../server/storage/memory.js'
import { BusinessService } from '../server/services/business.js'

const future = () => Date.now() + 3600000

test('内存事务：读改写整体串行，失败回滚，不吞掉后续操作', async () => {
  const store = new MemorySessionStore()
  await store.set('counter', { count: 0, expiresAt: future() })
  await Promise.all(Array.from({ length: 12 }, () => store.transaction(async (tx) => {
    const saved = await tx.get('counter')
    await Promise.resolve()
    await tx.set('counter', { ...saved, count: saved.count + 1 })
  })))
  assert.equal((await store.get('counter')).count, 12)
  await assert.rejects(store.transaction(async (tx) => {
    await tx.set('counter', { count: 999, expiresAt: future() })
    throw new Error('中断事务')
  }), /中断/)
  assert.equal((await store.get('counter')).count, 12)
})

test('文件事务：只迁移班级业务，跨重启保留删除墓碑，不复制学校凭证', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bupt-business-'))
  try {
    const legacy = new FileSessionStore(join(directory, '.sessions.local'))
    await legacy.set('class:legacy', { id: 'legacy', name: '旧班级', expiresAt: future() })
    await legacy.set('school-session', { accessToken: 'private-school-token', expiresAt: future() })
    const file = join(directory, '.business.local')
    const store = new FileBusinessStore(file, legacy)
    assert.equal((await store.get('class:legacy')).name, '旧班级')
    const snapshot = await readFile(store.files.recordPath('business'), 'utf8')
    assert.equal(snapshot.includes('private-school-token'), false)
    await store.delete('class:legacy')
    assert.equal(await new FileBusinessStore(file, legacy).get('class:legacy'), undefined)
    assert.ok(await legacy.get('class:legacy'), '保留迁移前旧副本供备份，但不再回读已删除键')
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test('文件事务：幂等结果与业务一起提交，写入失败回滚，响应丢失后重启可重放', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bupt-business-'))
  try {
    const file = join(directory, '.business.local')
    const store = new FileBusinessStore(file, new MemorySessionStore())
    const service = new BusinessService(store)
    const { classId } = await service.call('create', { username: 'alice', input: { name: '班级', password: 'class-pass' } })
    const { key } = await service.call('createGrant', { username: 'alice', input: { name: '助手', scopes: ['assignments:create', 'assignments:read'], classIds: [classId] } })
    const request = { key, action: 'addAssignment', classId, idempotencyKey: 'response-lost', input: { title: '作业', subject: '数学', content: '习题' } }
    const originalWrite = store.files.write
    store.files.write = async () => { throw new Error('模拟磁盘失败') }
    await assert.rejects(service.call('agent', request), /磁盘失败/)
    store.files.write = originalWrite
    assert.equal((await service.call('listAssignments', { username: 'alice', classId })).assignments.length, 0)
    const first = await service.call('agent', request)
    assert.equal(first.status, 201)
    const restarted = new BusinessService(new FileBusinessStore(file, new MemorySessionStore()))
    const replayed = await restarted.call('agent', request)
    assert.equal(replayed.status, 200)
    assert.equal(replayed.data.assignmentId, first.data.assignmentId)
    assert.equal((await restarted.call('listAssignments', { username: 'alice', classId })).assignments.length, 1)
  } finally { await rm(directory, { recursive: true, force: true }) }
})
