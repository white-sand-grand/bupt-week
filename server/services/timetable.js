import { ApiError } from '../http.js'
import { mergeCookies } from './cas.js'
import { buildHeaders, isLoginPage, parseSetCookies } from './jwgl.js'

const JWGL_BASE = 'https://jwgl.bupt.edu.cn'

// ── 课表页面解析 ────────────────────────────────────────────────────────────
// 教务的课表页（xsdPerson.jsp）是服务端渲染 HTML，没有 JSON 可拿，只能从
// 标记里抽字段。正则编码的是这个页面的 DOM 契约，别随手改。
//
// 解析原则是 fail-loud：结构对不上（周次缺失、星期不是 7 天、节次对不上、
// 时间格式不认识）一律抛错，绝不返回半份或错位的数据——宁可不显示，
// 不要显示错的课表。

const FAIL_NOT_TIMETABLE = '未找到课表，请重新登录教务系统后重试'
const FAIL_MISSING_META = '课表页面缺少周次、日期或节次信息，暂未更新本地课表'
const FAIL_BAD_COURSE = '部分课程的时间格式无法识别，暂未更新本地课表'

/** 节次起止时间的几种分隔写法（全角～/半角~/连字符/破折号） */
const PERIOD_TIME_PATTERN = /\d{2}:\d{2}\s*[～~\-—]\s*\d{2}:\d{2}/

const NAMED_ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' }

/** 实体 → 字符。数字实体（&#x1F600;/&#160;）超出 Unicode 范围时原样保留。 */
function decodeEntity(match, entity) {
  if (!entity.startsWith('#')) return NAMED_ENTITIES[entity.toLowerCase()] ?? match
  const isHex = entity[1].toLowerCase() === 'x'
  const code = isHex ? parseInt(entity.slice(2), 16) : Number(entity.slice(1))
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match
}

/** HTML 片段 → 纯文本。先去标签再解实体（顺序不能反：先解 &lt; 会凭空
 *  造出可剥的标签），最后折叠空白。 */
function plainText(fragment = '') {
  return fragment
    .replace(/<[^>]*>/g, ' ')
    .replace(/&(#x[\da-f]+|#\d+|amp|lt|gt|quot|apos|nbsp);/gi, decodeEntity)
    .replace(/\s+/g, ' ')
    .trim()
}

/** <select id="..."> 的全部选项（周次下拉、节次模式下拉共用）。 */
function selectOptions(html, id) {
  const body = html.match(new RegExp(`<select\\b[^>]*id=["']${id}["'][^>]*>([\\s\\S]*?)<\\/select>`, 'i'))?.[1] || ''
  const options = []
  for (const option of body.matchAll(/<option\b[^>]*value=["']([^"']*)["'][^>]*>([\s\S]*?)<\/option>/gi)) {
    options.push({ value: plainText(option[1]), label: plainText(option[2]) })
  }
  return options
}

/** 页内脚本里 var 声明的字符串变量（dqzc 当前周次、kbjcmsid 节次模式）。
 *  valuePattern 是值的字符集；dqzc 限定纯数字——教务只写数字，别的形状
 *  一律视为页面结构损坏（返回空串，由调用方 fail-loud）。 */
function scriptStringVar(html, name, valuePattern = '[^\'"]+') {
  return html.match(new RegExp(`\\bvar\\s+${name}\\s*=\\s*['"](${valuePattern})['"]`))?.[1] || ''
}

/** 顶部日期选择框的值（YYYY-MM-DD），用于锚定这页课表对应的具体一周。 */
function chosenDate(html) {
  return html.match(/<input\b[^>]*id=["']xzrq["'][^>]*value=["'](\d{4}-\d{2}-\d{2})["']/i)?.[1] || ''
}

/** 表头星期列：第一个 li 是「节次/日期」表头角，跳过；其余每列两个 span
 *  （星期名 + 日期）。行数必须是 7，否则视为结构损坏。 */
function dayColumns(html) {
  const header = html.match(/<ul\b[^>]*class=["']table-header["'][^>]*>([\s\S]*?)<\/ul>/i)?.[1] || ''
  return [...header.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].slice(1).map((match) => {
    const spans = [...match[1].matchAll(/<span\b[^>]*>([\s\S]*?)<\/span>/gi)].map((span) => plainText(span[1]))
    return { label: spans[0], date: spans[1] || '' }
  })
}

/** 左侧节次列：h5 是节次号，剩余文本里第一个「HH:MM～HH:MM」是起止时间。 */
function periodRows(html) {
  return [...html.matchAll(/<li\b[^>]*class=["']row-one["'][^>]*>([\s\S]*?)<\/li>/gi)].map((match) => ({
    number: Number(plainText(match[1].match(/<h5\b[^>]*>([\s\S]*?)<\/h5>/i)?.[1])),
    time: plainText(match[1]).match(PERIOD_TIME_PATTERN)?.[0] || '',
  }))
}

/** 课程卡详情 li（「上课时间：…」等）→ 按标签取值的函数。 */
function fieldLookup(details) {
  return (label) => details.find((item) => item.startsWith(label))?.replace(new RegExp(`^${label}[:：]\\s*`), '') || ''
}

/** 「[1,3-5]节」里的节次号；没有方括号节次标记返回空数组。 */
function slotNumbers(scheduleText) {
  const listed = scheduleText.match(/\[([\d\s,，\-]+)\]节/)?.[1] || ''
  return listed.match(/\d+/g)?.map(Number) || []
}

/** 一张课程卡 → 课表条目。dayN 类名从 0 起（day0=周一），节次取并集端点。 */
function courseFromCard(classAttr, cardHtml, periods) {
  const day = Number(classAttr.match(/\bday(\d)\b/)?.[1]) + 1
  const name = plainText(cardHtml.match(/<h4\b[^>]*>([\s\S]*?)<\/h4>/i)?.[1])
  const details = [...cardHtml.matchAll(/<li\b[^>]*>([\s\S]*?)<\/li>/gi)].map((item) => plainText(item[1]))
  const field = fieldLookup(details)
  const schedule = field('上课时间')
  const slots = slotNumbers(schedule)

  const dayKnown = Number.isInteger(day) && day >= 1 && day <= 7
  const slotsKnown = slots.length > 0 && slots.every((slot) => periods.some((period) => period.number === slot))
  if (!name || !dayKnown || !slotsKnown) {
    throw new Error(FAIL_BAD_COURSE)
  }

  return {
    name,
    day,
    start: Math.min(...slots),
    end: Math.max(...slots),
    location: field('上课地点'),
    campus: field('上课校区'),
    schedule,
    details,
  }
}

/** 全部课程卡 → 去重后的课程列表（同卡出现两次只留第一份）。 */
function parseCourses(html, periods) {
  const courses = []
  const seen = new Set()
  for (const match of html.matchAll(/<div\b[^>]*class=["']([^"']*\btable-class\b[^"']*)["'][^>]*>([\s\S]*?)<\/div>/gi)) {
    const course = courseFromCard(match[1], match[2], periods)
    const key = JSON.stringify(course)
    if (!seen.has(key)) {
      seen.add(key)
      courses.push(course)
    }
  }
  return courses
}

export function parseTimetable(html) {
  if (!/class=["'][^"']*\btable-header\b/i.test(html)) {
    throw new Error(FAIL_NOT_TIMETABLE)
  }

  // 周次取不到要转成 NaN 而不是 Number('')===0：前者会被下面的 fail-loud
  // 拦下，后者可能把「取不到」误当「第 0 周」放行
  const weekText = scriptStringVar(html, 'dqzc', '\\d+')
  const week = weekText === '' ? NaN : Number(weekText)
  const mode = scriptStringVar(html, 'kbjcmsid')
  const date = chosenDate(html)
  const weeks = selectOptions(html, 'xkzc')
    .map(({ value }) => Number(value))
    .filter((value) => Number.isInteger(value) && value >= 0 && value <= 60)
  const days = dayColumns(html)
  const periods = periodRows(html)

  const metaKnown = Number.isInteger(week) && weeks.includes(week) && mode && date
    && days.length === 7 && periods.length > 0
  if (!metaKnown) {
    throw new Error(FAIL_MISSING_META)
  }

  return {
    week,
    mode,
    date,
    weeks,
    modes: selectOptions(html, 'kbjcmsid'),
    days,
    periods,
    courses: parseCourses(html, periods),
  }
}

// ── 取数 ────────────────────────────────────────────────────────────────────

/**
 * 取一周课表（不带参数时取当前周，同时返回全部可选周次/节次模式）。
 *
 * @param {{ cookies: string, week?: number, mode?: string, fetchImpl?: typeof fetch }} options
 * @returns {Promise<{ timetable: object, cookies: string }>} cookies 是合并了
 *   本轮 Set-Cookie 的新 Cookie 罐，调用方应写回会话
 */
export async function fetchTimetable({ cookies, week, mode, fetchImpl = fetch }) {
  if (
    (week !== undefined && (!Number.isInteger(week) || week < 0 || week > 60))
    || (mode !== undefined && (typeof mode !== 'string' || !/^[A-Fa-f0-9]{32}$/.test(mode)))
  ) {
    throw new ApiError(400, '周次或节次模式无效')
  }

  const params = new URLSearchParams()
  if (week !== undefined) params.set('xkzc', String(week))
  if (mode !== undefined) params.set('kbjcmsid', mode)
  const query = params.toString()

  let response
  let html
  try {
    response = await fetchImpl(`${JWGL_BASE}/jsxsd/framework/xsdPerson.jsp${query ? `?${query}` : ''}`, {
      headers: buildHeaders(cookies, { Referer: `${JWGL_BASE}/jsxsd/framework/xsMain_bjyddx.jsp` }),
      signal: AbortSignal.timeout(30_000),
    })
    html = await response.text()
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError(502, { stage: 'jwgl-timetable', msg: '连不上教务系统，请稍后重试' })
  }

  if (response.status === 401 || response.status === 403 || isLoginPage(html)) {
    throw new ApiError(401, { stage: 'jwgl-auth', msg: '教务登录已过期，请重新登录' })
  }
  if (!response.ok) {
    throw new ApiError(502, { stage: 'jwgl-timetable', msg: `获取课表失败（HTTP ${response.status}）` })
  }

  let timetable
  try {
    timetable = parseTimetable(html)
  } catch (error) {
    throw new ApiError(502, { stage: 'jwgl-timetable', msg: error.message })
  }

  // 教务对不认识的参数会静默回退到默认页——校验往返一致，防止把「当前周」
  // 当成「请求的那一周」写进缓存。
  if ((week !== undefined && timetable.week !== week) || (mode !== undefined && timetable.mode !== mode)) {
    throw new ApiError(502, { stage: 'jwgl-timetable', msg: '教务系统返回的周次或节次模式与请求不符' })
  }

  return { timetable, cookies: mergeCookies(cookies, parseSetCookies(response)) }
}
