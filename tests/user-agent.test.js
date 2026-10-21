import { test } from 'node:test'
import assert from 'node:assert/strict'
import { withUserAgent, USER_AGENT } from '../server/user-agent.js'

test('withUserAgent：没有 UA 时补上', () => {
  const options = withUserAgent({ method: 'GET' })
  assert.equal(new Headers(options.headers).get('User-Agent'), USER_AGENT)
})

test('withUserAgent：已有 UA 时不覆盖', () => {
  const options = withUserAgent({ headers: { 'User-Agent': 'MyApp/1.0' } })
  assert.equal(new Headers(options.headers).get('User-Agent'), 'MyApp/1.0')
})

test('withUserAgent：接受 Headers 实例', () => {
  const headers = new Headers({ Cookie: 'a=1' })
  const options = withUserAgent({ headers })
  assert.equal(new Headers(options.headers).get('Cookie'), 'a=1')
  assert.equal(new Headers(options.headers).get('User-Agent'), USER_AGENT)
})

test('withUserAgent：不改动原 options 对象', () => {
  const original = { method: 'POST', headers: { Cookie: 'a=1' }, body: 'x' }
  const before = JSON.stringify(original.headers)
  withUserAgent(original)
  assert.equal(JSON.stringify(original.headers), before, '原对象不应被改')
})

test('withUserAgent：保留其他 fetch 选项', () => {
  const options = withUserAgent({ redirect: 'manual', method: 'POST' })
  assert.equal(options.redirect, 'manual')
  assert.equal(options.method, 'POST')
})
