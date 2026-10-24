import { computed, readonly, ref, watch } from 'vue'
import { auth } from './auth.js'
import { fetchCourses, fetchCourseware } from '../api/courseware.js'
import { friendlyError } from '../utils/errors.js'

/**
 * 课件状态：课程列表 + 每门课的资料树。
 *
 * 树按 siteId 缓存在内存（不落盘——课件列表大、时效要求低，退出登录即清），
 * 拉平成「目录行 + 文件行」的一维列表给视图直接渲染：一门课的所有资料
 * 一页铺开，多份文件滚动可见。
 */

const courses = ref([])
const coursesState = ref('idle') // idle | loading | done | error
const coursesError = ref('')
const currentSiteId = ref('')
const trees = ref({}) // siteId -> { state, rows, error }

/** 拉平资料树：目录节点与它挂的附件各成一行，children 递归。
 *  字段名按 MYUCLOUD 的防御式读取（上游存在别名）。 */
function flattenTree(nodes, depth = 0, prefix = '') {
  if (!Array.isArray(nodes)) return []
  return nodes.flatMap((node, index) => {
    if (!node || typeof node !== 'object') return []
    const nodeKey = `${prefix}${node.id || node.resourceId || index}`

    const fileRows = toArray(node.attachmentVOs ?? node.attachments).map((attachment, i) => {
      const resource = attachment?.resource || {}
      const isLink = String(attachment?.type) === '2' || Boolean(attachment?.siteResourceLink?.link)
      return {
        key: `${nodeKey}-file-${resource.id || attachment?.id || i}`,
        depth: depth + 1,
        isLink,
        name: isLink
          ? attachment.siteResourceLink?.title || attachment.siteResourceLink?.link || '外部链接'
          : resource.name || resource.fileName || attachment?.name || '未命名附件',
        resourceId: resource.id || resource.resourceId || '',
        // fileSizeUnit 上游给的是「2.5MB」这类现成文案，ext 是不带点的后缀
        meta: isLink ? '外部链接' : [resource.ext, resource.fileSizeUnit].filter(Boolean).join(' · '),
        link: isLink ? attachment.siteResourceLink?.link || '' : '',
      }
    })

    return [
      {
        key: `node-${nodeKey}`,
        depth,
        isNode: true,
        name: node.resourceName || node.name || node.title || '未命名资料',
        meta: node.resourceTypeName || '',
      },
      ...fileRows,
      ...flattenTree(node.children, depth + 1, `${nodeKey}.`),
    ]
  })
}

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
