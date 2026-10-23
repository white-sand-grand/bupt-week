/**
 * 与后端通信的唯一出口。
 *
 * 两种部署形态都由这里消化：
 *   - 同源（本机 dev / 前后端合并部署）：path 直接用相对地址
 *   - 跨域（Pages + Workers）：拼上 VITE_BACKEND_URL
 *
 * 注意：**不只是 fetch 要走这里。** 任何指向后端的地址——`<a href>`、
 * `location.href`、文件下载——都必须过 `backendUrl()`。
 * 相对路径在本机能跑（Vite 把 /api 代理到后端），部署到 Pages 后会解析到
 * Pages 自己的域名上然后 404，而本地完全正常。
 */

const BACKEND_URL = String(import.meta.env.VITE_BACKEND_URL || '').replace(/\/+$/, '')

/**
 * 把后端相对路径拼成完整地址。
 *
 * @param {string} path 以 / 开头的路径，例如 /api/auth/wecom/start
 * @returns {string} 配了后端就是绝对地址，没配就原样返回（同源部署）
 */
export function backendUrl(path) {
  return BACKEND_URL ? `${BACKEND_URL}${path}` : path
}

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
  const response = await fetch(backendUrl(path), {
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
