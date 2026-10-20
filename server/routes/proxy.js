import { ApiError } from '../http.js'
import { corsHeadersFor } from '../cors.js'

const FILE_ORIGIN = 'https://fileucloud.bupt.edu.cn'
const SOURCE_ORIGIN = 'https://ucloud.bupt.edu.cn'

// S3 兼容存储会拒绝携带业务鉴权头的请求（收到非 AWS4 签名报 InvalidRequest），
// 同时靠 Origin / Referer 校验防盗链。两边必须同时满足，只有服务端做得到。
const STRIPPED_REQUEST_HEADERS = ['authorization', 'blade-auth', 'tenant-id', 'cookie']

// 重建 Response 时要一并丢掉的长度/编码类头部：undici 已按 content-encoding
// 解压过 body，保留原始的 content-length 会让浏览器按压缩尺寸截断。
const DROP_ON_REBUILD = ['content-encoding', 'content-length', 'transfer-encoding']

// 附件可能是几百 MB 的课件，30s 只够建连不够传完，放宽到 120s（与云邮前端一致）。
const UPSTREAM_TIMEOUT_MS = 120_000

/**
 * 重整上游响应：剥掉上游的 CORS 头，补上本后端自己的。
 *
 * fetch() 返回的 Response，其 headers 是 immutable 的，任何头变动都必须重建
 * Response，就地 delete/set 会抛 TypeError: immutable。
 * 没有需要变动的头时原样返回，省掉一次响应体重建。
 *
 * @param {Response} response 上游响应
 * @param {Record<string, string>} extraHeaders 要补上的头（通常是本后端的 CORS 头）
 * @returns {Response}
 */
export function normalizeProxyResponse(response, extraHeaders = {}) {
  const headers = new Headers(response.headers)
  const upstreamCors = [...headers.keys()].filter((name) => name.startsWith('access-control-'))
  const forced = Object.entries(extraHeaders)

  if (upstreamCors.length === 0 && forced.length === 0) return response

  for (const name of upstreamCors) headers.delete(name)
  for (const name of DROP_ON_REBUILD) headers.delete(name)
  for (const [name, value] of forced) headers.set(name, value)

  const body = response.status === 204 || response.status === 304 ? null : response.body
  return new Response(body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  })
}

/**
 * /file/* → https://fileucloud.bupt.edu.cn/*
 *
 * 只处理 GET：附件下载与视频 Range 请求都只需要读。
 */
export function mountProxyRoutes(app, { allowedOrigins = [] } = {}) {
  const handler = async (c) => {
    const incoming = new URL(c.req.url)
    const target = new URL(FILE_ORIGIN)
    target.pathname = incoming.pathname.replace(/^\/file/, '') || '/'
    target.search = incoming.search

    // 显式构造请求头，只透传读取所需的头（Range 等）。不从 c.req.raw 复制请求
    // 对象——那头是 immutable 的，改写会抛错。
    const headers = new Headers(c.req.raw.headers)
    headers.delete('host')
    for (const name of STRIPPED_REQUEST_HEADERS) headers.delete(name)
    headers.set('Origin', SOURCE_ORIGIN)
    headers.set('Referer', `${SOURCE_ORIGIN}/`)

    let response
    try {
      response = await fetch(new Request(target, { method: 'GET', headers }), {
        signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS),
      })
    } catch (error) {
      // 不把原因吞掉：只报"连不上"而不说为什么，排查时等于没报。
      console.error('[proxy] 上游请求失败', {
        hostname: target.hostname,
        message: error?.message,
        cause: error?.cause?.message || error?.cause?.code,
      })
      throw new ApiError(502, `无法连接上游服务 ${target.hostname}`)
    }

    // 中间件设的 CORS 头对原始 Response 不生效，这里自己补。
    const cors = corsHeadersFor(c.req.header('Origin') || '', allowedOrigins)
    return normalizeProxyResponse(response, cors)
  }

  app.get('/file', handler)
  app.get('/file/*', handler)
}
