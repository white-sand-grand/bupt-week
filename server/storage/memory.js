import { isLive } from './is-live.js'
import { businessRecords } from './business-records.js'

/** 内存存储。测试用，也作为 KV 存储的 L1 缓存实现。 */
export class MemorySessionStore {
  constructor() {
    this.map = new Map()
    this.pending = Promise.resolve()
  }

  run(operation) {
    const task = this.pending.catch(() => {}).then(operation)
    this.pending = task.then(() => {}, () => {})
    return task
  }

  async get(id) {
    return this.run(() => {
      const session = this.map.get(id)
      if (!session) return undefined
      if (!isLive(session)) {
        this.map.delete(id)
        return undefined
      }
      return session
    })
  }

  async set(id, session) {
    return this.run(() => {
      this.map.set(id, session)
      return session
    })
  }

  async delete(id) {
    return this.run(() => this.map.delete(id))
  }

  transaction(operation) {
    return this.run(async () => {
      const snapshot = structuredClone(this.map)
      const result = await operation(businessRecords(snapshot))
      // 只在整个业务操作成功后提交；失败不会留下半份成员或幂等结果。
      this.map = new Map([...snapshot].filter(([, value]) => value !== null))
      return result
    })
  }

  get size() {
    return this.map.size
  }
}
