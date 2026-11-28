import { ApiError } from '../http.js'
import { hashPassword, newSalt, verifyPassword } from './password-hash.js'

const YEAR = 365 * 86400000
const ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
const text = (value) => typeof value === 'string' ? value.trim() : ''

export function inputError(msg) {
  return new ApiError(400, { stage: 'class-input', code: 'INVALID_INPUT', msg })
}

export function requiredText(value, max, label) {
  const clean = text(value)
  if (!clean || clean.length > max) throw inputError(`${label}需要 1-${max} 个字`)
  return clean
}

export async function saveRecord(store, key, value) {
  await store.set(key, { ...value, expiresAt: Date.now() + YEAR })
}

export function validPassword(password) {
  if (typeof password !== 'string' || password.length < 4 || password.length > 32) {
    throw inputError('班级密码需要 4-32 位')
  }
}

export function normalizeDeadline(value, explicit = false) {
  if (value === undefined || value === null || value === '') return ''
  if (typeof value !== 'string') throw inputError('截止时间格式不正确')
  const format = explicit
    ? /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):00(Z|[+-](?:0\d|1[0-4]):[0-5]\d)$/
    : /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2})$/
  const match = value.match(format)
  if (!match) throw inputError(explicit ? '截止时间应为带时区的整分钟时间，例如 2026-11-29T23:59:00+08:00' : '截止时间格式应为 年-月-日 时:分')
  const [, y, m, d, h, minute] = match
  const date = new Date(`${y}-${m}-${d}T00:00:00Z`)
  if (Number(y) < 1900 || date.getUTCMonth() + 1 !== Number(m) || date.getUTCDate() !== Number(d)
    || Number(h) > 23 || Number(minute) > 59 || /[+-]14:(?!00)/.test(value)) {
    throw inputError('截止时间不是有效日期')
  }
  if (!explicit) return value.replace('T', ' ')
  const instant = Date.parse(value)
  if (!Number.isFinite(instant)) throw inputError('截止时间不是有效日期')
  return new Date(instant + 8 * 3600000).toISOString().slice(0, 16).replace('T', ' ')
}

export function assignmentInput(input, explicit = false) {
  return {
    title: requiredText(input.title, 100, '作业标题'),
    subject: requiredText(input.subject, 40, '科目'),
    content: requiredText(input.content, 2000, '作业内容'),
    deadline: normalizeDeadline(input.deadline, explicit),
  }
}

/** 所有操作都由 BusinessService 放在同一个事务内，网页和 Agent 共用。 */
export class ClassRecords {
  constructor(store, username) {
    this.store = store
    this.username = username
  }

  async load(classId, member = true) {
    if (typeof classId !== 'string' || !classId || classId.length > 128) throw inputError('班级标识不正确')
    const record = await this.store.get(`class:${classId}`)
    if (!record || record.id !== classId) throw new ApiError(404, { stage: 'class-not-found', code: 'RESOURCE_NOT_FOUND', msg: '班级不存在或已被回收' })
    if (member && !(await this.members(classId)).includes(this.username)) {
      throw new ApiError(403, { stage: 'class-member', code: 'INSUFFICIENT_SCOPE', msg: '你还不是这个班级的成员' })
    }
    return record
  }

  async members(id) { return (await this.store.get(`class:${id}:members`))?.members || [] }
  async assignments(id) { return (await this.store.get(`class:${id}:assigns`))?.assignments || [] }

  async ids() {
    const ids = (await this.store.get(`user:${this.username}:classes`))?.ids || []
    const alive = []
    for (const id of ids) if (await this.store.get(`class:${id}`)) alive.push(id)
    if (alive.length !== ids.length) await saveRecord(this.store, `user:${this.username}:classes`, { ids: alive })
    return alive
  }

  async list() {
    const classes = []
    for (const id of await this.ids()) {
      const record = await this.load(id)
      classes.push({ classId: id, code: record.code, name: record.name, createdBy: record.createdBy,
        createdAt: record.createdAt, memberCount: (await this.members(id)).length })
    }
    return { classes }
  }

  async create(input, dryRun = false) {
    const name = requiredText(input.name, 40, '班级名称')
    validPassword(input.password)
    const mine = await this.ids()
    if (mine.length >= 8) throw inputError('最多创建 8 个班级')
    if (dryRun) return { dryRun: true, name }
    const classId = crypto.randomUUID()
    let code
    for (let attempt = 0; attempt < 6; attempt += 1) {
      code = [...crypto.getRandomValues(new Uint8Array(10))].map((b) => ALPHABET[b % ALPHABET.length]).join('')
      if (!(await this.store.get(`code:${code}`))) break
      code = ''
    }
    if (!code) throw new ApiError(503, { msg: '班级号暂时无法分配，请重试', code: 'TEMPORARILY_UNAVAILABLE' })
    const salt = await newSalt()
    const passHash = await hashPassword(input.password, salt)
    await saveRecord(this.store, `class:${classId}`, { id: classId, code, name, salt, passHash, createdBy: this.username, createdAt: Date.now() })
    await saveRecord(this.store, `class:${classId}:members`, { members: [this.username] })
    await saveRecord(this.store, `code:${code}`, { classId })
    await saveRecord(this.store, `user:${this.username}:classes`, { ids: [...mine, classId] })
    return { classId, code, name }
  }

  async join(input, dryRun = false) {
    const code = text(input.code).toUpperCase()
    if (!/^(?:[2-9A-HJ-NP-Z]{8}|[2-9A-HJ-NP-Z]{10})$/.test(code)) throw inputError('班级号是 10 位字母数字（不含 0/O/1/I/L）')
    const index = await this.store.get(`code:${code}`)
    if (!index?.classId) throw new ApiError(404, { stage: 'class-not-found', code: 'RESOURCE_NOT_FOUND', msg: '没有这个班级号，请核对后再试' })
    const record = await this.load(index.classId, false)
    validPassword(input.password)
    if (!(await verifyPassword(input.password, record.salt, record.passHash))) {
      throw new ApiError(401, { stage: 'class-password', code: 'CLASS_JOIN_DENIED', msg: '班级密码不对' })
    }
    const members = await this.members(record.id)
    const mine = await this.ids()
    if (!members.includes(this.username) && members.length >= 100) throw inputError('这个班级人数已满（100 人）')
    if (!mine.includes(record.id) && mine.length >= 8) throw inputError('最多加入 8 个班级')
    if (dryRun) return { dryRun: true, classId: record.id, name: record.name }
    await saveRecord(this.store, `class:${record.id}:members`, { members: [...new Set([...members, this.username])] })
    await saveRecord(this.store, `user:${this.username}:classes`, { ids: [...new Set([...mine, record.id])] })
    return { classId: record.id, name: record.name }
  }

  async changePassword(classId, input) {
    const record = await this.load(classId, false)
    if (record.createdBy !== this.username) {
      throw new ApiError(403, { stage: 'class-member', code: 'INSUFFICIENT_SCOPE', msg: '只有班级创建者可以修改加入密码' })
    }
    validPassword(input.password)
    const salt = await newSalt()
    const passHash = await hashPassword(input.password, salt)
    await saveRecord(this.store, `class:${classId}`, { ...record, salt, passHash })
    return { classId }
  }

  async listAssignments(classId) {
    const record = await this.load(classId)
    return { assignments: (await this.assignments(classId)).map((item) => ({
      id: item.id, assignmentTitle: item.title, chapterName: item.subject,
      siteId: `class:${classId}`, siteName: record.name,
      assignmentBeginTime: '', assignmentEndTime: item.deadline || '', submitTime: '', assignmentStatus: 99,
      content: item.content, createdBy: item.createdBy, createdAt: item.createdAt,
      createdVia: item.createdVia || 'web', automationName: item.automationName || '',
    })) }
  }

  async addAssignment(classId, input, { dryRun = false, explicit = false, grant } = {}) {
    await this.load(classId)
    const clean = assignmentInput(input, explicit)
    const externalId = input.externalId === undefined ? '' : requiredText(input.externalId, 128, '外部记录标识')
    const assignments = await this.assignments(classId)
    const existing = externalId && assignments.find((item) => item.externalId === externalId && item.createdBy === this.username)
    if (existing && JSON.stringify(assignmentInput(existing)) !== JSON.stringify(clean)) {
      throw new ApiError(409, { code: 'EXTERNAL_ID_CONFLICT', msg: '这条通知已录入，但内容不同，请先查询原作业' })
    }
    if (!existing && assignments.length >= 200) throw inputError('这个班级的作业已到上限（200 条）')
    const deadline = clean.deadline ? clean.deadline.replace(' ', 'T') + ':00+08:00' : null
    if (dryRun) return { dryRun: true, classId, ...clean, deadline, duplicate: Boolean(existing) }
    if (existing) return { assignmentId: existing.id, classId, subject: clean.subject, deadline, replayed: true }
    const assignmentId = crypto.randomUUID()
    await saveRecord(this.store, `class:${classId}:assigns`, { assignments: [...assignments, {
      id: assignmentId, ...clean, externalId, createdBy: this.username, createdAt: Date.now(),
      createdVia: grant ? 'agent' : 'web', ...(grant ? { automationId: grant.id, automationName: grant.name } : {}),
    }] })
    return { assignmentId, classId, subject: clean.subject, deadline, replayed: false }
  }

  async deleteAssignment(classId, assignmentId) {
    const record = await this.load(classId)
    const assignments = await this.assignments(classId)
    const target = assignments.find((item) => item.id === assignmentId)
    if (!target) throw new ApiError(404, { stage: 'class-not-found', msg: '这条作业不存在或已被删除' })
    if (target.createdBy !== this.username && record.createdBy !== this.username) {
      throw new ApiError(403, { stage: 'class-member', msg: '只有班级创建者或录入者可以删除这条作业' })
    }
    await saveRecord(this.store, `class:${classId}:assigns`, { assignments: assignments.filter((item) => item.id !== assignmentId) })
    return {}
  }

  async dissolve(classId) {
    const record = await this.load(classId, false)
    if (record.createdBy !== this.username) throw new ApiError(403, { stage: 'class-member', msg: '只有班级创建者可以解散班级' })
    for (const username of await this.members(classId)) {
      const key = `user:${username}:classes`
      const ids = ((await this.store.get(key))?.ids || []).filter((id) => id !== classId)
      if (ids.length) await saveRecord(this.store, key, { ids })
      else await this.store.delete(key)
    }
    for (const key of [`class:${classId}`, `class:${classId}:assigns`, `class:${classId}:members`, `class:${classId}:sources`, `code:${record.code}`]) {
      await this.store.delete(key)
    }
    return {}
  }

  async listSources(classId) {
    await this.load(classId)
    return { sources: (await this.store.get(`class:${classId}:sources`))?.sources || [] }
  }

  async addSource(classId, source, { dryRun = false, grant } = {}) {
    const { sources } = await this.listSources(classId)
    const existing = sources.find((item) => item.type === source.type
      && (item.type === 'github' ? item.url.toLowerCase() === source.url.toLowerCase() : item.url === source.url))
    if (!existing && sources.length >= 100) throw inputError('这个班级的资料源已到上限（100 条）')
    if (dryRun) return { dryRun: true, classId, source, duplicate: Boolean(existing) }
    if (existing) return { source: existing, replayed: true }
    const saved = { ...source, id: crypto.randomUUID(), createdBy: this.username, createdAt: Date.now(),
      createdVia: grant ? 'agent' : 'web', ...(grant ? { automationId: grant.id, automationName: grant.name } : {}) }
    await saveRecord(this.store, `class:${classId}:sources`, { sources: [...sources, saved] })
    return { source: saved, replayed: false }
  }

  async removeSource(classId, sourceId) {
    const record = await this.load(classId)
    const { sources } = await this.listSources(classId)
    const source = sources.find((item) => item.id === sourceId)
    if (!source) throw new ApiError(404, { msg: '资料源不存在' })
    if (source.createdBy !== this.username && record.createdBy !== this.username) throw new ApiError(403, { msg: '只有班级创建者或添加者可以移除资料源' })
    await saveRecord(this.store, `class:${classId}:sources`, { sources: sources.filter((item) => item.id !== sourceId) })
    return {}
  }
}
