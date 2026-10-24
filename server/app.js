import { Hono } from 'hono'
import { ApiError } from './http.js'
import { backendCors } from './cors.js'
import { mountProxyRoutes } from './routes/proxy.js'
import { createApiRoutes } from './routes/api.js'
import { createAuthRoutes } from './routes/auth.js'
import { createClassesRoutes } from './routes/classes.js'

/**
 * 后端应用工厂。
 *
 * Node 入口和 Workers 入口调用的是同一个函数，代码不分支。
 * 环境差异（文件系统 / KV / 监听端口）全部由入口注入。
 *
 * @param {{ getSessionStore?: object, getClassStore?: object, allowedOrigins?: string[], frontendUrl?: string }} options
 */
export function createBackend({ getSessionStore = null, getClassStore = null, allowedOrigins = [], frontendUrl = '' } = {}) {
  const app = new Hono()

  app.use('*', backendCors(allowedOrigins))
  app.use('/api/*', async (c, next) => {
    // 接口响应一律不缓存，避免代理层把登录态相关的数据缓存下来。
    c.header('Cache-Control', 'no-store')
    // 基础加固：MIME 嗅探关闭、referrer 不外泄（接口域名不该出现在下游站点的来源里）
    c.header('X-Content-Type-Options', 'nosniff')
    c.header('Referrer-Policy', 'no-referrer')
    await next()
  })

  app.get('/api/health', (c) =>
    c.json({ success: true, data: { ok: true, now: new Date().toISOString() } }),
  )

  // 业务接口与会话都依赖存储，没注入就不挂——而不是挂上去每次都 401。
  if (getSessionStore) {
    app.route('/api', createApiRoutes({ getSessionStore }))
    app.route('/api', createAuthRoutes({ getSessionStore, frontendUrl, allowedOrigins }))
    if (getClassStore) {
      app.route('/api', createClassesRoutes({ getSessionStore, getClassStore }))
    }
  }

  mountProxyRoutes(app, { allowedOrigins })

  app.notFound((c) => c.json({ success: false, msg: '接口不存在' }, 404))
  app.onError((error, c) => {
    if (error instanceof ApiError) return c.json(error.body, error.status)
    // 未知异常的 message 可能带内部细节（堆栈、上游地址），只进日志不进响应。
    console.error('[backend] 未处理的错误', error)
    return c.json({ success: false, msg: '服务器内部错误，请稍后再试' }, 500)
  })

  return app
}
