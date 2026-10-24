import { computed, readonly, ref, watch } from 'vue'
import { auth } from './auth.js'
import {
  addClassAssignment,
  createClass,
  deleteClassAssignment,
  fetchClassAssignments,
  joinClass,
  listMyClasses,
} from '../api/classes.js'
import { normalizeAssignment, sortAssignments } from '../utils/deadline.js'
import { friendlyError } from '../utils/errors.js'

/**
 * 班级状态：我的班级列表 + 每个班的手动作业。
 *
 * 加载一次进内存（不落 localStorage——班级数据是共享的，缓存意义小）；
 * 建班/入班/增删作业后重拉。作业 tab 的合并分组直接消费 classGroups。
 */

const classes = ref([])
const assignmentsByClass = ref({})
const state = ref('idle') // idle | loading | done | error
const error = ref('')
const selectedId = ref('')

const assignments = computed(() => {
  const all = []
  for (const cls of classes.value) {
    all.push(...(assignmentsByClass.value[cls.classId] ?? []))
  }
  return all
})

/** 作业 tab 追加在云邮分组之后的班级分组（每班一组，标题=班级名）。 */
const classGroups = computed(() =>
  classes.value
    .map((cls) => ({
      courseName: cls.name,
      items: sortAssignments(assignmentsByClass.value[cls.classId] ?? []),
    }))
    .filter((group) => group.items.length > 0),
)

async function load() {
  if (!auth.ucloudReady.value) return
  state.value = 'loading'
  error.value = ''
  try {
    const data = await listMyClasses(auth.sessionIdFor('ucloud'))
    classes.value = data.classes || []
    selectedId.value = classes.value.some((cls) => cls.classId === selectedId.value)
      ? selectedId.value
      : classes.value[0]?.classId || ''

    const pairs = await Promise.allSettled(
      classes.value.map((cls) => fetchClassAssignments(auth.sessionIdFor('ucloud'), cls.classId)),
    )
    const next = {}
    classes.value.forEach((cls, index) => {
      const result = pairs[index]
      const records = result.status === 'fulfilled' ? result.value.assignments ?? [] : []
      next[cls.classId] = records.map((record) => normalizeAssignment(record))
    })
    assignmentsByClass.value = next
    state.value = 'done'
  } catch (caught) {
    state.value = 'error'
    error.value = friendlyError(caught)
  }
}

/** 给作业 tab 的合并链路用：没拉过就拉，拉过不重复打。 */
async function ensureLoaded() {
  if (state.value === 'idle') await load()
}

async function create({ name, password }) {
  const data = await createClass(auth.sessionIdFor('ucloud'), name, password)
  await load()
  return data
}

async function join({ code, password }) {
  const data = await joinClass(auth.sessionIdFor('ucloud'), code, password)
  await load()
  return data
}

async function addAssignment(classId, payload) {
  const data = await addClassAssignment(auth.sessionIdFor('ucloud'), classId, payload)
  await load()
  return data
}

async function removeAssignment(classId, assignmentId) {
  await deleteClassAssignment(auth.sessionIdFor('ucloud'), classId, assignmentId)
  await load()
}

function select(classId) {
  selectedId.value = classId
}

function reset() {
  classes.value = []
  assignmentsByClass.value = {}
  state.value = 'idle'
  error.value = ''
  selectedId.value = ''
}

const selectedClass = computed(() => classes.value.find((cls) => cls.classId === selectedId.value) ?? null)

/** 能否删除这条班级作业：班级创建者或录入者。 */
function canDelete(assignment) {
  const username = auth.username.value
  return Boolean(username) && (assignment.createdBy === username || selectedClass.value?.createdBy === username)
}

watch(() => auth.ucloudReady.value, (ready) => {
  if (!ready) reset()
})

export const classesStore = {
  classes: readonly(classes),
  selectedId: readonly(selectedId),
  selectedClass: readonly(selectedClass),
  assignmentsByClass: readonly(assignmentsByClass),
  classGroups: readonly(classGroups),
  state: readonly(state),
  error: readonly(error),
  load,
  ensureLoaded,
  create,
  join,
  addAssignment,
  removeAssignment,
  select,
  canDelete,
  reset,
}
