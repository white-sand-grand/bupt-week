import { Hono } from 'hono'
import { ApiError, readJson } from '../http.js'
import { resolveResourceDownload } from '../services/resources.js'
import { fetchTimetable } from '../services/timetable.js'
import { fetchTimetableWeixin } from '../services/jwglweixin.js'
import { getAssignmentDetail, listAssignmentsWithCourses, listCourses } from '../services/assignments.js'
import { listCoursewareTree } from '../services/courseware.js'
import { slideSessionExpiry } from './auth.js'
import { deleteSessionIfUnchanged } from '../session-guard.js'

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
    if (!session || (session.kind !== 'jwgl' && session.kind !== 'jwglweixin')) {
      throw new ApiError(401, { stage: 'jwgl-auth', msg: '教务登录已过期，请重新登录' })
    }

    // 移动教务（主源）：token 会话，无 mode 概念（前端传来的固定值直接忽略）
    if (session.kind === 'jwglweixin') {
      let result
      try {
        result = await fetchTimetableWeixin({ token: session.token, week })
      } catch (error) {
        if (error instanceof ApiError && error.status === 401) {
          // 迟到的 401 不能删掉并发请求刚续期回写的会话（见 session-guard）
          await deleteSessionIfUnchanged(store, sessionId, session)
        }
        throw error
      }
      return c.json({ success: true, data: { timetable: result.timetable } })
    }

    let result
    try {
      result = await fetchTimetable({ cookies: session.cookies, week, mode })
    } catch (error) {
      if (error instanceof ApiError && error.status === 401) {
        await deleteSessionIfUnchanged(store, sessionId, session)
      }
      throw error
    }

    if (result.cookies !== session.cookies) {
      await store.set(sessionId, { ...session, cookies: result.cookies })
    }

    return c.json({ success: true, data: { timetable: result.timetable } })
  })

  routes.post('/ucloud/assignments', async (c) => {
    const { sessionId } = await readJson(c.req.raw)

    const store = getSessionStore()
    const session = await store.get(sessionId)
    if (!session || session.kind !== 'ucloud') {
      throw new ApiError(401, { stage: 'ucloud-auth', msg: '云邮登录已过期，请重新登录' })
    }

    const records = await listAssignmentsWithCourses({ token: session.accessToken, userId: session.userId })

    // 正常使用即续命：作业拉取成功说明会话活着，滑动续期（剩余充足时零写入）
    const slid = slideSessionExpiry(session)
    if (slid !== session) await store.set(sessionId, slid)

    return c.json({ success: true, data: { assignments: records } })
  })

  routes.post('/ucloud/assignment/detail', async (c) => {
    const { sessionId, assignmentId } = await readJson(c.req.raw)

    const session = await getSessionStore().get(sessionId)
    if (!session || session.kind !== 'ucloud') {
      throw new ApiError(401, { stage: 'ucloud-auth', msg: '云邮登录已过期，请重新登录' })
    }

    const detail = await getAssignmentDetail({ token: session.accessToken, assignmentId })
    return c.json({ success: true, data: detail })
  })

  /** 课件视图的课程下拉。作业回填用的是同一服务函数，形状 [{ id, name }]。 */
  routes.post('/ucloud/courses', async (c) => {
    const { sessionId } = await readJson(c.req.raw)

    const session = await getSessionStore().get(sessionId)
    if (!session || session.kind !== 'ucloud') {
      throw new ApiError(401, { stage: 'ucloud-auth', msg: '云邮登录已过期，请重新登录' })
    }

    const courses = await listCourses({ token: session.accessToken, userId: session.userId })
    return c.json({ success: true, data: { courses } })
  })

  /** 一门课的课件资料树。userId 从会话取，不信任前端传的。 */
  routes.post('/ucloud/courseware', async (c) => {
    const { sessionId, siteId } = await readJson(c.req.raw)

    const session = await getSessionStore().get(sessionId)
    if (!session || session.kind !== 'ucloud') {
      throw new ApiError(401, { stage: 'ucloud-auth', msg: '云邮登录已过期，请重新登录' })
    }
    if (!siteId) throw new ApiError(400, '缺少课程 ID')

    const tree = await listCoursewareTree({
      token: session.accessToken,
      siteId,
      userId: session.userId,
    })
    return c.json({ success: true, data: { tree } })
  })

  return routes
}
