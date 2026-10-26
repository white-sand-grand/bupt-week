import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { setImmediate } from 'node:timers/promises'
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

    // 权限位只取低 9 位，断言目录与实际记录文件的权限。
    // Windows/NTFS 不套用 POSIX 权限位（永远读到 0666），这条只在 POSIX 上有意义。
    if (process.platform !== 'win32') {
      assert.equal(statSync(`${file}.d`).mode & 0o777, 0o700)
      const [record] = readdirSync(`${file}.d`)
      assert.equal(statSync(join(`${file}.d`, record)).mode & 0o777, 0o600)
    }

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

test('FileSessionStore：更新单个键不再序列化其他记录，写入时让出事件循环', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bupt-week-'))
  try {
    const store = new FileSessionStore(join(dir, '.sessions.local'))
    let serialized = 0
    await store.set('large-class', makeSession({
      content: 'x'.repeat(1024 * 1024),
      toJSON() {
        serialized += 1
        return { content: this.content, expiresAt: this.expiresAt }
      },
    }))
    serialized = 0

    let yielded = false
    const heartbeat = setImmediate().then(() => { yielded = true })
    await store.set('session', makeSession())
    assert.equal(serialized, 0, '无关的班级大记录不应被再次序列化')
    assert.equal(yielded, true, '磁盘写入不应同步阻塞事件循环')
    await heartbeat
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('FileSessionStore：旧 JSON 文件迁移后仍可读写删除，重启不复活旧记录', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bupt-week-'))
  const file = join(dir, '.sessions.local')
  try {
    writeFileSync(file, JSON.stringify({
      a: makeSession(),
      'class:test:members': makeSession({ members: ['test-user'] }),
      expired: makeSession({ expiresAt: Date.now() - 1 }),
    }))
    const store = new FileSessionStore(file)
    assert.equal((await store.get('a')).cookies, 'JSESSIONID=abc')
    assert.deepEqual((await store.get('class:test:members')).members, ['test-user'])
    assert.equal(await store.get('expired'), undefined)
    assert.equal(existsSync(file), false, '全部迁移成功后移除旧快照')

    await store.set('class:test:members', makeSession({ members: ['new-user'] }))
    assert.equal(await store.delete('a'), true)
    assert.equal(await store.delete('missing'), false)
    const restored = new FileSessionStore(file)
    assert.equal(await restored.get('a'), undefined)
    assert.deepEqual((await restored.get('class:test:members')).members, ['new-user'])
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('FileSessionStore：并发修改同一键保持调用顺序，失败后仍可写入', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bupt-week-'))
  const file = join(dir, '.sessions.local')
  try {
    const store = new FileSessionStore(file)
    await store.set('a', makeSession({ cookies: 'saved' }))
    const circular = makeSession()
    circular.self = circular
    await assert.rejects(() => store.set('a', circular), /circular/i)
    assert.equal((await new FileSessionStore(file).get('a')).cookies, 'saved')
    await Promise.all([
      store.set('a', makeSession({ cookies: 'old' })),
      store.delete('a'),
      store.set('a', makeSession({ cookies: 'new' })),
      store.set('../other:key', makeSession()),
    ])
    assert.equal((await new FileSessionStore(file).get('a')).cookies, 'new')
    assert.equal((await store.get('../other:key')).cookies, 'JSESSIONID=abc')
    assert.equal(await store.get(undefined), undefined)
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
})

test('FileSessionStore：中断迁移可续跑，已迁移记录优先于旧快照', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bupt-week-'))
  const file = join(dir, '.sessions.local')
  try {
    await new FileSessionStore(file).set('a', makeSession({ cookies: 'new' }))
    // 模拟迁移一部分后进程中断：记录目录与尚未删除的旧快照并存。
    writeFileSync(file, JSON.stringify({
      a: makeSession({ cookies: 'old' }),
      b: makeSession({ cookies: 'remaining' }),
    }))
    const restored = new FileSessionStore(file)
    assert.equal((await restored.get('a')).cookies, 'new')
    assert.equal((await restored.get('b')).cookies, 'remaining')
    assert.equal(existsSync(file), false)
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
