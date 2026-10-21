import { serve } from '@hono/node-server'
import { createBackend } from '../app.js'
import { FileSessionStore } from '../storage/file.js'

const port = Number(process.env.PORT || 8787)
// 默认只绑回环。会话里存着上游 Cookie 和 token，不要暴露到局域网。
const hostname = process.env.HOST || '127.0.0.1'

const allowedOrigins = String(process.env.CORS_ORIGINS || '')
  .split(',')
  .map((origin) => origin.trim())
  .filter(Boolean)

// 会话落到项目目录的 .sessions.local，权限 0600，已被 .gitignore 挡住。
// 用工厂而不是直接传实例：FileSessionStore 构造时会读文件，推迟到真正有请求时再打开。
const store = new FileSessionStore()

const app = createBackend({
  getSessionStore: () => store,
  allowedOrigins,
  // 企业微信登录成功后跳回前端；不设则按 Referer 推断
  frontendUrl: process.env.FRONTEND_URL || '',
})

serve({ fetch: app.fetch, hostname, port }, () => {
  console.log(`[backend] listening on http://${hostname}:${port}`)
  if (allowedOrigins.length === 0) {
    console.log('[backend] 未设置 CORS_ORIGINS，跨域请求会被拒绝（本机同源开发不受影响）')
  }
})
