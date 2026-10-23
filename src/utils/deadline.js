/**
 * 截止时间分级与排序。分级骨架借鉴 MYUCLOUD src/utils/deadline.js，
 * 时间解释遵循 where_to_study 的结论：**截止是时刻不是时长**——
 * 学校接口给的是无时区的「北京时间墙上钟」，必须按 Asia/Shanghai 解释，
 * 不能跟着用户设备时区漂移。
 */

/** 无时区时间串（YYYY-MM-DD HH:mm[:ss]）按北京时间（+08:00）解释成时间戳。 */
export function beijingTimestamp(value) {
  if (typeof value !== 'string') return NaN
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

export function getDeadlineLevel(daysLeft, isCompleted) {
  if (isCompleted) return 'submitted'
  if (daysLeft === null) return 'normal'
  if (daysLeft < 0) return 'overdue'
  if (daysLeft <= 1) return 'danger'
  if (daysLeft <= 7) return 'warning'
  return 'normal'
}

export function getAssignmentStatus(daysLeft, isCompleted) {
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
  const text = String(value).trim()
  return text !== '' && text !== 'null' && text !== 'undefined' && text !== '-'
}

function submissionFromAssignmentStatus(value) {
  if (value === null || value === undefined || value === '') return null
  const status = Number(value)
  if (!Number.isFinite(status)) return null
  return status !== NOT_SUBMITTED_STATUS
}

export function isRecordCompleted(record) {
  if (hasValue(record.submitTime)) return true
  return Boolean(submissionFromAssignmentStatus(record.assignmentStatus))
}

// 学校的作业列表跨学期、又不总带课程信息。没归到本学期课程、且截止已久
// 的未交作业算「往期未交」，不再混进「已逾期」里催促。
export const CURRENT_TERM_GRACE_DAYS = 60

/** 上游 record → 展示模型。raw 不带出（附件等详情按需另取）。 */
export function normalizeAssignment(record, now = Date.now()) {
  const isCompleted = isRecordCompleted(record)
  const daysLeft = getDaysLeft(record.assignmentEndTime, now)
  const courseId = record.siteId || ''
  const courseName = record.siteName || '未知课程'
  const isPastTerm = !courseId && daysLeft !== null && daysLeft < -CURRENT_TERM_GRACE_DAYS
  let level = getDeadlineLevel(daysLeft, isCompleted)
  if (level === 'overdue' && isPastTerm) level = 'missed'

  return {
    id: String(record.id ?? ''),
    title: record.assignmentTitle || '无标题',
    chapter: record.chapterName || '',
    courseId,
    courseName,
    beginTime: record.assignmentBeginTime || '',
    deadline: record.assignmentEndTime || '',
    submitTime: record.submitTime || '',
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
