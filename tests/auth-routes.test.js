import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBackend } from '../server/app.js'
import { slideSessionExpiry } from '../server/routes/auth.js'
import { MemorySessionStore } from '../server/storage/memory.js'

const CAS_PAGE = '<input type="hidden" name="execution" value="e1s2e3" />'
const TTL = 7 * 86400000

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function scriptedFetch(responses) {
  const calls = []
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), options })
    const next = responses.shift()
    if (next instanceof Error) throw next
    return typeof next === 'function' ? next() : next
  }
  return { fetchImpl, calls }
}

function makeApp() {
  const store = new MemorySessionStore()
  const app = createBackend({ getSessionStore: () => store, allowedOrigins: [] })
  return { app, store }
}

/** 让云邮登录链路返回成功。 */
function ucloudHappy(fetchImpl) {
  const { fetchImpl: impl, calls } = scriptedFetch([
    new Response(CAS_PAGE, { headers: { 'set-cookie': 'a=1' } }),
    new Response(null, { status: 302, headers: { Location: 'https://ucloud.bupt.edu.cn?ticket=ST-x' } }),
    json({ access_token: 'blade-token', refresh_token: 'refresh-token', expires_in: 7199 }),
    json({ code: 200, success: true, data: { id: '2021001234', realName: '张三' } }),
  ])
  return { fetchImpl: impl, calls }
}

function post(app, path, body) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

// ── 云邮登录 ────────────────────────────────────────────────────────────────

test('POST /api/ucloud/login：成功，返回不透明 sessionId', async (t) => {
  const { app, store } = makeApp()
  const { fetchImpl } = ucloudHappy()
  t.mock.method(globalThis, 'fetch', fetchImpl)

  const response = await post(app, '/api/ucloud/login', { username: '2021001234', password: 'pw' })
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(body.success, true)
  assert.match(body.data.sessionId, /^[0-9a-f-]{36}$/, 'sessionId 应是 UUID')
  assert.equal(body.data.username, '2021001234')
  assert.equal(body.data.realName, '张三')
  assert.ok(body.data.expiresAt > Date.now())

  // 凭证只落在服务端
  const session = await store.get(body.data.sessionId)
  assert.equal(session.accessToken, 'blade-token')
  assert.equal(session.refreshToken, 'refresh-token')
})

test('POST /api/ucloud/login：响应体里绝不出现 token', async (t) => {
  const { app } = makeApp()
  t.mock.method(globalThis, 'fetch', ucloudHappy().fetchImpl)

  const response = await post(app, '/api/ucloud/login', { username: 'u', password: 'pw' })
  const text = await response.text()

  for (const secret of ['blade-token', 'refresh-token', 'Blade-Auth', 'access_token', 'refresh_token']) {
    assert.equal(text.includes(secret), false, `响应里泄露了 ${secret}`)
  }
})

test('POST /api/ucloud/login：缺参数时报 400', async () => {
  const { app } = makeApp()
  for (const body of [{}, { username: 'u' }, { password: 'p' }]) {
    const response = await post(app, '/api/ucloud/login', body)
    assert.equal(response.status, 400)
  }
})

test('POST /api/ucloud/login：CAS 失败时报 401 并带 stage', async (t) => {
  const { app } = makeApp()
  t.mock.method(globalThis, 'fetch', async () =>
    new Response('<input name="execution" value="e1" /><p>用户名或密码错误</p>'),
  )

  const response = await post(app, '/api/ucloud/login', { username: 'u', password: 'bad' })
  const body = await response.json()

  assert.equal(response.status, 401)
  assert.equal(body.success, false)
  assert.equal(body.stage, 'cas-login')
  assert.match(body.msg, /用户名或密码错误/)
})

test('POST /api/ucloud/session：有效会话原样返回', async (t) => {
  const { app, store } = makeApp()
  await store.set('sid', {
    kind: 'ucloud',
    accessToken: 'blade-token',
    refreshToken: 'r',
    userId: '1',
    username: 'u',
    realName: '张三',
    expiresAt: Date.now() + TTL,
  })
  t.mock.method(globalThis, 'fetch', async () => json({ code: 200, success: true, data: { id: '1' } }))

  const response = await post(app, '/api/ucloud/session', { sessionId: 'sid' })
  const body = await response.json()

  assert.equal(body.success, true)
  assert.equal(body.data.username, 'u')
  assert.equal(body.data.realName, '张三')
})

test('POST /api/ucloud/session：access_token 过期时用 refresh_token 静默续期', async (t) => {
  const { app, store } = makeApp()
  await store.set('sid', {
    kind: 'ucloud',
    accessToken: 'expired',
    refreshToken: 'refresh-token',
    userId: '1',
    username: 'u',
    realName: '张三',
    expiresAt: Date.now() + TTL,
  })

  let step = 0
  t.mock.method(globalThis, 'fetch', async () => {
    step += 1
    if (step === 1) return json({ msg: 'token 过期' }, 401) // 探测 → 401
    if (step === 2) return json({ access_token: 'fresh-token', refresh_token: 'fresh-refresh' }) // 续期
    return json({ code: 200, success: true, data: { id: '1' } }) // 确认新 token 可用
  })

  const response = await post(app, '/api/ucloud/session', { sessionId: 'sid' })
  assert.equal(response.status, 200)
  assert.equal(step, 3, '应当 探测→续期→再确认')

  const renewed = await store.get('sid')
  assert.equal(renewed.accessToken, 'fresh-token')
  assert.equal(renewed.refreshToken, 'fresh-refresh')
})

test('POST /api/ucloud/session：续期也失败时删掉会话并报 401', async (t) => {
  const { app, store } = makeApp()
  await store.set('sid', {
    kind: 'ucloud',
    accessToken: 'expired',
    refreshToken: 'dead',
    userId: '1',
    username: 'u',
    expiresAt: Date.now() + TTL,
  })

  let step = 0
  t.mock.method(globalThis, 'fetch', async () => {
    step += 1
    if (step === 1) return json({ msg: 'token 过期' }, 401) // 探测 → 401，触发续期
    return json({ error_description: 'refresh 也过期' }, 400) // 续期被拒
  })

  const response = await post(app, '/api/ucloud/session', { sessionId: 'sid' })
  assert.equal(response.status, 401)
  assert.equal((await response.json()).stage, 'ucloud-auth')
  assert.equal(await store.get('sid'), undefined, '失效会话应被删除')
})

test('POST /api/ucloud/session：没有 refresh_token 时直接 401', async (t) => {
  const { app, store } = makeApp()
  await store.set('sid', {
    kind: 'ucloud',
    accessToken: 'expired',
    refreshToken: '',
    userId: '1',
    username: 'u',
    expiresAt: Date.now() + TTL,
  })
  t.mock.method(globalThis, 'fetch', async () => json({}, 401))

  const response = await post(app, '/api/ucloud/session', { sessionId: 'sid' })
  assert.equal(response.status, 401)
})

test('POST /api/ucloud/session：未知或已过期的 sessionId 报 401', async () => {
  const { app } = makeApp()
  for (const sessionId of ['nope', '']) {
    const response = await post(app, '/api/ucloud/session', { sessionId })
    assert.equal(response.status, 401)
  }
})

test('POST /api/ucloud/session：拿jwgl的 sessionId 来问云邮会被拒', async () => {
  const { app, store } = makeApp()
  await store.set('sid', { kind: 'jwgl', cookies: 'x=1', username: 'u', expiresAt: Date.now() + TTL })
  const response = await post(app, '/api/ucloud/session', { sessionId: 'sid' })
  assert.equal(response.status, 401)
})

test('POST /api/ucloud/logout：删掉服务端会话', async () => {
  const { app, store } = makeApp()
  await store.set('sid', { kind: 'ucloud', accessToken: 't', expiresAt: Date.now() + TTL })

  const response = await post(app, '/api/ucloud/logout', { sessionId: 'sid' })
  assert.equal(response.status, 200)
  assert.equal(await store.get('sid'), undefined)
})

test('POST /api/ucloud/logout：sessionId 不存在也返回成功（幂等）', async () => {
  const { app } = makeApp()
  const response = await post(app, '/api/ucloud/logout', { sessionId: 'never-existed' })
  assert.equal(response.status, 200)
})

// ── 教务处登录 ──────────────────────────────────────────────────────────────

test('POST /api/jwgl/login：成功，返回 sessionId，Cookie 只存服务端', async (t) => {
  const { app, store } = makeApp()
  t.mock.method(globalThis, 'fetch', async () =>
    new Response('<title>教学评价</title>', { headers: { 'set-cookie': 'JSESSIONID=secret-cookie' } }),
  )

  const response = await post(app, '/api/jwgl/login', { username: '2021001234', password: 'pw' })
  const text = await response.text()
  const body = JSON.parse(text)

  assert.equal(response.status, 200)
  assert.equal(body.data.username, '2021001234')
  assert.match(body.data.sessionId, /^[0-9a-f-]{36}$/)

  // Cookie 绝不能出现在响应里
  assert.equal(text.includes('secret-cookie'), false, '响应里泄露了教务 Cookie')
  const session = await store.get(body.data.sessionId)
  assert.match(session.cookies, /JSESSIONID=secret-cookie/)
})

test('POST /api/jwgl/login：登录失败报 401 + stage', async (t) => {
  const { app } = makeApp()
  t.mock.method(globalThis, 'fetch', async () =>
    new Response('<title>登录</title><form id="userAccount"></form><p>密码错误</p>'),
  )

  const response = await post(app, '/api/jwgl/login', { username: 'u', password: 'bad' })
  const body = await response.json()

  assert.equal(response.status, 401)
  assert.equal(body.stage, 'jwgl-login')
})

test('POST /api/jwgl/session：有效会话返回，失效则删除并报 401', async (t) => {
  const { app, store } = makeApp()
  await store.set('ok', { kind: 'jwgl', cookies: 'JSESSIONID=x', username: 'u', expiresAt: Date.now() + TTL })
  await store.set('dead', { kind: 'jwgl', cookies: 'JSESSIONID=y', username: 'u', expiresAt: Date.now() + TTL })

  let call = 0
  t.mock.method(globalThis, 'fetch', async () => {
    call += 1
    return call === 1
      ? new Response('<title>教学评价</title>', { headers: { 'set-cookie': 'JSESSIONID=fresh' } })
      : new Response('<title>登录</title><form id="userAccount"></form>')
  })

  const good = await post(app, '/api/jwgl/session', { sessionId: 'ok' })
  assert.equal(good.status, 200)
  assert.match((await store.get('ok')).cookies, /JSESSIONID=fresh/)

  const bad = await post(app, '/api/jwgl/session', { sessionId: 'dead' })
  assert.equal(bad.status, 401)
  assert.equal(await store.get('dead'), undefined)
})

test('POST /api/jwgl/logout：删掉服务端会话', async () => {
  const { app, store } = makeApp()
  await store.set('sid', { kind: 'jwgl', cookies: 'x=1', username: 'u', expiresAt: Date.now() + TTL })

  assert.equal((await post(app, '/api/jwgl/logout', { sessionId: 'sid' })).status, 200)
  assert.equal(await store.get('sid'), undefined)
})

// ── 两个系统互不干扰 ────────────────────────────────────────────────────────

test('两个系统的 sessionId 不通用', async () => {
  const { app, store } = makeApp()
  await store.set('jw', { kind: 'jwgl', cookies: 'x=1', username: 'u', expiresAt: Date.now() + TTL })
  await store.set('uc', { kind: 'ucloud', accessToken: 't', userId: '1', username: 'u', expiresAt: Date.now() + TTL })

  assert.equal((await post(app, '/api/ucloud/session', { sessionId: 'jw' })).status, 401)
  assert.equal((await post(app, '/api/jwgl/session', { sessionId: 'uc' })).status, 401)
})

// ── 滑动续期（探活成功即续命，30 天绝对上限）─────────────────────────────────

const DAY = 86400000

test('slideSessionExpiry：剩余充足返回原引用（零写入）；不足 6 天推到 7 天', () => {
  const now = Date.now()
  const fresh = { kind: 'ucloud', createdAt: now, expiresAt: now + 7 * DAY }
  assert.equal(slideSessionExpiry(fresh), fresh, '剩余 7 天不动')

  const stale = { kind: 'ucloud', createdAt: now - 8 * DAY, expiresAt: now + 5 * DAY }
  const slid = slideSessionExpiry(stale)
  assert.notEqual(slid, stale)
  assert.ok(Math.abs(slid.expiresAt - (now + 7 * DAY)) < 60_000, '推到 7 天后')
  assert.equal(slid.createdAt, stale.createdAt, 'createdAt 不变')
})

test('slideSessionExpiry：30 天绝对上限——续期不越过创建起 30 天', () => {
  const now = Date.now()
  // 真实可达状态：25 天前创建（经多次滑动）现在剩 4 天，滑到头也只能到
  // createdAt+30 天（now+5 天），拿不满 7 天
  const veteran = { kind: 'ucloud', createdAt: now - 25 * DAY, expiresAt: now + 4 * DAY }
  const slid = slideSessionExpiry(veteran)
  assert.notEqual(slid, veteran)
  assert.ok(Math.abs(slid.expiresAt - (now + 5 * DAY)) < 60_000, '上限 = createdAt+30天，而非 now+7天')

  // 已顶到上限（剩 0.5 天触发条件但上限就在当下）：不再续也不缩短，等自然过期
  const capped = { kind: 'ucloud', createdAt: now - 29.5 * DAY, expiresAt: now + 0.5 * DAY }
  assert.equal(slideSessionExpiry(capped), capped, '顶到上限的会话保持原样')
})

test('slideSessionExpiry：老会话无 createdAt 按 expiresAt-7天补推，不被无限续', () => {
  const now = Date.now()
  const legacy = { kind: 'ucloud', expiresAt: now + 5 * DAY }
  const slid = slideSessionExpiry(legacy)
  assert.ok(Math.abs(slid.expiresAt - (now + 7 * DAY)) < 60_000)
  assert.ok(Math.abs(slid.createdAt - (now - 2 * DAY)) < 60_000, '补推的 createdAt 参与后续上限计算')
})

test('POST /api/ucloud/session：剩余不足 6 天时滑动续期并回写 store', async (t) => {
  const { app, store } = makeApp()
  const now = Date.now()
  await store.set('sid', {
    kind: 'ucloud', accessToken: 'tk', refreshToken: 'r', userId: '1',
    username: 'u', realName: '张三',
    createdAt: now - 8 * DAY, expiresAt: now + 5 * DAY,
  })
  t.mock.method(globalThis, 'fetch', async () => json({ code: 200, success: true, data: { id: '1' } }))

  const response = await post(app, '/api/ucloud/session', { sessionId: 'sid' })
  const body = await response.json()

  assert.equal(body.success, true)
  assert.ok(Math.abs(body.data.expiresAt - (now + 7 * DAY)) < 60_000, '响应里给新过期时间')
  const stored = await store.get('sid')
  assert.ok(Math.abs(stored.expiresAt - (now + 7 * DAY)) < 60_000, 'store 回写')
  assert.equal(JSON.stringify(stored).includes('password'), false, '凭证里永不出现密码')
})

test('POST /api/jwgl/session：jwglweixin 会话探活成功也滑动续期', async (t) => {
  const { app, store } = makeApp()
  const now = Date.now()
  await store.set('wx', {
    kind: 'jwglweixin', token: 'tk', username: 'u',
    createdAt: now - 8 * DAY, expiresAt: now + 5 * DAY,
  })
  t.mock.method(globalThis, 'fetch', async () => json({ code: '1', data: [{}] }))

  const response = await post(app, '/api/jwgl/session', { sessionId: 'wx' })
  const body = await response.json()

  assert.equal(body.success, true)
  assert.ok(Math.abs(body.data.expiresAt - (now + 7 * DAY)) < 60_000)
  assert.ok(Math.abs((await store.get('wx')).expiresAt - (now + 7 * DAY)) < 60_000)
})
