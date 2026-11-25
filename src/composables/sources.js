import { computed, ref, watch } from 'vue'
import { listGithubContents, resolveGithubRepository } from '../api/sources.js'
import { friendlyError } from '../utils/errors.js'
import { auth } from './auth.js'
import { classesStore } from './classes.js'
import { addClassSource, fetchClassSources, removeClassSource } from '../api/classes.js'

const STORAGE_KEY = 'bupt-week-github-sources-v1'
const storageError = ref('')

function restore() {
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) || '[]')
    if (!Array.isArray(stored)) return []
    const seen = new Set()
    return stored.filter((item) => {
      if (!item || typeof item.owner !== 'string' || typeof item.repo !== 'string'
        || !/^[A-Za-z0-9-]+$/.test(item.owner) || !/^[A-Za-z0-9_.-]+$/.test(item.repo)
        || /^\.+$/.test(item.repo) || typeof item.ref !== 'string' || !item.ref
        || item.url !== `https://github.com/${item.owner}/${item.repo}`) return false
      const key = item.url.toLowerCase()
      if (seen.has(key)) return false
      seen.add(key)
      return true
    }).map(({ owner, repo, ref, url }) => ({ owner, repo, ref, url }))
  } catch {
    return []
  }
}

const repositories = ref(restore())
// 目录缓存只保留在内存；切标签不会丢失，每次点击刷新可重新取数。
const browsers = ref({})
const classSources = ref([])
const sharedError = ref('')
const sharedState = ref('idle')
let sharedRevision = 0
const allRepositories = computed(() => [...repositories.value, ...classSources.value.filter((source) => source.type === 'github')])
const sharedLinks = computed(() => classSources.value.filter((source) => source.type === 'link'))

async function loadShared() {
  if (!auth.ucloudReady.value) return
  const revision = ++sharedRevision
  sharedState.value = 'loading'
  sharedError.value = ''
  try {
    await classesStore.load()
    if (classesStore.state.value === 'error') throw new Error(classesStore.error.value)
    if (revision !== sharedRevision) return
    const results = await Promise.allSettled(classesStore.classes.value.map(async (cls) => {
      const data = await fetchClassSources(auth.sessionIdFor('ucloud'), cls.classId)
      return (data.sources || []).map((source) => ({ ...source, classId: cls.classId, className: cls.name, classOwner: cls.createdBy }))
    }))
    if (revision !== sharedRevision) return
    classSources.value = results.flatMap((result) => result.status === 'fulfilled' ? result.value : [])
    const failed = results.find((result) => result.status === 'rejected')
    if (failed) sharedError.value = `部分班级资料源获取失败：${friendlyError(failed.reason)}`
    sharedState.value = 'done'
  } catch (error) {
    if (revision !== sharedRevision) return
    sharedError.value = friendlyError(error)
    sharedState.value = 'error'
  }
}

async function addShared(classId, input) {
  await addClassSource(auth.sessionIdFor('ucloud'), classId, input)
  await loadShared()
}

async function removeShared(source) {
  await removeClassSource(auth.sessionIdFor('ucloud'), source.classId, source.id)
  await loadShared()
}

function canRemove(source) {
  return !source.classId || source.createdBy === auth.username.value || source.classOwner === auth.username.value
}

watch(() => `${auth.username.value}:${auth.ucloudReady.value}`, () => {
  sharedRevision += 1
  classSources.value = []
  sharedError.value = ''
  sharedState.value = 'idle'
  browsers.value = {}
})

function save() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(repositories.value))
    storageError.value = ''
  } catch {
    storageError.value = '浏览器无法保存仓库地址，刷新后本次更改可能丢失。'
  }
}

async function add(url) {
  const repository = await resolveGithubRepository(url.trim())
  const existing = repositories.value.find((item) => item.url.toLowerCase() === repository.url.toLowerCase())
  if (existing) throw new Error('这个仓库已经添加过了，可点击下方仓库地址展开')
  repositories.value = [...repositories.value, repository]
  save()
}

function remove(repository) {
  repositories.value = repositories.value.filter((item) => item.url !== repository.url)
  delete browsers.value[browserKey(repository)]
  save()
}

function stateFor(repository) {
  const key = browserKey(repository)
  if (!browsers.value[key]) {
    browsers.value[key] = { open: false, path: '', state: 'idle', error: '', entries: [], limited: false, cache: Object.create(null), revision: 0 }
  }
  return browsers.value[key]
}

function browserKey(repository) { return `${repository.classId || 'local'}:${repository.url}:${repository.ref}` }

async function openDirectory(repository, path, refresh = false) {
  const state = stateFor(repository)
  const revision = ++state.revision
  state.path = path
  state.error = ''
  state.entries = []
  state.limited = false
  if (!refresh && state.cache[path]) {
    Object.assign(state, state.cache[path], { state: 'done' })
    return
  }
  state.state = 'loading'
  try {
    const data = await listGithubContents(repository, path)
    if (state.revision !== revision) return
    state.cache[path] = data
    Object.assign(state, data, { state: 'done' })
  } catch (error) {
    if (state.revision !== revision) return
    state.state = 'error'
    state.error = friendlyError(error)
  }
}

function toggle(repository) {
  const state = stateFor(repository)
  state.open = !state.open
  if (state.open && state.state === 'idle') openDirectory(repository, '')
}

export const sourcesStore = { repositories, storageError, add, remove, stateFor, openDirectory, toggle,
  allRepositories, sharedLinks, sharedError, sharedState, loadShared, addShared, removeShared, canRemove }
