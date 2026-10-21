import { ApiError } from '../http.js'
import { redactSensitive } from '../log-redact.js'
import { casAuthenticate, describeNetworkError } from './cas.js'

const SERVICE_URL = 'https://ucloud.bupt.edu.cn'
const API_BASE_URL = 'https://apiucloud.bupt.edu.cn'
const TOKEN_URL = `${API_BASE_URL}/ykt-basics/oauth/token`
const INFO_URL = `${API_BASE_URL}/ykt-basics/info`
const OAUTH_AUTHORIZATION = 'Basic cG9ydGFsOnBvcnRhbF9zZWNyZXQ='
const BUSINESS_AUTHORIZATION = 'Basic c3dvcmQ6c3dvcmRfc2VjcmV0'
const TENANT_ID = '000000'

function log(label, data = {}) {
  console.log(`[ucloud-auth] ${label}`, redactSensitive(data))
}

async function readJsonBody(response) {
  return response.json().catch(() => null)
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
 * 用已拿到的 CAS ticket 换云邮凭证。
 *
 * CAS 认证本身在 services/cas.js，两个系统共用。这里只负责 ticket → OAuth → 用户信息。
 *
 * @param {string} ticket CAS 签发的一次性票据
 * @returns {Promise<{accessToken: string, refreshToken: string, userId: string, username: string, realName: string}>}
 */
export async function loginUcloudWithTicket(ticket, { username = '', fetchImpl = fetch } = {}) {
  if (!ticket) {
    throw new ApiError(400, '缺少 CAS ticket')
  }

  const token = await postToken({ ticket, grant_type: 'third' }, fetchImpl)
  const info = await getUserInfo(token.access_token, fetchImpl)

  if (!info.id) {
    throw new ApiError(502, { stage: 'user-info', msg: '用户信息里没有 id，无法继续' })
  }

  const result = {
    accessToken: token.access_token,
    refreshToken: token.refresh_token || '',
    userId: String(info.id),
    username: username || info.account || info.userName || '',
    realName: info.realName || info.name || info.account || '',
  }

  log('login:done', { username: result.username, realName: result.realName })
  return result
}

/**
 * 云邮登录：CAS → ticket → OAuth → 用户信息。
 *
 * 统一登录时用的是 loginUcloudWithTicket（ticket 由 casAuthenticate 统一产出），
 * 这个独立入口保留给只登云邮的场景。
 */
export async function loginUcloud({ username = '', password = '', fetchImpl = fetch }) {
  const { ticket } = await casAuthenticate({ username, password, service: SERVICE_URL, fetchImpl })
  return loginUcloudWithTicket(ticket, { username, fetchImpl })
}
