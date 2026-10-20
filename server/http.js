export class ApiError extends Error {
  /**
   * @param {number} status HTTP 状态码
   * @param {string|{msg?: string, stage?: string}} body 字符串或错误详情对象
   */
  constructor(status, body) {
    const detail = typeof body === 'string' ? { msg: body } : body || {}
    super(detail.msg || '请求失败')
    this.name = 'ApiError'
    this.status = status
    this.stage = detail.stage
    this.body = { success: false, msg: this.message, ...(detail.stage ? { stage: detail.stage } : {}) }
  }
}

/** 读取 JSON 请求体；解析失败时返回空对象，由后续校验给出可读的错误。 */
export async function readJson(request) {
  try {
    const body = await request.json()
    return body && typeof body === 'object' ? body : {}
  } catch {
    return {}
  }
}
