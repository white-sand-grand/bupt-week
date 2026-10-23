import { computed, readonly, ref, watch } from 'vue'
import { auth } from './auth.js'
import { fetchTimetable } from '../api/timetable.js'
import { friendlyError } from '../utils/errors.js'
import {
  currentTimetableWeek,
  mergeTimetableWeek,
  readTimetableCache,
  TIMETABLE_KEY,
} from '../utils/timetable-cache.js'

/**
 * 课表状态：首次就绪时按周次列表逐周同步，每成功一周立刻写 localStorage；
 * 切换周次只读缓存；断网/中断时已同步的周次仍在，并提示还差几周。
 *
 * 同步带修订号守卫（借鉴 where_to_study 的 CourseRequestOwner）：
 * 退出后立刻换账号登录，旧同步的迟到响应会被丢弃，不会污染新缓存。
 */

const cache = ref(readCache())
const selectedWeek = ref(null)
const syncState = ref('idle') // idle | syncing | done | partial | error
const syncProgress = ref({ done: 0, total: 0 })
const error = ref('')

let revision = 0

function readCache() {
  try {
    return readTimetableCache(localStorage)
  } catch {
    localStorage.removeItem(TIMETABLE_KEY)
    return null
  }
}

function persist(next) {
  cache.value = next
  try {
    localStorage.setItem(TIMETABLE_KEY, JSON.stringify(next))
  } catch {
    // 隐私模式写不进去：内存里的课表仍可用，刷新后重新同步
  }
}

const username = computed(() => auth.username.value)
const weeks = computed(() => (cache.value?.username === username.value && auth.jwglReady.value
  ? cache.value.weeks
  : []))
const currentWeek = computed(() => {
  if (!weeks.value.length) return null
  const picked = weeks.value.find((w) => w.week === selectedWeek.value)
  if (picked) return picked.week
  return currentTimetableWeek(weeks.value) ?? weeks.value[0].week
})
const activeWeek = computed(() => weeks.value.find((w) => w.week === currentWeek.value) ?? null)
const pendingWeeks = computed(() => {
  // 每周课表自带完整的可选周次列表（教务返回的 weeks），拿它算「还差几周」
  const total = weeks.value[0]?.weeks?.length ?? weeks.value.length
  return Math.max(0, total - weeks.value.length)
})

/** 数据是什么时候落盘的（给「更新于 X」提示用）。 */
const savedAt = computed(() => (weeks.value.length ? cache.value?.savedAt ?? null : null))

/** 触发同步。本账号已有缓存则直接标记完成，不重复请求（幂等入口）。 */
function sync() {
  if (!auth.jwglReady.value) return
  if (weeks.value.length) {
    syncState.value = 'done'
    return
  }
  return runSync()
}

/** 强制重新同步：拉当前周（拿最新的周次列表和节次模式）+ 补齐缺失周次。
 *  已缓存的周跳过，重试不会把整个学期重拉一遍；在途时早退防连点叠加。 */
async function runSync() {
  if (syncState.value === 'syncing') return
  const mine = ++revision
  syncState.value = 'syncing'
  error.value = ''

  try {
    // 第一周不带参数：教务返回当前周 + 全部可选周次 + 节次模式
    const first = await fetchTimetable(auth.sessionIdFor('jwgl'))
    if (mine !== revision) return
    let merged = mergeTimetableWeek(cache.value, username.value, first)
    persist(merged)

    const total = first.weeks.length
    const cachedWeeks = new Set(weeks.value.map((w) => w.week))
    syncProgress.value = { done: weeks.value.length, total }

    for (const week of first.weeks) {
      if (week === first.week || cachedWeeks.has(week)) continue
      try {
        const next = await fetchTimetable(auth.sessionIdFor('jwgl'), { week, mode: first.mode })
        if (mine !== revision) return
        merged = mergeTimetableWeek(merged, username.value, next)
        persist(merged)
        syncProgress.value = { done: syncProgress.value.done + 1, total }
      } catch {
        // 单周失败不中断整体：标记 partial，继续下一周
        if (mine !== revision) return
        syncState.value = 'partial'
      }
    }

    if (mine !== revision) return
    if (syncState.value !== 'partial') syncState.value = 'done'
  } catch (caught) {
    if (mine !== revision) return
    // 一周都没拿到才算彻底失败；有旧周次时仍按 partial 展示
    syncState.value = weeks.value.length ? 'partial' : 'error'
    error.value = friendlyError(caught)
  }
}

function selectWeek(week) {
  selectedWeek.value = week
}

/** 退出登录时作废在途同步、清选中态；localStorage 保留（换回账号还能用）。 */
function reset() {
  revision += 1
  selectedWeek.value = null
  syncState.value = 'idle'
  syncProgress.value = { done: 0, total: 0 }
  error.value = ''
  cache.value = readCache()
}

// 教务侧登录态消失（退出/过期）即复位；再次登录后由视图重新触发 sync()
watch(() => auth.jwglReady.value, (ready) => {
  if (!ready) reset()
})

export const timetable = {
  weeks: readonly(weeks),
  activeWeek: readonly(activeWeek),
  currentWeek: readonly(currentWeek),
  syncState: readonly(syncState),
  syncProgress: readonly(syncProgress),
  pendingWeeks: readonly(pendingWeeks),
  savedAt: readonly(savedAt),
  error: readonly(error),
  sync,
  retry: runSync,
  selectWeek,
  reset,
}
