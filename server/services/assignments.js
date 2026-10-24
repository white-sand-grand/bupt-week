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
 * 课程列表（§2.2）。返回 [{ id, name }]，size=9999 一次拉全避免分页。
 */
async function listCourses({ token, userId, fetchImpl = fetch }) {
  const body = await requestJson(
    `${API_ORIGIN}/ykt-site/site/list/student/current?userId=${encodeURIComponent(userId)}`
      + '&siteRoleCode=2&current=1&size=9999',
    { headers: authHeaders(token) },
    { stage: 'ucloud-assignments', what: '获取课程列表' },
  )
  const records = Array.isArray(body?.data?.records) ? body.data.records : []
  return records
    .map((course) => ({ id: String(course.id ?? ''), name: course.siteName || course.name || '' }))
    .filter((course) => course.id && course.name)
}

/**
 * 带课程名的作业列表。
 *
 * 作业列表接口【实测 2026-10-24，38/38 条】根本不带 siteId/siteName（文档 §2.3
 * 早期的记录不成立），前端只能归到「未知课程」。课程名只能这样拿：先全量拉
 * 保底（跨学期/已结课的作业也都在），再用课程列表逐课程拉一遍，按作业 ID 把
 * siteId/siteName 回填到全量记录上。课程映射失败不致命——退化为无课程名，
 * 和旧行为一致。
 */
export async function listAssignmentsWithCourses({ token, userId, fetchImpl = fetch }) {
  const records = await listAssignments({ token, fetchImpl })

  let courses = []
  try {
    courses = await listCourses({ token, userId, fetchImpl })
  } catch {
    return records
  }
  if (!courses.length) return records

  // 逐课程并发拉，单课程失败只丢那一门的名字
  const tagged = await Promise.allSettled(
    courses.map((course) =>
      requestJson(
        `${API_ORIGIN}/ykt-site/work/student/list`,
        {
          method: 'POST',
          headers: { ...authHeaders(token), 'Content-Type': 'application/json' },
          body: JSON.stringify({ current: 1, size: 100, siteId: course.id }),
        },
        { stage: 'ucloud-assignments', what: '获取课程作业' },
      ).then((body) => ({
        course,
        items: Array.isArray(body?.data?.records) ? body.data.records : [],
      })),
    ),
  )

  const byId = new Map(records.map((record) => [String(record.id ?? ''), record]))
  for (const settled of tagged) {
    if (settled.status !== 'fulfilled') continue
    const { course, items } = settled.value
    for (const item of items) {
      const record = byId.get(String(item.id ?? ''))
      if (record && !record.siteId) {
        record.siteId = course.id
        record.siteName = course.name
      }
    }
  }
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
