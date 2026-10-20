import { test } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { MemorySessionStore } from '../server/storage/memory.js'
import { FileSessionStore } from '../server/storage/file.js'
import { KvSessionStore } from '../server/storage/kv.js'

const TTL = 60_000
const makeSession = (overrides = {}) => ({
  cookies: 'JSESSIONID=abc',
  expiresAt: Date.now() + TTL,
  ...overrides,
})

/** 最小 KV 假实现，记录调用以便断言写穿透与 TTL。 */
class FakeKv {
  constructor() {
    this.map = new Map()
    this.reads = 0
    this.writes = []
    this.deletes = []
  }

  async get(key) {
    this.reads += 1
    return this.map.has(key) ? this.map.get(key) : null
  }

  async put(key, value, options) {
    this.map.set(key, value)
    this.writes.push({ key, options })
  }

  async delete(key) {
    this.deletes.push(key)
    this.map.delete(key)
  }
}

test('MemorySessionStore：set / get / delete', async () => {
  const store = new MemorySessionStore()
  await store.set('a', makeSession())
  assert.equal((await store.get('a')).cookies, 'JSESSIONID=abc')
  assert.equal(await store.get('missing'), undefined)

  await store.delete('a')
  assert.equal(await store.get('a'), undefined)
})

test('MemorySessionStore：过期的会话读不到', async () => {
  const store = new MemorySessionStore()
  await store.set('a', makeSession({ expiresAt: Date.now() - 1 }))
  assert.equal(await store.get('a'), undefined)
})

test('FileSessionStore：跨实例恢复，且文件权限为 0600', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bupt-week-'))
  const file = join(dir, '.sessions.local')

  try {
    const first = new FileSessionStore(file)
    await first.set('a', makeSession())

    // 权限位只取低 9 位；umask 可能影响 writeFileSync 的 mode，这里断言实际值。
    assert.equal(statSync(file).mode & 0o777, 0o600)

    const second = new FileSessionStore(file)
    assert.equal((await second.get('a')).cookies, 'JSESSIONID=abc')
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('FileSessionStore：不恢复已过期的会话', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bupt-week-'))
  const file = join(dir, '.sessions.local')

  try {
    await new FileSessionStore(file).set('a', makeSession({ expiresAt: Date.now() - 1 }))
    assert.equal(await new FileSessionStore(file).get('a'), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('KvSessionStore：写入穿透到 KV 并带上 TTL', async () => {
  const kv = new FakeKv()
  const store = new KvSessionStore(kv)

  await store.set('a', makeSession())

  assert.equal(kv.writes.length, 1)
  assert.equal(kv.writes[0].key, 'a')
  assert.ok(kv.writes[0].options.expirationTtl > 0, 'TTL 应为正数')
  assert.ok(kv.writes[0].options.expirationTtl <= TTL / 1000 + 1, 'TTL 不应超过会话剩余寿命')
})

test('KvSessionStore：第二次读取命中 L1 缓存，不再读 KV', async () => {
  const kv = new FakeKv()
  const store = new KvSessionStore(kv)

  await store.set('a', makeSession())
  assert.equal(kv.reads, 0)

  await store.get('a')
  assert.equal(kv.reads, 0, '应从 L1 缓存读到')
})

test('KvSessionStore：冷启动时从 KV 回源', async () => {
  const kv = new FakeKv()
  await new KvSessionStore(kv).set('a', makeSession())

  const cold = new KvSessionStore(kv) // 模拟 isolate 被回收后重建
  assert.equal((await cold.get('a')).cookies, 'JSESSIONID=abc')
  assert.equal(kv.reads, 1)
})

test('KvSessionStore：读到无法解析的数据时清理并返回 undefined', async () => {
  const kv = new FakeKv()
  kv.map.set('a', '{ 这不是 JSON')

  const store = new KvSessionStore(kv)
  assert.equal(await store.get('a'), undefined)
  assert.deepEqual(kv.deletes, ['a'])
})

test('KvSessionStore：没有 KV 绑定时应立刻报错', () => {
  assert.throws(() => new KvSessionStore(null), /KV namespace/)
})
