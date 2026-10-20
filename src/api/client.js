/**
 * 与后端通信的唯一出口。
 *
 * 两种部署形态都由这里消化：
 *   - 同源（本机 dev / 前后端合并部署）：path 直接用相对地址
 *   - 跨域（Pages + Workers）：拼上 VITE_BACKEND_URL
 * 其他模块不许自己拼 URL，否则换个部署方式要改一片。
 */
const BACKEND_URL = String(import.meta.env.VITE_BACKEND_URL || '').replace(/\/+$/, '')

export class ApiError extends Error {
  constructor(message, { status, stage } = {}) {
    super(message)
    this.name = 'ApiError'
    this.status = status
    this.stage = stage
  }
}

/**
 * @param {string} path 以 / 开头的接口路径
 * @param {{ method?: string, body?: unknown, signal?: AbortSignal }} options
 * @returns {Promise<any>} 响应里的 data 字段
 */
export async function api(path, { method = 'GET', body, signal } = {}) {
  const response = await fetch(BACKEND_URL ? `${BACKEND_URL}${path}` : path, {
    method,
    signal,
    headers: body === undefined ? {} : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  const payload = await response.json().catch(() => null)

  if (!response.ok || !payload || payload.success !== true) {
    throw new ApiError(payload?.msg || `请求失败（HTTP ${response.status}）`, {
      status: response.status,
      stage: payload?.stage,
    })
  }

  return payload.data
}
