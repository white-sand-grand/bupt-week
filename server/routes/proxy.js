import { ApiError } from '../http.js'
import { withUserAgent } from '../user-agent.js'
import { corsHeadersFor } from '../cors.js'

const FILE_ORIGIN = 'https://fileucloud.bupt.edu.cn'
const SOURCE_ORIGIN = 'https://ucloud.bupt.edu.cn'

// S3 兼容存储会拒绝携带业务鉴权头的请求（收到非 AWS4 签名报 InvalidRequest），
// 同时靠 Origin / Referer 校验防盗链。两边必须同时满足，只有服务端做得到。
const STRIPPED_REQUEST_HEADERS = ['authorization', 'blade-auth', 'tenant-id', 'cookie']

/**
 * 来源准入：请求只要带了 Origin 或 Referer，就必须命中白名单之一。
 *
 * 浏览器跨站引用一定带其一，这条挡的是把本代理当免费外链/带宽中继挂到
 * 别的站点上；非浏览器的直连滥用它挡不住，那一层靠 Cloudflare 的限速规则。
 * 后端跑在回环地址上（本机开发形态）时直接放行——生产 Worker 的域名
 * 永远不是回环，这条不影响线上防护。
 */
function isAdmitted(request, allowedOrigins, ownOrigin) {
  try {
    if (new URL(ownOrigin).hostname === '127.0.0.1' || new URL(ownOrigin).hostname === 'localhost'
      || new URL(ownOrigin).hostname === '[::1]' || new URL(ownOrigin).hostname === '::1') {
      return true
    }
  } catch {
    // ownOrigin 解析不了就按正常流程判断
  }

  const origin = request.headers.get('Origin')
  if (origin) return allowedOrigins.includes(origin)

  const referer = request.headers.get('Referer')
  if (referer) {
    try {
      return allowedOrigins.includes(new URL(referer).origin)
    } catch {
      return false
    }
  }
  return true
}

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
    const own = new URL(c.req.url)
    if (!isAdmitted(c.req.raw, allowedOrigins, `${own.protocol}//${own.host}`)) {
      throw new ApiError(403, '来源不在白名单内，拒绝代理该请求')
    }

    const incoming = own
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
      response = await fetch(
        new Request(target, withUserAgent({ method: 'GET', headers })),
        { signal: AbortSignal.timeout(UPSTREAM_TIMEOUT_MS) },
      )
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
    // Vary: Origin 无条件带：共享缓存可能把「无 CORS 头」的响应错发给放行来源。
    const cors = { Vary: 'Origin', ...corsHeadersFor(c.req.header('Origin') || '', allowedOrigins) }
    return normalizeProxyResponse(response, cors)
  }

  app.get('/file', handler)
  app.get('/file/*', handler)
}
