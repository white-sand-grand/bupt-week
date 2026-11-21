import { api } from './client.js'

export async function resolveGithubRepository(url) {
  const { repository } = await api('/api/sources/github', { method: 'POST', body: { url } })
  return repository
}

function queryFor(repository, path) {
  return new URLSearchParams({ owner: repository.owner, repo: repository.repo, ref: repository.ref, path }).toString()
}

export function listGithubContents(repository, path) {
  return api(`/api/sources/github/contents?${queryFor(repository, path)}`)
}

export function githubDownloadPath(repository, path) {
  return `/api/sources/github/download?${queryFor(repository, path)}`
}
