import { getGithubRepository } from './github.js'
import { inputError, requiredText } from './class-records.js'

export async function prepareSource(input) {
  if (!['github', 'link'].includes(input.type)) throw inputError('资料源类型只支持 github 或 link')
  const raw = requiredText(input.url, 2048, '资料源地址')
  const name = input.name === undefined || input.name === '' ? '' : requiredText(input.name, 100, '资料源名称')
  if (input.type === 'github') {
    const repository = await getGithubRepository(raw)
    return { type: 'github', ...repository, name: name || `${repository.owner}/${repository.repo}` }
  }
  let url
  try { url = new URL(raw) } catch { throw inputError('请输入完整的 HTTPS 网页地址') }
  const host = url.hostname.toLowerCase()
  if (url.protocol !== 'https:' || url.username || url.password || !host.includes('.') || host.includes(':')
    || /^(?:\d{1,3}\.){3}\d{1,3}$/.test(host)
    || /(?:^|\.)(?:localhost|local|internal|lan|home|test|invalid)$/.test(host)) {
    throw inputError('只支持不含账号密码的公开 HTTPS 网页地址')
  }
  url.hash = ''
  return { type: 'link', url: url.href, name: name || host }
}
