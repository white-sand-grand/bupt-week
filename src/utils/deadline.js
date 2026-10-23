/**
 * 截止时间分级与排序。分级骨架借鉴 MYUCLOUD src/utils/deadline.js，
 * 时间解释遵循 where_to_study 的结论：**截止是时刻不是时长**——
 * 学校接口给的是无时区的「北京时间墙上钟」，必须按 Asia/Shanghai 解释，
 * 不能跟着用户设备时区漂移。
 */

/** 无时区时间串（YYYY-MM-DD HH:mm[:ss]）按北京时间（+08:00）解释成时间戳。
 *  日历上不存在的日期（如 2 月 30 日）引擎会宽容回退成 3 月 2 日——
 *  那是「看似合理的错误天数」，显式拒收（对抗性测试抓过）。 */
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
  const zoned = /^\d{4}-\d{2}-\d{2}[ T]\d{2}:\d{2}(?::\d{2})?$/.test(value)
    ? value.replace(' ', 'T') + '+08:00'
    : value
  return Date.parse(zoned)
}

export function getDaysLeft(deadline, now = Date.now()) {
  if (!deadline) return null
  const endTime = beijingTimestamp(deadline)
  if (Number.isNaN(endTime)) return null
  return Math.floor((endTime - now) / 86400000)
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

/** 按课程分组（保持传入顺序），组内保持给定排序。 */
export function groupByCourse(assignments) {
  const groups = []
  const index = new Map()
  for (const assignment of assignments) {
    const key = assignment.courseId || assignment.courseName
    if (!index.has(key)) {
      index.set(key, { courseName: assignment.courseName, items: [] })
      groups.push(index.get(key))
    }
    index.get(key).items.push(assignment)
  }
  return groups
}
