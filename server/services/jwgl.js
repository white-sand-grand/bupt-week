import { ApiError } from '../http.js'
import { mergeCookies } from './cas.js'

const JWGL_BASE = 'https://jwgl.bupt.edu.cn'

/**
 * 教务处登录的密码编码，从 MYUCLOUD 的 Python 版 auto_evalued 原样移植（逐字一致）。
 *
 * 实测结论：这就是一个手写的**标准 base64**。65 个字符的 key 只是为了把下标 64
 * 映射到 '='，省掉单独写 padding 常量；位运算与标准算法完全一致。
 *
 * 和 Buffer.toString('base64') 的差别只在输入解释：这里按 UTF-16 code unit
 * 逐字节走，Buffer 按 UTF-8。ASCII 输入（学号、密码）两者相同。
 *
 * 别去"修"它。学校那套就是要这个行为，改一个字符就可能静默登录失败——
 * 表现是服务端返回登录页，没有任何明确错误，极难查。
 */
export function encodeInp(value) {
  const KEY = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/='
  let output = ''
  let i = 0
  while (i < value.length) {
    const chr1 = value.charCodeAt(i++)
    const chr2 = i < value.length ? value.charCodeAt(i++) : null
    const chr3 = i < value.length ? value.charCodeAt(i++) : null

    const enc1 = chr1 >> 2
    const enc2 = ((chr1 & 3) << 4) | ((chr2 ?? 0) >> 4)
    const enc3 = (((chr2 ?? 0) & 15) << 2) | ((chr3 ?? 0) >> 6)
    const enc4 = (chr3 ?? 0) & 63

    let enc3val
    let enc4val
    if (chr2 === null) {
      enc3val = 64
      enc4val = 64
    } else if (chr3 === null) {
      enc3val = enc3
      enc4val = 64
    } else {
      enc3val = enc3
      enc4val = enc4
    }

    output += KEY[enc1] + KEY[enc2] + KEY[enc3val] + KEY[enc4val]
  }
  return output
}

function isLoginPage(html) {
  return (
    html.includes('/jsxsd/xk/LoginToXk') ||
    html.includes('id="userAccount"') ||
    html.includes("id='userAccount'") ||
    html.includes('<title>登录</title>')
  )
}

function parseText(html) {
  return html.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim()
}

// ── Cookie 罐 ───────────────────────────────────────────────────────────────

function parseSetCookies(response) {
  if (typeof response.headers.getSetCookie === 'function') {
    const list = response.headers.getSetCookie()
    if (list.length > 0) {
      return list.filter(Boolean).map((cookie) => cookie.split(';')[0]).join('; ')
    }
  }
  const raw = response.headers.get('set-cookie') || ''
  if (!raw) return ''
  return raw.split(',').map((item) => item.trim().split(';')[0]).filter(Boolean).join('; ')
}

function buildHeaders(cookies, extra = {}) {
  const headers = { 'User-Agent': 'Mozilla/5.0', ...extra }
  if (cookies && cookies.trim()) headers.Cookie = cookies
  return headers
}

// ── 登录 ────────────────────────────────────────────────────────────────────

/**
 * 教务处登录，三步全靠 Cookie 罐串起来。
 *
 * @returns {Promise<{cookies: string, username: string}>}
 */
export async function loginJwgl({ username = '', password = '', fetchImpl = fetch }) {
  if (typeof username !== 'string' || typeof password !== 'string' || !username || !password) {
    throw new ApiError(400, '学号和密码不能为空')
  }

  // 1. 拿初始 Cookie
  let cookies = ''
  try {
    const first = await fetchImpl(`${JWGL_BASE}/jsxsd/`, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
    })
    cookies = parseSetCookies(first)
  } catch {
    throw new ApiError(502, { stage: 'jwgl-connect', msg: '连不上教务系统，请检查网络' })
  }

  // 2. 提交。密码字段留空，真密码在 encoded 里
  const encoded = `${encodeInp(username)}%%%${encodeInp(password)}`
  let second
  let cookies2 = cookies
  try {
    second = await fetchImpl(`${JWGL_BASE}/jsxsd/xk/LoginToXk`, {
      method: 'POST',
      headers: buildHeaders(cookies, {
        'Content-Type': 'application/x-www-form-urlencoded',
        Origin: JWGL_BASE,
        Referer: `${JWGL_BASE}/jsxsd/`,
      }),
      body: new URLSearchParams({ userAccount: username, userPassword: '', encoded }).toString(),
    })
    cookies2 = mergeCookies(cookies, parseSetCookies(second))
  } catch {
    throw new ApiError(502, { stage: 'jwgl-login', msg: '教务系统登录请求失败，请稍后重试' })
  }

  // 3. 用一个需要登录的页面验证是否真的登进去了
  let third
  let html = ''
  let cookies3 = cookies2
  try {
    third = await fetchImpl(`${JWGL_BASE}/jsxsd/xspj/xspj_find.do`, {
      headers: buildHeaders(cookies2, { Referer: `${JWGL_BASE}/jsxsd/` }),
    })
    html = await third.text()
    cookies3 = mergeCookies(cookies2, parseSetCookies(third))
  } catch {
    throw new ApiError(502, { stage: 'jwgl-verify', msg: '教务系统验证请求失败，请稍后重试' })
  }

  if (!third.ok) {
    throw new ApiError(502, { stage: 'jwgl-verify', msg: `教务登录验证失败（HTTP ${third.status}）` })
  }

  if (isLoginPage(html)) {
    // 教务的失败提示混在 HTML 里，挑几个关键词拼一句人能看懂的话
    const hints = ['用户名', '密码', '验证码', '错误', '失败'].filter((hint) =>
      parseText(html).includes(hint),
    )
    throw new ApiError(401, {
      stage: 'jwgl-login',
      msg: `教务登录失败：${hints.join(' / ') || '学号或密码有误'}`,
    })
  }

  return { cookies: cookies3, username }
}

/**
 * 校验教务会话是否还有效，顺带把刷新出来的 Cookie 带回去。
 * 失效时抛 401，由路由层删掉会话。
 */
export async function validateJwglSession(cookies, fetchImpl = fetch) {
  if (!cookies) {
    throw new ApiError(401, { stage: 'jwgl-auth', msg: '教务凭证已过期，请重新登录' })
  }

  let response
  let body = ''
  try {
    response = await fetchImpl(`${JWGL_BASE}/jsxsd/xspj/xspj_find.do`, {
      headers: buildHeaders(cookies, { Referer: `${JWGL_BASE}/jsxsd/` }),
    })
    body = await response.text()
  } catch {
    throw new ApiError(502, { stage: 'jwgl-verify', msg: '无法连接教务系统' })
  }

  if (response.status === 401 || response.status === 403 || isLoginPage(body)) {
    throw new ApiError(401, { stage: 'jwgl-auth', msg: '教务凭证已过期，请重新登录' })
  }
  if (!response.ok) {
    throw new ApiError(502, { stage: 'jwgl-verify', msg: `教务请求失败（HTTP ${response.status}）` })
  }

  return mergeCookies(cookies, parseSetCookies(response))
}

// ── CAS 统一登录 ────────────────────────────────────────────────────────────

/**
 * 用 CAS ticket 登录教务处。
 *
 * jwgl.bupt.edu.cn 是注册过的 CAS service（实测，见 docs/unified-login-plan.md），
 * 所以一次 CAS 认证可以同时服务云邮和教务——这就是"统一登录"。
 *
 * **收 ticket 的确切路径是【待验证】**：按 `/?ticket=` 猜，即让教务系统在根路径
 * 自行校验并建立会话。jwgl.bupt.edu.cn 从开发机不可达，验不了，需要在校园网内试。
 * 走不通就走上面的 loginJwgl（encodeInp 老登录），两条路按可用性切换。
 *
 * @param {string} ticket CAS 签发的一次性票据
 * @returns {Promise<{cookies: string}>}
 */
export async function loginJwglWithTicket(ticket, fetchImpl = fetch) {
  if (!ticket) {
    throw new ApiError(400, '缺少 CAS ticket')
  }

  const url = `${JWGL_BASE}/?ticket=${encodeURIComponent(ticket)}`

  let first
  try {
    first = await fetchImpl(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      redirect: 'manual',
    })
  } catch {
    throw new ApiError(502, { stage: 'jwgl-connect', msg: '连不上教务系统，请检查网络' })
  }

  let cookies = parseSetCookies(first)

  // 教务可能先 302 到某个落地页，跟着走一次把 Cookie 收全
  const location = first.headers.get('location') || ''
  if (location && first.status >= 300 && first.status < 400) {
    try {
      const next = await fetchImpl(new URL(location).toString(), {
        headers: buildHeaders(cookies, { 'User-Agent': 'Mozilla/5.0' }),
        redirect: 'manual',
      })
      cookies = mergeCookies(cookies, parseSetCookies(next))
    } catch {
      // 跟不动就算了，下面用已有 Cookie 验证
    }
  }

  const verified = await validateJwglSession(cookies, fetchImpl)
  return { cookies: verified }
}
