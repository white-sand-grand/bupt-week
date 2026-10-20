import { ApiError } from '../http.js'

const API_ORIGIN = 'https://apiucloud.bupt.edu.cn'
const FILE_ORIGIN = 'https://fileucloud.bupt.edu.cn'
const BUSINESS_AUTH = 'Basic c3dvcmQ6c3dvcmRfc2VjcmV0'
const TENANT_ID = '000000'

/**
 * 云邮附件直链 → 本站 /file 代理路径。
 *
 * 只认 fileucloud.bupt.edu.cn。别的域名一律返回空字符串——否则这个代理会被
 * 当成任意源的开放转发用。上游给的地址理论上只有这一个域名，多一层校验不亏。
 *
 * @param {string} fileUrl 形如 https://fileucloud.bupt.edu.cn/ucloud/document/xxx.pdf?...
 * @returns {string} 形如 /file/ucloud/document/xxx.pdf?...，不合规时返回 ''
 */
export function toFileProxyPath(fileUrl = '') {
  const replaced = String(fileUrl).replace(/^https?:\/\/fileucloud\.bupt\.edu\.cn(?=\/)/i, '/file')
  return replaced.startsWith('/file/') || replaced === '/file' ? replaced : ''
}

/**
 * 取一个附件的可下载地址。
 *
 * 上游 `preview-url` 返回的 previewUrl 是带签名的 fileucloud 直链，浏览器既不能
 * 跨域取（CORS 白名单只放行 ucloud.bupt.edu.cn），也不能带 Blade-Auth（S3 防盗链
 * 会以 InvalidRequest 拒掉）。所以必须由本后端改写成本站 /file 路径，走已有代理。
 *
 * @param {{ token: string, resourceId: string, fetchImpl?: typeof fetch }} options
 * @returns {Promise<string>} /file/... 形式的代理路径
 */
export async function resolveResourceDownload({ token, resourceId, fetchImpl = fetch }) {
  if (!token) {
    throw new ApiError(401, { stage: 'ucloud-auth', msg: '请先登录云邮再下载附件' })
  }
  if (!resourceId) {
    throw new ApiError(400, '缺少附件 ID')
  }

  const url = `${API_ORIGIN}/blade-source/resource/preview-url?resourceId=${encodeURIComponent(resourceId)}`

  let body
  try {
    const response = await fetchImpl(url, {
      headers: {
        'Blade-Auth': token,
        Authorization: BUSINESS_AUTH,
        'Tenant-Id': TENANT_ID,
      },
    })
    body = await response.json().catch(() => null)
    if (!response.ok) {
      throw new ApiError(502, `获取附件地址失败（HTTP ${response.status}）`)
    }
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError(502, `无法连接上游服务 ${API_ORIGIN.replace(/^https?:\/\//, '')}`)
  }

  if (!body || body.success === false || (body.code !== undefined && body.code !== 200)) {
    throw new ApiError(502, `获取附件地址失败：${body?.msg || '上游返回异常'}`)
  }

  const fileUrl = toFileProxyPath(body?.data?.previewUrl || '')
  if (!fileUrl) {
    throw new ApiError(502, '附件地址不在文件存储域名上，暂时无法下载')
  }

  return fileUrl
}
