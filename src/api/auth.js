import { api } from './client.js'

/**
 * 两个系统的登录。
 *
 * 前端只拿到不透明 sessionId，不接触密码、不接触 Blade-Auth / refresh_token /
 * 教务 Cookie。换来的代价是每次请求多一跳服务端查询，收益是凭证不暴露给 XSS。
 */

export const loginUcloud = (username, password) =>
  api('/api/ucloud/login', { method: 'POST', body: { username, password } })

export const checkUcloudSession = (sessionId) =>
  api('/api/ucloud/session', { method: 'POST', body: { sessionId } })

export const logoutUcloud = (sessionId) =>
  api('/api/ucloud/logout', { method: 'POST', body: { sessionId } })

export const loginJwgl = (username, password) =>
  api('/api/jwgl/login', { method: 'POST', body: { username, password } })

export const checkJwglSession = (sessionId) =>
  api('/api/jwgl/session', { method: 'POST', body: { sessionId } })

export const logoutJwgl = (sessionId) =>
  api('/api/jwgl/logout', { method: 'POST', body: { sessionId } })
