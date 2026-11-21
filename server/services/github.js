import { ApiError } from '../http.js'

const API_ORIGIN = 'https://api.github.com'
const NAME = /^[A-Za-z0-9_.-]+$/

function repositoryPath(owner, repo) {
  if (typeof owner !== 'string' || typeof repo !== 'string'
    || !NAME.test(owner) || !NAME.test(repo) || /^\.+$/.test(owner) || /^\.+$/.test(repo)
    || owner.length > 100 || repo.length > 100) {
    throw new ApiError(400, 'GitHub 仓库地址无效')
  }
  return `/repos/${owner}/${repo}`
}

function contentsPath({ owner, repo, path = '', ref = '' }) {
  const base = repositoryPath(owner, repo)
  if (typeof path !== 'string' || path.length > 4096
    || /[\\\x00-\x1f\x7f]/.test(path)
    || (path && path.split('/').some((part) => !part || part === '.' || part === '..'))) {
    throw new ApiError(400, '仓库文件路径无效')
  }
  if (typeof ref !== 'string' || !ref || ref.length > 255 || /[\x00-\x1f\x7f]/.test(ref)) {
    throw new ApiError(400, '缺少或无效的仓库分支，请重新添加仓库')
  }
  return `${base}/contents/${path.split('/').map(encodeURIComponent).join('/')}?${new URLSearchParams({ ref })}`
}

async function githubRequest(path, { raw = false, fetchImpl = fetch } = {}) {
  let response
  try {
    response = await fetchImpl(`${API_ORIGIN}${path}`, {
      headers: {
        Accept: raw ? 'application/vnd.github.raw+json' : 'application/vnd.github+json',
        'User-Agent': 'BUPT-week',
        'X-GitHub-Api-Version': '2022-11-28',
      },
      // 只访问固定 API 域名，不跟随上游重定向，也不复制浏览器的凭证。
      redirect: 'manual',
      signal: AbortSignal.timeout(raw ? 120_000 : 20_000),
    })
  } catch {
    throw new ApiError(502, '无法连接 GitHub，请检查网络后重试')
  }
  if (response.ok) return response
  await response.body?.cancel()
  if (response.status === 404) throw new ApiError(404, '仓库或文件不存在，或该仓库不是公开仓库')
  if (response.status === 403 || response.status === 429) {
    throw new ApiError(429, 'GitHub 暂时限制了访问频率，请稍后重试，或前往原仓库下载')
  }
  if (response.status >= 300 && response.status < 400) {
    throw new ApiError(422, '仓库地址已变更，请使用 GitHub 上的最新地址重新添加')
  }
  if (response.status === 409) throw new ApiError(422, '这个仓库还是空的，暂时没有可下载的文件')
  if (response.status === 422) throw new ApiError(422, 'GitHub 无法提供该文件，请前往原仓库下载')
  throw new ApiError(502, `GitHub 请求失败（HTTP ${response.status}），请稍后重试`)
}

async function githubJson(path, options) {
  const response = await githubRequest(path, options)
  const data = await response.json().catch(() => null)
  if (!data) throw new ApiError(502, 'GitHub 返回的数据无法读取，请稍后重试')
  return data
}

export async function getGithubRepository(url, options) {
  let parsed
  try { parsed = new URL(url) } catch { throw new ApiError(400, '请输入完整的 GitHub 仓库地址') }
  const parts = parsed.pathname.replace(/\/+$/, '').split('/').slice(1)
  if (parsed.protocol !== 'https:' || parsed.hostname !== 'github.com' || parsed.port
    || parsed.username || parsed.password || parts.length !== 2) {
    throw new ApiError(400, '请填写 https://github.com/作者/仓库 形式的仓库首页地址')
  }
  const [owner, rawRepo] = parts
  const repo = rawRepo.replace(/\.git$/, '')
  const data = await githubJson(repositoryPath(owner, repo), options)
  if (data.private !== false || !data.owner?.login || !data.name || !data.default_branch) {
    throw new ApiError(422, '目前仅支持有默认分支的公开 GitHub 仓库')
  }
  repositoryPath(data.owner.login, data.name)
  return {
    owner: data.owner.login,
    repo: data.name,
    ref: data.default_branch,
    url: `https://github.com/${data.owner.login}/${data.name}`,
  }
}

export async function listGithubContents(query, options) {
  const data = await githubJson(contentsPath(query), options)
  if (!Array.isArray(data)) throw new ApiError(400, '请选择文件夹浏览')
  const entries = data.map((item) => ({
    name: item.name,
    path: item.path,
    type: item.type === 'dir' ? 'dir' : item.type === 'file' && !item.submodule_git_url ? 'file' : 'link',
    size: item.size,
  }))
  entries.sort((a, b) => (a.type !== 'dir') - (b.type !== 'dir') || a.name.localeCompare(b.name, 'zh-CN', { numeric: true }))
  return { entries, limited: data.length >= 1000 }
}

export async function getGithubFile(query, options) {
  if (!query.path) throw new ApiError(400, '缺少要下载的文件路径')
  const data = await githubJson(contentsPath(query), options)
  if (data.type !== 'file' || data.target || data.submodule_git_url || !/^[a-f0-9]{40,64}$/.test(data.sha || '')) {
    throw new ApiError(422, '该项目不是普通文件，请前往原仓库查看')
  }
  if (data.size > 100 * 1024 * 1024) throw new ApiError(422, '文件超过 100 MB，请前往原仓库下载')
  if (data.encoding === 'base64' && data.size < 1024 && data.content
    && atob(data.content.replace(/\s/g, '')).startsWith('version https://git-lfs.github.com/spec/v1')) {
    throw new ApiError(422, '该文件使用 Git LFS 存储，请前往原仓库下载完整文件')
  }
  // 用文件的 SHA 固定本次下载，避免分支在解析与取流之间更新。
  const response = await githubRequest(`${repositoryPath(query.owner, query.repo)}/git/blobs/${data.sha}`, { ...options, raw: true })
  return { response, filename: data.name }
}
