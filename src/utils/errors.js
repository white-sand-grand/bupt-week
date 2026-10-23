/**
 * 面向用户的错误文案。
 *
 * 后端 ApiError 的 msg 本就是给人看的（中文、说人话），直接透传；
 * 这里兜的是它之外的部分——浏览器原生错误（Failed to fetch 这类英文黑话）
 * 和裸 HTTP 状态码。原则：用户能看懂发生了什么、下一步能做什么。
 */

/** 网络层失败的典型特征：fetch 的 TypeError，或各内核的报错文案。 */
const NETWORK_PATTERN = /failed to fetch|fetch failed|networkerror|load failed|err_(connection|name_not_resolved)/i

/**
 * 把任意异常转成用户可读的一句话。
 *
 * @param {unknown} caught 异常对象
 * @param {{ fallback?: string, online?: boolean }} options
 *   online 默认取 navigator.onLine；注入是为了可测试（Node 里没有 navigator）
 */
export function friendlyError(caught, { fallback = '出了点问题，请稍后重试', online } = {}) {
  const isOnline = online ?? (typeof navigator === 'undefined' ? true : navigator.onLine)
  if (!isOnline) return '当前处于离线状态，联网后即可获取最新数据'

  const message = String(caught?.message || '')
  const name = caught?.name || ''

  if (name === 'ApiError') {
    const status = Number(caught.status)
    if (status === 401) return '登录已过期，请退出后重新登录'
    // 「请求失败（HTTP xxx）」是 client.js 没拿到服务端 msg 时的兜底拼接；
    // 服务端给了 msg 就信它（那里写的是人话）
    if (!message || /^请求失败/.test(message)) {
      return status ? `请求失败（HTTP ${status}），请稍后重试` : fallback
    }
    return message
  }

  if (name === 'AbortError') return '请求已取消，请重试'
  if (name === 'TypeError' || NETWORK_PATTERN.test(message)) {
    return '网络连接失败，请检查网络后重试'
  }

  return message || fallback
}
