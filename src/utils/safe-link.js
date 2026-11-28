/**
 * 外链协议白名单：只放行 http(s)，其余（javascript:/data:/未知协议）降级为
 * 空串——调用方应把空串当「不可点」，绑定时用 `|| undefined` 去掉 href。
 *
 * 服务端在各入口（source-input.js / github.js / byrdocs.js）已做同样校验，
 * 这里是前端纵深层：不依赖服务端永远正确，渲染侧自己兜底。
 */
const SAFE_LINK = /^https?:\/\//i

export function safeExternalUrl(value) {
  return typeof value === 'string' && SAFE_LINK.test(value.trim()) ? value : ''
}
