import { ApiError } from './http.js'

const WINDOW_MS = 10 * 60_000
const MAX_FAILURES = 10

/**
 * 登录失败限速（进程内固定窗口计数，按来源 IP）。
 *
 * 登录接口部署在公网、无需认证、直通学校 CAS，不加限制就是一个现成的
 * 密码试探入口。这里挡的是单一来源的低成本爆破；分布式攻击和 Workers
 * 多 isolate 各自计数的场景挡不住，那一层要靠 Cloudflare 的 WAF 限速规则
 * （见 docs/deployment.md）。
 *
 * 只数 401（密码确实不对）：成功登录、400（参数缺失）不占额度，
 * 正常用户输错几次不会被锁。
 *
 * 注意必须是**包装 handler** 而不是中间件：Hono 注册了 onError 之后，
 * handler 抛出的异常由 compose 直接送进 onError，不会回流过前置中间件，
 * 中间件里根本数不到失败。
 *
 * @returns {(handler: Function) => Function} 包一层路由 handler
 */
export function createLoginRateLimiter({ windowMs = WINDOW_MS, maxFailures = MAX_FAILURES } = {}) {
  const failures = new Map()

  function prune(now) {
    for (const [key, bucket] of failures) {
      if (bucket.expiresAt <= now) failures.delete(key)
    }
  }

  return (handler) => async (c) => {
    // Workers 上该头由 Cloudflare 覆写、不可伪造；本机入口只有回环流量。
    const key = c.req.header('CF-Connecting-IP') || 'local'
    const now = Date.now()
    prune(now)

    const bucket = failures.get(key)
    if (bucket && bucket.count >= maxFailures) {
      throw new ApiError(429, { stage: 'rate-limit', msg: '登录尝试太多，请稍后再试' })
    }

    try {
      return await handler(c)
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        if (bucket && bucket.expiresAt > now) bucket.count += 1
        else failures.set(key, { count: 1, expiresAt: now + windowMs })
      }
      throw error
    }
  }
}
