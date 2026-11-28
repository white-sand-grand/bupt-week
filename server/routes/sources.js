import { Hono } from 'hono'
import { ApiError, readJson } from '../http.js'
import { createRequestRateLimiter } from '../rate-limit.js'
import { isAdmitted } from '../admission.js'
import { getGithubFile, getGithubRepository, listGithubContents } from '../services/github.js'

export function createSourcesRoutes({ allowedOrigins = [] } = {}) {
  const routes = new Hono()

  // 匿名入口，每次命中都打第三方或流式转发大文件：按来源限请求次数，
  // 防止单一客户端打满共享的 GitHub 匿名配额（60 次/小时按出口 IP 计）、
  // 把下载当带宽中继或刷爆 BYR 的搜索接口。浏览器跨站引用由来源准入挡；
  // 非浏览器直连由这一层限速加 Cloudflare WAF 规则兜底（docs/deployment.md）。
  const limitBrowse = createRequestRateLimiter({ maxRequests: 60, windowMs: 60_000 })
  const limitDownload = createRequestRateLimiter({ maxRequests: 20, windowMs: 60_000 })

  function admit(c) {
    const own = new URL(c.req.url)
    if (!isAdmitted(c.req.raw, allowedOrigins, `${own.protocol}//${own.host}`)) {
      throw new ApiError(403, '来源不在白名单内，拒绝代理该请求')
    }
  }

  routes.post('/github', limitBrowse(async (c) => {
    admit(c)
    const { url } = await readJson(c.req.raw)
    const repository = await getGithubRepository(url)
    return c.json({ success: true, data: { repository } })
  }))

  routes.get('/github/contents', limitBrowse(async (c) => {
    admit(c)
    const data = await listGithubContents(c.req.query())
    return c.json({ success: true, data })
  }))

  routes.get('/github/download', limitDownload(async (c) => {
    admit(c)
    const { response, filename } = await getGithubFile(c.req.query())
    // c.body 保留中间件设置的 CORS / 安全头；仅复制文件长度，不转发 Cookie 等上游头。
    c.header('Content-Type', 'application/octet-stream')
    c.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
    if (!response.headers.has('content-encoding') && response.headers.has('content-length')) {
      c.header('Content-Length', response.headers.get('content-length'))
    }
    return c.body(response.body)
  }))

  return routes
}
