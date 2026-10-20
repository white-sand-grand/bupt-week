import { ApiError } from '../http.js'
import { redactSensitive } from '../log-redact.js'

const SERVICE_URL = 'https://ucloud.bupt.edu.cn'
const API_BASE_URL = 'https://apiucloud.bupt.edu.cn'
const TOKEN_URL = `${API_BASE_URL}/ykt-basics/oauth/token`
const INFO_URL = `${API_BASE_URL}/ykt-basics/info`
const OAUTH_AUTHORIZATION = 'Basic cG9ydGFsOnBvcnRhbF9zZWNyZXQ='
const BUSINESS_AUTHORIZATION = 'Basic c3dvcmQ6c3dvcmRfc2VjcmV0'
const TENANT_ID = '000000'
const LOGIN_URL = `https://auth.bupt.edu.cn/authserver/login?service=${encodeURIComponent(SERVICE_URL)}`

function log(label, data = {}) {
  console.log(`[ucloud-auth] ${label}`, redactSensitive(data))
}

// ── HTML 辅助 ───────────────────────────────────────────────────────────────

function pickInputValue(html, name) {
  const input = html.match(new RegExp(`<input[^>]*name=["'\\s]*${name}["']?[^>]*>`, 'i'))?.[0] || ''
  return input.match(/value="([^"]*)"/i)?.[1] || ''
}

function pickCasError(html) {
  return (
    html
      .match(/<p[^>]*>(.*?)<\/p>/i)?.[1]
      ?.replace(/<[^>]+>/g, '')
      .trim() || ''
  )
}

// ── Cookie 辅助 ─────────────────────────────────────────────────────────────

/**
 * 取出响应里的所有 Set-Cookie，砍掉属性只留 name=value。
 *
 * getSetCookie() 在 Node 18.13+ 和 Cloudflare Workers 都可用。兜底那条只能取到
 * 第一个头——多个 Set-Cookie 被逗号拼接后无法可靠拆分（Expires 里就有逗号），
 * 所以宁可少拿也不要猜错。
 */
function readSetCookies(headers) {
  if (typeof headers.getSetCookie === 'function') {
    return headers.getSetCookie().filter(Boolean)
  }
  const raw = headers.get('set-cookie') || ''
  return raw ? [raw.split(';')[0]] : []
}

function joinCookies(headers) {
  return readSetCookies(headers)
    .map((cookie) => cookie.split(';')[0].trim())
    .filter(Boolean)
    .join('; ')
}

async function readJsonBody(response) {
  return response.json().catch(() => null)
}

/** 把底层网络错误翻成一句人能看懂的话。Node 的 fetch 失败时 message 只有 "fetch failed"。 */
function describeNetworkError(error) {
  const cause = error?.cause || {}
  const code = cause.code || cause.errno || error?.code || ''
  const hostname = error?.upstream || ''

  if (code === 'ECONNREFUSED') return '连接被拒绝'
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return '连接超时'
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '域名解析失败'
  if (code === 'ECONNRESET') return '连接被重置'
  if (code === 'CERT_HAS_EXPIRED' || code === 'DEPTH_ZERO_SELF_SIGNED_CERT') return '证书校验失败'
  if (code === 'EPROTO' || code === 'ERR_SSL_WRONG_VERSION_NUMBER') return 'TLS 握手失败'
  return code || error?.message || '未知网络错误'
}

// ── CAS 登录 ────────────────────────────────────────────────────────────────

/**
 * 走完 CAS，返回一次性 ticket。
 *
 * 第二步必须 redirect: 'manual'：成功时是 302，ticket 在 Location 里。
 * 浏览器做不到这件事——manual 模式拿到的是 opaque redirect，Location 被吃掉。
 * 这也是整个项目必须有服务端的根本原因。
 */
async function casLogin(username, password, fetchImpl) {
  let loginPage
  try {
    loginPage = await fetchImpl(LOGIN_URL, { redirect: 'manual' })
  } catch (error) {
    throw new ApiError(502, {
      stage: 'cas-connect',
      msg: `连不上统一认证服务（${describeNetworkError(error)}）。如果本机走了代理，Node 的 fetch 默认不读 HTTP_PROXY，见 docs/deployment.md`,
    })
  }

  const cookies = joinCookies(loginPage.headers)
  const loginHtml = await loginPage.text()
  const execution = pickInputValue(loginHtml, 'execution')

  log('cas:get', { status: loginPage.status, hasCookies: Boolean(cookies), hasExecution: Boolean(execution) })

  if (!execution) {
    throw new ApiError(502, {
      stage: 'cas-get',
      msg: '读不出统一认证登录页的隐藏字段，可能是页面改版或被风控',
    })
  }

  const form = new URLSearchParams({
    username,
    password,
    type: pickInputValue(loginHtml, 'type') || 'username_password',
    execution,
    _eventId: pickInputValue(loginHtml, '_eventId') || 'submit',
    submit: 'LOGIN',
  })

  let casResponse
  try {
    casResponse = await fetchImpl(LOGIN_URL, {
      method: 'POST',
      redirect: 'manual',
      headers: {
        Cookie: cookies,
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0',
      },
      body: form,
    })
  } catch (error) {
    throw new ApiError(502, {
      stage: 'cas-connect',
      msg: `统一认证登录请求失败（${describeNetworkError(error)}）`,
    })
  }

  const location = casResponse.headers.get('location') || ''
  let ticket = ''
  if (location) {
    try {
      ticket = new URL(location).searchParams.get('ticket') || ''
    } catch {
      ticket = ''
    }
  }

  log('cas:post', {
    status: casResponse.status,
    hasTicket: Boolean(ticket),
    location: location ? redactSensitive(location) : '',
  })

  if (!ticket) {
    const errorHtml = location ? '' : await casResponse.text()
    const error = pickCasError(errorHtml)
    throw new ApiError(401, {
      stage: 'cas-login',
      msg: error || '统一认证没有返回票据，请检查学号和密码',
    })
  }

  return ticket
}

// ── OAuth ───────────────────────────────────────────────────────────────────

async function postToken(body, fetchImpl) {
  let response
  try {
    response = await fetchImpl(TOKEN_URL, {
      method: 'POST',
      headers: {
        Authorization: OAUTH_AUTHORIZATION,
        'Tenant-Id': TENANT_ID,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: new URLSearchParams(body),
    })
  } catch (error) {
    throw new ApiError(502, {
      stage: 'oauth-connect',
      msg: `连不上云邮凭证服务（${describeNetworkError(error)}）`,
    })
  }

  const payload = await readJsonBody(response)

  log('oauth:token', { status: response.status, grant_type: body.grant_type, payload })

  if (!response.ok || !payload?.access_token) {
    throw new ApiError(response.status === 401 ? 401 : 502, {
      stage: 'oauth-token',
      msg: payload?.error_description || payload?.msg || '换取云邮凭证失败',
    })
  }

  return payload
}

/** 用 refresh_token 换新的 access_token。access_token 只有约 2 小时，必须配这个。 */
export async function refreshAccessToken(refreshToken, fetchImpl = fetch) {
  if (!refreshToken) {
    throw new ApiError(401, { stage: 'oauth-refresh', msg: '云邮登录已过期，请重新登录' })
  }
  try {
    return await postToken({ grant_type: 'refresh_token', refresh_token: refreshToken }, fetchImpl)
  } catch (error) {
    if (error instanceof ApiError) {
      throw new ApiError(401, { stage: 'oauth-refresh', msg: error.message })
    }
    throw error
  }
}

// ── 用户信息 ────────────────────────────────────────────────────────────────

export async function getUserInfo(accessToken, fetchImpl = fetch) {
  let response
  try {
    response = await fetchImpl(INFO_URL, {
      headers: {
        Authorization: BUSINESS_AUTHORIZATION,
        'Tenant-Id': TENANT_ID,
        'Blade-Auth': accessToken,
      },
    })
  } catch (error) {
    throw new ApiError(502, {
      stage: 'user-info-connect',
      msg: `连不上云邮服务（${describeNetworkError(error)}）`,
    })
  }

  const payload = await readJsonBody(response)

  log('ucloud:info', { status: response.status, payload })

  if (!response.ok || payload?.success === false) {
    throw new ApiError(response.status === 401 ? 401 : 502, {
      stage: 'user-info',
      msg: payload?.msg || `获取用户信息失败（HTTP ${response.status}）`,
    })
  }

  return payload?.data || {}
}

// ── 登录编排 ────────────────────────────────────────────────────────────────

/**
 * 云邮登录：CAS → ticket → OAuth → 用户信息。
 *
 * 返回值里没有任何东西直接给前端——由路由层换成不透明 sessionId。
 *
 * @returns {Promise<{accessToken: string, refreshToken: string, userId: string, username: string, realName: string}>}
 */
export async function loginUcloud({ username = '', password = '', fetchImpl = fetch }) {
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    throw new ApiError(400, '学号和密码不能为空')
  }

  const ticket = await casLogin(username, password, fetchImpl)
  const token = await postToken({ ticket, grant_type: 'third' }, fetchImpl)
  const info = await getUserInfo(token.access_token, fetchImpl)

  if (!info.id) {
    throw new ApiError(502, { stage: 'user-info', msg: '用户信息里没有 id，无法继续' })
  }

  log('login:done', { username, realName: info.realName || info.name || info.account })

  return {
    accessToken: token.access_token,
    refreshToken: token.refresh_token || '',
    userId: String(info.id),
    username,
    realName: info.realName || info.name || info.account || '',
  }
}
