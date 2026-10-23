import { Hono } from 'hono'
import { ApiError, readJson } from '../http.js'
import { resolveResourceDownload } from '../services/resources.js'
import { fetchTimetable } from '../services/timetable.js'

/**
 * 本站自己的业务接口。
 *
 * 约定：sessionId 走请求体，不放在 query 里——query 会进访问日志和 Referer。
 */
export function createApiRoutes({ getSessionStore }) {
  const routes = new Hono()

  routes.post('/ucloud/resource/download', async (c) => {
    const { sessionId, resourceId } = await readJson(c.req.raw)

    const session = await getSessionStore().get(sessionId)
    if (!session || session.kind !== 'ucloud') {
      throw new ApiError(401, { stage: 'ucloud-auth', msg: '云邮登录已过期，请重新登录' })
    }

    const fileUrl = await resolveResourceDownload({
      token: session.accessToken,
      resourceId,
    })

    return c.json({ success: true, data: { fileUrl } })
  })

  routes.post('/jwgl/timetable', async (c) => {
    const { sessionId, week, mode } = await readJson(c.req.raw)

    const store = getSessionStore()
    const session = await store.get(sessionId)
    if (!session || session.kind !== 'jwgl') {
      throw new ApiError(401, { stage: 'jwgl-auth', msg: '教务登录已过期，请重新登录' })
    }

    let result
    try {
      result = await fetchTimetable({ cookies: session.cookies, week, mode })
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) await store.delete(sessionId)
      throw error
    }

    if (result.cookies !== session.cookies) {
      await store.set(sessionId, { ...session, cookies: result.cookies })
    }

    return c.json({ success: true, data: { timetable: result.timetable } })
  })

  return routes
}
