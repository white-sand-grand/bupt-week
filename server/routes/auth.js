import { Hono } from 'hono'
import { ApiError, readJson } from '../http.js'
import { getUserInfo, loginUcloud, refreshAccessToken } from '../services/ucloud.js'
import { loginJwgl, validateJwglSession } from '../services/jwgl.js'

// 服务端会话 7 天。上游会话可能提前失效，届时提示重新登录即可。
const SESSION_TTL_MS = 7 * 86400000

function newSessionId() {
  return crypto.randomUUID()
}

function expiresAt() {
  return Date.now() + SESSION_TTL_MS
}

/**
 * 云邮会话探活，必要时静默续期。
 *
 * access_token 只有约 2 小时（expires_in: 7199）。不做续期的话用户每两小时就要
 * 重新登录一次，不可用。云邮前端自己是这么做的（见 docs/api-reference.md 1.3），
 * 照抄即可。
 *
 * @returns {Promise<object|null>} 续期后的会话；彻底失效返回 null
 */
async function renewUcloudSession(session) {
  try {
    await getUserInfo(session.accessToken)
    return session
  } catch (error) {
    if (error.status !== 401) throw error
  }

  if (!session.refreshToken) return null

  try {
    const token = await refreshAccessToken(session.refreshToken)
    // 换到新 token 后必须真调一次接口确认可用，否则只是把错误推迟到下一步
    await getUserInfo(token.access_token)
    return { ...session, accessToken: token.access_token, refreshToken: token.refresh_token || session.refreshToken }
  } catch {
    return null
  }
}

export function createAuthRoutes({ getSessionStore }) {
  const routes = new Hono()

  // ── 云邮 ─────────────────────────────────────────────────────────────────

  routes.post('/ucloud/login', async (c) => {
    const { username, password } = await readJson(c.req.raw)
    const result = await loginUcloud({ username, password })

    const sessionId = newSessionId()
    await getSessionStore().set(sessionId, { kind: 'ucloud', ...result, expiresAt: expiresAt() })

    return c.json({
      success: true,
      data: {
        sessionId,
        username: result.username,
        realName: result.realName,
        expiresAt: expiresAt(),
      },
    })
  })

  routes.post('/ucloud/session', async (c) => {
    const { sessionId } = await readJson(c.req.raw)
    const store = getSessionStore()
    const session = await store.get(sessionId)

    if (!session || session.kind !== 'ucloud') {
      throw new ApiError(401, { stage: 'ucloud-auth', msg: '云邮登录已过期，请重新登录' })
    }

    const renewed = await renewUcloudSession(session)
    if (!renewed) {
      await store.delete(sessionId)
      throw new ApiError(401, { stage: 'ucloud-auth', msg: '云邮登录已过期，请重新登录' })
    }
    if (renewed !== session) await store.set(sessionId, renewed)

    return c.json({
      success: true,
      data: {
        sessionId,
        username: renewed.username,
        realName: renewed.realName,
        expiresAt: renewed.expiresAt,
      },
    })
  })

  routes.post('/ucloud/logout', async (c) => {
    const { sessionId } = await readJson(c.req.raw)
    await getSessionStore().delete(sessionId)
    return c.json({ success: true })
  })

  // ── 教务处 ───────────────────────────────────────────────────────────────

  routes.post('/jwgl/login', async (c) => {
    const { username, password } = await readJson(c.req.raw)
    const result = await loginJwgl({ username, password })

    const sessionId = newSessionId()
    await getSessionStore().set(sessionId, {
      kind: 'jwgl',
      cookies: result.cookies,
      username: result.username,
      expiresAt: expiresAt(),
    })

    return c.json({ success: true, data: { sessionId, username: result.username, expiresAt: expiresAt() } })
  })

  routes.post('/jwgl/session', async (c) => {
    const { sessionId } = await readJson(c.req.raw)
    const store = getSessionStore()
    const session = await store.get(sessionId)

    if (!session || session.kind !== 'jwgl') {
      throw new ApiError(401, { stage: 'jwgl-auth', msg: '教务登录已过期，请重新登录' })
    }

    let cookies
    try {
      cookies = await validateJwglSession(session.cookies)
    } catch (error) {
      if (error.status === 401) await store.delete(sessionId)
      throw error
    }

    if (cookies !== session.cookies) await store.set(sessionId, { ...session, cookies })

    return c.json({
      success: true,
      data: { sessionId, username: session.username, expiresAt: session.expiresAt },
    })
  })

  routes.post('/jwgl/logout', async (c) => {
    const { sessionId } = await readJson(c.req.raw)
    await getSessionStore().delete(sessionId)
    return c.json({ success: true })
  })

  return routes
}
