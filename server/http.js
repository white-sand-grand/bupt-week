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

/** 请求体上限：最大的合法载荷是班级作业正文（2000 字），128KB 是数十倍富余。
 *  超限直接 413——没有这道闸，一个匿名 logout 带几百 MB 的 JSON 就能把
 *  Node 入口的内存打尖（Workers 有自身的请求体限制，Node 没有）。 */
const MAX_BODY_BYTES = 128 * 1024

/** 读取 JSON 请求体；解析失败时返回空对象，由后续校验给出可读的错误。
 *  体积超限抛 413：有 content-length 先按声明拦，读完再按实长兜一道
 *  （分块发送者可以不声明长度）。 */
export async function readJson(request) {
  const declared = Number(request.headers.get('content-length'))
  if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
    throw new ApiError(413, { stage: 'body-too-large', msg: '请求体太大' })
  }
  let text
  try {
    text = await request.text()
  } catch {
    return {}
  }
  if (text.length > MAX_BODY_BYTES) {
    throw new ApiError(413, { stage: 'body-too-large', msg: '请求体太大' })
  }
  try {
    const body = JSON.parse(text)
    return body && typeof body === 'object' ? body : {}
  } catch {
    return {}
  }
}
