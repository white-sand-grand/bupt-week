import { serve } from '@hono/node-server'
import { createBackend } from '../app.js'
import { FileBusinessStore, FileSessionStore } from '../storage/file.js'

const port = Number(process.env.PORT || 8787)
// 默认只绑回环。会话里存着上游 Cookie 和 token，不要暴露到局域网。
const hostname = process.env.HOST || '127.0.0.1'

const allowedOrigins = String(process.env.CORS_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)

// 会话落到项目目录的 .sessions.local.d/，旧 .sessions.local 首次访问时自动迁移。
// 班级与 Agent 授权使用独立原子快照，旧班级键从会话存储只读迁入。
// 同一目录只由一个实例写入；学校凭证不复制到业务快照。
const store = new FileSessionStore()
const businessStore = new FileBusinessStore(undefined, store)

const app = createBackend({
  getSessionStore: () => store,
  getClassStore: () => businessStore,
  allowedOrigins,
  // 企业微信登录成功后跳回前端；不设则按 Referer 推断
  frontendUrl: process.env.FRONTEND_URL || '',
})

serve({
  // Node 形态没有 Cloudflare 覆写，CF-Connecting-IP 是客户端想写就写的头；
  // 限流若信它，随机伪造一串就次次新桶。剥掉，限流改读适配器 env 中的
  // incoming.socket.remoteAddress；直接部署按连接来源隔离。
  fetch: (request, ...rest) => {
    request.headers.delete('CF-Connecting-IP')
    return app.fetch(request, ...rest)
  },
  hostname,
  port,
}, () => {
  console.log(`[backend] listening on http://${hostname}:${port}`)
  if (allowedOrigins.length === 0) {
    console.log('[backend] 未设置 CORS_ORIGINS，跨域请求会被拒绝（本机同源开发不受影响）')
  }
})
