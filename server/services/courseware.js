import { ApiError } from '../http.js'

const API_ORIGIN = 'https://apiucloud.bupt.edu.cn'
const BUSINESS_AUTH = 'Basic c3dvcmQ6c3dvcmRfc2VjcmV0'
const TENANT_ID = '000000'

/**
 * 课程资料树（课件）。接口未经真实账号实测（【待实测】，见
 * docs/api-reference.md §2.10），字段按防御式读取——上游可能存在别名。
 *
 * 树节点：
 *   目录节点：id / resourceName / resourceTypeName / children / attachmentVOs
 *   附件 VO：type=2 是外部链接（siteResourceLink.{title,link}），否则
 *           resource.{id, name, ext, fileSizeUnit, url}——resource.id 就是
 *           下载用的 resourceId，走既有 preview-url → /file 链路。
 */

/**
 * 拉一门课的资料树。
 *
 * @param {{ token: string, siteId: string, userId: string, fetchImpl?: typeof fetch }} options
 * @returns {Promise<Array>} data 里的树数组原样透传——拉平/展示是前端的职责（薄后端）
 */
export async function listCoursewareTree({ token, siteId, userId, fetchImpl = fetch }) {
  if (!token) {
    throw new ApiError(401, { stage: 'ucloud-auth', msg: '请先登录云邮再查看课件' })
  }
  if (!siteId || !userId) {
    throw new ApiError(400, '缺少课程 ID 或用户 ID')
  }

  const url =
    `${API_ORIGIN}/ykt-site/site-resource/tree/student?siteId=${encodeURIComponent(siteId)}` +
    `&userId=${encodeURIComponent(userId)}`

  let body
  try {
    const response = await fetchImpl(url, {
      method: 'POST',
      headers: {
        'Blade-Auth': token,
        Authorization: BUSINESS_AUTH,
        'Tenant-Id': TENANT_ID,
        'Content-Type': 'application/json',
      },
      body: '{}',
    })
    body = await response.json().catch(() => null)
    if (response.status === 401) {
      // access_token 约 2 小时过期，引导重新登录而不是报上游故障
      throw new ApiError(401, { stage: 'ucloud-auth', msg: '云邮登录已过期，请重新登录' })
    }
    if (!response.ok) {
      throw new ApiError(502, { stage: 'ucloud-courseware', msg: `获取课件失败（HTTP ${response.status}）` })
    }
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError(502, { stage: 'ucloud-courseware', msg: `无法连接云邮服务（${API_ORIGIN.replace(/^https?:\/\//, '')}）` })
  }

  if (!body || body.success === false || (body.code !== undefined && body.code !== 200)) {
    throw new ApiError(502, { stage: 'ucloud-courseware', msg: `获取课件失败：${body?.msg || '上游返回异常'}` })
  }

  // 空树（data 为 null/undefined）是正常态：这门课没传过资料
  return Array.isArray(body?.data) ? body.data : []
}
