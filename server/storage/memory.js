import { isLive } from './is-live.js'

/** 内存存储。测试用，也作为 KV 存储的 L1 缓存实现。 */
export class MemorySessionStore {
  constructor() {
    this.map = new Map()
  }

  async get(id) {
    const session = this.map.get(id)
    if (!session) return undefined
    if (!isLive(session)) {
      this.map.delete(id)
      return undefined
    }
    return session
  }

  async set(id, session) {
    this.map.set(id, session)
    return session
  }

  async delete(id) {
    return this.map.delete(id)
  }

  get size() {
    return this.map.size
  }
}
