import { ApiError } from '../http.js'
import { ClassRecords, inputError, requiredText } from './class-records.js'

const DAY = 86400000
export const AGENT_SCOPES = ['classes:read', 'classes:create', 'classes:join', 'assignments:read', 'assignments:create', 'sources:read', 'sources:create']
const WRITE_ACTIONS = new Set(['create', 'join', 'addAssignment', 'addSource'])
const ACTION_SCOPES = { me: '', list: 'classes:read', create: 'classes:create', join: 'classes:join',
  listAssignments: 'assignments:read', addAssignment: 'assignments:create', listSources: 'sources:read', addSource: 'sources:create' }

export async function digest(value) {
  return [...new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)))].map((v) => v.toString(16).padStart(2, '0')).join('')
}

function equalDigest(a, b) {
  if (typeof a !== 'string' || a.length !== b.length) return false
  let difference = 0
  for (let i = 0; i < a.length; i += 1) difference |= a.charCodeAt(i) ^ b.charCodeAt(i)
  return difference === 0
}

function publicGrant(grant) {
  return { id: grant.id, name: grant.name, scopes: grant.scopes, classIds: grant.classIds,
    createdAt: grant.createdAt, expiresAt: grant.expiresAt }
}

export async function listGrants(store, username) {
  const ids = (await store.get(`user:${username}:agent-keys`))?.ids || []
  const grants = []
  for (const id of ids) {
    const grant = await store.get(`agent:key:${id}`)
    if (grant?.username === username) grants.push(grant)
  }
  return grants
}

export async function createGrant(store, username, input) {
  const name = requiredText(input.name, 40, '授权名称')
  if (!Array.isArray(input.scopes) || !input.scopes.length || input.scopes.some((scope) => !AGENT_SCOPES.includes(scope))) throw inputError('请选择有效的调用权限')
  const scopes = [...new Set(input.scopes)].sort()
  const classIds = input.classIds === null ? null : Array.isArray(input.classIds) ? [...new Set(input.classIds)] : []
  if (classIds !== null) {
    if (!classIds.length || classIds.length > 8 || scopes.some((scope) => scope === 'classes:create' || scope === 'classes:join')) throw inputError('指定班级授权需要选择班级；建班和入班需要账号范围授权')
    const classes = new ClassRecords(store, username)
    for (const id of classIds) await classes.load(id)
  }
  const days = input.days ?? 30
  if (![7, 30, 90].includes(days)) throw inputError('有效期可选 7、30 或 90 天')
  const grants = await listGrants(store, username)
  if (grants.length >= 10) throw inputError('最多保留 10 个有效授权，请先撤销旧授权')
  const id = crypto.randomUUID()
  const secret = [...crypto.getRandomValues(new Uint8Array(32))].map((v) => v.toString(16).padStart(2, '0')).join('')
  const key = `bwk_${id}.${secret}`
  const grant = { id, name, username, scopes, classIds, createdAt: Date.now(), expiresAt: Date.now() + days * DAY, hash: await digest(key) }
  await store.set(`agent:key:${id}`, grant)
  await store.set(`user:${username}:agent-keys`, { ids: [...grants.map((item) => item.id), id], expiresAt: Date.now() + 91 * DAY })
  return { key, grant: publicGrant(grant) }
}

export async function revokeGrant(store, username, id) {
  const grants = await listGrants(store, username)
  if (id !== 'all' && !grants.some((grant) => grant.id === id)) throw new ApiError(404, { msg: '授权不存在' })
  for (const grant of grants) if (id === 'all' || grant.id === id) await store.delete(`agent:key:${grant.id}`)
  const ids = grants.filter((grant) => id !== 'all' && grant.id !== id).map((grant) => grant.id)
  await store.set(`user:${username}:agent-keys`, { ids, expiresAt: Date.now() + 91 * DAY })
  return {}
}

export async function authenticateGrant(store, key) {
  const match = typeof key === 'string' && key.match(/^bwk_([0-9a-f-]{36})\.[0-9a-f]{64}$/)
  const grant = match && await store.get(`agent:key:${match[1]}`)
  if (!grant || !equalDigest(grant.hash, await digest(key))) throw new ApiError(401, { code: 'INVALID_API_KEY', msg: 'Agent Key 无效、过期或已撤销' })
  return grant
}

async function rateLimit(store, grant, write, join) {
  const now = Date.now()
  const key = `agent:rate:${grant.username}`
  const bucket = await store.get(key) || { requests: 0, writes: 0, expiresAt: now + 60_000 }
  if (bucket.requests >= 60 || write && bucket.writes >= 20) throw new ApiError(429, {
    code: 'RATE_LIMITED', msg: '调用太频繁，请稍后再试', retryAfter: Math.max(1, Math.ceil((bucket.expiresAt - now) / 1000)),
  })
  bucket.requests += 1
  if (write) bucket.writes += 1
  await store.set(key, bucket)
  if (join) {
    const failure = await store.get(`agent:join-failures:${grant.username}`)
    if (failure?.count >= 10) throw new ApiError(429, { code: 'RATE_LIMITED', msg: '班级密码尝试太多，请稍后再试', retryAfter: Math.max(1, Math.ceil((failure.expiresAt - now) / 1000)) })
  }
}

export function requireScope(grant, action, classId) {
  const scope = ACTION_SCOPES[action]
  if (scope === undefined) throw new ApiError(404, { code: 'RESOURCE_NOT_FOUND', msg: '接口不存在' })
  if (classId && grant.classIds !== null && !grant.classIds.includes(classId)) throw new ApiError(404, { code: 'RESOURCE_NOT_FOUND', msg: '班级不存在或不在授权范围内' })
  if (scope && !grant.scopes.includes(scope) || (action === 'create' || action === 'join') && grant.classIds !== null) {
    throw new ApiError(403, { code: 'INSUFFICIENT_SCOPE', msg: '此授权没有执行该操作的权限' })
  }
}

function canonical(value) {
  if (Array.isArray(value)) return value.map(canonical)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map((key) => [key, canonical(value[key])]))
  return value
}

async function audit(store, grant, action, classId, status, data) {
  const now = Date.now()
  const key = `agent:audit:${grant.username}`
  const events = ((await store.get(key))?.events || []).filter((event) => event.at > now - 30 * DAY)
  events.push({ at: now, automationId: grant.id, action, classId: classId || data?.classId || '',
    objectId: data?.assignmentId || data?.source?.id || '', status })
  await store.set(key, { events: events.slice(-1000), expiresAt: now + 30 * DAY })
}

/** 在同一事务内鉴权、计数、业务写入和保存重放结果。 */
export async function agentRequest(store, request) {
  const { key, action, classId, input = {}, idempotencyKey = '' } = request
  const grant = await authenticateGrant(store, key)
  const write = WRITE_ACTIONS.has(action)
  const dryRun = input.dryRun === true
  try {
    if (!request.rateChecked) await rateLimit(store, grant, write && !dryRun, action === 'join')
    requireScope(grant, action, classId)
    const classes = new ClassRecords(store, grant.username)
    if (classId) await classes.load(classId)
    if (action === 'me') return { status: 200, data: publicGrant(grant) }
    let replayKey
    let fingerprint
    if (write && !dryRun) {
      if (!/^[\x21-\x7e]{1,128}$/.test(idempotencyKey)) throw inputError('写入需要 1-128 位可打印字符的 Idempotency-Key')
      replayKey = `agent:replay:${grant.id}:${await digest(`${action}:${classId || ''}:${idempotencyKey}`)}`
      const { source, ...originalInput } = input
      fingerprint = await digest(JSON.stringify(canonical({ ...originalInput, dryRun: false })))
      const saved = await store.get(replayKey)
      if (saved) {
        if (saved.fingerprint !== fingerprint) throw new ApiError(409, { code: 'IDEMPOTENCY_CONFLICT', msg: '同一个 Idempotency-Key 对应了不同内容，请先核对原操作' })
        return { status: 200, data: { ...saved.data, replayed: true } }
      }
    }
    if (action === 'addSource' && request.prepareOnly) return { status: 200, prepare: true }
    let data
    if (action === 'list') {
      data = await classes.list()
      if (grant.classIds !== null) data.classes = data.classes.filter((item) => grant.classIds.includes(item.classId))
    } else if (action === 'create') data = await classes.create(input, dryRun)
    else if (action === 'join') data = await classes.join(input, dryRun)
    else if (action === 'listAssignments') data = await classes.listAssignments(classId)
    else if (action === 'addAssignment') data = await classes.addAssignment(classId, input, { dryRun, explicit: true, grant })
    else if (action === 'listSources') data = await classes.listSources(classId)
    else if (action === 'addSource') data = await classes.addSource(classId, input.source, { dryRun, grant })
    const status = write && !dryRun && !data.replayed ? 201 : 200
    if (replayKey) await store.set(replayKey, { data, fingerprint, expiresAt: Date.now() + DAY })
    if (write) await audit(store, grant, action, classId, status, data)
    return { status, data }
  } catch (error) {
    if (!(error instanceof ApiError)) throw error
    if (error.body.code === 'CLASS_JOIN_DENIED') {
      const failureKey = `agent:join-failures:${grant.username}`
      const failure = await store.get(failureKey) || { count: 0, expiresAt: Date.now() + 10 * 60_000 }
      await store.set(failureKey, { ...failure, count: failure.count + 1 })
      error.status = 403
    }
    await audit(store, grant, action, classId, error.status)
    // 校验错误返回后提交失败计数；业务校验在首次修改之前完成。
    return { status: error.status, error: { ...error.body, code: error.body.code || (error.status === 400 ? 'INVALID_INPUT' : 'RESOURCE_NOT_FOUND') } }
  }
}
