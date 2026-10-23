/**
 * 跨域配置。
 *
 * 前端部署在 GitHub Pages，后端在另一个域名，必须显式放行。
 * 匹配用的是 origin（协议 + 域名 + 端口），不含路径——把
 * `https://user.github.io/BUPT-week/` 填进 CORS_ORIGINS 是常见错误，
 * 那样永远匹配不上。
 */

const ALLOWED_METHODS = 'GET, POST, OPTIONS'
const ALLOWED_HEADERS = 'Content-Type'

/**
 * 计算某个 origin 对应的 CORS 响应头。
 *
 * 抽成纯函数是因为有两条消费路径：
 *   1. backendCors 中间件，服务走 c.json() 的普通接口
 *   2. /file 代理，直接返回上游 Response
 * Hono 里 handler 返回原始 Response 时，中间件用 c.header() 设的头会被丢掉，
 * 所以代理必须自己算一遍。两处共用同一个函数，避免规则漂移。
 *
 * @param {string} origin 请求头里的 Origin，可能为空
 * @param {string[]} allowedOrigins 配置允许的来源
 * @returns {Record<string, string>} 不允许时返回空对象
 */
export function corsHeadersFor(origin, allowedOrigins = []) {
  if (!origin || !allowedOrigins.includes(origin)) return {}

  return {
    'Access-Control-Allow-Origin': origin,
    'Access-Control-Allow-Methods': ALLOWED_METHODS,
    'Access-Control-Allow-Headers': ALLOWED_HEADERS,
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  }
}

export function backendCors(allowedOrigins = []) {
  return async (c, next) => {
    for (const [name, value] of Object.entries(
      corsHeadersFor(c.req.header('Origin') || '', allowedOrigins),
    )) {
      c.header(name, value)
    }
    // 未命中白名单也要带 Vary：共享缓存可能把「无 CORS 头」的响应原样发给
    // 放行来源，让对方的合法跨域请求拿不到 CORS 头而失败。
    if (!c.req.header('Origin') || !allowedOrigins.includes(c.req.header('Origin'))) {
      c.header('Vary', 'Origin')
    }

    if (c.req.method === 'OPTIONS') return c.body(null, 204)

    await next()
  }
}
