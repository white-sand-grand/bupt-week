import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBackend } from '../server/app.js'
import { MemorySessionStore } from '../server/storage/memory.js'

const CAS_PAGE = '<input type="hidden" name="execution" value="e1s2e3" />'

function makeApp() {
  const store = new MemorySessionStore()
  const app = createBackend({ getSessionStore: () => store, allowedOrigins: [] })
  return { app, store }
}

function post(app, path, body) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/** CAS 恒定拒绝密码（302 缺失 → cas-login 401）。 */
function casAlwaysRejects(t) {
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const target = String(url)
    if (target.includes('authserver/login?service=')) {
      if (options.method === 'POST') {
        return new Response('<html><body><p>Invalid credentials.</p></body></html>')
      }
      return new Response(CAS_PAGE, { headers: { 'set-cookie': 'a=1' } })
    }
    return new Response(JSON.stringify({}), { headers: { 'Content-Type': 'application/json' } })
  })
}

test('登录失败达到阈值后返回 429，并带可读信息', async (t) => {
  const { app } = makeApp()
  casAlwaysRejects(t)

  // 默认阈值 10 次。每次都是密码错（401），应逐次放行。
  for (let attempt = 1; attempt <= 10; attempt += 1) {
    const response = await post(app, '/api/auth/login', { username: 'u', password: 'bad' })
    assert.equal(response.status, 401, `第 ${attempt} 次不该被限速`)
  }

  const blocked = await post(app, '/api/auth/login', { username: 'u', password: 'bad' })
  assert.equal(blocked.status, 429)
  const body = await blocked.json()
  assert.equal(body.success, false)
  assert.equal(body.stage, 'rate-limit')
  assert.match(body.msg, /稍后/)
})

test('限速按应用实例隔离：新实例（新进程/新 isolate）从零开始', async (t) => {
  casAlwaysRejects(t)

  const first = makeApp()
  for (let attempt = 0; attempt < 10; attempt += 1) {
    await post(first.app, '/api/auth/login', { username: 'u', password: 'bad' })
  }
  assert.equal((await post(first.app, '/api/auth/login', { username: 'u', password: 'bad' })).status, 429)

  const second = makeApp()
  assert.equal((await post(second.app, '/api/auth/login', { username: 'u', password: 'bad' })).status, 401)
})

test('参数缺失（400）不占限速额度', async (t) => {
  const { app } = makeApp()
  casAlwaysRejects(t)

  for (let attempt = 0; attempt < 15; attempt += 1) {
    await post(app, '/api/auth/login', { username: '', password: '' })
  }

  // 15 次 400 之后，真正的密码尝试仍应走到上游（401），不是 429
  assert.equal((await post(app, '/api/auth/login', { username: 'u', password: 'bad' })).status, 401)
})

// ── 2026-10-25 对抗加固轮 ────────────────────────────────────────────────────

import { createLoginRateLimiter, createRequestRateLimiter } from '../server/rate-limit.js'
import { ApiError } from '../server/http.js'

function ipContext(ip = '9.9.9.9') {
  return { req: { header: (name) => (name === 'CF-Connecting-IP' ? ip : undefined) } }
}

test('对抗：并发失败突刺全额计数，不被读改写竞态免单', async () => {
  const limiter = createLoginRateLimiter({ maxFailures: 5 })
  const handler = limiter(async () => {
    throw new ApiError(401, { stage: 'test', msg: '密码错' })
  })

  // 20 个并发 401：旧实现里各自拿着 await 前的旧桶引用回写，
  // 互相覆盖后计数停在 1，突刺全免单；修后必须全额累计
  await Promise.allSettled(Array.from({ length: 20 }, () => handler(ipContext())))

  await assert.rejects(
    () => handler(ipContext()),
    (error) => error.status === 429,
    '突刺之后的下一个请求必须已被挡',
  )
})

test('对抗：请求级限速按命中次数计数（不分成败），超限 429', async () => {
  const limiter = createRequestRateLimiter({ maxRequests: 3 })
  const handler = limiter(async () => 'ok')

  for (let i = 0; i < 3; i += 1) {
    assert.equal(await handler(ipContext()), 'ok')
  }
  await assert.rejects(
    () => handler(ipContext()),
    (error) => error.status === 429,
  )
  // 不同来源互不影响
  assert.equal(await handler(ipContext('8.8.8.8')), 'ok')
})
