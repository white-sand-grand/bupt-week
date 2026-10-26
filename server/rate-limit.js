import { ApiError } from './http.js'

const WINDOW_MS = 10 * 60_000
const MAX_FAILURES = 10

function sourceIp(c) {
  // Node 用适配器提供的连接地址；Workers 用 Cloudflare 覆写的来源头。
  // 转发头在 Node 可由客户端伪造，不能用于覆盖真实连接地址。
  return c.env?.incoming?.socket?.remoteAddress || c.req.header('CF-Connecting-IP') || 'local'
}

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
    const key = sourceIp(c)
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
        // 计数必须在 catch 里重读重判：进门的桶引用是 await 之前捕获的，
        // 并发失败各自拿旧引用回写会互相覆盖——突刺全免单、计数还被重置
        const nowAfter = Date.now()
        const current = failures.get(key)
        if (current && current.expiresAt > nowAfter) current.count += 1
        else failures.set(key, { count: 1, expiresAt: nowAfter + windowMs })
      }
      throw error
    }
  }
}

/**
 * 请求级限速（不分成败，每次命中都计数）。
 *
 * 给无需认证、但每次命中都会写存储或打上游的匿名入口用（如企微 start：
 * 每次都写一条 KV，脚本耗尽每日写配额后全站登录跟着失败）。
 */
export function createRequestRateLimiter({ windowMs = WINDOW_MS, maxRequests = 30 } = {}) {
  const counts = new Map()

  return (handler) => async (c) => {
    const key = sourceIp(c)
    const now = Date.now()
    for (const [k, bucket] of counts) {
      if (bucket.expiresAt <= now) counts.delete(k)
    }

    const bucket = counts.get(key)
    const count = bucket && bucket.expiresAt > now ? bucket.count + 1 : 1
    if (count > maxRequests) {
      throw new ApiError(429, { stage: 'rate-limit', msg: '请求太频繁，请稍后再试' })
    }
    if (bucket && bucket.expiresAt > now) bucket.count = count
    else counts.set(key, { count, expiresAt: now + windowMs })

    return handler(c)
  }
}
