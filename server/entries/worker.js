import { createBackend } from '../app.js'
import { MemorySessionStore } from '../storage/memory.js'
import { KvSessionStore } from '../storage/kv.js'

// 模块级缓存：同一 isolate 内的多个请求复用同一个应用实例与存储。
let cachedApp
const cachedStores = new Map()

function getStore(env, binding = 'SESSIONS') {
  if (cachedStores.has(binding)) return cachedStores.get(binding)

  let store
  if (env[binding]) {
    store = new KvSessionStore(env[binding])
  } else {
    // 没绑 KV 时退化为内存存储：功能可用，但 isolate 一回收数据就没了。
    // 真要用起来必须按 wrangler.toml 里的说明建好 KV namespace。
    console.warn(`[worker] 未绑定 KV namespace ${binding}，数据仅存内存，重启即失效`)
    store = new MemorySessionStore()
  }
  cachedStores.set(binding, store)
  return store
}

function parseOrigins(raw) {
  return String(raw || '')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean)
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
      cachedApp = createBackend({
        getSessionStore: () => getStore(env),
        // 班级功能数据（班级/成员/手动录入的作业），与 SESSIONS 分 namespace
        getClassStore: () => getStore(env, 'CLASSES'),
        allowedOrigins: parseOrigins(env.CORS_ORIGINS),
        // 企业微信登录成功后跳回前端。必须是公网可达的地址。
        frontendUrl: env.FRONTEND_URL || '',
      })
    }
    return cachedApp.fetch(request, env, executionCtx)
  },
}
