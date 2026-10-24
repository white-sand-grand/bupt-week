import { api, backendUrl } from './client.js'

/**
 * 登录接口。
 *
 * 云邮和教务共用同一套统一身份认证（CAS），所以前端只有一个登录表单，
 * 一次请求同时登两个系统。任一侧过期只影响对应功能，不级联。
 */

/** 统一登录：一次认证，同时登云邮和教务处。 */
export const login = (username, password) =>
  api('/api/auth/login', { method: 'POST', body: { username, password } })

/**
 * 企业微信 / 微信内自动识别的入口。
 *
 * 这是浏览器跳转（<a href> 和 location.href），不是 fetch——
 * 所以必须自己拼后端地址，不能指望 api() 帮忙。
 */
export const wecomStartUrl = backendUrl('/api/auth/wecom/start')

export const checkUcloudSession = (sessionId) =>
  api('/api/ucloud/session', { method: 'POST', body: { sessionId } })

export const logoutUcloud = (sessionId) =>
  api('/api/ucloud/logout', { method: 'POST', body: { sessionId } })

export const checkJwglSession = (sessionId) =>
  api('/api/jwgl/session', { method: 'POST', body: { sessionId } })

export const logoutJwgl = (sessionId) =>
  api('/api/jwgl/logout', { method: 'POST', body: { sessionId } })

/**
 * 补填教务密码（教务密码与统一身份密码不同的人用）。
 * sessionId 是云邮会话——用它证明本人，密码只在这一次请求里用。
 */
export const submitJwglweixinPassword = (sessionId, password) =>
  api('/api/auth/jwglweixin/password', { method: 'POST', body: { sessionId, password } })
