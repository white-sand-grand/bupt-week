import { computed, readonly, ref, watch } from 'vue'
import { auth } from './auth.js'
import { fetchAssignments, fetchAssignmentDetail } from '../api/assignments.js'
import { normalizeAssignment, sortAssignments, groupByCourse } from '../utils/deadline.js'

/**
 * 作业状态：登录后拉全量列表，分级排序分组都在前端（薄后端约定）。
 * 附件详情按卡片懒加载，缓存在内存里；退出登录即清空。
 */

const raw = ref([])
const state = ref('idle') // idle | loading | done | error
const error = ref('')
const expanded = ref({})
const attachments = ref({})
const attachmentState = ref({})

let revision = 0

const assignments = computed(() => sortAssignments(raw.value.map((record) => normalizeAssignment(record))))
const groups = computed(() => groupByCourse(assignments.value))
const unfinishedCount = computed(() => assignments.value.filter((item) => !item.isCompleted && item.level !== 'missed').length)

async function load() {
  if (!auth.ucloudReady.value) return
  if (state.value === 'done') return

  const mine = ++revision
  state.value = 'loading'
  error.value = ''
  try {
    const records = await fetchAssignments(auth.sessionIdFor('ucloud'))
    if (mine !== revision) return
    raw.value = records
    state.value = 'done'
  } catch (caught) {
    if (mine !== revision) return
    state.value = 'error'
    error.value = caught.message || '作业列表获取失败'
  }
}

/** 展开卡片：懒加载附件详情，每个作业只拉一次。 */
async function toggle(id) {
  if (expanded.value[id]) {
    expanded.value = { ...expanded.value, [id]: false }
    return
  }
  expanded.value = { ...expanded.value, [id]: true }

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
  state: readonly(state),
  error: readonly(error),
  expanded: readonly(expanded),
  attachments: readonly(attachments),
  attachmentState: readonly(attachmentState),
  load,
  toggle,
  reset,
}
