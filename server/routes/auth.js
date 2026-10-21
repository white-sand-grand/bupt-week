import { Hono } from 'hono'
import { ApiError, readJson } from '../http.js'
import { CAS_CLIENTS, casAuthenticate, casClientRedirect } from '../services/cas.js'
import { getUserInfo, loginUcloudWithTicket, refreshAccessToken } from '../services/ucloud.js'
import { loginJwgl, loginJwglWithTicket, validateJwglSession } from '../services/jwgl.js'

// 服务端会话 7 天。上游会话可能提前失效，届时提示重新登录即可。
const SESSION_TTL_MS = 7 * 86400000

const UCLOUD_SERVICE = 'https://ucloud.bupt.edu.cn'
const JWGL_SERVICE = 'https://jwgl.bupt.edu.cn/'

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
 * 重新登录一次，不可用。云邮前端自己是这么做的（见 api-reference.md 1.3），照抄。
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

/**
 * 用一次 CAS 认证同时登两个系统。
 *
 * 关键在 Cookie 罐：第一次认证建立 CASTGC（SSO 会话），第二次用同一个 Cookie
 * 请求另一个 service 的 ticket，CAS 直接给、不重新认证。这就是"统一登录"——
 * 两个系统共用同一套统一身份认证（实测见 docs/unified-login-plan.md）。
 *
 * 教务处那条路（ticket → 会话）的入口路径是【待验证】的，失败时回退到已经跑通的
 * encodeInp 老登录。两条路按可用性切换，互不影响。
 */
async function loginBothSystems({ username, password, fetchImpl = fetch }) {
  // 第一次：云邮。这次会真正校验学号密码。
  const ucloudCas = await casAuthenticate({ username, password, service: UCLOUD_SERVICE, fetchImpl })
  const ucloud = await loginUcloudWithTicket(ucloudCas.ticket, { username, fetchImpl })

  // 第二次：教务处。复用同一个 Cookie 罐，不重新认证。
  let jwgl
  let jwglVia = 'cas'
  try {
    const jwglCas = await casAuthenticate({
      username,
      password,
      service: JWGL_SERVICE,
      fetchImpl: reuseCookies(fetchImpl, ucloudCas.cookies),
    })
    jwgl = await loginJwglWithTicket(jwglCas.ticket, fetchImpl)
  } catch (error) {
    console.warn(`[auth] 教务处 CAS 登录失败（${error.stage || 'unknown'}: ${error.message}），回退到原登录方式`)
    jwglVia = 'legacy'
    jwgl = await loginJwgl({ username, password, fetchImpl })
  }

  return { ucloud, jwgl, jwglVia }
}

/**
 * 包一层 fetch，把上一次 CAS 认证拿到的 Cookie 固设进去。
 *
 * CAS 的 SSO 会话（CASTGC）就存在这些 Cookie 里。第二次请求带上它，
 * CAS 才会认"这人已经登过了"，直接签发新 ticket。
 */
function reuseCookies(fetchImpl, cookies) {
  if (!cookies) return fetchImpl
  return async (url, options = {}) => {
    const headers = new Headers(options.headers)
    headers.set('Cookie', cookies)
    return fetchImpl(url, { ...options, headers })
  }
}

export function createAuthRoutes({ getSessionStore }) {
  const routes = new Hono()

  // ── 统一登录 ──────────────────────────────────────────────────────────────

  routes.post('/auth/login', async (c) => {
    const { username, password } = await readJson(c.req.raw)
    const { ucloud, jwgl, jwglVia } = await loginBothSystems({ username, password })

    const store = getSessionStore()
    const ucloudSessionId = newSessionId()
    const jwglSessionId = newSessionId()

    await store.set(ucloudSessionId, {
      kind: 'ucloud',
      ...ucloud,
      expiresAt: expiresAt(),
    })
    await store.set(jwglSessionId, {
      kind: 'jwgl',
      cookies: jwgl.cookies,
      username,
      expiresAt: expiresAt(),
    })

    return c.json({
      success: true,
      data: {
        ucloud: { sessionId: ucloudSessionId, username: ucloud.username, realName: ucloud.realName },
        jwgl: { sessionId: jwglSessionId, username },
        // 方便排查：教务处这次是走 CAS 还是回退到了老登录
        jwglVia,
        expiresAt: expiresAt(),
      },
    })
  })

  // ── 云邮（保留单系统入口，便于单独调试） ─────────────────────────────────

  routes.post('/ucloud/login', async (c) => {
    const { username, password } = await readJson(c.req.raw)
    const { ticket } = await casAuthenticate({ username, password, service: UCLOUD_SERVICE })
    const result = await loginUcloudWithTicket(ticket, { username })

    const sessionId = newSessionId()
    await getSessionStore().set(sessionId, { kind: 'ucloud', ...result, expiresAt: expiresAt() })

    return c.json({
      success: true,
      data: { sessionId, username: result.username, realName: result.realName, expiresAt: expiresAt() },
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

  // ── 企业微信 / 微信内自动识别 ─────────────────────────────────────────────

  /**
   * 第一步：把浏览器送去做企业微信识别。
   *
   * 做法见 docs/unified-login-plan.md 候选 A：
   *   1. 请 CAS 生成 mc-wx 跳转（service=云邮），拿到带 CAS state 的 app.bupt URL
   *   2. 只把该 URL 的 redirect 换成本站 callback，state 原样保留
   *      —— state 才是 CAS 认的凭证，redirect 在 app.bupt 侧、可以换（实测）
   *   3. 302 浏览器去那个地址
   *
   * 用户在微信里会被企业微信自动识别，无需再输学号密码。
   */
  routes.get('/auth/wecom/start', async (c) => {
    const { redirectUrl, state } = await casClientRedirect({
      clientName: CAS_CLIENTS.wecom,
      service: UCLOUD_SERVICE,
    })

    const target = new URL(redirectUrl)
    target.searchParams.set('redirect', `${backendOrigin(c.req.url)}/api/auth/wecom/callback`)

    return c.redirect(target.toString())
  })

  /**
   * 第二步：接收 app.bupt 回流的 code + CAS state。
   *
   * 带着这两个参数请求 CAS 的 mc-wx 登录页，CAS 校验 state、拿 code 换身份，
   * 然后 302 到 service?ticket=ST-xxx——ticket 就在那个 Location 里，我们读得到。
   *
   * 成功后 302 回前端，把 sessionId 放在 fragment 里（不进 Referer）。
   */
  routes.get('/auth/wecom/callback', async (c) => {
    const code = c.req.query('code') || ''
    const state = c.req.query('state') || ''

    if (!code || !state) {
      return c.redirect(`${frontendOrigin(c)}#/login?error=wecom-cancelled`)
    }

    const loginUrl = `https://auth.bupt.edu.cn/authserver/login?client_name=${CAS_CLIENTS.wecom}`
      + `&code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`

    let response
    try {
      response = await fetch(loginUrl, { redirect: 'manual' })
    } catch {
      return c.redirect(`${frontendOrigin(c)}#/login?error=wecom-connect`)
    }

    const location = response.headers.get('location') || ''
    let ticket = ''
    if (location) {
      try {
        ticket = new URL(location).searchParams.get('ticket') || ''
      } catch {
        ticket = ''
      }
    }

    if (!ticket) {
      // 到这一步失败，最可能是 CAS 不认被改过的 redirect，或者 code 已过期
      console.warn('[auth] 企业微信回调没拿到 ticket', { status: response.status, hasLocation: Boolean(location) })
      return c.redirect(`${frontendOrigin(c)}#/login?error=wecom-no-ticket`)
    }

    const ucloud = await loginUcloudWithTicket(ticket)
    const sessionId = newSessionId()
    await getSessionStore().set(sessionId, { kind: 'ucloud', ...ucloud, expiresAt: expiresAt() })

    return c.redirect(`${frontendOrigin(c)}#/login?wecom=ok&sessionId=${encodeURIComponent(sessionId)}`)
  })

  return routes
}

/** 从请求 URL 反推本站来源（不带尾斜杠），用于拼 callback 的绝对地址。 */
function backendOrigin(requestUrl) {
  const url = new URL(requestUrl)
  return `${url.protocol}//${url.host}`
}

/**
 * 前端地址。企业微信流程最后要跳回前端，开发时是 Vite，线上是 Pages。
 * 用 Referer 反推：用户是从前端点进来的，Referer 就是前端地址。
 */
function frontendOrigin(context) {
  const referer = context.req.header('Referer') || ''
  if (referer) {
    try {
      const url = new URL(referer)
      // 带尾斜杠：拼出来是 http://host/#/login 而不是 http://host#/login
      return `${url.protocol}//${url.host}/`
    } catch {
      // Referer 不可解析就落到默认值
    }
  }
  return 'http://127.0.0.1:5173/'
}
