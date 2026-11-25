import { Hono } from 'hono'
import { ApiError, readJson } from '../http.js'
import { createLoginRateLimiter } from '../rate-limit.js'
import { prepareSource } from '../services/source-input.js'

export async function requireUcloudSession(store, sessionId) {
  const session = await store.get(sessionId)
  if (!session || session.kind !== 'ucloud' || !session.username) {
    throw new ApiError(401, { stage: 'ucloud-auth', msg: '云邮登录已过期，请重新登录' })
  }
  return session
}

/** 网页协议保持兼容；业务读写统一交给事务服务。 */
export function createClassesRoutes({ getSessionStore, getBusinessService }) {
  const routes = new Hono()
  const actions = {
    '/classes/create': 'create', '/classes/join': 'join', '/classes/list': 'list',
    '/classes/assignments': 'listAssignments', '/classes/assignment/add': 'addAssignment',
    '/classes/assignment/delete': 'deleteAssignment', '/classes/dissolve': 'dissolve',
    '/classes/sources': 'listSources', '/classes/source/add': 'addSource', '/classes/source/remove': 'removeSource',
  }
  const limitJoin = createLoginRateLimiter()
  for (const [path, action] of Object.entries(actions)) {
    const handler = async (c) => {
      const { sessionId, classId, ...input } = await readJson(c.req.raw)
      const { username } = await requireUcloudSession(getSessionStore(), sessionId)
      const service = getBusinessService()
      if (action === 'addSource') {
        await service.call('sourceAccess', { username, classId })
        input.source = await prepareSource(input)
      }
      const data = await service.call(action, { username, classId, input })
      return c.json({ success: true, data })
    }
    routes.post(path, action === 'join' ? limitJoin(handler) : handler)
  }
  return routes
}
