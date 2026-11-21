import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBackend } from '../server/app.js'
import { MemorySessionStore } from '../server/storage/memory.js'
import { loginByrdocs, searchByrdocs } from '../server/services/byrdocs.js'

const UUID = '12345678-1234-4234-8234-123456789abc'
const USERNAME = '2021001234'
const PASSWORD = 'private-password-probe'
const FILE_KEY = `${'a'.repeat(32)}.pdf`
const TOKEN = `header.${btoa(JSON.stringify({ id: `BUPT-${USERNAME}`, download: true }))}.signature`

function makeApp() {
  const store = new MemorySessionStore()
  return { store, app: createBackend({ getSessionStore: () => store, allowedOrigins: ['https://example.org'] }) }
}

async function seed(store, token = TOKEN) {
  await store.set('sid', { kind: 'ucloud', username: USERNAME, accessToken: 'school-token', expiresAt: Date.now() + 3600_000 })
  if (token) await store.set('byrdocs:sid', { kind: 'byrdocs', token, expiresAt: Date.now() + 3600_000 })
}

function post(app, path, body) {
  return app.request(path, { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: 'https://example.org' }, body: JSON.stringify(body) })
}

function loginUpstream(url, options = {}) {
  assert.equal(options.redirect, 'manual')
  assert.equal(new Headers(options.headers).has('cookie'), false)
  if (String(url).endsWith('/api/auth/login')) return Response.json({ success: true, loginURL: `https://byrdocs.org/auth/${UUID}/byrdocs-cli` })
  if (String(url).endsWith('/api/auth/bupt_login')) {
    assert.deepEqual(JSON.parse(options.body), { username: USERNAME, password: PASSWORD, uuid: UUID })
    return Response.json({ success: true, token: TOKEN })
  }
  throw new Error('Unexpected endpoint')
}

test('ByrDocs：一次账号密码认证取得独立下载凭证，拒绝外站登录会话与非本人 token', async () => {
  assert.equal(await loginByrdocs({ username: USERNAME, password: PASSWORD, fetchImpl: loginUpstream }), TOKEN)
  let requests = 0
  await assert.rejects(loginByrdocs({ username: USERNAME, password: PASSWORD, fetchImpl: async () => {
    requests += 1
    return Response.json({ success: true, loginURL: `https://evil.example/auth/${UUID}/byrdocs-cli` })
  } }), /无法创建/)
  assert.equal(requests, 1)
  await assert.rejects(loginByrdocs({ username: USERNAME, password: PASSWORD, fetchImpl: async (url, options) => {
    if (String(url).endsWith('/bupt_login')) return Response.json({ success: true, token: `h.${btoa(JSON.stringify({ id: 'BUPT-other', download: true }))}.s` })
    return loginUpstream(url, options)
  } }), /本人下载凭证/)
})

test('ByrDocs 补连：学号只取本站会话，密码和 token 不进响应与日志，凭证仅在后端', async (t) => {
  const { app, store } = makeApp()
  await seed(store, '')
  const logs = []
  for (const method of ['log', 'warn', 'error']) t.mock.method(console, method, (...args) => logs.push(args.map(String).join(' ')))
  t.mock.method(globalThis, 'fetch', loginUpstream)
  const response = await post(app, '/api/sources/byrdocs/connect', { sessionId: 'sid', username: 'other', password: PASSWORD })
  assert.equal(response.status, 200)
  const body = await response.text()
  assert.equal(body.includes(PASSWORD), false)
  assert.equal(body.includes(TOKEN), false)
  assert.deepEqual(JSON.parse(body).data, { ready: true })
  assert.equal((await store.get('byrdocs:sid')).token, TOKEN)
  assert.equal(JSON.stringify([...store.map.entries()]).includes(PASSWORD), false)
  assert.equal(logs.join('').includes(PASSWORD), false)
  assert.equal(logs.join('').includes(TOKEN), false)
  const status = await post(app, '/api/sources/byrdocs/status', { sessionId: 'sid' })
  assert.deepEqual((await status.json()).data, { ready: true })
})

test('ByrDocs：认证错误不回显上游密码，退出中的补连不能写回', async (t) => {
  const { app, store } = makeApp()
  await seed(store, '')
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).endsWith('/bupt_login')) return Response.json({ success: false, error: `rejected ${PASSWORD}` })
    return loginUpstream(url, options)
  })
  const denied = await post(app, '/api/sources/byrdocs/connect', { sessionId: 'sid', password: PASSWORD })
  assert.equal(denied.status, 401)
  assert.equal((await denied.text()).includes(PASSWORD), false)
  assert.equal(await store.get('byrdocs:sid'), undefined)
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    if (String(url).endsWith('/bupt_login')) await store.delete('sid')
    return loginUpstream(url, options)
  })
  const response = await post(app, '/api/sources/byrdocs/connect', { sessionId: 'sid', password: PASSWORD })
  assert.equal(response.status, 401)
  assert.equal(await store.get('byrdocs:sid'), undefined)
})

test('ByrDocs 搜索：固定公开接口、类型和 30 项上限，只映射可下载 PDF/ZIP', async () => {
  const results = await searchByrdocs({ keyword: ' 概率论 ', type: 'test', fetchImpl: async (url, options) => {
    assert.equal(url, 'https://search.byrdocs.org/api/search')
    const request = JSON.parse(options.body)
    assert.equal(request.keyword, '概率论')
    assert.equal(request.limit, 30)
    assert.match(request.jmespath, /filetype/)
    assert.equal(new Headers(options.headers).get('authorization'), null)
    return Response.json({ results: [
      { id: 'a'.repeat(32), type: 'test', data: { title: '概率论/试题', filetype: 'pdf', filesize: 100 } },
      { id: 'wiki-1', type: 'test', data: { title: '维基', filetype: 'wiki' }, url: 'javascript:alert(1)' },
    ] })
  } })
  assert.equal(results.length, 1)
  assert.equal(results[0].key, FILE_KEY)
  assert.equal(results[0].filename, '概率论_试题.pdf')
  assert.ok(results[0].url.startsWith('https://byrdocs.org/'))
})

test('ByrDocs 下载：sessionId 仅在请求体，独立 token 只发往固定域名，按原名转发字节并保留安全/CORS 头', async (t) => {
  const { app, store } = makeApp()
  await seed(store)
  const upstream = t.mock.method(globalThis, 'fetch', async (url, options) => {
    const target = new URL(url)
    assert.equal(target.origin, 'https://byrdocs.org')
    assert.equal(target.pathname, `/files/${FILE_KEY}`)
    assert.equal(target.searchParams.get('f'), '3')
    assert.equal(target.searchParams.has('sessionId'), false)
    assert.deepEqual(options.headers, { Authorization: `Bearer ${TOKEN}` })
    assert.equal(options.redirect, 'manual')
    return new Response('%PDF-test', { headers: { 'Content-Type': 'application/pdf', 'Content-Length': '9', 'Set-Cookie': 'private=1' } })
  })
  const response = await post(app, '/api/sources/byrdocs/download', { sessionId: 'sid', key: FILE_KEY, filename: '概率论试题.pdf' })
  assert.equal(response.status, 200)
  assert.equal(await response.text(), '%PDF-test')
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://example.org')
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff')
  assert.equal(response.headers.get('Content-Length'), '9')
  assert.equal(response.headers.get('Set-Cookie'), null)
  assert.match(response.headers.get('Content-Disposition'), /filename\*=UTF-8/)
  for (const key of ['../private.pdf', 'https://evil.example/file.pdf', `${'a'.repeat(32)}.html`]) {
    const invalid = await post(app, '/api/sources/byrdocs/download', { sessionId: 'sid', key, filename: 'a.pdf' })
    assert.equal(invalid.status, 400)
  }
  assert.equal(upstream.mock.callCount(), 1)
})

test('ByrDocs 下载认证失败只清 ByrDocs，重连后的新凭证不会被迟到失败清掉，退出一并销毁凭证', async (t) => {
  const { app, store } = makeApp()
  await seed(store)
  let replace = false
  t.mock.method(globalThis, 'fetch', async () => {
    if (replace) await store.set('byrdocs:sid', { kind: 'byrdocs', token: 'new-token', expiresAt: Date.now() + 3600_000 })
    return new Response('', { status: 401 })
  })
  assert.equal((await post(app, '/api/sources/byrdocs/download', { sessionId: 'sid', key: FILE_KEY, filename: 'a.pdf' })).status, 401)
  assert.equal(await store.get('byrdocs:sid'), undefined)
  assert.equal((await store.get('sid')).accessToken, 'school-token')
  await seed(store)
  replace = true
  await post(app, '/api/sources/byrdocs/download', { sessionId: 'sid', key: FILE_KEY, filename: 'a.pdf' })
  assert.equal((await store.get('byrdocs:sid')).token, 'new-token')
  await post(app, '/api/ucloud/logout', { sessionId: 'sid' })
  assert.equal(await store.get('byrdocs:sid'), undefined)
  assert.equal(await store.get('sid'), undefined)
})

test('ByrDocs：无本站会话不可连接或下载，登录重定向/HTML 页面不能被保存为文件', async (t) => {
  const { app, store } = makeApp()
  for (const path of ['connect', 'download', 'status']) {
    assert.equal((await post(app, `/api/sources/byrdocs/${path}`, { sessionId: 'invalid' })).status, 401)
  }
  await seed(store)
  for (const response of [new Response('', { status: 302, headers: { Location: 'https://evil.example/' } }), new Response('<html>login</html>', { headers: { 'Content-Type': 'text/html' } })]) {
    const mock = t.mock.method(globalThis, 'fetch', async () => response)
    const result = await post(app, '/api/sources/byrdocs/download', { sessionId: 'sid', key: FILE_KEY, filename: 'a.pdf' })
    assert.equal(result.status, 502)
    mock.mock.restore()
  }
})
