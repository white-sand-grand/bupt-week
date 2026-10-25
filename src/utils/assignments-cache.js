/**
 * 作业列表的本地缓存。语义对齐课表缓存（timetable-cache.js）：
 * 按 username 隔离、结构校验、损坏自愈——但读取永远静默返回，
 * 因为缓存只是兜底，不值得为它打断界面。
 *
 * 用途：打开页面先亮缓存、后台刷新（stale-while-revalidate）；
 * 刷新失败或离线时保住已有数据，而不是把用户推到一张空列表前。
 */

export const ASSIGNMENTS_KEY = 'bupt-week-assignments-v1'

export function validateAssignmentsCache(value) {
  // username 必须非空：空串会让所有「上游没给学号」的账号共享同一份缓存
  // （企微回流路径就可能拿到空学号），击穿按账号隔离的约定
  return value?.version === 1 && typeof value.username === 'string' && value.username !== ''
    && typeof value.savedAt === 'string' && Number.isFinite(Date.parse(value.savedAt))
    && Array.isArray(value.records)
    && value.records.every((record) => record && record.id !== undefined && record.id !== null)
}

/**
 * 读指定账号的缓存。
 * JSON 损坏或结构不对：清掉键、返回 null（这份数据已不可信）。
 * 账号不符：返回 null 但**不清键**——那是另一个账号的缓存，退出换号后还要用。
 */
export function readAssignmentsCache(storage, username) {
  let raw = null
  try {
    raw = storage.getItem(ASSIGNMENTS_KEY)
    if (!raw) return null
    const cache = JSON.parse(raw)
    if (cache.username !== username) return null
    if (!validateAssignmentsCache(cache)) throw new Error('bad cache')
    return cache
  } catch {
    try {
      // 只有确认这份 JSON 属于当前账号却坏了才清；username 不符的路径不会走到这
      if (raw !== null && JSON.parse(raw)?.username === username) {
        storage.removeItem(ASSIGNMENTS_KEY)
      }
    } catch {
      storage.removeItem(ASSIGNMENTS_KEY)
    }
    return null
  }
}

/**
 * 写缓存。记录不完整（缺 id）宁可不写，也别把坏数据落盘。
 * 隐私模式写失败静默放过：内存里的数据仍可用，只是刷新后要重新拉。
 * @returns 写入的缓存对象；校验不过返回 null
 */
export function writeAssignmentsCache(storage, username, records) {
  const cache = { version: 1, username, savedAt: new Date().toISOString(), records }
  if (!validateAssignmentsCache(cache)) return null
  try {
    storage.setItem(ASSIGNMENTS_KEY, JSON.stringify(cache))
  } catch {
    // localStorage 满了或被禁：无所谓，缓存只是加速器
  }
  return cache
}
