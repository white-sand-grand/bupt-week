import { ApiError } from '../http.js'

/**
 * 移动教务（jwglweixin.bupt.edu.cn）—— 课表主数据源。
 *
 * 协议逐字对照 Nemoyuzx/where_to_study 的 src-tauri/src/{classrooms,schedule,config}.rs
 * （结论全文见 docs/jwglweixin-source.md）：
 * - 登录：POST /bjyddx/login，明文表单 userNo/pwd 换 token（不走 CAS）
 * - 课表：POST /bjyddx/student/curriculum?week=all，平铺课程实例（非周网格）
 * - 该域名公网可达（211.68.69.240），不依赖校园网——与校内-only 的
 *   jwgl.bupt.edu.cn（见 services/jwgl.js）是两套系统
 *
 * 解析输出对齐 services/timetable.js 的 timetable 对象（week/mode/date/weeks/
 * modes/days/periods/courses），前端协议零改动。mode 用固定值 'jwglweixin'，
 * 前端缓存的隔离键（username+mode+semesterStart）因此天然区分两个数据源。
 */

const WEIXIN_BASE = 'https://jwglweixin.bupt.edu.cn'
const LOGIN_URL = `${WEIXIN_BASE}/bjyddx/login`
const CURRICULUM_URL = `${WEIXIN_BASE}/bjyddx/student/curriculum`

const HEADERS = {
  'User-Agent': 'Mozilla/5.0',
  Origin: WEIXIN_BASE,
  Referer: `${WEIXIN_BASE}/sjd/#/restClassroom`,
}

/** 与桌面教务一致的星期标签；date 由学期起点合成。 */
const DAY_LABELS = ['星期一', '星期二', '星期三', '星期四', '星期五', '星期六', '星期日']

/** where_to_study config.rs 的 SLOT_TIMES（14 节，逐字对照）。 */
const SLOT_TIMES = [
  ['08:00', '08:45'], ['08:50', '09:35'], ['09:50', '10:35'], ['10:40', '11:25'],
  ['11:30', '12:15'], ['13:00', '13:45'], ['13:50', '14:35'], ['14:45', '15:30'],
  ['15:40', '16:25'], ['16:35', '17:20'], ['17:25', '18:10'], ['18:30', '19:15'],
  ['19:20', '20:05'], ['20:10', '20:55'],
]

/** 谨慎的固定 mode 值：前端只把它当缓存隔离键，不做节次模式语义。 */
const MODE = 'jwglweixin'

// ── 登录 ────────────────────────────────────────────────────────────────────

function codeIsSuccess(payload) {
  const code = payload?.code
  return code === 1 || code === '1'
}

/**
 * 用学号密码换移动教务 token。
 *
 * 密码错与网络错分开报：密码错（401）是登录编排里「试下一个数据源」和前端
 * 「补填教务密码」的判定依据，不能和网络失败混为一谈。
 * @returns {Promise<{ token: string, username: string }>}
 */
export async function loginJwglweixin({ username, password, fetchImpl = fetch }) {
  if (!username || !password) {
    throw new ApiError(400, '学号和密码不能为空')
  }

  let response
  let payload
  try {
    response = await fetchImpl(LOGIN_URL, {
      method: 'POST',
      headers: { ...HEADERS, Referer: `${WEIXIN_BASE}/sjd/#/login`, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ userNo: username, pwd: password }).toString(),
      signal: AbortSignal.timeout(20_000),
    })
    payload = await response.json().catch(() => null)
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError(502, { stage: 'jwglweixin-connect', msg: '连不上移动教务，请稍后重试' })
  }

  if (!codeIsSuccess(payload)) {
    const message = payload?.Msg || payload?.msg || '移动教务登录失败'
    throw new ApiError(401, { stage: 'jwglweixin-login', msg: message })
  }

  const token = String(payload?.data?.token ?? '').trim()
  if (!token) {
    // 登录「成功」却没给 token：按上游异常处理，不是用户密码问题
    throw new ApiError(502, { stage: 'jwglweixin-login', msg: '移动教务登录成功但没有返回凭证' })
  }
  return { token, username }
}

// ── 解析器（对照 where_to_study schedule.rs 的 parse_sjd_* 系列） ──────────

const MAX_NESTING_DEPTH = 64

/** 递归收集课程实例：含 courseName 或 jx0408id 的对象视为一条（深度上限 64）。 */
export function collectCourseItems(node, out = [], depth = 0) {
  if (depth > MAX_NESTING_DEPTH || node === null || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const item of node) collectCourseItems(item, out, depth + 1)
    return out
  }
  if ('courseName' in node || 'jx0408id' in node) {
    out.push(node)
    return out
  }
  for (const value of Object.values(node)) collectCourseItems(value, out, depth + 1)
  return out
}

/**
 * classTime 数字编码 → 节次区间。编码形如 "1030405"：首字符是节数门数，
 * 之后每两位是一个 1-based 节次节点（where_to_study 的 parse_sjd_slots 语义，
 * 节点号即 1-based 节次）。识别不了回退 weekNoteDetail 里的数字。
 * @returns {{ start: number, end: number } | null}
 */
export function parseClassTimeSlots(raw) {
  const tail = typeof raw === 'string' && /^\d+$/.test(raw) && raw.length > 1
    ? raw.slice(1)
    : ''
  const nodes = (tail.match(/\d{2}/g) || []).map(Number).filter((n) => n >= 1 && n <= SLOT_TIMES.length)
  if (nodes.length) {
    return { start: Math.min(...nodes), end: Math.max(...nodes) }
  }
  return null
}

/**
 * 周次文本 → 周号数组。支持：区间（1-5）、单周（3）、全角逗号、「单/双」周
 * 过滤、[...] / (...) 注记剔除（where_to_study 的 expand_week_numbers 语义）。
 */
export function parseWeekNumbers(classWeek, classWeekDetails) {
  const expand = (text) => {
    if (typeof text !== 'string' || !text.trim()) return []
    // 单/双周标记常写在括号注记里（如「1-10周(单)」），必须先于注记剔除提取
    const oddOnly = /单/.test(text)
    const evenOnly = /双/.test(text)
    let normalized = text.replace(/，/g, ',').replace(/[\[\（(（【]/g, '(').replace(/[\]）)】]/g, ')')
    normalized = normalized.replace(/\([^)]*\)/g, '').replace(/周/g, '').replace(/第/g, '').replace(/[单双]/g, '')

    const weeks = []
    for (const part of normalized.split(/[,、\s]+/)) {
      if (!part) continue
      const range = part.match(/^(\d+)-(\d+)$/)
      if (range) {
        const from = Number(range[1])
        const to = Number(range[2])
        if (!Number.isInteger(from) || !Number.isInteger(to) || from < 1 || to > 60 || from > to) continue
        for (let week = from; week <= to; week++) weeks.push(week)
        continue
      }
      const single = part.match(/^(\d+)$/)
      if (single) {
        const week = Number(single[1])
        if (week >= 1 && week <= 60) weeks.push(week)
      }
    }
    const filtered = weeks.filter((week) => (oddOnly ? week % 2 === 1 : evenOnly ? week % 2 === 0 : true))
    return [...new Set(filtered)].sort((a, b) => a - b)
  }

  const primary = expand(classWeek)
  if (primary.length) return primary
  const secondary = expand(classWeekDetails)
  if (secondary.length) return secondary
  // 最后兜底：把注记文本里的数字全捞出来（where_to_study 同款兜底）
  const digits = typeof classWeekDetails === 'string'
    ? (classWeekDetails.match(/\d+/g) || []).map(Number).filter((week) => week >= 1 && week <= 60)
    : []
  return [...new Set(digits)].sort((a, b) => a - b)
}

/** 星期：weekDay 首字符是 1-7 数字（"1"=周一）。识别不了返回 null。 */
function parseWeekday(raw) {
  const first = typeof raw === 'string' ? raw.trim().charAt(0) : ''
  const day = Number(first)
  return Number.isInteger(day) && day >= 1 && day <= 7 ? day : null
}

/** 楼-房间合成地点：房间已含楼名时去重（where_to_study 的合成规则）。 */
function composeLocation(building, room) {
  const b = (building || '').trim()
  const r = (room || '').trim()
  if (b && r && !r.includes(b)) return `${b}-${r}`
  return r || b
}

/**
 * 从「当前周」payload 推学期第一周周一。
 * data[0].date[] 里找同时含 mxrq（日期）与 zc≠"all" 的项：
 * monday = mxrq - (xqid-1) 天；termStart = monday - (zc-1) 周。
 */
export function inferTermStartDate(payload) {
  const root = Array.isArray(payload?.data) ? payload.data[0] : null
  const entries = Array.isArray(root?.date) ? root.date : []
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object') continue
    const zc = Number(entry.zc)
    const date = typeof entry.mxrq === 'string' ? new Date(`${entry.mxrq}T00:00:00Z`) : null
    if (!Number.isInteger(zc) || zc < 1 || zc > 60 || !date || Number.isNaN(date.getTime())) continue
    if (entry.zc === 'all') continue
    const weekdayRaw = Number(entry.xqid)
    const weekday = Number.isInteger(weekdayRaw) && weekdayRaw >= 1 && weekdayRaw <= 7
      ? weekdayRaw
      : date.getUTCDay() === 0 ? 7 : date.getUTCDay()
    const monday = new Date(date)
    monday.setUTCDate(monday.getUTCDate() - (weekday - 1))
    monday.setUTCDate(monday.getUTCDate() - (zc - 1) * 7)
    return monday
  }
  return null
}

/** 当前周号：date[] 里第一个 zc 可解析且非 all 的值，兜底 data[0].week。 */
export function inferCurrentWeek(payload) {
  const root = Array.isArray(payload?.data) ? payload.data[0] : null
  const entries = Array.isArray(root?.date) ? root.date : []
  for (const entry of entries) {
    if (!entry || typeof entry !== 'object' || entry.zc === 'all') continue
    const zc = Number(entry.zc)
    if (Number.isInteger(zc) && zc >= 1 && zc <= 60) return zc
  }
  const week = Number(root?.week)
  return Number.isInteger(week) && week >= 1 && week <= 60 ? week : null
}

function isoDate(date) {
  return date.toISOString().slice(0, 10)
}

/**
 * 整学期 payload → 前端 timetable 周对象集合。
 *
 * @param {{ allPayload: object, currentPayload: object, termStart: Date, currentWeek: number }} parsed
 * @returns {{ weeks: Map<number, object>, weekNumbers: number[] }} 每周的 timetable 形状对象
 */
export function buildWeekIndex(allPayload, currentPayload) {
  const termStart = inferTermStartDate(currentPayload) || inferTermStartDate(allPayload)
  const currentWeek = inferCurrentWeek(currentPayload) ?? inferCurrentWeek(allPayload)
  if (!termStart || !currentWeek) {
    throw new Error('移动教务没有返回学期日期或当前周次，暂未更新本地课表')
  }

  const items = collectCourseItems(allPayload?.data)
  const byWeek = new Map()
  const weekSet = new Set([currentWeek])
  for (const item of items) {
    const day = parseWeekday(item.weekDay ?? item.classTime)
    const slots = parseClassTimeSlots(item.classTime) || parseClassTimeSlots(item.weekNoteDetail)
    const weekNumbers = parseWeekNumbers(item.classWeek, item.classWeekDetails)
    const name = typeof item.courseName === 'string' ? item.courseName.trim() : ''
    if (!name || day === null || !slots || !weekNumbers.length) continue

    const location = composeLocation(item.buildingName, item.classroomName ?? item.location)
    const teacher = typeof item.teacherName === 'string' ? item.teacherName.trim() : ''
    const course = {
      name,
      day,
      start: slots.start,
      end: slots.end,
      location,
      campus: '',
      schedule: `[${slots.start}-${slots.end}]节`,
      details: [name, teacher, location].filter(Boolean),
    }
    for (const week of weekNumbers) {
      weekSet.add(week)
      if (!byWeek.has(week)) byWeek.set(week, [])
      const key = JSON.stringify(course)
      if (!byWeek.get(week).some((existing) => JSON.stringify(existing) === key)) {
        byWeek.get(week).push(course)
      }
    }
  }

  // 补齐连续区间：无课的周也要有对象（前端 weeks 下拉与周导航按序号走）
  const weekNumbers = []
  for (let week = 1; week <= Math.max(...weekSet); week++) weekNumbers.push(week)

  const periods = SLOT_TIMES.map(([from, to], index) => ({ number: index + 1, time: `${from}~${to}` }))
  const weeks = new Map()
  for (const week of weekNumbers) {
    const monday = new Date(termStart)
    monday.setUTCDate(monday.getUTCDate() + (week - 1) * 7)
    const days = DAY_LABELS.map((label, index) => {
      const day = new Date(monday)
      day.setUTCDate(day.getUTCDate() + index)
      return { label, date: isoDate(day).slice(5) }
    })
    weeks.set(week, {
      week,
      mode: MODE,
      date: isoDate(monday),
      weeks: weekNumbers,
      modes: [],
      days,
      periods,
      courses: (byWeek.get(week) || []).sort((a, b) => a.day - b.day || a.start - b.start),
    })
  }
  return { weeks, weekNumbers, currentWeek }
}

// ── 取数 ────────────────────────────────────────────────────────────────────

/** token → 整学期解析结果。前端按周补漏会连发多个请求，别每次都打上游。 */
const semesterCache = new Map()
const SEMESTER_CACHE_TTL_MS = 5 * 60_000

async function requestCurriculum(token, week, fetchImpl) {
  let response
  let payload
  try {
    response = await fetchImpl(`${CURRICULUM_URL}?week=${encodeURIComponent(week)}`, {
      method: 'POST',
      headers: { ...HEADERS, token },
      signal: AbortSignal.timeout(30_000),
    })
    payload = await response.json().catch(() => null)
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError(502, { stage: 'jwglweixin-timetable', msg: '连不上移动教务，请稍后重试' })
  }

  // token 失效在移动教务侧表现为 HTTP 500 + JSON 或 code!=1（where_to_study 特判过）
  if (response.status === 401 || (response.status >= 500 && payload) || (payload && !codeIsSuccess(payload) && /token|登录|认证/i.test(String(payload?.Msg || payload?.msg || '')))) {
    throw new ApiError(401, { stage: 'jwglweixin-auth', msg: '移动教务登录已过期，请重新登录' })
  }
  if (!payload || !codeIsSuccess(payload)) {
    throw new ApiError(502, { stage: 'jwglweixin-timetable', msg: `获取课表失败：${payload?.Msg || payload?.msg || '上游返回异常'}` })
  }
  return payload
}

async function loadSemester(token, fetchImpl) {
  const cached = semesterCache.get(token)
  if (cached && Date.now() - cached.fetchedAt < SEMESTER_CACHE_TTL_MS) return cached

  const [currentPayload, allPayload] = await Promise.all([
    requestCurriculum(token, '', fetchImpl),
    requestCurriculum(token, 'all', fetchImpl),
  ])
  const built = buildWeekIndex(allPayload, currentPayload)
  const entry = { ...built, fetchedAt: Date.now() }
  semesterCache.set(token, entry)
  if (semesterCache.size > 50) {
    // 粗暴防泄漏：会话数不会多，超量全清（TTL 很短，代价可忽略）
    semesterCache.clear()
    semesterCache.set(token, entry)
  }
  return entry
}

/** 测试用：清空整学期缓存。 */
export function __clearSemesterCache() {
  semesterCache.clear()
}

/**
 * 取一周课表（移动教务）。不带 week 时取当前周。
 * 返回形状与 services/timetable.js 的 fetchTimetable 对齐（除了没有 cookies）。
 * @param {{ token: string, week?: number, fetchImpl?: typeof fetch }} options
 */
export async function fetchTimetableWeixin({ token, week, fetchImpl = fetch }) {
  if (!token) {
    throw new ApiError(401, { stage: 'jwglweixin-auth', msg: '请先登录移动教务' })
  }
  if (week !== undefined && (!Number.isInteger(week) || week < 1 || week > 60)) {
    throw new ApiError(400, '周次无效')
  }

  const semester = await loadSemester(token, fetchImpl)
  const target = week ?? semester.currentWeek
  const timetable = semester.weeks.get(target)
  if (!timetable) {
    throw new ApiError(502, { stage: 'jwglweixin-timetable', msg: '移动教务没有这一周的课表' })
  }
  return { timetable }
}

/**
 * 会话探活：轻量请求当前周。token 有效即 200。
 * @returns {Promise<{ username: string }>} 探活不返回新凭证
 */
export async function validateWeixinSession({ token, fetchImpl = fetch }) {
  if (!token) {
    throw new ApiError(401, { stage: 'jwglweixin-auth', msg: '教务登录已过期，请重新登录' })
  }
  await requestCurriculum(token, '', fetchImpl)
  return { valid: true }
}
