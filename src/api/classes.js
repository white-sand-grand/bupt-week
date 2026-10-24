import { api } from './client.js'

/** 班级功能接口。sessionId 一律走请求体（不进 query，与全站约定一致）。 */

export function createClass(sessionId, name, password) {
  return api('/api/classes/create', { method: 'POST', body: { sessionId, name, password } })
}

export function joinClass(sessionId, code, password) {
  return api('/api/classes/join', { method: 'POST', body: { sessionId, code, password } })
}

export function listMyClasses(sessionId) {
  return api('/api/classes/list', { method: 'POST', body: { sessionId } })
}

export function fetchClassAssignments(sessionId, classId) {
  return api('/api/classes/assignments', { method: 'POST', body: { sessionId, classId } })
}

export function addClassAssignment(sessionId, classId, payload) {
  return api('/api/classes/assignment/add', { method: 'POST', body: { sessionId, classId, ...payload } })
}

export function deleteClassAssignment(sessionId, classId, assignmentId) {
  return api('/api/classes/assignment/delete', { method: 'POST', body: { sessionId, classId, assignmentId } })
}

export function dissolveClass(sessionId, classId) {
  return api('/api/classes/dissolve', { method: 'POST', body: { sessionId, classId } })
}
