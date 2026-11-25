import { api } from './client.js'

export function listAgentKeys(sessionId) {
  return api('/api/agent/keys/list', { method: 'POST', body: { sessionId } })
}

export function createAgentKey(sessionId, input) {
  return api('/api/agent/keys/create', { method: 'POST', body: { sessionId, ...input } })
}

export function revokeAgentKey(sessionId, id) {
  return api('/api/agent/keys/revoke', { method: 'POST', body: { sessionId, id } })
}
