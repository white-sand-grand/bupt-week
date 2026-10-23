import { ApiError } from '../http.js'
import { withUserAgent } from '../user-agent.js'
import { redactSensitive } from '../log-redact.js'

const CAS_BASE = 'https://auth.bupt.edu.cn'

/** CAS 支持的登录方式，见 docs/unified-login-plan.md 第三节。 */
export const CAS_CLIENTS = {
  /** 企业微信 / 微信内自动识别（redirect 在 app.bupt.edu.cn 侧，可改） */
  wecom: 'mc-wx',
  /** 企业微信直连（redirect_uri 由微信侧固定校验，改不了，仅记录用） */
  wecomDirect: 'ww-direct',
  /** 扫码 */
  qr: 'mc-qr',
}

function log(label, data = {}) {
  console.log(`[cas] ${label}`, redactSensitive(data))
}

/**
 * 把底层网络错误翻成一句人能看懂的话。Node 的 fetch 失败时 message 只有 "fetch failed"。
 *
 * 导出给其他服务用：云邮、教务、代理都连着学校域名，报错时说"连接超时"远比
 * "fetch failed" 有用。
 */
export function describeNetworkError(error) {
  const cause = error?.cause || {}
  const code = cause.code || cause.errno || error?.code || ''
  if (code === 'ECONNREFUSED') return '连接被拒绝'
  if (code === 'ETIMEDOUT' || code === 'UND_ERR_CONNECT_TIMEOUT') return '连接超时'
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return '域名解析失败'
  if (code === 'ECONNRESET') return '连接被重置'
  if (code === 'CERT_HAS_EXPIRED') return '证书校验失败'
  return code || error?.message || '未知网络错误'
}

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

/** 按名字覆盖式合并：后到的同名 Cookie 替换先前的，不重复堆积。 */
export function mergeCookies(current = '', updates = '') {
  if (!updates) return current
  const names = new Set(updates.split('; ').map((cookie) => cookie.split('=')[0]))
  return [
    ...current.split('; ').filter((cookie) => cookie && !names.has(cookie.split('=')[0])),
    updates,
  ]
    .filter(Boolean)
    .join('; ')
}

/** 从 302 的 Location 里取 CAS ticket，取不到返回空串。 */
function ticketFromLocation(location) {
  if (!location) return ''
  try {
    return new URL(location).searchParams.get('ticket') || ''
  } catch {
    return ''
  }
}

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

/**
 * 用学号密码走完 CAS，返回 SSO Cookie 和一次性 ticket。
 *
 * 这是两个系统共用的认证入口：jwgl.bupt.edu.cn 和 ucloud.bupt.edu.cn 都是
 * 注册过的 CAS service（实测，见 docs/unified-login-plan.md），所以一次认证
 * 可以分别取两个 service 的 ticket。
 *
 * 第二步必须 redirect: 'manual'：成功时是 302，ticket 在 Location 里。
 * 浏览器做不到这件事——manual 模式拿到的是 opaque redirect，Location 被吃掉。
 * 这是整个项目必须有服务端的根本原因。
 *
 * @param {{ username: string, password: string, service: string, fetchImpl?: typeof fetch }} options
 * @returns {Promise<{ cookies: string, ticket: string }>}
 */
export async function casAuthenticate({ username = '', password = '', service, fetchImpl = fetch }) {
  if (!username || !password) {
    throw new ApiError(400, '学号和密码不能为空')
  }
  if (!service) {
    throw new ApiError(500, '缺少 CAS service 参数')
  }

  const loginUrl = `${CAS_BASE}/authserver/login?service=${encodeURIComponent(service)}`

  let loginPage
  try {
    loginPage = await fetchImpl(loginUrl, withUserAgent({ redirect: 'manual' }))
  } catch (error) {
    throw new ApiError(502, {
      stage: 'cas-connect',
      msg: `连不上统一认证服务（${describeNetworkError(error)}）。如果本机走了代理，Node 的 fetch 默认不读 HTTP_PROXY，见 docs/deployment.md`,
    })
  }

  const cookies = joinCookies(loginPage.headers)
  const loginHtml = await loginPage.text()
  const execution = pickInputValue(loginHtml, 'execution')

  log('cas:get', { service, status: loginPage.status, hasExecution: Boolean(execution) })

  // 已有 SSO 会话（请求带了 CASTGC）时 CAS 不出登录页，直接 302 发 ticket。
  // 这是统一登录里第二次认证的形态：不用重交学号密码。
  if (loginPage.status >= 300 && loginPage.status < 400) {
    const ssoTicket = ticketFromLocation(loginPage.headers.get('location'))
    if (ssoTicket) {
      log('cas:sso', { service, status: loginPage.status })
      return { cookies, ticket: ssoTicket }
    }
  }

  if (!execution) {
    // CAS 对未注册的 service 返回的是 "Application Not Authorized" 页，
    // 表现就是取不到 execution。把原因说清楚，别让人以为是网络问题。
    const unauthorized = /Application Not Authorized/i.test(loginHtml)
    throw new ApiError(502, {
      stage: 'cas-get',
      msg: unauthorized
        ? `统一认证不识别该服务（${service}），请联系管理员确认它已接入 CAS`
        : '读不出统一认证登录页的隐藏字段，可能是页面改版或被风控',
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
    casResponse = await fetchImpl(
      loginUrl,
      withUserAgent({
        method: 'POST',
        redirect: 'manual',
        headers: {
          Cookie: cookies,
          'Content-Type': 'application/x-www-form-urlencoded',
        },
        body: form,
      }),
    )
  } catch (error) {
    throw new ApiError(502, { stage: 'cas-connect', msg: `统一认证登录请求失败（${describeNetworkError(error)}）` })
  }

  const location = casResponse.headers.get('location') || ''
  const ticket = ticketFromLocation(location)

  log('cas:post', { service, status: casResponse.status, hasTicket: Boolean(ticket) })

  if (!ticket) {
    const errorHtml = location ? '' : await casResponse.text()
    throw new ApiError(401, {
      stage: 'cas-login',
      msg: pickCasError(errorHtml) || '统一认证没有返回票据，请检查学号和密码',
    })
  }

  // 把 POST 下发的 Cookie（含 CASTGC）并进罐子。只返回 GET 的 Cookie 的话，
  // 调用方拿不到 SSO 会话，下一次认证还得重交密码——「复用 Cookie 罐」就落空了。
  return { cookies: mergeCookies(cookies, joinCookies(casResponse.headers)), ticket }
}

/**
 * 取某个登录方式（企业微信、扫码等）的跳转地址。
 *
 * 用于企业微信自动识别：CAS 会 302 到第三方，并带上自己生成的 state。
 * 我们把那个 URL 的 redirect 换成本站，见 docs/unified-login-plan.md 候选 A。
 *
 * @returns {Promise<{ redirectUrl: string, state: string }>}
 */
export async function casClientRedirect({ clientName, service, fetchImpl = fetch }) {
  const url = `${CAS_BASE}/authserver/clientredirect?client_name=${encodeURIComponent(clientName)}&service=${encodeURIComponent(service)}`

  let response
  try {
    response = await fetchImpl(url, withUserAgent({ redirect: 'manual' }))
  } catch (error) {
    throw new ApiError(502, {
      stage: 'wecom-connect',
      msg: `连不上统一认证服务（${describeNetworkError(error)}）`,
    })
  }

  const location = response.headers.get('location') || ''
  if (!location) {
    throw new ApiError(502, { stage: 'wecom-start', msg: '统一认证没有返回跳转地址，该登录方式可能暂不可用' })
  }

  let state = ''
  try {
    state = new URL(location).searchParams.get('state') || ''
  } catch {
    state = ''
  }

  return { redirectUrl: location, state }
}
