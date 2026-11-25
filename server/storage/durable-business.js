import { ApiError } from '../http.js'
import { isLive } from './is-live.js'
import { isLegacyBusinessKey } from './business-records.js'
import { BusinessService } from '../services/business.js'

/**
 * 当前班级规模使用单个权威对象，使班级号、成员索引、授权与作业跨键原子提交。
 * 不存学校密码或学校 token；CLASSES KV 只在某个旧键首次访问时用于迁移。
 */
export class BusinessObject {
  constructor(state, env) {
    this.state = state
    this.env = env
    this.service = new BusinessService({ transaction: (operation) => state.storage.transaction(async (tx) => {
      const store = {
        get: async (key) => {
          let value = await tx.get(key)
          if (value === undefined && isLegacyBusinessKey(key)) {
            const raw = env.CLASSES ? await env.CLASSES.get(key) : null
            // 损坏的旧数据应报错，不把它当成空班级覆盖。
            value = raw ? JSON.parse(raw) : null
            if (raw) await tx.put(key, isLive(value) ? value : null)
          }
          return isLive(value) ? value : undefined
        },
        set: (key, value) => tx.put(key, value),
        delete: (key) => isLegacyBusinessKey(key) ? tx.put(key, null) : tx.delete(key),
      }
      return operation(store)
    }) })
  }

  async fetch(request) {
    try {
      const { action, args } = await request.json()
      const data = await this.service.call(action, args)
      if (await this.state.storage.getAlarm() === null) await this.state.storage.setAlarm(Date.now() + 3600000)
      return Response.json({ success: true, data })
    } catch (error) {
      if (error instanceof ApiError) return Response.json(error.body, { status: error.status })
      // 不记录 RPC 正文或未知异常对象，避免授权密钥进入日志。
      console.error('[business] 事务失败')
      return Response.json({ success: false, code: 'TEMPORARILY_UNAVAILABLE', msg: '班级存储暂时不可用，请使用原幂等键重试' }, { status: 503 })
    }
  }

  async alarm() {
    let cursor
    do {
      const batch = await this.state.storage.list({ ...(cursor ? { startAfter: cursor } : {}), limit: 256 })
      if (!batch.size) break
      await this.state.storage.transaction(async (tx) => {
        for (const key of batch.keys()) {
          if (isLegacyBusinessKey(key)) continue
          const value = await tx.get(key)
          if (value !== undefined && !isLive(value)) await tx.delete(key)
        }
      })
      cursor = [...batch.keys()].at(-1)
      if (batch.size < 256) break
    } while (cursor)
    await this.state.storage.setAlarm(Date.now() + 3600000)
  }
}

export class DurableBusinessClient {
  constructor(namespace) { this.namespace = namespace }

  async call(action, args) {
    if (!this.namespace) throw new ApiError(503, { code: 'TEMPORARILY_UNAVAILABLE', msg: '未配置 BUSINESS Durable Object，班级写入尚未启用' })
    const object = this.namespace.get(this.namespace.idFromName('business-v1'))
    let response
    try {
      response = await object.fetch('https://business.internal/operation', { method: 'POST',
        headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action, args }) })
    } catch {
      throw new ApiError(503, { code: 'TEMPORARILY_UNAVAILABLE', msg: '班级存储暂时不可用，请使用原幂等键重试' })
    }
    const result = await response.json()
    if (!response.ok) throw new ApiError(response.status, result)
    return result.data
  }
}
