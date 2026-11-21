import { ref } from 'vue'
import { listGithubContents, resolveGithubRepository } from '../api/sources.js'
import { friendlyError } from '../utils/errors.js'

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
  delete browsers.value[repository.url]
  save()
}

function stateFor(repository) {
  if (!browsers.value[repository.url]) {
    browsers.value[repository.url] = { open: false, path: '', state: 'idle', error: '', entries: [], limited: false, cache: Object.create(null), revision: 0 }
  }
  return browsers.value[repository.url]
}

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

export const sourcesStore = { repositories, storageError, add, remove, stateFor, openDirectory, toggle }
