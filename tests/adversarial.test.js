import { test } from 'node:test'
import assert from 'node:assert/strict'
import {
  beijingTimestamp,
  getDaysLeft,
  groupByCourse,
  normalizeAssignment,
  sortAssignments,
} from '../src/utils/deadline.js'
import {
  readAssignmentsCache,
  validateAssignmentsCache,
  writeAssignmentsCache,
} from '../src/utils/assignments-cache.js'
import {
  currentTimetableWeek,
  mergeTimetableWeek,
  validateTimetableCache,
} from '../src/utils/timetable-cache.js'
import { formatUpdatedAt, beijingDateString } from '../src/utils/format.js'
import { friendlyError } from '../src/utils/errors.js'

/**
 * 对抗性测试：假设上游返回的数据是坏的/恶意的，前端数据层必须
 * 「不抛异常、不进死循环、输出仍在合法域内」。学校接口的脏数据
 * 是现实问题（跨学期遗留、字段缺失、格式漂移都实测出现过）。
 */

const VALID_LEVELS = new Set(['overdue', 'danger', 'warning', 'normal', 'submitted', 'missed'])

test('normalizeAssignment：null / 空对象 / 全空字段都不抛，输出结构完整', () => {
  for (const record of [null, undefined, {}, { id: null }, Object.create(null)]) {
    const view = normalizeAssignment(record)
    assert.ok(typeof view.title === 'string' && view.title.length > 0)
    assert.ok(VALID_LEVELS.has(view.level))
    assert.ok(Array.isArray([view]))
  }
})

test('normalizeAssignment：字段是错误类型（数字/数组/对象）时不抛', () => {
  const hostile = {
    id: { nested: true },
    assignmentTitle: ['数组当标题'],
    siteName: 12345,
    assignmentEndTime: { not: 'a string' },
    assignmentStatus: 'weird-status',
    submitTime: ['2026-01-01'],
  }
  const view = normalizeAssignment(hostile)
  assert.ok(VALID_LEVELS.has(view.level))
  assert.equal(typeof view.deadline, 'string')
})

test('normalizeAssignment：assignmentStatus 的脏值语义——空/横杠/null 都算查不到，不误判已提交', () => {
  // 99=未提交是约定；非法值绝不能被 Number() 意外转成非 99 而误标「已提交」
  for (const status of ['', '-', 'null', 'undefined', null, undefined]) {
    const view = normalizeAssignment({ id: 'x', assignmentStatus: status })
    assert.equal(view.isCompleted, false, `status=${JSON.stringify(status)} 不该被判为已提交`)
  }
  // 边界：'099'、' 99 ' 这类变体也应视为未提交
  for (const status of ['099', ' 99 ', 99, '99.0']) {
    const view = normalizeAssignment({ id: 'x', assignmentStatus: status })
    assert.equal(view.isCompleted, false)
  }
})

test('normalizeAssignment：超长字段与 emoji 不炸（哈希/切片/展示路径都吃得下）', () => {
  const long = 'A'.repeat(100_000)
  const view = normalizeAssignment({
    id: long,
    assignmentTitle: `🐙${'课'.repeat(1000)}`,
    siteName: long,
    // 明天截止 → 永远落在 danger 档。写死日期会在到期当刻翻成 overdue（时间炸弹）
    assignmentEndTime: `${beijingDateString(1)} 23:59`,
  })
  assert.ok(view.title.length > 0)
  assert.equal(view.level, 'danger')
})

test('sortAssignments + groupByCourse：混入脏数据仍稳定（不抛、每组保序、全部保留）', () => {
  const mixed = [
    normalizeAssignment({ id: '1', assignmentEndTime: '2026-10-24 23:59', assignmentStatus: 99 }),
    normalizeAssignment(null),
    normalizeAssignment({ id: '2', assignmentEndTime: 'garbage-date', siteId: 's1', assignmentStatus: 99 }),
    normalizeAssignment({ id: '3', assignmentEndTime: '2026-01-01 00:00', assignmentStatus: 0, submitTime: '2026-01-01 00:00' }),
  ]
  const sorted = sortAssignments(mixed)
  assert.equal(sorted.length, mixed.length, '一个都不能少（丢卡片=丢作业信息）')
  const groups = groupByCourse(sorted)
  assert.equal(groups.reduce((sum, group) => sum + group.items.length, 0), mixed.length)
})

test('beijingTimestamp / getDaysLeft：非法日期返回 NaN/null，不产生误导性天数', () => {
  for (const bad of ['明天', '2026-99-99 99:99', '', '2026-13-45T99:99', 12345, null, undefined]) {
    assert.ok(Number.isNaN(beijingTimestamp(bad)), `${JSON.stringify(bad)} 应判非法`)
    assert.equal(getDaysLeft(bad), null)
  }
  // 2月30日：正则放行但语义非法，V8 判 NaN——如果实现变了这里会提醒
  assert.ok(Number.isNaN(beijingTimestamp('2026-02-30 10:00')))
})

test('timetable 缓存校验：结构攻击（weeks 空/日期垃圾/课程越界）全部拒收', () => {
  const good = {
    version: 1, username: 'u', savedAt: '2026-10-24T00:00:00Z',
    weeks: [{ week: 1, date: '2026-10-19', days: Array.from({ length: 7 }, () => ({ label: '一', date: '2026-10-19' })), periods: [{ number: 1, time: '08:00' }], courses: [] }],
  }
  assert.ok(validateTimetableCache(good))
  assert.equal(validateTimetableCache({ ...good, weeks: [] }), false)
  assert.equal(validateTimetableCache({ ...good, weeks: [{ ...good.weeks[0], date: 'not-a-date' }] }), false)
  assert.equal(validateTimetableCache({ ...good, weeks: [{ ...good.weeks[0], courses: [{ name: 'x', day: 9, start: 1, end: 1, details: [] }] }] }), false)
  assert.equal(validateTimetableCache({ ...good, weeks: [{ ...good.weeks[0], courses: [{ name: 'x', day: 1, start: 5, end: 2, details: [] }] }] }), false, 'start>end 是非法课程')
})

test('mergeTimetableWeek：上游返回垃圾周（缺字段/日期非法）直接拒收，不覆盖已有缓存', () => {
  const cache = null
  const goodUsername = 'u'
  const garbageTimetable = { week: 1, mode: 'A', date: 'garbage', weeks: [1], days: [], periods: [], courses: [] }
  assert.throws(() => mergeTimetableWeek(cache, goodUsername, garbageTimetable), /不完整/)
})

test('currentTimetableWeek：日期非法的周不参与匹配', () => {
  const weeks = [
    { week: 1, date: '2026-10-19' },
    { week: 2, date: 'garbage' },
    { week: 3, date: '2026-11-02' },
  ]
  // 2026-10-24 落在第 1 周；第 2 周的垃圾日期不该炸
  assert.equal(currentTimetableWeek(weeks, new Date('2026-10-24T12:00:00')), 1)
})

test('assignments 缓存：records 里的 id 边界（0/false/空串算有值，null/undefined 算没有）', () => {
  assert.ok(validateAssignmentsCache({ version: 1, username: 'u', savedAt: '2026-10-24T00:00:00Z', records: [{ id: 0 }] }))
  assert.ok(validateAssignmentsCache({ version: 1, username: 'u', savedAt: '2026-10-24T00:00:00Z', records: [{ id: false }] }))
  assert.ok(validateAssignmentsCache({ version: 1, username: 'u', savedAt: '2026-10-24T00:00:00Z', records: [{ id: '' }] }))
  assert.equal(validateAssignmentsCache({ version: 1, username: 'u', savedAt: '2026-10-24T00:00:00Z', records: [{ id: null }] }), false)
  assert.equal(validateAssignmentsCache({ version: 1, username: 'u', savedAt: '2026-10-24T00:00:00Z', records: [{}] }), false)
})

test('assignments 缓存：savedAt 篡改成非法日期 → 整份缓存拒收（时间提示不可说谎）', () => {
  const storage = {
    store: {},
    getItem(key) { return this.store[key] ?? null },
    setItem(key, value) { this.store[key] = String(value) },
    removeItem(key) { delete this.store[key] },
  }
  writeAssignmentsCache(storage, 'u', [{ id: 'a' }])
  const raw = JSON.parse(storage.store['bupt-week-assignments-v1'])
  raw.savedAt = 'not-a-date'
  storage.store['bupt-week-assignments-v1'] = JSON.stringify(raw)
  assert.equal(readAssignmentsCache(storage, 'u'), null)
})

test('formatUpdatedAt / beijingDateString：极端 ISO 与垃圾输入不抛，输出总是 string', () => {
  assert.equal(formatUpdatedAt('2026-10-24T24:99:00Z'), '', '非法时刻返回空串')
  for (const weird of ['+100000-01-01T00:00:00Z', '-000001-01-01T00:00:00Z', '20']) {
    const text = formatUpdatedAt(weird)
    assert.equal(typeof text, 'string', `${weird} 不该炸`)
  }
  assert.equal(typeof beijingDateString(0, 'not-a-number'), 'string', '垃圾 now 不该炸')
  assert.equal(beijingDateString(0, Date.now()).length, 10, '正常情况是 YYYY-MM-DD')
})

test('friendlyError：message 是对象/循环结构时不抛（String() 兜底）', () => {
  const circular = { name: 'TypeError' }
  circular.self = circular
  circular.message = circular
  const text = friendlyError(circular, { online: true })
  assert.equal(typeof text, 'string')
  assert.ok(text.length > 0)
})

// ── 2026-10-25 对抗加固轮：钉住当轮修复的回归口 ────────────────────────────

test('beijingTimestamp：形态漂移的串一律 NaN，不落回设备本地时区解释', () => {
  // 这些串 V8 的宽容 Date.parse 都「能解析」：纯日期按 UTC 午夜、
  // 单位数/前导空格/毫秒按本地钟——在北京时区外静默差 8~16 小时，
  // 「今天截止」的翻转时刻会被设备时区劫持。必须 NaN。
  const drifted = [
    '2026-10-24',                // 纯日期（V8 按 UTC 午夜）
    '2026-1-1',                  // 单位数月日
    '2026/10/24 10:00',          // 斜杠分隔
    ' 2026-10-24 10:00',         // 前导空格
    '2026-10-24 10:00:00.500',   // 毫秒
    '2026-10-24T10:00:00.500',
  ]
  for (const value of drifted) {
    assert.ok(Number.isNaN(beijingTimestamp(value)), `${value} 应拒收（NaN），不得按设备时区解释`)
  }
  // 带显式时区标注的串没有歧义：原样解析的行为保留
  assert.equal(beijingTimestamp('2026-10-24T23:59:00Z'), Date.parse('2026-10-24T23:59:00Z'))
  assert.equal(beijingTimestamp('2026-10-24T23:59:00+09:00'), Date.parse('2026-10-24T23:59:00+09:00'))
})

test('作业缓存：空串 username 不是合法账号键，写读两侧都拒收', () => {
  const storage = {
    store: {},
    getItem(key) { return this.store[key] ?? null },
    setItem(key, value) { this.store[key] = String(value) },
    removeItem(key) { delete this.store[key] },
  }
  // 企微回流路径可能拿到空学号：空串若放行，所有这类账号共享同一份缓存
  assert.equal(writeAssignmentsCache(storage, '', [{ id: 'a' }]), null, '空 username 不落盘')
  assert.equal(storage.store['bupt-week-assignments-v1'], undefined)
  // 纵有人手工塞了一份空 username 的缓存进来，校验也要判它不可信
  storage.store['bupt-week-assignments-v1'] = JSON.stringify({
    version: 1, username: '', savedAt: new Date().toISOString(), records: [{ id: 'a' }],
  })
  assert.equal(validateAssignmentsCache(JSON.parse(storage.store['bupt-week-assignments-v1'])), false)
  assert.equal(readAssignmentsCache(storage, ''), null)
})

test('课表缓存：空串 username 同样拒收', () => {
  assert.equal(validateTimetableCache({ version: 1, username: '', savedAt: '2026-10-25T00:00:00Z', weeks: [] }), false)
})

test('课件拉平：外链只放行 http(s)，下载不了的行不出现，超深树不爆栈', async () => {
  const { flattenTree } = await import('../src/utils/courseware-tree.js')
  const rows = flattenTree([{
    id: 'n1',
    attachmentVOs: [
      { type: '2', siteResourceLink: { title: '投毒链接', link: 'javascript:fetch("/api/")' } },
      { type: '2', siteResourceLink: { title: '数据协议', link: 'data:text/html,<script>1</script>' } },
      { type: '2', siteResourceLink: {} },
      { type: '1', resource: { name: '正常课件.pdf', id: 'r1' } },
      { type: '1', resource: {} },
      { siteResourceLink: { link: 'https://teacher.example.com/syllabus' } },
    ],
  }])

  const fileRows = rows.filter((row) => !row.isNode)
  const links = fileRows.filter((row) => row.isLink)
  // javascript:/data:/空链接全部出局，合法 http 外链保留
  assert.equal(links.length, 1)
  assert.equal(links[0].link, 'https://teacher.example.com/syllabus')
  // 没有 resourceId 的文件行不渲染（点了必 400，还共用 '' 进度键）
  const downloadRows = fileRows.filter((row) => !row.isLink)
  assert.deepEqual(downloadRows.map((row) => row.name), ['正常课件.pdf'])

  // 万层深树：截断而不是 RangeError
  let deep = { id: 'leaf', attachmentVOs: [{ type: '1', resource: { id: 'x', name: '深处的文件' } }] }
  for (let i = 0; i < 5000; i += 1) deep = { id: `d${i}`, children: [deep] }
  const flattened = flattenTree([deep])
  assert.ok(Array.isArray(flattened) && flattened.length < 100, '超深树按深度上限截断')
})
