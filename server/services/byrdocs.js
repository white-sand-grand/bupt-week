import { ApiError } from '../http.js'

const ORIGIN = 'https://byrdocs.org'
const SEARCH_URL = 'https://search.byrdocs.org/api/search'

function fail(status, msg) {
  return new ApiError(status, { stage: 'byrdocs-auth', msg })
}

async function request(url, options = {}, fetchImpl = fetch) {
  try {
    return await fetchImpl(url, { redirect: 'manual', signal: AbortSignal.timeout(20_000), ...options })
  } catch {
    throw new ApiError(502, '无法连接 BYR Docs，请稍后重试或前往官网')
  }
}

async function readResponse(response) {
  const body = await response.json().catch(() => null)
  if (response.status === 429) throw new ApiError(429, 'BYR Docs 访问过于频繁，请稍后重试')
  if (!response.ok || !body) throw new ApiError(502, 'BYR Docs 服务暂时不可用，请稍后重试')
  return body
}

/** 密码只在本次认证请求中使用，返回的是 ByrDocs 自己签发的下载凭证。 */
export async function loginByrdocs({ username, password, fetchImpl = fetch }) {
  if (typeof username !== 'string' || !username || typeof password !== 'string' || !password) {
    throw fail(400, '请填写统一身份认证密码以连接 BYR Docs')
  }
  const signal = AbortSignal.timeout(15_000)
  const begin = await readResponse(await request(`${ORIGIN}/api/auth/login`, { method: 'POST', signal }, fetchImpl))
  let uuid
  try {
    const url = new URL(begin.loginURL)
    if (url.origin === ORIGIN) uuid = /^\/auth\/([a-f0-9-]{36})\/byrdocs-cli$/.exec(url.pathname)?.[1]
  } catch { /* 不信任认证返回的外站地址 */ }
  if (!begin.success || !uuid) throw fail(502, '无法创建 BYR Docs 登录会话，请稍后重试')
  const body = await readResponse(await request(`${ORIGIN}/api/auth/bupt_login`, {
    method: 'POST', signal,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ username, password, uuid }),
  }, fetchImpl))
  if (!body.success || typeof body.token !== 'string') {
    // 上游 error 可能包含用户输入或内部细节，不直接回显。
    throw fail(401, 'BYR Docs 认证未通过，请检查统一身份认证密码，或在官网确认账号能否登录')
  }
  try {
    const payload = JSON.parse(atob(body.token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')))
    if (payload.id !== `BUPT-${username}` || payload.download !== true
      || (typeof payload.exp === 'number' && payload.exp <= Date.now() / 1000)) throw new Error()
  } catch {
    throw fail(502, 'BYR Docs 没有返回可用的本人下载凭证，请稍后重试')
  }
  return body.token
}

export function byrdocsSessionKey(sessionId) {
  return `byrdocs:${sessionId}`
}

export async function saveByrdocsSession(store, sessionId, token, createdAt = Date.now()) {
  await store.set(byrdocsSessionKey(sessionId), {
    kind: 'byrdocs', token, expiresAt: createdAt + 30 * 86400000,
  })
}

export async function searchByrdocs({ keyword, type = 'all', fetchImpl = fetch }) {
  if (typeof keyword !== 'string' || !keyword.trim() || keyword.length > 100
    || !['all', 'book', 'doc', 'test'].includes(type)) {
    throw new ApiError(400, '请填写 1～100 字的关键词，并选择有效的资料类型')
  }
  const body = await readResponse(await request(SEARCH_URL, {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ keyword: keyword.trim(), type, limit: 30, jmespath: "[?data.filetype == 'pdf' || data.filetype == 'zip']" }),
  }, fetchImpl))
  const results = Array.isArray(body.results) ? body.results : Array.isArray(body.data) ? body.data : Array.isArray(body) ? body : null
  if (!results) throw new ApiError(502, 'BYR Docs 搜索返回的格式已变化，请前往官网查看')
  return results.slice(0, 30).flatMap((item) => {
    const data = item?.data || {}
    if (!/^[a-f0-9]{32}$/i.test(item?.id || '') || !['pdf', 'zip'].includes(data.filetype)
      || typeof data.title !== 'string') return []
    const key = `${item.id.toLowerCase()}.${data.filetype}`
    return [{
      key, title: data.title, filename: `${[...(data.title || item.id).replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')].slice(0, 90).join('')}.${data.filetype}`,
      type: item.type, size: data.filesize,
      url: `${ORIGIN}/?${new URLSearchParams({ q: item.id, c: item.type || 'all' })}`,
    }]
  })
}

export async function downloadByrdocs({ token, key, filename, fetchImpl = fetch }) {
  if (typeof key !== 'string' || !/^[a-f0-9]{32}\.(pdf|zip)$/i.test(key)) {
    throw new ApiError(400, 'BYR Docs 文件编号无效')
  }
  if (typeof filename !== 'string' || !filename || filename.length > 200 || /[\x00-\x1f\x7f/\\]/.test(filename)) {
    throw new ApiError(400, '下载文件名无效')
  }
  const response = await request(`${ORIGIN}/files/${key}?${new URLSearchParams({ filename, f: '3' })}`, {
    headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(120_000),
  }, fetchImpl)
  if (!response.ok) {
    await response.body?.cancel()
    if (response.status === 401 || response.status === 403) throw fail(401, 'BYR Docs 下载认证已失效，请在添加源页重新连接；课表和作业不受影响')
    if (response.status === 404) throw new ApiError(404, 'BYR Docs 文件不存在，请重新搜索')
    throw new ApiError(502, 'BYR Docs 下载失败，请稍后重试或前往官网')
  }
  if (/text\/html|application\/json/i.test(response.headers.get('Content-Type') || '')) {
    await response.body?.cancel()
    throw new ApiError(502, 'BYR Docs 返回了页面而非文件，请重新连接或前往官网')
  }
  return response
}
