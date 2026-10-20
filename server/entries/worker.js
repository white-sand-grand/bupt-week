import { createBackend } from '../app.js'
import { MemorySessionStore } from '../storage/memory.js'
import { KvSessionStore } from '../storage/kv.js'

// 模块级缓存：同一 isolate 内的多个请求复用同一个应用实例与会话存储。
let cachedApp
let cachedStore

function getStore(env) {
  if (cachedStore) return cachedStore

  if (env.SESSIONS) {
    cachedStore = new KvSessionStore(env.SESSIONS)
  } else {
    // 没绑 KV 时退化为内存存储：功能可用，但 isolate 一回收会话就没了。
    // 真要用起来必须按 wrangler.toml 里的说明建好 KV namespace。
    console.warn('[worker] 未绑定 KV namespace SESSIONS，会话仅存内存，重启即失效')
    cachedStore = new MemorySessionStore()
  }
  return cachedStore
}

/**
 * Cloudflare Workers 入口。
 *
 * 与 entries/node.js 调用同一个 createBackend，server/ 下没有任何环境判断。
 * 两个入口唯一的差别就是注入哪种会话存储。
 */
export default {
  fetch(request, env, executionCtx) {
    if (!cachedApp) {
      const allowedOrigins = String(env.CORS_ORIGINS || '')
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean)
      cachedApp = createBackend({ getSessionStore: () => getStore(env), allowedOrigins })
    }
    return cachedApp.fetch(request, env, executionCtx)
  },
}
