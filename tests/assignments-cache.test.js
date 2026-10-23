import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  ASSIGNMENTS_KEY,
  readAssignmentsCache,
  validateAssignmentsCache,
  writeAssignmentsCache,
} from '../src/utils/assignments-cache.js'

/** localStorage 的内存替身。 */
function memoryStorage(initial = {}) {
  const store = { ...initial }
  return {
    getItem: (key) => (key in store ? store[key] : null),
    setItem: (key, value) => { store[key] = String(value) },
    removeItem: (key) => { delete store[key] },
    dump: () => store,
  }
}

const RECORDS = [{ id: 'hw-1', siteName: '数据结构', assignmentTitle: '实验一', assignmentStatus: 99 }]

test('write→read 回环：结构校验通过，原样取回', () => {
  const storage = memoryStorage()
  const written = writeAssignmentsCache(storage, '2021001234', RECORDS)
  assert.ok(written.savedAt)

  const cache = readAssignmentsCache(storage, '2021001234')
  assert.equal(cache.username, '2021001234')
  assert.deepEqual(cache.records, RECORDS)
  assert.equal(cache.savedAt, written.savedAt)
})

test('无缓存返回 null；JSON 损坏清键自愈', () => {
  const empty = memoryStorage()
  assert.equal(readAssignmentsCache(empty, 'u1'), null)

  const broken = memoryStorage({ [ASSIGNMENTS_KEY]: '{oops' })
  assert.equal(readAssignmentsCache(broken, 'u1'), null)
  assert.equal(broken.dump()[ASSIGNMENTS_KEY], undefined, '坏键应被清掉')
})

test('结构不对清键自愈：缺 username / 版本不符 / records 非 数组 / 记录缺 id', () => {
  const bad = { version: 1, username: 'u1', savedAt: new Date().toISOString(), records: [{ noId: true }] }
  const storage = memoryStorage({ [ASSIGNMENTS_KEY]: JSON.stringify(bad) })
  assert.equal(readAssignmentsCache(storage, 'u1'), null)
  assert.equal(storage.dump()[ASSIGNMENTS_KEY], undefined)

  assert.equal(validateAssignmentsCache({ ...bad, records: [[1]] }), false)
  assert.equal(validateAssignmentsCache({ ...bad, version: 2 }), false)
  assert.equal(validateAssignmentsCache(null), false)
})

test('账号不符返回 null 但不清键：那是另一个账号的缓存', () => {
  const storage = memoryStorage()
  writeAssignmentsCache(storage, 'alice', RECORDS)

  assert.equal(readAssignmentsCache(storage, 'bob'), null)
  assert.ok(storage.dump()[ASSIGNMENTS_KEY], '别人账号的缓存必须保留')

  const alice = readAssignmentsCache(storage, 'alice')
  assert.equal(alice.username, 'alice')
})

test('记录不完整宁可不写：write 校验不过返回 null 且不落盘', () => {
  const storage = memoryStorage()
  assert.equal(writeAssignmentsCache(storage, 'u1', [{ noId: true }]), null)
  assert.equal(storage.dump()[ASSIGNMENTS_KEY], undefined)
})

test('localStorage 写失败（隐私模式）静默放过，返回值仍可用', () => {
  const storage = {
    getItem: () => null,
    setItem: () => { throw new Error('quota exceeded') },
    removeItem: () => {},
  }
  const written = writeAssignmentsCache(storage, 'u1', RECORDS)
  assert.equal(written.username, 'u1', '写入失败也应返回缓存对象（savedAt 给内存态用）')
})
