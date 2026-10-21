export const USER_AGENT = 'Mozilla/5.0'

/**
 * 确保请求带 User-Agent。
 *
 * 学校的 CAS（Apereo）会**直接拒绝没有 User-Agent 的请求**：
 *   java.lang.IllegalStateException: Request does not specify a user-agent
 *   at org.apereo.cas.web.support.DefaultCasCookieVal...
 *
 * Node 的 undici fetch 会发默认 UA，所以本机一切正常；
 * **Cloudflare Workers 的 fetch 不发**，于是整条登录链在 Workers 上静默挂掉——
 * 表现是 CAS 返回 500，而不是报错，极难查。
 *
 * 所有发往学校域名的请求都过一遍这个函数。
 */
export function withUserAgent(options = {}) {
  const headers = new Headers(options.headers)
  if (!headers.has('User-Agent')) headers.set('User-Agent', USER_AGENT)
  return { ...options, headers }
}
