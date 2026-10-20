import { test } from 'node:test'
import assert from 'node:assert/strict'
import { corsHeadersFor } from '../server/cors.js'
import { normalizeProxyResponse } from '../server/routes/proxy.js'

const ALLOWED = ['https://example.github.io']

test('corsHeadersFor：允许的来源返回完整头', () => {
  assert.deepEqual(corsHeadersFor('https://example.github.io', ALLOWED), {
    'Access-Control-Allow-Origin': 'https://example.github.io',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    Vary: 'Origin',
  })
})

test('corsHeadersFor：来源不在白名单、或没有 Origin 头，返回空', () => {
  assert.deepEqual(corsHeadersFor('https://evil.example.com', ALLOWED), {})
  assert.deepEqual(corsHeadersFor('', ALLOWED), {})
})

test('corsHeadersFor：带路径的配置永远匹配不上（常见误配）', () => {
  assert.deepEqual(corsHeadersFor('https://example.github.io', ['https://example.github.io/BUPT-week/']), {})
})

test('normalizeProxyResponse：没有需要变动的头时原样返回', () => {
  const original = new Response('hello', { status: 200, headers: { 'Content-Type': 'text/plain' } })
  assert.equal(normalizeProxyResponse(original, {}), original)
})

test('normalizeProxyResponse：剥掉上游 CORS 头，保留其他头', () => {
  const original = new Response('hello', {
    status: 200,
    headers: {
      'Access-Control-Allow-Origin': 'https://ucloud.bupt.edu.cn',
      'Access-Control-Expose-Headers': 'x-foo',
      'Content-Type': 'text/plain',
      'X-Amz-Request-Id': 'abc',
    },
  })

  const result = normalizeProxyResponse(original, corsHeadersFor('https://example.github.io', ALLOWED))

  assert.notEqual(result, original)
  assert.equal(result.headers.get('access-control-allow-origin'), 'https://example.github.io')
  assert.equal(result.headers.get('access-control-expose-headers'), null)
  assert.equal(result.headers.get('content-type'), 'text/plain')
  assert.equal(result.headers.get('x-amz-request-id'), 'abc')
  assert.equal(result.headers.get('vary'), 'Origin')
})

test('normalizeProxyResponse：只补本后端 CORS 头时也重建响应', () => {
  // 上游没发 CORS 头，但我们仍要放行前端——这条路径同样必须重建 Response。
  const original = new Response('hello', { status: 200, headers: { 'Content-Type': 'text/plain' } })
  const result = normalizeProxyResponse(original, corsHeadersFor('https://example.github.io', ALLOWED))

  assert.notEqual(result, original)
  assert.equal(result.headers.get('access-control-allow-origin'), 'https://example.github.io')
})

test('normalizeProxyResponse：重建响应体可读，且丢掉 content-length / content-encoding', async () => {
  const original = new Response('hello world', {
    status: 206,
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Content-Length': '11',
      'Content-Encoding': 'gzip',
      'Content-Range': 'bytes 0-10/11',
    },
  })

  const result = normalizeProxyResponse(original, corsHeadersFor('https://example.github.io', ALLOWED))

  assert.equal(result.status, 206)
  assert.equal(result.headers.get('content-length'), null)
  assert.equal(result.headers.get('content-encoding'), null)
  assert.equal(result.headers.get('content-range'), 'bytes 0-10/11')
  assert.equal(await result.text(), 'hello world')
})

test('normalizeProxyResponse：204 / 304 重建时不能带 body', () => {
  const original = new Response(null, {
    status: 204,
    headers: { 'Access-Control-Allow-Origin': '*' },
  })
  const result = normalizeProxyResponse(original, corsHeadersFor('https://example.github.io', ALLOWED))
  assert.equal(result.status, 204)
  assert.equal(result.body, null)
})
