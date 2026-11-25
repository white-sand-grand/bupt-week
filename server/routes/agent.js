import { Hono } from 'hono'
import { ApiError, readJson } from '../http.js'
import { createRequestRateLimiter } from '../rate-limit.js'
import { requireUcloudSession } from './classes.js'
import { prepareSource } from '../services/source-input.js'
import { agentOpenApi } from '../agent-openapi.js'

const INPUT_FIELDS = {
  create: ['name', 'password', 'dryRun'], join: ['code', 'password', 'dryRun'],
  addAssignment: ['title', 'subject', 'content', 'deadline', 'externalId', 'dryRun'],
  addSource: ['type', 'url', 'name', 'dryRun'],
}

export function createAgentRoutes({ getSessionStore, getBusinessService }) {
  const routes = new Hono()
  const limitInvalidCalls = createRequestRateLimiter({ maxRequests: 120, windowMs: 60_000 })
  const limitKeyCreation = createRequestRateLimiter({ maxRequests: 10, windowMs: 60_000 })

  routes.get('/v1/openapi.json', (c) => c.json(agentOpenApi))

  for (const [path, action] of [['list', 'listGrants'], ['create', 'createGrant'], ['revoke', 'revokeGrant']]) {
    const handler = async (c) => {
      const { sessionId, ...input } = await readJson(c.req.raw)
      const { username } = await requireUcloudSession(getSessionStore(), sessionId)
      if (Object.keys(input).some((key) => !['name', 'scopes', 'classIds', 'days', 'id'].includes(key))) {
        throw new ApiError(400, { code: 'INVALID_INPUT', msg: '授权管理不接受学校账号或密码等额外字段' })
      }
      return c.json({ success: true, data: await getBusinessService().call(action, { username, input }) })
    }
    routes.post(`/keys/${path}`, action === 'createGrant' ? limitKeyCreation(handler) : handler)
  }

  const definitions = [
    ['get', '/v1/me', 'me'], ['get', '/v1/classes', 'list'], ['post', '/v1/classes', 'create'],
    ['post', '/v1/classes/join', 'join'],
    ['get', '/v1/classes/:classId/assignments', 'listAssignments'], ['post', '/v1/classes/:classId/assignments', 'addAssignment'],
    ['get', '/v1/classes/:classId/sources', 'listSources'], ['post', '/v1/classes/:classId/sources', 'addSource'],
  ]
  for (const [method, path, action] of definitions) {
    routes[method](path, limitInvalidCalls(async (c) => {
      const key = c.req.header('Authorization')?.match(/^Bearer (.+)$/i)?.[1] || ''
      const input = method === 'post' ? await readJson(c.req.raw) : {}
      if (Object.keys(input).some((field) => !INPUT_FIELDS[action]?.includes(field))
        || input.dryRun !== undefined && typeof input.dryRun !== 'boolean') {
        throw new ApiError(400, { code: 'INVALID_INPUT', msg: '请求包含未知字段或 dryRun 格式不正确；此 API 不接收学校账号密码' })
      }
      const classId = c.req.param('classId')
      const service = getBusinessService()
      const request = { key, action, classId, input, idempotencyKey: c.req.header('Idempotency-Key') || '' }
      let result
      if (action === 'addSource') {
        // 先鉴权、全局计数和查询重放，再访问 GitHub；网络失败也占额度。
        result = await service.call('agent', { ...request, prepareOnly: true })
        if (result.prepare) {
          input.source = await prepareSource(input)
          // 提交时重新验证 Key 和成员身份；请求不能伪造内部 rateChecked 标记。
          result = await service.call('agent', { ...request, rateChecked: true })
        }
      } else result = await service.call('agent', request)
      if (result.error?.retryAfter) c.header('Retry-After', String(result.error.retryAfter))
      return c.json(result.error || { success: true, data: result.data }, result.status)
    }))
  }
  return routes
}
