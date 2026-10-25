import { computed, readonly, ref, watch } from 'vue'
import { auth } from './auth.js'
import { fetchAssignments, fetchAssignmentDetail } from '../api/assignments.js'
import { normalizeAssignment, sortAssignments, groupByCourse, isCurrentTerm } from '../utils/deadline.js'
import { classesStore } from './classes.js'
import { readAssignmentsCache, writeAssignmentsCache } from '../utils/assignments-cache.js'
import { friendlyError } from '../utils/errors.js'

/**
 * 作业状态：stale-while-revalidate。
 *
 *   打开页面 → 先把本地缓存亮出来（有就立刻能看）→ 后台拉最新 →
 *   成功则覆盖并落盘；失败且手里有数据则保留，只挂一条「刷新失败」提示。
 *
 * 附件详情按卡片懒加载，缓存在内存里；退出登录清内存，localStorage 里的
 * 列表缓存按账号隔离保留（和课表同一个约定）。
 */

const raw = ref([])
const state = ref('idle') // idle | loading | done | error
const error = ref('')
/** true = 手里的数据来自缓存且最近一次刷新失败（黄条提示，不是红条报错） */
const stale = ref(false)
/** 当前数据是什么时候落盘的（ISO）。给「更新于 X」提示用。 */
const savedAt = ref(null)
const expanded = ref({})
const attachments = ref({})
const attachmentState = ref({})

let revision = 0

/** 展示列表只留本学期：截止已过宽限期（60 天）的往期作业（含往期未交）不再出现。
 *  解析不了截止时间的一律保留——映射失败不能误杀正常作业。 */
const assignments = computed(() =>
  sortAssignments(raw.value.map((record) => normalizeAssignment(record))).filter(isCurrentTerm))

/** 未提交判定，与「X 项未完成」计数同口径：!isCompleted 且非往期未交。 */
function isUnsubmitted(item) {
  return !item.isCompleted && item.level !== 'missed'
}

/** 「只看未提交」开关：会话级（切视图重挂载不丢，退出登录重置）。
 *  作用范围就是本学期列表——往期作业在上游已经滤掉，这里不再重复判。 */
const unsubmittedOnly = ref(false)

function toggleUnsubmittedOnly() {
  unsubmittedOnly.value = !unsubmittedOnly.value
}

/** 云邮分组在前，班级分组（手动录入的共享作业）追加在后。
 *  「只看未提交」时两侧同口径过滤，被滤空的组整个藏掉。 */
const groups = computed(() => {
  const cloud = unsubmittedOnly.value ? assignments.value.filter(isUnsubmitted) : assignments.value
  const classPart = unsubmittedOnly.value
    ? classesStore.classGroups.value
      .map((group) => ({ ...group, items: group.items.filter(isUnsubmitted) }))
      .filter((group) => group.items.length > 0)
    : classesStore.classGroups.value
  return [...groupByCourse(cloud), ...classPart]
})

const unfinishedCount = computed(() => assignments.value.filter(isUnsubmitted).length)

/** 「只看未提交」开着但列表空了：是全交了而不是本来没数据，提示口径不一样。 */
const filteredEmpty = computed(() =>
  unsubmittedOnly.value
  && groups.value.length === 0
  && (assignments.value.length > 0 || classesStore.classGroups.value.length > 0))

/** 强制走网络刷新（重试按钮也走这里，所以不看 state 直接拉）。
 *  在途时直接返回：连点重试不允许叠加请求（revision 只保数据正确，防重复靠这里）。 */
async function refresh() {
  if (!auth.ucloudReady.value) return
  if (state.value === 'loading') return
  const mine = ++revision
  state.value = 'loading'
  error.value = ''
  try {
    const records = await fetchAssignments(auth.sessionIdFor('ucloud'))
    if (mine !== revision) return
    raw.value = records
    stale.value = false
    const cache = writeAssignmentsCache(localStorage, auth.username.value, records)
    savedAt.value = cache?.savedAt ?? new Date().toISOString()
    state.value = 'done'
  } catch (caught) {
    if (mine !== revision) return
    // 手里已经有数据（缓存或上一次成功）：失败降级成提示，数据照常展示
    if (raw.value.length) {
      stale.value = true
      error.value = friendlyError(caught)
      state.value = 'done'
    } else {
      state.value = 'error'
      error.value = friendlyError(caught)
    }
  }
}

/** 进视图时调用：有缓存先亮，再刷新。已经在拉就别叠加请求。
 *  班级作业顺带 ensureLoaded（不阻塞主列表——班级拉不到只影响追加的分组）。 */
async function load() {
  if (!auth.ucloudReady.value) return
  if (state.value === 'loading') return
  if (state.value === 'idle') {
    const cache = readAssignmentsCache(localStorage, auth.username.value)
    if (cache) {
      raw.value = cache.records
      savedAt.value = cache.savedAt
      state.value = 'done'
    }
  }
  classesStore.ensureLoaded().catch(() => {})
  await refresh()
}

/** 展开卡片：懒加载附件详情，每个作业只拉一次（失败可用 retryAttachment 重拉）。 */
async function toggle(id) {
  if (expanded.value[id]) {
    expanded.value = { ...expanded.value, [id]: false }
    return
  }
  expanded.value = { ...expanded.value, [id]: true }
  await loadAttachments(id)
}

async function loadAttachments(id) {
  if (attachments.value[id] || attachmentState.value[id] === 'loading') return
  attachmentState.value = { ...attachmentState.value, [id]: 'loading' }
  try {
    const detail = await fetchAssignmentDetail(auth.sessionIdFor('ucloud'), id)
    attachments.value = { ...attachments.value, [id]: detail.attachments }
    attachmentState.value = { ...attachmentState.value, [id]: 'done' }
  } catch {
    attachmentState.value = { ...attachmentState.value, [id]: 'error' }
  }
}

function reset() {
  revision += 1
  raw.value = []
  state.value = 'idle'
  error.value = ''
  stale.value = false
  savedAt.value = null
  unsubmittedOnly.value = false
  expanded.value = {}
  attachments.value = {}
  attachmentState.value = {}
}

watch(() => auth.ucloudReady.value, (ready) => {
  if (!ready) reset()
})

export const assignmentsStore = {
  groups: readonly(groups),
  unfinishedCount: readonly(unfinishedCount),
  unsubmittedOnly: readonly(unsubmittedOnly),
  filteredEmpty: readonly(filteredEmpty),
  state: readonly(state),
  error: readonly(error),
  stale: readonly(stale),
  savedAt: readonly(savedAt),
  expanded: readonly(expanded),
  attachments: readonly(attachments),
  attachmentState: readonly(attachmentState),
  load,
  retry: refresh,
  toggle,
  toggleUnsubmittedOnly,
  retryAttachment: loadAttachments,
  reset,
}
