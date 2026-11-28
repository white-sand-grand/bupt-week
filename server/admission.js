/**
 * 来源准入：请求只要带了 Origin 或 Referer，就必须命中白名单之一。
 *
 * 挡的是把本站公开代理/中继接口当免费外链挂到别的站点上（浏览器跨站引用
 * 一定带其一）。非浏览器的直连滥用它挡不住，那一层靠应用内限速加
 * Cloudflare 的 WAF 限速规则（见 docs/deployment.md）。
 * 后端跑在回环地址上（本机开发/测试形态）时直接放行——生产 Worker 的域名
 * 永远不是回环，这条不影响线上防护。
 *
 * @param {Request} request
 * @param {string[]} allowedOrigins 配置允许的前端来源
 * @param {string} ownOrigin 本后端自身的 origin（从请求 URL 反推）
 * @returns {boolean}
 */
export function isAdmitted(request, allowedOrigins, ownOrigin) {
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
