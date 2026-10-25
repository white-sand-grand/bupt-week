/**
 * 截止时间分级与排序。核心结论：**截止是时刻不是时长**——
 * 学校接口给的是无时区的「北京时间墙上钟」，必须按 Asia/Shanghai 解释，
 * 不能跟着用户设备时区漂移。
 */

/** 无时区时间串（YYYY-MM-DD HH:mm[:ss]）按北京时间（+08:00）解释成时间戳。
 *  日历上不存在的日期（如 2 月 30 日）引擎会宽容回退成 3 月 2 日——
 *  那是「看似合理的错误天数」，显式拒收（对抗性测试抓过）。
 *  形态之外的串也一律 NaN：V8 的宽容解析会按设备本地时区/UTC 解释
 *  （纯日期按 UTC 午夜、漂移形态按本地钟），静默差 8 小时+——「今天
 *  截止/已截止」的翻转时刻不能交给设备时区决定。带显式时区标注的串
 *  没有歧义，原样解析。 */
const WALL_CLOCK = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?$/
const EXPLICIT_TZ = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(:\d{2})?(Z|[+-]\d{2}:?\d{2})$/

export function beijingTimestamp(value) {
  if (typeof value !== 'string') return NaN
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})[ T]/)
  if (match) {
    const year = Number(match[1])
    const month = Number(match[2])
    const day = Number(match[3])
    if (month < 1 || month > 12 || day < 1 || day > 31) return NaN
    const probe = new Date(Date.UTC(year, month - 1, day))
    if (probe.getUTCMonth() !== month - 1 || probe.getUTCDate() !== day) return NaN
  }
  if (WALL_CLOCK.test(value)) return Date.parse(value.replace(' ', 'T') + '+08:00')
  if (EXPLICIT_TZ.test(value)) return Date.parse(value)
  return NaN
}

export function getDaysLeft(deadline, now = Date.now()) {
  if (!deadline) return null
  const endTime = beijingTimestamp(deadline)
  if (Number.isNaN(endTime)) return null
  return Math.floor((endTime - now) / 86400000)
}

/** 进度条窗口：begin 缺失时按「临近截止」语义回退 7 天（与分级阈值一致）。 */
const PROGRESS_WINDOW_MS = 7 * 86400000

/**
 * 提交进度（0..1）：从发布到截止走了多远。
 *
 * 学校的作业列表接口【实测 2026-10-24，38/38 条】assignmentBeginTime 全为空，
 * 所以起点缺失时回退成「截止前 7 天」的窗口——正好对齐分级阈值（7 天进入
 * 临近截止），进度条从进入 warning 带开始填充，到截止铺满，语义自洽。
 * 起点有值就用真值；截止非法或区间不合法（end <= start）返回 null，不画。
 */
export function deadlineProgress(beginTime, deadline, now = Date.now()) {
  const end = beijingTimestamp(deadline)
  if (Number.isNaN(end)) return null
  const start = beijingTimestamp(beginTime)
  const begin = Number.isNaN(start) ? end - PROGRESS_WINDOW_MS : start
  if (end <= begin) return null
  return Math.min(1, Math.max(0, (now - begin) / (end - begin)))
}

function getDeadlineLevel(daysLeft, isCompleted) {
  if (isCompleted) return 'submitted'
  if (daysLeft === null) return 'normal'
  if (daysLeft < 0) return 'overdue'
  if (daysLeft <= 1) return 'danger'
  if (daysLeft <= 7) return 'warning'
  return 'normal'
}

function getAssignmentStatus(daysLeft, isCompleted) {
  if (isCompleted) return '已提交'
  if (daysLeft === null) return '待完成'
  if (daysLeft < 0) return '已截止未交'
  if (daysLeft === 0) return '今天截止'
  if (daysLeft === 1) return '明天截止'
  if (daysLeft <= 7) return '临近截止'
  return '待完成'
}

// ── 提交状态判定（字段语义见 services/assignments.js 顶注） ─────────────────

const NOT_SUBMITTED_STATUS = 99

function hasValue(value) {
  if (value === null || value === undefined) return false
  // 只认字符串：数组/对象会被 String() 拼成真值，曾把 ['2026-01-01'] 误判成已提交
  if (typeof value !== 'string') return false
  const text = value.trim()
  return text !== '' && text !== 'null' && text !== 'undefined' && text !== '-'
}

function submissionFromAssignmentStatus(value) {
  if (value === null || value === undefined || value === '') return null
  const status = Number(value)
  if (!Number.isFinite(status)) return null
  return status !== NOT_SUBMITTED_STATUS
}

export function isRecordCompleted(record) {
  if (hasValue(record?.submitTime)) return true
  return Boolean(submissionFromAssignmentStatus(record?.assignmentStatus))
}

// 学校的作业列表跨学期、又不总带课程信息。没归到本学期课程、且截止已久
// 的未交作业算「往期未交」，不再混进「已逾期」里催促。
const CURRENT_TERM_GRACE_DAYS = 60

/** 是否还算本学期：截止缺解析（daysLeft null）的一律保留——课程映射失败
 *  时不能误杀没过期的作业；只有截止已过宽限期 60 天的才算往期。 */
export function isCurrentTerm(assignment) {
  return assignment.daysLeft === null || assignment.daysLeft >= -CURRENT_TERM_GRACE_DAYS
}

/**
 * 距截止倒计时（精确到分钟）。now 由调用方传入——要求锚定在页面打开时刻，
 * 不随时钟走（用户明确要求不实时刷新）。
 * @returns {string} 形如「距截止 2天3小时15分」；已过截止或解析不了返回 ''
 */
export function formatCountdown(deadline, now) {
  const end = beijingTimestamp(deadline)
  if (Number.isNaN(end)) return ''
  const diff = end - now
  if (diff <= 0) return ''
  const minutes = Math.floor(diff / 60_000)
  const days = Math.floor(minutes / 1440)
  const hours = Math.floor((minutes % 1440) / 60)
  const mins = minutes % 60
  const parts = []
  if (days > 0) parts.push(`${days}天`)
  if (hours > 0) parts.push(`${hours}小时`)
  if (mins > 0) parts.push(`${mins}分`)
  return parts.length ? `距截止 ${parts.join('')}` : '距截止 不足1分钟'
}

/** 展示模型的字符串字段只放行 string——上游塞对象/数组进来时宁可落空，不带着脏类型进视图。 */
const text = (value, fallback = '') => (typeof value === 'string' ? value : fallback)

/** 上游 record → 展示模型。raw 不带出（附件等详情按需另取）。
 *  上游塞 null/非对象进来也不能炸——map 里一个炸全列表就没了（对抗性测试抓过）。 */
export function normalizeAssignment(record, now = Date.now()) {
  const safe = record && typeof record === 'object' ? record : {}
  const isCompleted = isRecordCompleted(safe)
  const daysLeft = getDaysLeft(safe.assignmentEndTime, now)
  const courseId = text(safe.siteId)
  const courseName = text(safe.siteName) || '未知课程'
  const isPastTerm = !courseId && daysLeft !== null && daysLeft < -CURRENT_TERM_GRACE_DAYS
  let level = getDeadlineLevel(daysLeft, isCompleted)
  if (level === 'overdue' && isPastTerm) level = 'missed'

  return {
    id: String(safe.id ?? ''),
    title: text(safe.assignmentTitle) || '无标题',
    chapter: text(safe.chapterName),
    courseId,
    courseName,
    beginTime: text(safe.assignmentBeginTime),
    deadline: text(safe.assignmentEndTime),
    submitTime: text(safe.submitTime),
    // 班级手动录入的作业专用：正文与录入者（云邮记录没有这两个字段，落 ''）
    content: text(safe.content),
    createdBy: text(safe.createdBy),
    daysLeft,
    level,
    isCompleted,
    status: level === 'missed' ? '往期未交' : getAssignmentStatus(daysLeft, isCompleted),
  }
}

function priorityOf(assignment) {
  if (assignment.level === 'overdue') return 0
  if (assignment.level === 'danger') return 1
  if (assignment.level === 'warning') return 2
  if (assignment.isCompleted) return 4
  if (assignment.level === 'missed') return 5
  return 3
}

/**
 * 紧急度排序：已逾期 → 今天/明天 → 一周内 → 待完成 → 已提交 → 往期未交。
 * 同级内：未完成的按截止时间正序；已逾期按截止时间倒序（刚过期的最扎眼）；
 * 已提交按提交时间倒序（最近提交的最靠前）。
 */
export function sortAssignments(assignments) {
  return [...assignments].sort((left, right) => {
    const priorityDiff = priorityOf(left) - priorityOf(right)
    if (priorityDiff !== 0) return priorityDiff

    const toTime = (value, fallback = Number.MAX_SAFE_INTEGER) => {
      const time = value ? beijingTimestamp(value) : NaN
      return Number.isNaN(time) ? fallback : time
    }

    if (left.isCompleted && right.isCompleted) {
      return toTime(right.submitTime, toTime(right.deadline, 0)) - toTime(left.submitTime, toTime(left.deadline, 0))
    }
    if (left.level === 'overdue' && right.level === 'overdue') {
      return toTime(right.deadline) - toTime(left.deadline)
    }
    return toTime(left.deadline) - toTime(right.deadline)
  })
}

/** 按课程分组（保持传入顺序），组内保持给定排序。
 *  key 供渲染层作 v-for 键：云邮组用课程 id，班级组（按科目拆分）自行带 key。 */
export function groupByCourse(assignments) {
  const groups = []
  const index = new Map()
  for (const assignment of assignments) {
    const key = assignment.courseId || assignment.courseName
    if (!index.has(key)) {
      const group = { key, courseName: assignment.courseName, items: [] }
      index.set(key, group)
      groups.push(group)
    }
    index.get(key).items.push(assignment)
  }
  return groups
}
