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
 * @param {string} sessionId 云邮会话 ID——服务端靠它鉴权（本站所有业务接口
 *   都把 sessionId 放请求体，不进 query），漏发会被当成未登录永远 401
 * @param {string} resourceId 云邮资源 ID
 * @returns {Promise<string>} /file/... 形式的路径
 */
export async function resolveResourceDownload(sessionId, resourceId) {
  const { fileUrl } = await api('/api/ucloud/resource/download', {
    method: 'POST',
    body: { sessionId, resourceId },
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
 * @param {{ onProgress?: ({ received: number, total: number|null }) => void, signal?: AbortSignal }} [options]
 *   onProgress 在传了且浏览器支持流式读取时逐块回调；total 取自 Content-Length，
 *   代理或上游没给（chunked）时是 null，调用方按「只知道已下载多少」展示。
 */
export async function downloadFile(fileUrl, filename, { onProgress, signal } = {}) {
  // fileUrl 是后端返回的 /file/... 相对路径，同样要拼上后端地址
  const response = await fetch(backendUrl(fileUrl), { signal })
  if (!response.ok) {
    throw new Error(`下载失败（HTTP ${response.status}）`)
  }

  const blob = await responseToBlob(response, onProgress)
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
 * 响应体 → Blob。给了 onProgress 就逐块读取汇报（附件是几百 MB 的课件，
 * 一圈等待毫无反馈会让用户以为点了个假按钮）；Content-Length 拿不到时
 * total 为 null。流式读取不可用的旧 webview 落回一次性 blob。
 */
async function responseToBlob(response, onProgress) {
  if (typeof onProgress !== 'function' || !response.body) {
    return response.blob()
  }

  const total = Number(response.headers.get('Content-Length')) || null
  const chunks = []
  let received = 0
  const reader = response.body.getReader()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    chunks.push(value)
    received += value.byteLength
    onProgress({ received, total })
  }
  return new Blob(chunks, { type: response.headers.get('Content-Type') || '' })
}

/**
 * 一步完成：解析地址并下载。第 3 期作业列表里每个附件的入口。
 */
export async function downloadResource(sessionId, resourceId, filename, options = {}) {
  const fileUrl = await resolveResourceDownload(sessionId, resourceId)
  await downloadFile(fileUrl, filename, options)
}
