import { Hono } from 'hono'
import { ApiError, readJson } from '../http.js'
import { createLoginRateLimiter, createRequestRateLimiter } from '../rate-limit.js'
import { isAdmitted } from '../admission.js'
import { byrdocsSessionKey, downloadByrdocs, loginByrdocs, saveByrdocsSession, searchByrdocs } from '../services/byrdocs.js'

export function createByrdocsRoutes({ getSessionStore, allowedOrigins = [] }) {
  const routes = new Hono()
  const limitLogin = createLoginRateLimiter()
  // 搜索匿名可用且每次都打第三方：限请求次数，防止脚本刷爆 BYR 的搜索接口
  // 导致全站搜索被上游限流（WAF 外层兜底见 docs/deployment.md）。
  const limitSearch = createRequestRateLimiter({ maxRequests: 30, windowMs: 60_000 })

  function admit(c) {
    const own = new URL(c.req.url)
    if (!isAdmitted(c.req.raw, allowedOrigins, `${own.protocol}//${own.host}`)) {
      throw new ApiError(403, '来源不在白名单内，拒绝代理该请求')
    }
  }

  async function sessionFor(sessionId) {
    const store = getSessionStore()
    const session = typeof sessionId === 'string' ? await store.get(sessionId) : null
    if (session?.kind !== 'ucloud') throw new ApiError(401, '请先登录本站，再连接 BYR Docs')
    return { store, session }
  }

  routes.post('/status', async (c) => {
    const { sessionId } = await readJson(c.req.raw)
    const { store } = await sessionFor(sessionId)
    const byrdocs = await store.get(byrdocsSessionKey(sessionId))
    return c.json({ success: true, data: { ready: byrdocs?.kind === 'byrdocs' } })
  })

  routes.post('/connect', limitLogin(async (c) => {
    const { sessionId, password } = await readJson(c.req.raw)
    const { store, session } = await sessionFor(sessionId)
    const token = await loginByrdocs({ username: session.username, password })
    // 在途认证结束时若已退出，不再写回凭证。
    const latest = await store.get(sessionId)
    if (latest?.kind !== 'ucloud' || latest.username !== session.username) throw new ApiError(401, '本站登录已结束，请重新登录')
    await saveByrdocsSession(store, sessionId, token, session.createdAt)
    return c.json({ success: true, data: { ready: true } })
  }))

  routes.post('/search', limitSearch(async (c) => {
    admit(c)
    const { keyword, type } = await readJson(c.req.raw)
    const results = await searchByrdocs({ keyword, type })
    return c.json({ success: true, data: { results } })
  }))

  routes.post('/download', async (c) => {
    const { sessionId, key, filename } = await readJson(c.req.raw)
    const { store } = await sessionFor(sessionId)
    const byrdocs = await store.get(byrdocsSessionKey(sessionId))
    if (byrdocs?.kind !== 'byrdocs') throw new ApiError(401, { stage: 'byrdocs-auth', msg: '请先在添加源页连接 BYR Docs' })
    let response
    try {
      response = await downloadByrdocs({ token: byrdocs.token, key, filename })
    } catch (error) {
      // 只清理失效的 ByrDocs 凭证，不清云邮；并发重连成功的凭证不能被旧失败覆盖。
      if (error.status === 401) {
        const current = await store.get(byrdocsSessionKey(sessionId))
        if (current?.token === byrdocs.token) await store.delete(byrdocsSessionKey(sessionId))
      }
      throw error
    }
    c.header('Content-Type', 'application/octet-stream')
    c.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
    if (!response.headers.has('content-encoding') && response.headers.has('content-length')) {
      c.header('Content-Length', response.headers.get('content-length'))
    }
    return c.body(response.body)
  })

  return routes
}
