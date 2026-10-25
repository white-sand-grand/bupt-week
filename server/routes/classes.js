import { Hono } from 'hono'
import { ApiError, readJson } from '../http.js'
import { createLoginRateLimiter } from '../rate-limit.js'
import { hashPassword, newSalt, verifyPassword } from '../services/password-hash.js'

/**
 * 班级：手动录入、凭班级号+密码共享作业。
 *
 * 存储（getClassStore，KV/文件/内存均可，接口同 session store）：
 *   class:{id}          班级档案（含密码哈希与盐）
 *   class:{id}:members  成员学号清单
 *   class:{id}:assigns  手动录入的作业数组
 *   code:{code}         班级号 → classId 索引（KV 只能按键取，加入时靠它找班）
 *   user:{username}:classes  我的班级索引
 *
 * 所有值都带 expiresAt（存储层按它判活/续 TTL）；班级被使用即续期，闲置
 * 一年自动回收。清单类数据是读-改-写，并发下最后写入赢——班级规模的
 * 使用频率下可接受，为此上 Durable Object 不值。
 *
 * 身份：所有路由用 ucloud 会话鉴权，成员身份就是会话里的学号（username）。
 */

const CLASS_TTL_MS = 365 * 86400000
// 班级号字符表：去掉易混淆的 0/O/1/I/L，抄进纸条念给人听也不出错
const CODE_ALPHABET = '23456789ABCDEFGHJKMNPQRSTUVWXYZ'
const CODE_LENGTH = 8
const MAX_CLASSES_PER_USER = 8
const MAX_ASSIGNMENTS_PER_CLASS = 200
const MAX_MEMBERS = 100

const text = (value) => (typeof value === 'string' ? value.trim() : '')

/** 每个键的过期时间都跟着班级活跃度走：被读写就续一年。 */
function freshExpiry(record) {
  return { ...record, expiresAt: Date.now() + CLASS_TTL_MS }
}

async function readRecord(store, key) {
  return (await store.get(key)) ?? null
}

async function writeJson(store, key, record) {
  await store.set(key, freshExpiry(record))
}

/** ucloud 会话鉴权：拿不回会话一律 401。 */
async function requireUcloudSession(store, sessionId) {
  const session = await store.get(sessionId)
  if (!session || session.kind !== 'ucloud') {
    throw new ApiError(401, { stage: 'ucloud-auth', msg: '云邮登录已过期，请重新登录' })
  }
  return session
}

async function loadClass(classStore, classId) {
  const record = await readRecord(classStore, `class:${classId}`)
  if (!record || record.id !== classId) {
    throw new ApiError(404, { stage: 'class-not-found', msg: '班级不存在或已被回收' })
  }
  return record
}

async function loadMembers(classStore, classId) {
  const record = await readRecord(classStore, `class:${classId}:members`)
  return Array.isArray(record?.members) ? record.members : []
}

/** 非成员一律 403——班级数据（尤其作业列表）不外泄。 */
async function requireMember(classStore, classId, username) {
  const members = await loadMembers(classStore, classId)
  if (!members.includes(username)) {
    throw new ApiError(403, { stage: 'class-member', msg: '你还不是这个班级的成员' })
  }
}

function makeCode() {
  const bytes = crypto.getRandomValues(new Uint8Array(CODE_LENGTH))
  return [...bytes].map((byte) => CODE_ALPHABET[byte % CODE_ALPHABET.length]).join('')
}

/** 我的班级索引（user:{username}:classes），剔掉已被回收的班级。 */
async function myClassIds(classStore, username) {
  const record = await readRecord(classStore, `user:${username}:classes`)
  const ids = Array.isArray(record?.ids) ? record.ids : []
  const alive = []
  for (const id of ids) {
    if (await classStore.get(`class:${id}`)) alive.push(id)
  }
  if (alive.length !== ids.length) {
    await writeJson(classStore, `user:${username}:classes`, { ids: alive })
  }
  return alive
}

export function createClassesRoutes({ getSessionStore, getClassStore }) {
  const routes = new Hono()
  const limitClassJoin = createLoginRateLimiter()

  routes.post('/classes/create', async (c) => {
    const { sessionId, name, password } = await readJson(c.req.raw)
    const sessionStore = getSessionStore()
    const classStore = getClassStore()
    const session = await requireUcloudSession(sessionStore, sessionId)
    const username = session.username

    const cleanName = text(name)
    if (!cleanName || cleanName.length > 40) {
      throw new ApiError(400, { stage: 'class-input', msg: '班级名称需要 1-40 个字' })
    }
    if (typeof password !== 'string' || password.length < 4 || password.length > 32) {
      throw new ApiError(400, { stage: 'class-input', msg: '班级密码需要 4-32 位' })
    }

    const mine = await myClassIds(classStore, username)
    if (mine.length >= MAX_CLASSES_PER_USER) {
      throw new ApiError(400, { stage: 'class-input', msg: `最多创建 ${MAX_CLASSES_PER_USER} 个班级` })
    }

    const classId = crypto.randomUUID()
    const salt = await newSalt()
    const passHash = await hashPassword(password, salt)

    // 班级号碰撞重试：8 位 31 进制空间约 8500 亿，实际一次就中
    let code = makeCode()
    for (let attempt = 0; (await classStore.get(`code:${code}`)) && attempt < 5; attempt += 1) {
      code = makeCode()
    }

    const createdAt = Date.now()
    await writeJson(classStore, `class:${classId}`, {
      id: classId, code, name: cleanName, passHash, salt, createdAt, createdBy: username,
    })
    await writeJson(classStore, `class:${classId}:members`, { members: [username] })
    await writeJson(classStore, `code:${code}`, { classId })
    await writeJson(classStore, `user:${username}:classes`, { ids: [...mine, classId] })

    return c.json({ success: true, data: { classId, code, name: cleanName } })
  })

  routes.post('/classes/join', limitClassJoin(async (c) => {
    const { sessionId, code, password } = await readJson(c.req.raw)
    const session = await requireUcloudSession(getSessionStore(), sessionId)
    const classStore = getClassStore()
    const username = session.username

    const cleanCode = text(code).toUpperCase()
    if (!/^[2-9A-HJ-NP-Z]{8}$/.test(cleanCode)) {
      throw new ApiError(400, { stage: 'class-input', msg: '班级号是 8 位字母数字（不含 0/O/1/I/L）' })
    }

    const index = await readRecord(classStore, `code:${cleanCode}`)
    if (!index?.classId) {
      throw new ApiError(404, { stage: 'class-not-found', msg: '没有这个班级号，请核对后再试' })
    }
    const record = await loadClass(classStore, index.classId)

    // 长度先于哈希校验：PBKDF2 对超大 key 是全长 HMAC，不设上限等于给
    // 持会话者一个内存/CPU 消耗入口。口径与 create 一致（4-32 位）。
    if (typeof password !== 'string' || password.length < 4 || password.length > 32) {
      throw new ApiError(400, { stage: 'class-input', msg: '班级密码需要 4-32 位' })
    }

    if (!(await verifyPassword(password ?? '', record.salt, record.passHash))) {
      throw new ApiError(401, { stage: 'class-password', msg: '班级密码不对' })
    }

    const members = await loadMembers(classStore, record.id)
    if (!members.includes(username)) {
      if (members.length >= MAX_MEMBERS) {
        throw new ApiError(400, { stage: 'class-input', msg: `这个班级人数已满（${MAX_MEMBERS} 人）` })
      }
      await writeJson(classStore, `class:${record.id}:members`, { members: [...members, username] })
      const mine = await myClassIds(classStore, username)
      if (!mine.includes(record.id)) {
        await writeJson(classStore, `user:${username}:classes`, { ids: [...mine, record.id] })
      }
    }

    return c.json({ success: true, data: { classId: record.id, name: record.name } })
  }))

  routes.post('/classes/list', async (c) => {
    const { sessionId } = await readJson(c.req.raw)
    const session = await requireUcloudSession(getSessionStore(), sessionId)
    const classStore = getClassStore()

    const ids = await myClassIds(classStore, session.username)
    const classes = []
    for (const id of ids) {
      const record = await classStore.get(`class:${id}`)
      if (!record) continue
      const members = await loadMembers(classStore, id)
      classes.push({
        classId: record.id,
        code: record.code,
        name: record.name,
        createdBy: record.createdBy,
        createdAt: record.createdAt,
        memberCount: members.length,
      })
    }
    return c.json({ success: true, data: { classes } })
  })

  routes.post('/classes/assignments', async (c) => {
    const { sessionId, classId } = await readJson(c.req.raw)
    const session = await requireUcloudSession(getSessionStore(), sessionId)
    const classStore = getClassStore()
    const record = await loadClass(classStore, classId)
    await requireMember(classStore, classId, session.username)

    const stored = await readRecord(classStore, `class:${classId}:assigns`)
    const assignments = Array.isArray(stored?.assignments) ? stored.assignments : []

    // record 形状对齐云邮作业（services/assignments.js 的上游 record）：
    // 前端 normalize/sort/倒计时/进度条零改动直接复用。
    // siteName=班级名（分组标题）；科目放 chapterName；content 由
    // normalizeAssignment 透传。deadline 是北京时间墙上钟（YYYY-MM-DD HH:mm）。
    const data = assignments.map((item) => ({
          id: item.id,
          assignmentTitle: item.title,
          chapterName: item.subject,
          siteId: `class:${classId}`,
          siteName: record.name,
          assignmentBeginTime: '',
          assignmentEndTime: item.deadline || '',
          submitTime: '',
          assignmentStatus: 99,
          content: item.content,
        }))
    return c.json({ success: true, data: { assignments: data } })
  })

  routes.post('/classes/assignment/add', async (c) => {
    const { sessionId, classId, title, subject, content, deadline } = await readJson(c.req.raw)
    const session = await requireUcloudSession(getSessionStore(), sessionId)
    const classStore = getClassStore()
    await loadClass(classStore, classId)
    await requireMember(classStore, classId, session.username)

    const cleanTitle = text(title)
    const cleanSubject = text(subject)
    const cleanContent = text(content)
    if (!cleanTitle || cleanTitle.length > 100) {
      throw new ApiError(400, { stage: 'class-input', msg: '作业标题需要 1-100 个字' })
    }
    if (!cleanSubject || cleanSubject.length > 40) {
      throw new ApiError(400, { stage: 'class-input', msg: '科目需要 1-40 个字' })
    }
    if (!cleanContent || cleanContent.length > 2000) {
      throw new ApiError(400, { stage: 'class-input', msg: '作业内容需要 1-2000 个字' })
    }

    // 截止时间可选；给就必须是合法的月日时分（datetime-local 的 T 换成空格，
    // 与云邮作业的墙上钟格式一致——无时区、按北京时间解释）
    let cleanDeadline = ''
    if (deadline !== undefined && deadline !== null && String(deadline).trim() !== '') {
      cleanDeadline = String(deadline).trim().replace('T', ' ')
      if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(cleanDeadline)) {
        throw new ApiError(400, { stage: 'class-input', msg: '截止时间格式应为 月/日 时:分' })
      }
    }

    const stored = await readRecord(classStore, `class:${classId}:assigns`)
    const assignments = Array.isArray(stored?.assignments) ? stored.assignments : []
    if (assignments.length >= MAX_ASSIGNMENTS_PER_CLASS) {
      throw new ApiError(400, { stage: 'class-input', msg: `这个班级的作业已到上限（${MAX_ASSIGNMENTS_PER_CLASS} 条）` })
    }

    const assignmentId = crypto.randomUUID()
    await writeJson(classStore, `class:${classId}:assigns`, {
      assignments: [...assignments, {
        id: assignmentId,
        title: cleanTitle,
        subject: cleanSubject,
        content: cleanContent,
        deadline: cleanDeadline,
        createdBy: session.username,
        createdAt: Date.now(),
      }],
    })

    return c.json({ success: true, data: { assignmentId } })
  })

  routes.post('/classes/assignment/delete', async (c) => {
    const { sessionId, classId, assignmentId } = await readJson(c.req.raw)
    const session = await requireUcloudSession(getSessionStore(), sessionId)
    const classStore = getClassStore()
    const record = await loadClass(classStore, classId)
    await requireMember(classStore, classId, session.username)

    const stored = await readRecord(classStore, `class:${classId}:assigns`)
    const assignments = Array.isArray(stored?.assignments) ? stored.assignments : []
    const target = assignments.find((item) => item.id === assignmentId)
    if (!target) {
      throw new ApiError(404, { stage: 'class-not-found', msg: '这条作业不存在或已被删除' })
    }
    // 创建班级的人是管理员；录入者也能删自己录的
    if (target.createdBy !== session.username && record.createdBy !== session.username) {
      throw new ApiError(403, { stage: 'class-member', msg: '只有班级创建者或录入者可以删除这条作业' })
    }

    await writeJson(classStore, `class:${classId}:assigns`, {
      assignments: assignments.filter((item) => item.id !== assignmentId),
    })
    return c.json({ success: true, data: {} })
  })

  routes.post('/classes/dissolve', async (c) => {
    const { sessionId, classId } = await readJson(c.req.raw)
    const session = await requireUcloudSession(getSessionStore(), sessionId)
    const classStore = getClassStore()
    const record = await loadClass(classStore, classId)

    // 解散是创建者的权限：成员不能拆全班的共享数据
    if (record.createdBy !== session.username) {
      throw new ApiError(403, { stage: 'class-member', msg: '只有班级创建者可以解散班级' })
    }

    // 逐个剪除成员的「我的班级」索引（含创建者自己），再删班级本体各键。
    // 单班数据量小（≤100 人），逐键处理足够；不是原子事务，中断会留下孤儿
    // 索引——myClassIds 读取时本就会剔掉指向已删班级的条目，可自愈。
    const members = await loadMembers(classStore, classId)
    for (const username of members) {
      const mine = await myClassIds(classStore, username)
      const rest = mine.filter((id) => id !== classId)
      if (rest.length) await writeJson(classStore, `user:${username}:classes`, { ids: rest })
      else await classStore.delete(`user:${username}:classes`)
    }
    await classStore.delete(`class:${classId}:assigns`)
    await classStore.delete(`class:${classId}:members`)
    await classStore.delete(`code:${record.code}`)
    await classStore.delete(`class:${classId}`)

    return c.json({ success: true, data: {} })
  })

  return routes
}
