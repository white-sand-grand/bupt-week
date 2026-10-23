import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBackend } from '../server/app.js'
import { MemorySessionStore } from '../server/storage/memory.js'

/**
 * 学号与密码的隐私保障，逐条落成可执行的断言：
 * 密码只存在于「请求处理过程中的内存」，不出现在响应、会话存储、日志的任何一处。
 */

const CAS_PAGE = '<input type="hidden" name="execution" value="e1s2e3" />'
const PASSWORD = 'pW-s3cret-隐私探针'

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function makeApp() {
  const store = new MemorySessionStore()
  const app = createBackend({ getSessionStore: () => store, allowedOrigins: [] })
  return { app, store }
}

/** 云邮 CAS 成功 + 教务 CAS 成功的完整统一登录链路。 */
function happyUpstream() {
  return async (url, options = {}) => {
    const target = String(url)
    if (target.includes('authserver/login?service=')) {
      if (options.method === 'POST') {
        const service = decodeURIComponent(new URL(target).searchParams.get('service') || '')
        return new Response(null, { status: 302, headers: { Location: `${service}?ticket=ST-x` } })
      }
      return new Response(CAS_PAGE, { headers: { 'set-cookie': 'a=1' } })
    }
    if (target.includes('ykt-basics/oauth/token')) {
      return json({ access_token: 'at', refresh_token: 'rt', expires_in: 7199 })
    }
    if (target.includes('ykt-basics/info')) {
      return json({ code: 200, success: true, data: { id: '1', realName: '张三' } })
    }
    if (target.includes('jwgl.bupt.edu.cn')) {
      return new Response('<title>教学评价</title>', { headers: { 'set-cookie': 'JSESSIONID=j; Path=/' } })
    }
    return json({})
  }
}

/** 收集一段时间内 console 的全部输出。 */
function captureConsole() {
  const chunks = []
  const original = { log: console.log, error: console.error, warn: console.warn }
  console.log = (...args) => chunks.push(args.map(String).join(' '))
  console.error = (...args) => chunks.push(args.map(String).join(' '))
  console.warn = (...args) => chunks.push(args.map(String).join(' '))
  return () => {
    console.log = original.log
    console.error = original.error
    console.warn = original.warn
    return chunks
  }
}

function post(app, path, body) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

test('统一登录：密码不进响应体、不进会话存储、不进日志', async (t) => {
  const { app, store } = makeApp()
  t.mock.method(globalThis, 'fetch', happyUpstream())
  const restore = captureConsole()

  try {
    const response = await post(app, '/api/auth/login', { username: '2021001234', password: PASSWORD })
    const text = await response.text()
    const logs = restore()

    assert.equal(response.status, 200)

    // 响应体里只有不透明 sessionId 与姓名
    assert.equal(text.includes(PASSWORD), false, '密码绝不能出现在响应体')
    assert.equal(text.includes('access_token'), false)
    assert.equal(text.includes('refresh_token'), false)

    // 会话存储里只有派生凭证（token / Cookie），没有密码
    const stored = JSON.stringify([...store.map.entries()])
    assert.equal(stored.includes(PASSWORD), false, '密码绝不能进会话存储')
    assert.equal(stored.includes('at'), true, '派生凭证应在服务端会话里（这是设计）')

    // 服务端日志全文无密码
    for (const line of logs) {
      assert.equal(line.includes(PASSWORD), false, `日志里出现了密码：${line.slice(0, 120)}`)
    }
  } finally {
    restore()
  }
})

test('登录失败：错误信息不回显密码', async (t) => {
  const { app } = makeApp()
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    if (String(url).includes('authserver/login?service=') && options.method === 'POST') {
      return new Response('<html><body><p>Invalid credentials.</p></body></html>')
    }
    return new Response(CAS_PAGE, { headers: { 'set-cookie': 'a=1' } })
  })

  const response = await post(app, '/api/auth/login', { username: '2021001234', password: PASSWORD })
  const body = await response.json()

  assert.equal(response.status, 401)
  assert.equal(JSON.stringify(body).includes(PASSWORD), false, '失败响应不能回显密码')
})

test('未知异常：响应是固定文案，不含内部细节', async () => {
  const store = new MemorySessionStore()
  const app = createBackend({
    getSessionStore: () => store,
    allowedOrigins: [],
    // 不存在的定制点：直接挂一个会抛非 ApiError 的路由来验证 onError 兜底
  })
  app.post('/api/__boom', (c) => {
    throw new Error('secret-internal-detail /var/db/password.txt')
  })

  const response = await app.request('/api/__boom', { method: 'POST' })
  const body = await response.json()

  assert.equal(response.status, 500)
  assert.equal(body.msg, '服务器内部错误，请稍后再试')
  assert.equal(JSON.stringify(body).includes('secret-internal-detail'), false)
})

test('下载接口：教务会话不能调云邮下载（kind 校验）', async () => {
  const { app, store } = makeApp()
  await store.set('jw', { kind: 'jwgl', cookies: 'x=1', username: 'u', expiresAt: Date.now() + 86400000 })

  const response = await post(app, '/api/ucloud/resource/download', { sessionId: 'jw', resourceId: 'r' })
  const body = await response.json()

  assert.equal(response.status, 401)
  assert.equal(body.stage, 'ucloud-auth')
})

test('未命中白名单的请求也带 Vary: Origin（含 /file 代理）', async (t) => {
  const { app } = makeApp()
  t.mock.method(globalThis, 'fetch', async () => new Response('ok'))

  const api = await app.request('/api/health', { headers: { Origin: 'https://evil.example.com' } })
  assert.equal(api.headers.get('vary'), 'Origin')

  const file = await app.request('/file/x.pdf', { headers: { Origin: 'https://evil.example.com' } })
  assert.equal(file.headers.get('vary'), 'Origin')
})
