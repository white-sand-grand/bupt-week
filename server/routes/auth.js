import { Hono } from 'hono'
import { ApiError, readJson } from '../http.js'
import { CAS_CLIENTS, casAuthenticate, casClientRedirect, mergeCookies } from '../services/cas.js'
import { getUserInfo, loginUcloudWithTicket, refreshAccessToken } from '../services/ucloud.js'
import { loginJwgl, loginJwglWithTicket, validateJwglSession } from '../services/jwgl.js'
import { loginJwglweixin, validateWeixinSession } from '../services/jwglweixin.js'
import { createLoginRateLimiter } from '../rate-limit.js'
import { withUserAgent } from '../user-agent.js'

// 服务端会话 7 天；探活/业务成功时滑动续期，30 天绝对上限。
// 上游会话可能提前失效，届时提示重新登录即可。
const SESSION_TTL_MS = 7 * 86400000
// 滑动续期的绝对上限：无论怎么活跃，距创建 30 天必须重新登录——
// 被盗 sessionId 的最长有效窗口要有硬顶
const SESSION_ABSOLUTE_MS = 30 * 86400000
// 剩余时间低于 6 天才滑动：每次成功请求都回写是写放大（KV 按天配额），
// 这样每天最多滑一次，剩余充足时零写入
const SESSION_SLIDE_BELOW_MS = 6 * 86400000

const UCLOUD_SERVICE = 'https://ucloud.bupt.edu.cn'

// /wecom/start 时把前端地址存进这个 cookie，callback 时读出来
const FRONTEND_COOKIE = 'bupt-week-frontend'
// /wecom/start 时把 CAS 的 state 存进这个 cookie，callback 时必须对上。
// 一次性绑定：证明这次回流确实由我们发起、且发生在同一个浏览器里。
const WECOM_STATE_COOKIE = 'bupt-week-wecom-state'
const JWGL_SERVICE = 'https://jwgl.bupt.edu.cn/'

function newSessionId() {
  return crypto.randomUUID()
}

function expiresAt() {
  return Date.now() + SESSION_TTL_MS
}

/**
 * 滑动续期（纯函数，不碰存储）：会话被正常使用且剩余不足 6 天时，把过期
 * 时间推到 min(现在+7天, 创建起 30 天绝对上限)。调用方比较返回值与入参
 * 的引用决定是否回写 store（与 token/cookie 刷新合并成一次写）。
 *
 * 老会话（滑动机制上线前建的）没有 createdAt：按 expiresAt-7天 补推，
 * 绝对上限从此刻起算，不会被无限续。
 * @returns {object} 无需续期时原样返回入参引用，否则返回带新 expiresAt 的副本
 */
export function slideSessionExpiry(session) {
  const now = Date.now()
  const createdAt = Number.isFinite(session.createdAt) ? session.createdAt : session.expiresAt - SESSION_TTL_MS
  if (session.expiresAt - now >= SESSION_SLIDE_BELOW_MS) return session
  const expiresAt = Math.min(now + SESSION_TTL_MS, createdAt + SESSION_ABSOLUTE_MS)
  if (expiresAt <= session.expiresAt) return session
  return { ...session, createdAt, expiresAt }
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
 * 教务侧的数据源优先级（2026-10-24 起）：
 *   1. 移动教务 jwglweixin（主源：公网可达，token 登录不走 CAS）
 *   2. 教务处 jwgl（回退：CAS ticket 路径【待验证】→ encodeInp 老登录）
 * 全部失败时降级（云邮照常登录、教务 null）：
 *   - 移动教务报密码错（401）→ jwglPasswordNeeded，提示教务密码可能与统一
 *     身份密码不同，前端给补填入口
 *   - jwgl-connect（网络不可达）→ 校园网场景文案
 */
async function loginBothSystems({ username, password, fetchImpl = fetch }) {
  // 第一次：云邮。这次会真正校验学号密码。
  const ucloudCas = await casAuthenticate({ username, password, service: UCLOUD_SERVICE, fetchImpl })
  const ucloud = await loginUcloudWithTicket(ucloudCas.ticket, { username, fetchImpl })

  // 第二次：教务。先试移动教务。
  let jwgl
  let jwglVia = 'weixin'
  let jwglMessage = ''
  let jwglPasswordNeeded = false
  try {
    jwgl = { kind: 'jwglweixin', ...(await loginJwglweixin({ username, password, fetchImpl })) }
  } catch (weixinError) {
    // 401 = 密码不匹配（教务密码 ≠ 统一身份密码）；502 = 移动教务不可达。
    // 两种都要继续试 jwgl——校内可能 jwglweixin 故障，校外密码不同但校内可回退。
    const passwordWrong = weixinError.status === 401
    console.warn(`[auth] 移动教务登录失败（${weixinError.stage || 'unknown'}: ${weixinError.message}），回退教务处 CAS`)
    jwglVia = 'cas'
    try {
      const jwglCas = await casAuthenticate({
        username,
        password,
        service: JWGL_SERVICE,
        fetchImpl: reuseCookies(fetchImpl, ucloudCas.cookies),
      })
      jwgl = { kind: 'jwgl', ...(await loginJwglWithTicket(jwglCas.ticket, fetchImpl)) }
    } catch (error) {
      console.warn(`[auth] 教务处 CAS 登录失败（${error.stage || 'unknown'}: ${error.message}），回退到原登录方式`)
      jwglVia = 'legacy'
      try {
        jwgl = { kind: 'jwgl', ...(await loginJwgl({ username, password, fetchImpl })) }
      } catch (legacyError) {
        const unreachable = legacyError.stage === 'jwgl-connect'
        if (unreachable || (passwordWrong && legacyError.status === 401)) {
          console.warn('[auth] 教务登录全部失败，降级为仅云邮登录')
          return {
            ucloud,
            jwgl: null,
            jwglVia: 'unavailable',
            jwglMessage: passwordWrong
              ? '教务登录失败：教务系统密码可能与统一身份密码不同。作业功能不受影响；可在课表页补填教务密码。'
              : legacyError.message,
            jwglPasswordNeeded: passwordWrong,
          }
        }
        throw legacyError
      }
    }
  }

  return { ucloud, jwgl, jwglVia, jwglMessage, jwglPasswordNeeded }
}

/**
 * 包一层 fetch，把上一次 CAS 认证的 Cookie 并进请求。
 *
 * CAS 的 SSO 会话（CASTGC）就存在这些 Cookie 里。第二次请求带上它，
 * CAS 才会认"这人已经登过了"，直接签发新 ticket。
 *
 * 合并而不是覆盖：请求自带的 Cookie（新流程自己的 JSESSIONID，与 execution
 * 配对）优先，上次认证留下的 SSO Cookie 补位。直接覆盖会让两个流程的
 * JSESSIONID 错位，CAS 拒掉表单、静默回退到老登录。
 */
function reuseCookies(fetchImpl, cookies) {
  if (!cookies) return fetchImpl
  return async (url, options = {}) => {
    const headers = new Headers(options.headers)
    const merged = mergeCookies(cookies, headers.get('Cookie') || '')
    if (merged) headers.set('Cookie', merged)
    return fetchImpl(url, { ...options, headers })
  }
}

export function createAuthRoutes({ getSessionStore, frontendUrl = '', allowedOrigins = [] }) {
  const routes = new Hono()
  const limitLogin = createLoginRateLimiter()

  // ── 统一登录 ──────────────────────────────────────────────────────────────

  routes.post('/auth/login', limitLogin(async (c) => {
    const { username, password } = await readJson(c.req.raw)
    const { ucloud, jwgl, jwglVia, jwglMessage, jwglPasswordNeeded } = await loginBothSystems({ username, password })

    const store = getSessionStore()
    const ucloudSessionId = newSessionId()

    await store.set(ucloudSessionId, {
      kind: 'ucloud',
      ...ucloud,
      createdAt: Date.now(),
      expiresAt: expiresAt(),
    })

    // 教务侧降级（jwgl 为 null）时不建会话。凭证形态按数据源分两种：
    // jwglweixin（token）/ jwgl（Cookie 罐），消费方按 kind 分流。
    let jwglSessionId = null
    if (jwgl) {
      jwglSessionId = newSessionId()
      await store.set(jwglSessionId, {
        kind: jwgl.kind,
        ...(jwgl.kind === 'jwglweixin' ? { token: jwgl.token } : { cookies: jwgl.cookies }),
        username,
        createdAt: Date.now(),
        expiresAt: expiresAt(),
      })
    }

    return c.json({
      success: true,
      data: {
        ucloud: { sessionId: ucloudSessionId, username: ucloud.username, realName: ucloud.realName },
        // 教务侧降级时为 null（jwglMessage 说明原因），前端据此呈现「仅云邮可用」
        jwgl: jwgl ? { sessionId: jwglSessionId, username } : null,
        // 方便排查：移动教务 / 教务处 CAS / 老登录 / 全部不可达
        jwglVia,
        ...(jwglMessage ? { jwglMessage } : {}),
        ...(jwglPasswordNeeded ? { jwglPasswordNeeded } : {}),
        expiresAt: expiresAt(),
      },
    })
  }))

  // ── 云邮（保留单系统入口，便于单独调试） ─────────────────────────────────

  routes.post('/ucloud/login', limitLogin(async (c) => {
    const { username, password } = await readJson(c.req.raw)
    const { ticket } = await casAuthenticate({ username, password, service: UCLOUD_SERVICE })
    const result = await loginUcloudWithTicket(ticket, { username })

    const sessionId = newSessionId()
    await getSessionStore().set(sessionId, { kind: 'ucloud', ...result, createdAt: Date.now(), expiresAt: expiresAt() })

    return c.json({
      success: true,
      data: { sessionId, username: result.username, realName: result.realName, expiresAt: expiresAt() },
    })
  }))

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
    // token 续期与滑动续期合并成至多一次回写（都是换 expiresAt/凭证后 set）
    const slid = slideSessionExpiry(renewed)
    if (slid !== session) await store.set(sessionId, slid)

    return c.json({
      success: true,
      data: {
        sessionId,
        username: slid.username,
        realName: slid.realName,
        expiresAt: slid.expiresAt,
      },
    })
  })

  routes.post('/ucloud/logout', async (c) => {
    const { sessionId } = await readJson(c.req.raw)
    await getSessionStore().delete(sessionId)
    return c.json({ success: true })
  })

  // ── 教务处 ───────────────────────────────────────────────────────────────

  routes.post('/jwgl/login', limitLogin(async (c) => {
    const { username, password } = await readJson(c.req.raw)
    const result = await loginJwgl({ username, password })

    const sessionId = newSessionId()
    await getSessionStore().set(sessionId, {
      kind: 'jwgl',
      cookies: result.cookies,
      username: result.username,
      createdAt: Date.now(),
      expiresAt: expiresAt(),
    })

    return c.json({ success: true, data: { sessionId, username: result.username, expiresAt: expiresAt() } })
  }))

  routes.post('/jwgl/session', async (c) => {
    const { sessionId } = await readJson(c.req.raw)
    const store = getSessionStore()
    const session = await store.get(sessionId)

    if (!session || (session.kind !== 'jwgl' && session.kind !== 'jwglweixin')) {
      throw new ApiError(401, { stage: 'jwgl-auth', msg: '教务登录已过期，请重新登录' })
    }

    if (session.kind === 'jwglweixin') {
      try {
        await validateWeixinSession({ token: session.token })
      } catch (error) {
        if (error.status === 401) await store.delete(sessionId)
        throw error
      }
      const slid = slideSessionExpiry(session)
      if (slid !== session) await store.set(sessionId, slid)
      return c.json({
        success: true,
        data: { sessionId, username: session.username, expiresAt: slid.expiresAt },
      })
    }

    let cookies
    try {
      cookies = await validateJwglSession(session.cookies)
    } catch (error) {
      if (error.status === 401) await store.delete(sessionId)
      throw error
    }

    // Cookie 刷新与滑动续期合并成至多一次回写
    const slid = slideSessionExpiry(cookies !== session.cookies ? { ...session, cookies } : session)
    if (slid !== session) await store.set(sessionId, slid)

    return c.json({
      success: true,
      data: { sessionId, username: session.username, expiresAt: slid.expiresAt },
    })
  })

  /**
   * 补填教务密码：统一登录假定教务密码=统一身份密码，不同的人在这里补。
   *
   * 用云邮会话鉴权（能拿出有效云邮会话就是本人），拿会话里的学号 + 用户补填
   * 的密码登移动教务。密码只在这一次请求里用，不落任何存储。
   */
  routes.post('/auth/jwglweixin/password', limitLogin(async (c) => {
    const { sessionId, password } = await readJson(c.req.raw)
    const store = getSessionStore()
    const session = await store.get(sessionId)

    if (!session || session.kind !== 'ucloud') {
      throw new ApiError(401, { stage: 'ucloud-auth', msg: '云邮登录已过期，请重新登录' })
    }

    const { token } = await loginJwglweixin({ username: session.username, password })

    const jwglSessionId = newSessionId()
    await store.set(jwglSessionId, {
      kind: 'jwglweixin',
      token,
      username: session.username,
      createdAt: Date.now(),
      expiresAt: expiresAt(),
    })

    return c.json({
      success: true,
      data: { sessionId: jwglSessionId, username: session.username, expiresAt: expiresAt() },
    })
  }))

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

    const response = c.redirect(target.toString())

    // 一次性绑定：把 CAS 的 state 记进 HttpOnly cookie，callback 必须对上。
    // state 是 CAS 签发的随机值（猜不出），cookie 只在我们的域名上——
    // 这条链把「回流的 code/state」钉死在「我们发起的 start」和同一个浏览器上。
    if (state) {
      response.headers.append(
        'Set-Cookie',
        `${WECOM_STATE_COOKIE}=${encodeURIComponent(state)}; Path=/api/auth/wecom; HttpOnly; SameSite=Lax; Secure; Max-Age=900`,
      )
    }

    // 前端地址只在 Referer 命中白名单时才记 cookie。Referer 任何页面都能伪造——
    // 无条件信任等于允许把登录结果（URL 里带着 sessionId）302 到任意地址。
    // 此刻用户从我们页面点进来，Referer 是可信的，但只信白名单里的那些。
    // 配了 FRONTEND_URL 时它优先，这里不用记。
    if (!frontendUrl) {
      const refererOrigin = whitelistedRefererOrigin(c.req.header('Referer') || '', allowedOrigins)
      if (refererOrigin) {
        response.headers.append(
          'Set-Cookie',
          `${FRONTEND_COOKIE}=${encodeURIComponent(refererOrigin)}; Path=/; HttpOnly; SameSite=Lax; Secure; Max-Age=900`,
        )
      }
    }
    return response
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
      return redirectToFrontend(c, frontendUrl, '#/login?error=wecom-cancelled', [expireStateCookie()])
    }

    // start 时种下的 state cookie 必须与回流参数一致，否则这次回流不是我们
    // 发起的流程（或换了浏览器），拒绝——不校验的话任何人都能拿自己的
    // code/state 打到我们 callback，把别人的 sessionId 塞进受害者浏览器。
    const boundState = readCookie(c, WECOM_STATE_COOKIE)
    if (!boundState || boundState !== state) {
      console.warn('[auth] 企业微信回调 state 校验失败', { hasCookie: Boolean(boundState) })
      return redirectToFrontend(c, frontendUrl, '#/login?error=wecom-state', [expireStateCookie()])
    }

    const loginUrl = `https://auth.bupt.edu.cn/authserver/login?client_name=${CAS_CLIENTS.wecom}`
      + `&code=${encodeURIComponent(code)}&state=${encodeURIComponent(state)}`

    let response
    try {
      response = await fetch(loginUrl, withUserAgent({ redirect: 'manual' }))
    } catch {
      return redirectToFrontend(c, frontendUrl, '#/login?error=wecom-connect', [expireStateCookie()])
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
      return redirectToFrontend(c, frontendUrl, '#/login?error=wecom-no-ticket', [expireStateCookie()])
    }

    const ucloud = await loginUcloudWithTicket(ticket)
    const sessionId = newSessionId()
    await getSessionStore().set(sessionId, { kind: 'ucloud', ...ucloud, createdAt: Date.now(), expiresAt: expiresAt() })

    return redirectToFrontend(
      c,
      frontendUrl,
      `#/login?wecom=ok&sessionId=${encodeURIComponent(sessionId)}`,
      [expireStateCookie()],
    )
  })

  return routes
}

/** 从请求 URL 反推本站来源（不带尾斜杠），用于拼 callback 的绝对地址。 */
function backendOrigin(requestUrl) {
  const url = new URL(requestUrl)
  return `${url.protocol}//${url.host}`
}

/**
 * 从 Referer 提取前端 origin；只在命中 CORS 白名单时返回，其余返回空串。
 *
 * Referer 是任何页面都能带的头，不能直接当可信输入——攻击者页面带上自己的
 * Referer 打 start，就能让 callback 把 sessionId 302 到他的域名。
 */
function whitelistedRefererOrigin(referer, allowedOrigins) {
  if (!referer) return ''
  try {
    const origin = new URL(referer).origin
    return allowedOrigins.includes(origin) ? origin : ''
  } catch {
    return ''
  }
}

/** 让 state cookie 立即过期。callback 无论成败都带上一条，一次性使用。 */
function expireStateCookie() {
  return `${WECOM_STATE_COOKIE}=; Path=/api/auth/wecom; Max-Age=0`
}

/**
 * 前端地址。企业微信流程最后要跳回前端。
 *
 * 取值优先级：环境变量 FRONTEND_URL > /wecom/start 时留下的 cookie。
 *
 * **不能用回调时的 Referer 推断。** 走到 callback 这一步，用户是从
 * app.bupt.edu.cn 跳回来的，Referer 是 app.bupt 而不是我们的前端——
 * 拿它当前端地址会把用户弹回 app.bupt。这是个实际踩过的坑。
 *
 * 两者都没有时返回空字符串，由调用方给出明确提示，而不是猜一个地址把用户
 * 送去一个 404 页面。
 */
function frontendOrigin(context, configured) {
  if (configured) return configured.replace(/\/+$/, '') + '/'

  const cookie = readCookie(context, FRONTEND_COOKIE)
  if (cookie) {
    try {
      return `${new URL(cookie).origin}/`
    } catch {
      // cookie 内容不可解析就往下走
    }
  }
  return ''
}

function readCookie(context, name) {
  const raw = context.req.header('Cookie') || ''
  for (const part of raw.split(';')) {
    const [key, ...value] = part.trim().split('=')
    if (key === name) return decodeURIComponent(value.join('='))
  }
  return ''
}

/**
 * 跳回前端。拿不到前端地址时返回一段明确的文字，而不是拼一个坏 URL 把用户
 * 送到 404 页面——那种失败看起来像站点挂了，实际只是没配地址。
 *
 * @param {string[]} setCookies 额外要下发的 Set-Cookie（如清掉 state cookie）
 */
function redirectToFrontend(context, configured, hash, setCookies = []) {
  const origin = frontendOrigin(context, configured)
  const response = origin
    ? context.redirect(`${origin}${hash}`)
    : context.html(
        '<!DOCTYPE html><meta charset="utf-8"><title>登录完成</title>'
        + '<body style="font-family:system-ui;padding:2rem;line-height:1.7">'
        + '<h2>企业微信登录已完成</h2>'
        + '<p>但没能确定要跳回哪个页面。请手动打开站点首页，登录态已生效。</p>'
        + '<p style="color:#888;font-size:.85rem">'
        + '如果这是你自己部署的实例，在后端设置 FRONTEND_URL 环境变量即可自动跳回。'
        + '</p></body>',
      )
  for (const cookie of setCookies) {
    response.headers.append('Set-Cookie', cookie)
  }
  return response
}
