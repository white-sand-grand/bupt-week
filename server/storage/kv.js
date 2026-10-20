import { MemorySessionStore } from './memory.js'
import { isLive } from './is-live.js'

/**
 * Cloudflare KV 存储，用于 Workers 部署。
 *
 * KV 是最终一致的：刚写进去立刻在别的节点读，可能拿到旧值。本项目是单用户
 * 个人工具，靠「内存 L1 + KV L2 写穿透」规避：
 *   - 读先查内存，命中就不再碰 KV
 *   - 写同时更新内存和 KV
 *   - 进程内缓存由 entries/worker.js 的模块级单例保住
 *
 * 代价是 isolate 被回收后首次请求要回源 KV 一次，可接受。
 */
export class KvSessionStore {
  /** @param {{ get: Function, put: Function, delete: Function }} kv KV namespace 绑定 */
  constructor(kv) {
    if (!kv) throw new Error('KvSessionStore 需要 KV namespace 绑定')
    this.kv = kv
    this.cache = new MemorySessionStore()
  }

  async get(id) {
    const cached = await this.cache.get(id)
    if (cached) return cached

    const raw = await this.kv.get(id)
    if (!raw) return undefined

    let session
    try {
      session = JSON.parse(raw)
    } catch {
      await this.kv.delete(id)
      return undefined
    }
    if (!isLive(session)) {
      await this.kv.delete(id)
      return undefined
    }
    await this.cache.set(id, session)
    return session
  }

  async set(id, session) {
    await this.cache.set(id, session)
    const ttl = Math.max(1, Math.ceil((session.expiresAt - Date.now()) / 1000))
    await this.kv.put(id, JSON.stringify(session), { expirationTtl: ttl })
    return session
  }

  async delete(id) {
    await this.cache.delete(id)
    await this.kv.delete(id)
    return true
  }
}
