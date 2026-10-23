/**
 * 时间展示格式化。数据时间戳是 ISO（UTC），展示按北京时间墙上钟——
 * 用户在校园里就是按北京时间生活的。
 */

/**
 * 北京时间的日期串（YYYY-MM-DD），带天数偏移。
 * 「今天/昨天」判断、与学校接口的墙上钟日期比对都走这里，
 * 设备在什么时区都不影响。
 */
export function beijingDateString(offsetDays = 0, now = Date.now()) {
  return new Date(now + offsetDays * 86_400_000).toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
}

/**
 * ISO 时间 → 「今天 14:30 / 昨天 21:00 / 10月20日 14:30」。
 * 无法解析返回空串，调用方按无时间处理（宁可少展示，不展示垃圾）。
 */
export function formatUpdatedAt(iso, now = new Date()) {
  if (!iso) return ''
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return ''

  const day = date.toLocaleDateString('sv-SE', { timeZone: 'Asia/Shanghai' })
  const time = date.toLocaleTimeString('zh-CN', {
    timeZone: 'Asia/Shanghai', hour: '2-digit', minute: '2-digit', hour12: false,
  })

  if (day === beijingDateString(0, now.getTime())) return `今天 ${time}`
  if (day === beijingDateString(-1, now.getTime())) return `昨天 ${time}`
  const [, month, dayOfMonth] = day.split('-')
  return `${Number(month)}月${Number(dayOfMonth)}日 ${time}`
}
