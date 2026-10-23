import { api, backendUrl } from './client.js'

/**
 * 附件下载。
 *
 * 为什么不能直接 `<a href="fileucloud 直链">`：
 *   - 那个域名 CORS 白名单只放行 ucloud.bupt.edu.cn，本站取不到
 *   - S3 防盗链会拒绝携带 Blade-Auth 的请求
 * 所以必须经后端换成本站 /file 路径，再由 /file 代理补上 Origin / Referer、
 * 剥掉鉴权头去取。
 */

/**
 * 向后端要某个附件的代理下载地址。
 *
 * @param {string} resourceId 云邮资源 ID
 * @returns {Promise<string>} /file/... 形式的路径
 */
export async function resolveResourceDownload(resourceId) {
  const { fileUrl } = await api('/api/ucloud/resource/download', {
    method: 'POST',
    body: { resourceId },
  })
  return fileUrl
}

/**
 * 下载到本地。
 *
 * 用 blob + <a download> 而不是直接跳转：跳转会离开单页应用，而且文件名会变成
 * S3 的 storageId.ext，而不是作业里显示的附件名。
 *
 * @param {string} fileUrl /file/... 路径
 * @param {string} filename 保存用的文件名
 */
export async function downloadFile(fileUrl, filename) {
  // fileUrl 是后端返回的 /file/... 相对路径，同样要拼上后端地址
  const response = await fetch(backendUrl(fileUrl))
  if (!response.ok) {
    throw new Error(`下载失败（HTTP ${response.status}）`)
  }

  const blob = await response.blob()
  const objectUrl = URL.createObjectURL(blob)
  const anchor = document.createElement('a')
  anchor.href = objectUrl
  anchor.download = filename || 'download'
  document.body.appendChild(anchor)
  anchor.click()
  document.body.removeChild(anchor)
  URL.revokeObjectURL(objectUrl)
}

/**
 * 一步完成：解析地址并下载。第 3 期作业列表里每个附件的入口。
 */
export async function downloadResource(resourceId, filename) {
  const fileUrl = await resolveResourceDownload(resourceId)
  await downloadFile(fileUrl, filename)
}
