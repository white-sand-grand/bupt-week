import { ApiError } from '../http.js'

const API_ORIGIN = 'https://apiucloud.bupt.edu.cn'
const BUSINESS_AUTH = 'Basic c3dvcmQ6c3dvcmRfc2VjcmV0'
const TENANT_ID = '000000'

/**
 * 云邮作业。接口形状见 docs/api-reference.md §2.2–2.5（【实测】）。
 *
 * 字段语义（MYUCLOUD 用真实账号核对过，比 api-reference §2.3 的早期记录更准）：
 * - status 是作业自身状态（2=进行中、3=已截止），与是否提交无关；
 * - assignmentStatus 才是本人提交状态（99=未提交、0=已提交、1=已批改）；
 * - submitTime 有值即已提交。三层判断都在前端 utils/deadline.js 里做。
 */

function authHeaders(token) {
  return {
    'Blade-Auth': token,
    Authorization: BUSINESS_AUTH,
    'Tenant-Id': TENANT_ID,
  }
}

async function requestJson(url, options, { stage, what }) {
  let response
  let body
  try {
    response = await fetch(url, options)
    body = await response.json().catch(() => null)
    if (response.status === 401) {
      // access_token 约 2 小时过期。这里报 401 让前端引导重新登录，
      // 而不是当成上游故障报 502。
      throw new ApiError(401, { stage: 'ucloud-auth', msg: '云邮登录已过期，请重新登录' })
    }
    if (!response.ok) {
      throw new ApiError(502, { stage, msg: `${what}失败（HTTP ${response.status}）` })
    }
  } catch (error) {
    if (error instanceof ApiError) throw error
    throw new ApiError(502, { stage, msg: `无法连接云邮服务（${API_ORIGIN.replace(/^https?:\/\//, '')}）` })
  }

  if (!body || body.success === false || (body.code !== undefined && body.code !== 200)) {
    throw new ApiError(502, { stage, msg: `${what}失败：${body?.msg || '上游返回异常'}` })
  }
  return body
}

/**
 * 全量作业列表（不传 siteId 即全部课程，前端自己分组）。
 * @returns {Promise<Array>} records 原样透传——分级/排序是前端的职责（薄后端）
 */
export async function listAssignments({ token, fetchImpl = fetch }) {
  if (!token) {
    throw new ApiError(401, { stage: 'ucloud-auth', msg: '请先登录云邮' })
  }

  const body = await requestJson(
    `${API_ORIGIN}/ykt-site/work/student/list`,
    {
      method: 'POST',
      headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
      body: JSON.stringify({ current: 1, size: 100 }),
    },
    { stage: 'ucloud-assignments', what: '获取作业列表' },
  )

  const records = Array.isArray(body?.data?.records) ? body.data.records : []
  return records
}

/**
 * 单个作业详情：附件元数据在 data.assignmentResource
 * （resourceId / resourceName / resourceType，无下载链接——下载走 preview-url）。
 */
export async function getAssignmentDetail({ token, assignmentId, fetchImpl = fetch }) {
  if (!token) {
    throw new ApiError(401, { stage: 'ucloud-auth', msg: '请先登录云邮' })
  }
  if (!assignmentId) {
    throw new ApiError(400, '缺少作业 ID')
  }

  // 参数名是单数 assignmentId，写成小写 L 的 assignmentld 会报缺少参数
  const body = await requestJson(
    `${API_ORIGIN}/ykt-site/work/detail?assignmentId=${encodeURIComponent(assignmentId)}`,
    { headers: authHeaders(token) },
    { stage: 'ucloud-assignments', what: '获取作业详情' },
  )

  const data = body?.data || {}
  return {
    attachments: Array.isArray(data.assignmentResource)
      ? data.assignmentResource.map((item) => ({
        resourceId: String(item.resourceId ?? ''),
        resourceName: item.resourceName || '附件',
        resourceType: item.resourceType || '',
      })).filter((item) => item.resourceId)
      : [],
  }
}
