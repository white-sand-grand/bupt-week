import { computed, readonly, ref, watch } from 'vue'
import { auth } from './auth.js'
import { fetchCourses, fetchCourseware } from '../api/courseware.js'
import { flattenTree } from '../utils/courseware-tree.js'
import { friendlyError } from '../utils/errors.js'

/**
 * 课件状态：课程列表 + 每门课的资料树。
 *
 * 树按 siteId 缓存在内存（不落盘——课件列表大、时效要求低，退出登录即清），
 * 拉平成「目录行 + 文件行」的一维列表给视图直接渲染：一门课的所有资料
 * 一页铺开，多份文件滚动可见。拉平逻辑在 utils/courseware-tree.js（纯函数）。
 */

const courses = ref([])
const coursesState = ref('idle') // idle | loading | done | error
const coursesError = ref('')
const currentSiteId = ref('')
const trees = ref({}) // siteId -> { state, rows, error }

function toArray(value) {
  return Array.isArray(value) ? value : []
}

async function loadCourses() {
  if (!auth.ucloudReady.value || coursesState.value === 'loading') return
  coursesState.value = 'loading'
  coursesError.value = ''
  try {
    courses.value = await fetchCourses(auth.sessionIdFor('ucloud'))
    coursesState.value = 'done'
    // 首次进入默认选第一门课；会话恢复时保留用户已选的
    if (!currentSiteId.value && courses.value.length) openCourse(courses.value[0].id)
  } catch (error) {
    coursesState.value = 'error'
    coursesError.value = friendlyError(error)
  }
}

function openCourse(siteId) {
  currentSiteId.value = siteId
  void loadTree(siteId)
}

async function loadTree(siteId) {
  const cached = trees.value[siteId]
  if (cached?.state === 'loading' || cached?.state === 'done') return
  trees.value = { ...trees.value, [siteId]: { state: 'loading', rows: [], error: '' } }
  try {
    const tree = await fetchCourseware(auth.sessionIdFor('ucloud'), siteId)
    trees.value = { ...trees.value, [siteId]: { state: 'done', rows: flattenTree(tree), error: '' } }
  } catch (error) {
    trees.value = { ...trees.value, [siteId]: { state: 'error', rows: [], error: friendlyError(error) } }
  }
}

/** 展示态聚合：课程行 + 当前课的资料行（给 computed 用）。 */
const fileCount = computed(() => {
  const current = trees.value[currentSiteId.value]
  if (!current || current.state !== 'done') return 0
  return current.rows.filter((row) => !row.isNode).length
})

function reset() {
  courses.value = []
  coursesState.value = 'idle'
  coursesError.value = ''
  currentSiteId.value = ''
  trees.value = {}
}

watch(() => auth.ucloudReady.value, (ready) => {
  if (!ready) reset()
})

export const coursewareStore = {
  courses: readonly(courses),
  coursesState: readonly(coursesState),
  coursesError: readonly(coursesError),
  currentSiteId: readonly(currentSiteId),
  trees: readonly(trees),
  fileCount: readonly(fileCount),
  loadCourses,
  openCourse,
  retryTree: (siteId) => loadTree(siteId),
  reset,
}
