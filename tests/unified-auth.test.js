import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBackend } from '../server/app.js'
import { MemorySessionStore } from '../server/storage/memory.js'

const CAS_PAGE = '<input type="hidden" name="execution" value="e1s2e3" />'
const TTL = 7 * 86400000

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function makeApp({ frontendUrl = '' } = {}) {
  const store = new MemorySessionStore()
  const app = createBackend({ getSessionStore: () => store, allowedOrigins: [], frontendUrl })
  return { app, store }
}

function post(app, path, body) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

/**
 * 造假 fetch，按 URL 特征分流响应，并把每次调用记下来。
 * 这样能同时验证"云邮走了一次 CAS"和"教务处走了第二次 CAS"。
 */
function fakeUpstream({ jwglViaCas = true, log = [] } = {}) {
  return async (url, options = {}) => {
    const target = String(url)
    log.push({ url: target, options })

    if (target.includes('auth.bupt.edu.cn/authserver/login?service=')) {
      const service = decodeURIComponent(new URL(target).searchParams.get('service') || '')
      if (target.includes('POST') || options.method === 'POST') {
        const ticket = service.includes('jwgl') ? 'ST-jwgl' : 'ST-ucloud'
        return new Response(null, {
          status: 302,
          headers: { Location: `${service}?ticket=${ticket}` },
        })
      }
      return new Response(CAS_PAGE, { headers: { 'set-cookie': 'CASTGC=abc; Path=/' } })
    }

    if (target.includes('ykt-basics/oauth/token')) {
      return json({ access_token: 'blade-token', refresh_token: 'refresh-token', expires_in: 7199 })
    }
    if (target.includes('ykt-basics/info')) {
      return json({ code: 200, success: true, data: { id: '2021001234', realName: '张三' } })
    }

    // 教务处：CAS ticket 入口，或老的 encodeInp 登录
    if (target.includes('jwgl.bupt.edu.cn')) {
      if (target.includes('?ticket=')) {
        if (!jwglViaCas) {
          return new Response('<html><title>登录</title><form id="userAccount"></form></html>')
        }
        return new Response('<title>教学评价</title>', { headers: { 'set-cookie': 'JSESSIONID=jw; Path=/' } })
      }
      if (target.includes('xk/LoginToXk')) {
        return new Response('', { status: 200, headers: { 'set-cookie': 'JSESSIONID=legacy; Path=/' } })
      }
      // 验证页
      return new Response('<title>教学评价</title>', { headers: { 'set-cookie': 'JSESSIONID=verify; Path=/' } })
    }

    return json({ code: 200, success: true, data: {} })
  }
}

// ── 统一登录 ────────────────────────────────────────────────────────────────

test('POST /api/auth/login：一次请求登两个系统，各拿一个 sessionId', async (t) => {
  const { app, store } = makeApp()
  const log = []
  t.mock.method(globalThis, 'fetch', fakeUpstream({ log }))

  const response = await post(app, '/api/auth/login', { username: '2021001234', password: 'pw' })
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(body.success, true)
  assert.match(body.data.ucloud.sessionId, /^[0-9a-f-]{36}$/)
  assert.match(body.data.jwgl.sessionId, /^[0-9a-f-]{36}$/)
  assert.equal(body.data.ucloud.realName, '张三')
  assert.equal(body.data.ucloud.username, '2021001234')
  assert.equal(body.data.jwgl.username, '2021001234')
  assert.equal(body.data.jwglVia, 'cas')

  // 两个系统都存了会话，且凭证只在服务端
  const ucloudSession = await store.get(body.data.ucloud.sessionId)
  const jwglSession = await store.get(body.data.jwgl.sessionId)
  assert.equal(ucloudSession.kind, 'ucloud')
  assert.equal(ucloudSession.accessToken, 'blade-token')
  assert.equal(jwglSession.kind, 'jwgl')
  assert.match(jwglSession.cookies, /JSESSIONID=/)
})

test('POST /api/auth/login：CAS 被请求了两次，service 分别是两个系统', async (t) => {
  const { app } = makeApp()
  const log = []
  t.mock.method(globalThis, 'fetch', fakeUpstream({ log }))

  await post(app, '/api/auth/login', { username: 'u', password: 'p' })

  const services = log
    .filter((call) => call.url.includes('authserver/login?service='))
    .map((call) => decodeURIComponent(new URL(call.url).searchParams.get('service') || ''))

  assert.ok(services.some((s) => s.includes('ucloud.bupt.edu.cn')), '应向云邮取 ticket')
  assert.ok(services.some((s) => s.includes('jwgl.bupt.edu.cn')), '应向教务处取 ticket')
})

test('POST /api/auth/login：响应里绝不出现任何凭证', async (t) => {
  const { app } = makeApp()
  t.mock.method(globalThis, 'fetch', fakeUpstream({}))

  const response = await post(app, '/api/auth/login', { username: 'u', password: 'pw' })
  const text = await response.text()

  for (const secret of ['blade-token', 'refresh-token', 'JSESSIONID', 'Blade-Auth', 'access_token']) {
    assert.equal(text.includes(secret), false, `响应里泄露了 ${secret}`)
  }
})

test('POST /api/auth/login：教务处 CAS 走不通时回退到原登录，整体仍成功', async (t) => {
  const { app, store } = makeApp()
  const log = []
  t.mock.method(globalThis, 'fetch', fakeUpstream({ jwglViaCas: false, log }))

  const response = await post(app, '/api/auth/login', { username: 'u', password: 'p' })
  const body = await response.json()

  assert.equal(response.status, 200, '一侧回退不该让整个登录失败')
  assert.equal(body.data.jwglVia, 'legacy')

  // 确实走到了老的 encodeInp 登录
  assert.ok(
    log.some((call) => call.url.includes('jwgl.bupt.edu.cn/jsxsd/xk/LoginToXk')),
    '应回退到 encodeInp 登录',
  )
  // 老登录的 Cookie 也进了会话
  const jwglSession = await store.get(body.data.jwgl.sessionId)
  assert.ok(jwglSession.cookies.includes('JSESSIONID='))
})

test('POST /api/auth/login：云邮失败时整体失败，不留下半套登录', async (t) => {
  const { app, store } = makeApp()
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const target = String(url)
    if (target.includes('authserver/login?service=')) {
      if (options.method === 'POST') {
        return new Response('<html><body><p>Invalid credentials.</p></body></html>')
      }
      return new Response(CAS_PAGE, { headers: { 'set-cookie': 'a=1' } })
    }
    return json({})
  })

  const response = await post(app, '/api/auth/login', { username: 'u', password: 'bad' })
  assert.equal(response.status, 401)
  assert.equal((await response.json()).stage, 'cas-login')
  assert.equal(store.size, 0, '不该留下任何会话')
})

test('POST /api/auth/login：缺参数时报 400', async () => {
  const { app } = makeApp()
  for (const body of [{}, { username: 'u' }, { password: 'p' }]) {
    const response = await post(app, '/api/auth/login', body)
    assert.equal(response.status, 400)
  }
})

// ── 企业微信流程 ────────────────────────────────────────────────────────────

test('GET /api/auth/wecom/start：换掉 app.bupt 的 redirect，保留 CAS 的 state', async (t) => {
  const { app } = makeApp()
  t.mock.method(globalThis, 'fetch', async (url) => {
    assert.match(String(url), /client_name=mc-wx/)
    return new Response(null, {
      status: 302,
      headers: {
        Location:
          'https://app.bupt.edu.cn/uc/api/oauth/index?response_type=code&appid=200210806102757400'
          + '&redirect=https%3A%2F%2Fauth.bupt.edu.cn%2Fauthserver%2Flogin%3Fclient_name%3Dmc-wx'
          + '&state=TST-109420-8UngFvR',
      },
    })
  })

  const response = await app.request('/api/auth/wecom/start')
  assert.equal(response.status, 302)

  const location = response.headers.get('location')
  const target = new URL(location)

  // 关键断言：redirect 换成了我们的 callback
  assert.equal(
    target.searchParams.get('redirect'),
    'http://localhost/api/auth/wecom/callback',
  )
  // 必须是绝对地址，否则 app.bupt 认不出
  // 而 state 原样保留——state 才是 CAS 认的凭证
  assert.equal(target.searchParams.get('state'), 'TST-109420-8UngFvR')
  assert.equal(target.searchParams.get('appid'), '200210806102757400')
  assert.equal(target.host, 'app.bupt.edu.cn')
})

test('GET /api/auth/wecom/callback：拿到 ticket 后登录并跳回前端', async (t) => {
  const { app, store } = makeApp()
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const target = String(url)
    if (target.includes('client_name=mc-wx')) {
      // CAS 拿 code 换到身份，302 到 service?ticket=
      return new Response(null, {
        status: 302,
        headers: { Location: 'https://ucloud.bupt.edu.cn?ticket=ST-from-wecom' },
      })
    }
    if (target.includes('ykt-basics/oauth/token')) {
      return json({ access_token: 'wecom-token', refresh_token: 'r', expires_in: 7199 })
    }
    if (target.includes('ykt-basics/info')) {
      return json({ code: 200, success: true, data: { id: '2021001234', realName: '李四' } })
    }
    return json({})
  })

  const response = await app.request('/api/auth/wecom/callback?code=CODE123&state=TST-109420-abc', {
    headers: { Referer: 'http://127.0.0.1:5173/' },
  })

  assert.equal(response.status, 302)
  const location = response.headers.get('location')
  assert.match(location, /^http:\/\/127\.0\.0\.1:5173\/#\/login\?wecom=ok&sessionId=/)

  // 会话真的建起来了
  const sessionId = new URLSearchParams(location.slice(location.indexOf('?') + 1)).get('sessionId')
  const session = await store.get(sessionId)
  assert.equal(session.kind, 'ucloud')
  assert.equal(session.accessToken, 'wecom-token')
  assert.equal(session.realName, '李四')
})

test('GET /api/auth/wecom/callback：code 或 state 缺失时跳回前端报错', async () => {
  const { app } = makeApp()
  for (const query of ['', '?code=only', '?state=only']) {
    const response = await app.request(`/api/auth/wecom/callback${query}`, {
      headers: { Referer: 'http://127.0.0.1:5173/' },
    })
    assert.equal(response.status, 302)
    assert.match(response.headers.get('location'), /error=wecom-cancelled/)
  }
})

test('GET /api/auth/wecom/callback：CAS 没给 ticket 时跳回前端报错', async (t) => {
  const { app } = makeApp()
  t.mock.method(globalThis, 'fetch', async () =>
    new Response('<html>出错了</html>', { status: 200 }),
  )

  const response = await app.request('/api/auth/wecom/callback?code=C&state=S', {
    headers: { Referer: 'http://127.0.0.1:5173/' },
  })

  assert.equal(response.status, 302)
  assert.match(response.headers.get('location'), /error=wecom-no-ticket/)
})

test('GET /api/auth/wecom/callback：CAS 连不上时跳回前端报错', async (t) => {
  const { app } = makeApp()
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('network down')
  })

  const response = await app.request('/api/auth/wecom/callback?code=C&state=S', {
    headers: { Referer: 'http://127.0.0.1:5173/' },
  })

  assert.match(response.headers.get('location'), /error=wecom-connect/)
})

test('GET /api/auth/wecom/start：CAS 连不上时返回可读错误', async (t) => {
  const { app } = makeApp()
  t.mock.method(globalThis, 'fetch', async () => {
    throw new Error('network down')
  })

  const response = await app.request('/api/auth/wecom/start')
  const body = await response.json()

  assert.equal(response.status, 502)
  assert.equal(body.stage, 'wecom-connect')
})

test('wecom/callback：配了 FRONTEND_URL 时跳回它，不依赖 Referer', async (t) => {
  const { app } = makeApp({ frontendUrl: 'https://example.github.io/BUPT-week/' })
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).includes('client_name=mc-wx')) {
      return new Response(null, {
        status: 302,
        headers: { Location: 'https://ucloud.bupt.edu.cn?ticket=ST-x' },
      })
    }
    if (String(url).includes('oauth/token')) return json({ access_token: 't', refresh_token: 'r' })
    if (String(url).includes('ykt-basics/info')) {
      return json({ code: 200, success: true, data: { id: '1', realName: '王五' } })
    }
    return json({})
  })

  // 故意不带 Referer——模拟用户直接在微信里打开 start 地址
  const response = await app.request('/api/auth/wecom/callback?code=C&state=S')

  assert.equal(response.status, 302)
  assert.equal(
    response.headers.get('location'),
    'https://example.github.io/BUPT-week/#/login?wecom=ok&sessionId='
      + encodeURIComponent(new URLSearchParams(response.headers.get('location').split('?')[1]).get('sessionId')),
  )
})

test('wecom/callback：没配 FRONTEND_URL 又没有 Referer 时，跳回后端自身而不是 localhost', async (t) => {
  const { app } = makeApp()
  t.mock.method(globalThis, 'fetch', async (url) => {
    if (String(url).includes('client_name=mc-wx')) {
      return new Response(null, {
        status: 302,
        headers: { Location: 'https://ucloud.bupt.edu.cn?ticket=ST-x' },
      })
    }
    if (String(url).includes('oauth/token')) return json({ access_token: 't', refresh_token: 'r' })
    if (String(url).includes('ykt-basics/info')) {
      return json({ code: 200, success: true, data: { id: '1', realName: '王五' } })
    }
    return json({})
  })

  const response = await app.request('/api/auth/wecom/callback?code=C&state=S')
  const location = response.headers.get('location')

  assert.equal(response.status, 302)
  assert.equal(location.includes('127.0.0.1'), false, '不能跳回 localhost，手机上打不开')
  assert.match(location, /^http:\/\/localhost\/#\/login\?wecom=ok&sessionId=/)
})
