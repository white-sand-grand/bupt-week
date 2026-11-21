import { Hono } from 'hono'
import { readJson } from '../http.js'
import { getGithubFile, getGithubRepository, listGithubContents } from '../services/github.js'

export function createSourcesRoutes() {
  const routes = new Hono()

  routes.post('/github', async (c) => {
    const { url } = await readJson(c.req.raw)
    const repository = await getGithubRepository(url)
    return c.json({ success: true, data: { repository } })
  })

  routes.get('/github/contents', async (c) => {
    const data = await listGithubContents(c.req.query())
    return c.json({ success: true, data })
  })

  routes.get('/github/download', async (c) => {
    const { response, filename } = await getGithubFile(c.req.query())
    // c.body 保留中间件设置的 CORS / 安全头；仅复制文件长度，不转发 Cookie 等上游头。
    c.header('Content-Type', 'application/octet-stream')
    c.header('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(filename)}`)
    if (!response.headers.has('content-encoding') && response.headers.has('content-length')) {
      c.header('Content-Length', response.headers.get('content-length'))
    }
    return c.body(response.body)
  })

  return routes
}
