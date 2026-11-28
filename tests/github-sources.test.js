import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBackend } from '../server/app.js'

const REPOSITORY = { private: false, owner: { login: 'teacher' }, name: 'homework', default_branch: 'course/main' }
const QUERY = new URLSearchParams({ owner: 'teacher', repo: 'homework', ref: 'course/main', path: '第一章/作业 #1.pdf' })
const SHA = 'a'.repeat(40)

function json(data, status = 200) {
  return Response.json(data, { status })
}

test('添加源：验证公开仓库，归一化 .git 与尾斜杠，保留默认分支', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    assert.equal(url, 'https://api.github.com/repos/teacher/homework')
    assert.equal(options.redirect, 'manual')
    assert.equal(options.headers.Authorization, undefined)
    return json(REPOSITORY)
  })
  const app = createBackend()
  const response = await app.request('/api/sources/github', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ url: 'https://github.com/teacher/homework.git/?tab=readme' }),
  })
  assert.equal(response.status, 200)
  assert.deepEqual((await response.json()).data.repository, {
    owner: 'teacher', repo: 'homework', ref: 'course/main', url: 'https://github.com/teacher/homework',
  })
})

test('添加源：外站、伪装域名、内网、带凭证和目录链接在取数前拒绝', async (t) => {
  const upstream = t.mock.method(globalThis, 'fetch', () => { throw new Error('不应访问上游') })
  const app = createBackend()
  for (const url of [null, 'x', 'http://github.com/a/b', 'https://github.com.evil/a/b', 'https://127.0.0.1/a/b', 'https://user:pass@github.com/a/b', 'https://github.com/a/b/tree/main']) {
    const response = await app.request('/api/sources/github', {
      method: 'POST', body: JSON.stringify({ url }),
    })
    assert.equal(response.status, 400, String(url))
  }
  for (const extra of [{ owner: '..' }, { repo: '../private' }, { path: '../secret' }, { path: '/etc/passwd' }, { path: 'a\\b' }, { ref: '' }]) {
    const response = await app.request(`/api/sources/github/contents?${new URLSearchParams({ owner: 'a', repo: 'b', ref: 'main', path: '', ...extra })}`)
    assert.equal(response.status, 400, JSON.stringify(extra))
  }
  assert.equal(upstream.mock.callCount(), 0)
})

test('仓库目录：按需读取多级中文路径，编码 # 与分支斜杠，目录排在文件前', async (t) => {
  t.mock.method(globalThis, 'fetch', async (url) => {
    const target = new URL(url)
    assert.equal(target.origin, 'https://api.github.com')
    assert.equal(decodeURIComponent(target.pathname), '/repos/teacher/homework/contents/第一章/作业 #1.pdf')
    assert.equal(target.searchParams.get('ref'), 'course/main')
    return json([
      { name: '练习10.pdf', path: '第一章/练习10.pdf', type: 'file', size: 100 },
      { name: '练习2.pdf', path: '第一章/练习2.pdf', type: 'file', size: 200 },
      { name: '参考', path: '第一章/参考', type: 'dir', size: 0 },
      { name: '外部模块', path: '第一章/外部模块', type: 'file', submodule_git_url: 'https://example.com', size: 0 },
    ])
  })
  const response = await createBackend().request(`/api/sources/github/contents?${QUERY}`)
  assert.equal(response.status, 200)
  const { data } = await response.json()
  assert.deepEqual(data.entries.map((item) => item.name), ['参考', '练习2.pdf', '练习10.pdf', '外部模块'])
  assert.equal(data.entries.at(-1).type, 'link')
  assert.equal(data.limited, false)
})

test('GitHub 下载：按 SHA 取原始字节，中文文件名，保留跨域和安全头，不转发学校凭证', async (t) => {
  const calls = []
  t.mock.method(globalThis, 'fetch', async (url, options) => {
    calls.push(url)
    const headers = new Headers(options.headers)
    for (const key of ['cookie', 'authorization', 'blade-auth', 'tenant-id']) assert.equal(headers.has(key), false)
    assert.equal(options.redirect, 'manual')
    if (calls.length === 1) return json({ name: '作业 #1.pdf', type: 'file', sha: SHA, size: 9 })
    assert.equal(url, `https://api.github.com/repos/teacher/homework/git/blobs/${SHA}`)
    assert.equal(headers.get('accept'), 'application/vnd.github.raw+json')
    return new Response('%PDF-test', { headers: { 'Content-Length': '9', 'Set-Cookie': 'upstream=secret', 'Access-Control-Allow-Origin': '*' } })
  })
  const app = createBackend({ allowedOrigins: ['https://example.org'] })
  const response = await app.request(`/api/sources/github/download?${QUERY}`, {
    headers: { Origin: 'https://example.org', Cookie: 'school=secret', Authorization: 'Bearer school-token', 'Blade-Auth': 'school-token' },
  })
  assert.equal(response.status, 200)
  assert.equal(await response.text(), '%PDF-test')
  assert.equal(response.headers.get('Content-Type'), 'application/octet-stream')
  assert.equal(response.headers.get('Content-Length'), '9')
  assert.equal(response.headers.get('Content-Disposition'), `attachment; filename*=UTF-8''${encodeURIComponent('作业 #1.pdf')}`)
  assert.equal(response.headers.get('Access-Control-Allow-Origin'), 'https://example.org')
  assert.equal(response.headers.get('Cache-Control'), 'no-store')
  assert.equal(response.headers.get('X-Content-Type-Options'), 'nosniff')
  assert.equal(response.headers.get('Referrer-Policy'), 'no-referrer')
  assert.equal(response.headers.get('Set-Cookie'), null)
  assert.equal(calls.length, 2)
})

test('GitHub 下载：LFS 指针、目录、子模块和超大文件不伪装成下载成功', async (t) => {
  const app = createBackend()
  for (const data of [
    { type: 'dir', name: 'folder' },
    { type: 'file', name: 'module', sha: SHA, submodule_git_url: 'https://example.org' },
    { type: 'file', name: 'large.pdf', sha: SHA, size: 101 * 1024 * 1024 },
    { type: 'file', name: 'lfs.pdf', sha: SHA, size: 130, encoding: 'base64', content: btoa('version https://git-lfs.github.com/spec/v1\noid sha256:abc\nsize 1000') },
  ]) {
    const upstream = t.mock.method(globalThis, 'fetch', async () => json(data))
    const response = await app.request(`/api/sources/github/download?${QUERY}`)
    assert.equal(response.status, 422)
    assert.match((await response.json()).msg, /原仓库/)
    assert.equal(upstream.mock.callCount(), 1)
    upstream.mock.restore()
  }
})

test('GitHub 错误：限流、私有或缺失仓库、地址迁移与网络失败提供可读提示', async (t) => {
  const app = createBackend()
  for (const [status, expected, pattern] of [[403, 429, /频率/], [404, 404, /公开仓库/], [301, 422, /地址已变更/], [409, 422, /空的/], [500, 502, /GitHub 请求失败/]]) {
    const upstream = t.mock.method(globalThis, 'fetch', async () => new Response('', { status }))
    const response = await app.request(`/api/sources/github/contents?${QUERY}`)
    assert.equal(response.status, expected)
    assert.match((await response.json()).msg, pattern)
    upstream.mock.restore()
  }
  t.mock.method(globalThis, 'fetch', async () => { throw new TypeError('private internal detail') })
  const response = await app.request(`/api/sources/github/contents?${QUERY}`)
  assert.equal(response.status, 502)
  assert.match((await response.json()).msg, /无法连接 GitHub/)
})

test('添加源：跨站引用（Origin/Referer 不在白名单）在取数前拒绝', async (t) => {
  const upstream = t.mock.method(globalThis, 'fetch', () => { throw new Error('不应访问上游') })
  const app = createBackend({ allowedOrigins: ['https://example.org'] })
  // 用非回环的请求 URL 才会走到真实准入分支（本机回环形态默认放行）。
  const base = 'https://backend.example'
  const cases = [
    { path: '/api/sources/github', init: { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ url: 'https://github.com/a/b' }) }, headers: { Origin: 'https://evil.example' } },
    { path: '/api/sources/github/contents?owner=a&repo=b&ref=main&path=', init: { method: 'GET' }, headers: { Referer: 'https://evil.example/page' } },
    { path: `/api/sources/github/download?${QUERY}`, init: { method: 'GET' }, headers: { Origin: 'https://evil.example' } },
  ]
  for (const { path, init, headers } of cases) {
    const response = await app.request(new Request(`${base}${path}`, { ...init, headers: { ...init.headers, ...headers } }))
    assert.equal(response.status, 403, path)
    assert.match((await response.json()).msg, /白名单/)
  }
  assert.equal(upstream.mock.callCount(), 0)
})

test('添加源：匿名浏览按来源限次，防单一客户端打满共享的 GitHub 匿名配额', async (t) => {
  const app = createBackend()
  t.mock.method(globalThis, 'fetch', async () => json(REPOSITORY))
  let last
  for (let i = 0; i < 61; i += 1) {
    last = await app.request('/api/sources/github', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url: 'https://github.com/teacher/homework' }),
    })
    if (i < 60) assert.equal(last.status, 200, `第 ${i + 1} 次应正常`)
  }
  assert.equal(last.status, 429, '第 61 次应限流')
  assert.match((await last.json()).msg, /太频繁/)
})
