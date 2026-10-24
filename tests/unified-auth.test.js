import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBackend } from '../server/app.js'
import { MemorySessionStore } from '../server/storage/memory.js'

const CAS_PAGE = '<input type="hidden" name="execution" value="e1s2e3" />'
const TTL = 7 * 86400000

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

function makeApp({ frontendUrl = '', allowedOrigins = [] } = {}) {
  const store = new MemorySessionStore()
  const app = createBackend({ getSessionStore: () => store, allowedOrigins, frontendUrl })
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
 *
 * jwglweixin（移动教务主源）三种行为：
 *   'ok' → 换到 token；'wrong-password' → code 0；'unreachable'（默认）→
 *   网络不可达。默认不可达：本文件既有用例测的是教务处 jwgl 的 CAS/legacy/
 *   降级链，主源可用时根本走不到那里。
 */
function fakeUpstream({ jwglViaCas = true, jwglUnreachable = false, jwglweixin = 'unreachable', log = [] } = {}) {
  return async (url, options = {}) => {
    const target = String(url)
    log.push({ url: target, options })

    if (target.includes('jwglweixin.bupt.edu.cn/bjyddx/login')) {
      if (jwglweixin === 'ok') {
        return json({ code: 1, data: { token: 'wx-token', expires_in: 7200 } })
      }
      if (jwglweixin === 'wrong-password') {
        return json({ code: 0, Msg: '用户名或密码错误' })
      }
      throw new Error('fetch failed')
    }
    if (target.includes('jwglweixin.bupt.edu.cn')) {
      // 课表请求只有登录成功后才会发生；给个能用的空壳
      return json({ code: 1, data: [{ date: [{ mxrq: '2026-10-26', xqid: '1', zc: '8' }] }] })
    }

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
      // 校外环境：域名只在校园网 DNS 存在，连接层直接失败（实测 NXDOMAIN）
      if (jwglUnreachable) {
        throw new Error('fetch failed')
      }
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

test('POST /api/auth/login：第二次认证带上 CASTGC 时走 SSO 短路，不再重交密码', async (t) => {
  const { app, store } = makeApp()
  const log = []
  t.mock.method(
    globalThis,
    'fetch',
    async (url, options = {}) => {
      const target = String(url)
      log.push({ url: target, options })

      if (target.includes('authserver/login?service=')) {
        const service = decodeURIComponent(new URL(target).searchParams.get('service') || '')
        const cookie = new Headers(options.headers).get('Cookie') || ''

        // 带着 CASTGC 的 GET：CAS 认得这个 SSO 会话，直接 302 发 ticket
        if (options.method !== 'POST' && cookie.includes('CASTGC=')) {
          return new Response(null, {
            status: 302,
            headers: { Location: `${service}?ticket=ST-jwgl-sso` },
          })
        }
        if (options.method === 'POST') {
          return new Response(null, {
            status: 302,
            // POST 成功同时签发 CASTGC——真实 CAS 的行为
            headers: { Location: `${service}?ticket=ST-ucloud`, 'Set-Cookie': 'CASTGC=tgc-1; Path=/' },
          })
        }
        return new Response(CAS_PAGE, { headers: { 'set-cookie': 'JSESSIONID=cas-page; Path=/' } })
      }

      if (target.includes('ykt-basics/oauth/token')) {
        return json({ access_token: 'blade-token', refresh_token: 'refresh-token', expires_in: 7199 })
      }
      if (target.includes('ykt-basics/info')) {
        return json({ code: 200, success: true, data: { id: '2021001234', realName: '张三' } })
      }
      if (target.includes('jwgl.bupt.edu.cn')) {
        return new Response('<title>教学评价</title>', { headers: { 'set-cookie': 'JSESSIONID=jw; Path=/' } })
      }
      return json({ code: 200, success: true, data: {} })
    },
  )

  const response = await post(app, '/api/auth/login', { username: 'u', password: 'p' })
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(body.data.jwglVia, 'cas')

  // 学号密码只 POST 过一次（第一次认证）；第二次靠 CASTGC 直接拿 ticket
  const credentialPosts = log.filter(
    (call) => call.options.method === 'POST' && call.url.includes('authserver/login'),
  )
  assert.equal(credentialPosts.length, 1, 'SSO 生效时密码只应提交一次')

  // 教务侧拿到的就是 SSO ticket
  assert.ok(log.some((call) => call.url.includes('jwgl.bupt.edu.cn/?ticket=ST-jwgl-sso')))
  assert.equal((await store.get(body.data.jwgl.sessionId)).kind, 'jwgl')
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

test('POST /api/auth/login：移动教务可用时作为主源，jwglVia=weixin', async (t) => {
  const { app, store } = makeApp()
  const log = []
  t.mock.method(globalThis, 'fetch', fakeUpstream({ jwglweixin: 'ok', log }))

  const response = await post(app, '/api/auth/login', { username: 'u', password: 'p' })
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(body.data.jwglVia, 'weixin')

  // 会话是 token 型
  const session = await store.get(body.data.jwgl.sessionId)
  assert.equal(session.kind, 'jwglweixin')
  assert.equal(session.token, 'wx-token')

  // 主源成功就不该去碰教务处 jwgl（校外它的域名根本不存在）
  assert.equal(log.some((call) => call.url.includes('jwgl.bupt.edu.cn')), false)
})

test('POST /api/auth/login：移动教务挂了回退教务处 CAS，整体仍成功', async (t) => {
  const { app, store } = makeApp()
  const log = []
  t.mock.method(globalThis, 'fetch', fakeUpstream({ jwglweixin: 'unreachable', jwglViaCas: true, log }))

  const response = await post(app, '/api/auth/login', { username: 'u', password: 'p' })
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.equal(body.data.jwglVia, 'cas')
  const session = await store.get(body.data.jwgl.sessionId)
  assert.equal(session.kind, 'jwgl')
})

test('POST /api/auth/login：教务密码与统一身份不同（校外）→ 降级 + jwglPasswordNeeded', async (t) => {
  const { app, store } = makeApp()
  t.mock.method(globalThis, 'fetch', fakeUpstream({ jwglweixin: 'wrong-password', jwglUnreachable: true }))

  const response = await post(app, '/api/auth/login', { username: 'u', password: 'p' })
  const body = await response.json()

  // 云邮照常登录，教务降级，但降级原因标成「密码不同」并开放补填
  assert.equal(response.status, 200)
  assert.equal(body.data.jwglVia, 'unavailable')
  assert.equal(body.data.jwglPasswordNeeded, true)
  assert.match(body.data.jwglMessage, /补填教务密码/)
  assert.equal(store.size, 1)
})

test('POST /api/auth/jwglweixin/password：补填教务密码，成功建移动教务会话', async (t) => {
  const { app, store } = makeApp()
  await store.set('uc-sid', {
    kind: 'ucloud',
    accessToken: 'tk',
    username: '2021001234',
    expiresAt: Date.now() + 3600_000,
  })
  let seen = null
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    seen = { url: String(url), body: options.body }
    return json({ code: 1, data: { token: 'wx-token-2' } })
  })

  const response = await post(app, '/api/auth/jwglweixin/password', { sessionId: 'uc-sid', password: 'jwgl-pw' })
  const body = await response.json()

  assert.equal(response.status, 200)
  assert.match(body.data.sessionId, /^[0-9a-f-]{36}$/)
  // 用云邮会话里的学号 + 补填的密码登录；密码不进任何持久化
  assert.ok(seen.url.includes('/bjyddx/login'))
  assert.equal(seen.body, 'userNo=2021001234&pwd=jwgl-pw')
  const session = await store.get(body.data.sessionId)
  assert.equal(session.kind, 'jwglweixin')
  assert.equal(session.token, 'wx-token-2')
  assert.equal(session.username, '2021001234')
  assert.equal(JSON.stringify(session).includes('jwgl-pw'), false, '密码绝不能落会话')
})

test('POST /api/auth/jwglweixin/password：密码仍不对报 401，云邮会话缺失也 401', async (t) => {
  const { app, store } = makeApp()
  await store.set('uc-sid', {
    kind: 'ucloud', accessToken: 'tk', username: '2021001234', expiresAt: Date.now() + 3600_000,
  })
  t.mock.method(globalThis, 'fetch', async () => json({ code: 0, Msg: '用户名或密码错误' }))

  const wrong = await post(app, '/api/auth/jwglweixin/password', { sessionId: 'uc-sid', password: 'still-bad' })
  assert.equal(wrong.status, 401)
  assert.match((await wrong.json()).msg, /用户名或密码错误/)

  const noSession = await post(app, '/api/auth/jwglweixin/password', { sessionId: 'nope', password: 'x' })
  assert.equal(noSession.status, 401)
})

test('POST /api/auth/login：教务系统不可达时降级为仅云邮登录，作业功能不陪葬', async (t) => {
  const { app, store } = makeApp()
  const log = []
  t.mock.method(globalThis, 'fetch', fakeUpstream({ jwglUnreachable: true, log }))

  const response = await post(app, '/api/auth/login', { username: 'u', password: 'p' })
  const body = await response.json()

  // 云邮侧是真实凭证校验，已经成功——不能因为教务连不上把人挡在门外
  // （2026-10-24 校外实测：三次登录云邮全通、教务 NXDOMAIN，整体 502）
  assert.equal(response.status, 200)
  assert.equal(body.success, true)
  assert.match(body.data.ucloud.sessionId, /^[0-9a-f-]{36}$/)
  assert.equal(body.data.ucloud.realName, '张三')

  assert.equal(body.data.jwgl, null, '教务侧应以 null 标记不可用')
  assert.equal(body.data.jwglVia, 'unavailable')
  assert.match(body.data.jwglMessage, /校园网/)

  // store 里只有云邮一条会话，没有半套教务会话
  assert.equal(store.size, 1)
  const ucloudSession = await store.get(body.data.ucloud.sessionId)
  assert.equal(ucloudSession.kind, 'ucloud')

  // 确实两条教务路径都试过了（CAS → 回退 legacy），不是跳过了教务
  assert.ok(log.some((call) => call.url.includes('jwgl.bupt.edu.cn/?ticket=')))
  assert.ok(log.some((call) => call.url.includes('jwgl.bupt.edu.cn/jsxsd/')))
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
    headers: {
      Cookie:
        'bupt-week-frontend=' + encodeURIComponent('http://127.0.0.1:5173')
        + '; bupt-week-wecom-state=TST-109420-abc',
    },
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
      headers: { Cookie: 'bupt-week-frontend=' + encodeURIComponent('http://127.0.0.1:5173') },
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
    headers: {
      Cookie:
        'bupt-week-frontend=' + encodeURIComponent('http://127.0.0.1:5173')
        + '; bupt-week-wecom-state=S',
    },
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
    headers: {
      Cookie:
        'bupt-week-frontend=' + encodeURIComponent('http://127.0.0.1:5173')
        + '; bupt-week-wecom-state=S',
    },
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

  // 故意不带 Referer——模拟用户直接在微信里打开 start 地址。
  // state cookie 必须带上且与 query 一致，这是 start→callback 的一次性绑定。
  const response = await app.request('/api/auth/wecom/callback?code=C&state=S', {
    headers: { Cookie: 'bupt-week-wecom-state=S' },
  })

  assert.equal(response.status, 302)
  assert.equal(
    response.headers.get('location'),
    'https://example.github.io/BUPT-week/#/login?wecom=ok&sessionId='
      + encodeURIComponent(new URLSearchParams(response.headers.get('location').split('?')[1]).get('sessionId')),
  )
})

test('wecom/callback：什么线索都没有时给出明确提示，而不是拼个 404', async (t) => {
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

  // 没配 FRONTEND_URL、也没有 start 时种下的前端 cookie（state cookie 有——
  // 这测的是「拿不到前端地址」这一支，不是「流程没绑定」）
  const response = await app.request('/api/auth/wecom/callback?code=C&state=S', {
    headers: { Cookie: 'bupt-week-wecom-state=S' },
  })
  const text = await response.text()

  assert.equal(response.status, 200)
  assert.match(text, /企业微信登录已完成/)
  assert.match(text, /手动打开站点首页/)
  // 不该把用户送去一个 404 页面——那种失败看起来像站点挂了
  assert.equal(response.headers.get('location'), null)
})

test('wecom/callback：Referer 是 app.bupt 时不能拿它当前端地址', async (t) => {
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

  // 走到 callback 时 Referer 必然是 app.bupt——那是跳转来源，不是我们的前端。
  // 拿它当前端地址会把用户弹回 app.bupt。
  const response = await app.request('/api/auth/wecom/callback?code=C&state=S', {
    headers: {
      Referer: 'https://app.bupt.edu.cn/uc/wap/login?redirect=x',
      Cookie: 'bupt-week-wecom-state=S',
    },
  })
  const location = response.headers.get('location')

  assert.equal(location, null, `不该跳转，实际跳到了 ${location}`)
  assert.match(await response.text(), /手动打开站点首页/)
})

test('wecom/start：白名单内的 Referer 才种前端 cookie，并种下一次性 state cookie', async (t) => {
  const { app } = makeApp({ allowedOrigins: ['https://white-sand-grand.github.io'] })
  t.mock.method(globalThis, 'fetch', async () =>
    new Response(null, {
      status: 302,
      headers: {
        Location:
          'https://app.bupt.edu.cn/uc/api/oauth/index?response_type=code&appid=200210806102757400'
          + '&redirect=https%3A%2F%2Fauth.bupt.edu.cn%2Fauthserver%2Flogin%3Fclient_name%3Dmc-wx'
          + '&state=TST-1',
      },
    }),
  )

  // 此刻用户是从我们页面点进来的，Referer 是白名单内的前端
  const response = await app.request('/api/auth/wecom/start', {
    headers: { Referer: 'https://white-sand-grand.github.io/bupt-week/' },
  })

  const cookies = response.headers.getSetCookie()

  const frontend = cookies.find((cookie) => cookie.startsWith('bupt-week-frontend='))
  assert.ok(frontend, '白名单内的 Referer 应种下前端 cookie')
  assert.match(frontend, /white-sand-grand\.github\.io/)
  // SameSite=Lax：顶级 GET 跳转才会带上它，否则 app.bupt 回来时丢了
  assert.match(frontend, /SameSite=Lax/)
  assert.match(frontend, /HttpOnly/)
  assert.match(frontend, /Secure/)

  // state cookie 与 CAS 签发的 state 一致，callback 要靠它验一次
  const state = cookies.find((cookie) => cookie.startsWith('bupt-week-wecom-state='))
  assert.ok(state, '应种下 state cookie')
  assert.match(state, /bupt-week-wecom-state=TST-1/)
  assert.match(state, /SameSite=Lax/)
  assert.match(state, /HttpOnly/)
})

test('wecom/start：Referer 不在白名单时不种前端 cookie（防会话劫持）', async (t) => {
  const { app } = makeApp({ allowedOrigins: ['https://white-sand-grand.github.io'] })
  t.mock.method(globalThis, 'fetch', async () =>
    new Response(null, {
      status: 302,
      headers: {
        Location:
          'https://app.bupt.edu.cn/uc/api/oauth/index?response_type=code&appid=200210806102757400'
          + '&redirect=https%3A%2F%2Fauth.bupt.edu.cn%2Fauthserver%2Flogin%3Fclient_name%3Dmc-wx'
          + '&state=TST-1',
      },
    }),
  )

  // 攻击者页面把受害者引到 start：Referer 是攻击者的域名。
  // 旧实现会把它种进 cookie，登录成功后 sessionId 就被 302 到攻击者域名。
  const response = await app.request('/api/auth/wecom/start', {
    headers: { Referer: 'https://attacker.example/page' },
  })

  const cookies = response.headers.getSetCookie()
  assert.equal(
    cookies.some((cookie) => cookie.startsWith('bupt-week-frontend=')),
    false,
    '非白名单 Referer 绝不能种下前端 cookie',
  )
  // state cookie 与来源无关，照常种——它只绑定流程，不含地址
  assert.ok(cookies.some((cookie) => cookie.startsWith('bupt-week-wecom-state=')))
})

test('wecom/callback：state 对不上时拒绝，且不创建任何会话', async (t) => {
  const { app, store } = makeApp({ frontendUrl: 'https://example.github.io' })
  let upstreamCalled = false
  t.mock.method(globalThis, 'fetch', async () => {
    upstreamCalled = true
    return new Response(null, {
      status: 302,
      headers: { Location: 'https://ucloud.bupt.edu.cn?ticket=ST-x' },
    })
  })

  // 没带 state cookie / 带了但对不上：都视为不是我们发起的流程
  for (const cookieHeader of ['', 'bupt-week-wecom-state=WRONG', 'other=x']) {
    const headers = cookieHeader ? { Cookie: cookieHeader } : {}
    const response = await app.request('/api/auth/wecom/callback?code=C&state=S', { headers })
    assert.equal(response.status, 302)
    assert.match(response.headers.get('location'), /error=wecom-state/)
  }

  assert.equal(upstreamCalled, false, 'state 校验失败就不该去请求 CAS')
  assert.equal(store.size, 0, '绝不能创建会话')
})

test('wecom/callback：处理完（无论成败）清掉 state cookie，一次性使用', async (t) => {
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

  const response = await app.request('/api/auth/wecom/callback?code=C&state=S', {
    headers: { Cookie: 'bupt-week-wecom-state=S' },
  })

  assert.equal(response.status, 302)
  assert.ok(
    response.headers
      .getSetCookie()
      .some((cookie) => cookie.startsWith('bupt-week-wecom-state=;') && cookie.includes('Max-Age=0')),
    '成功后应清掉 state cookie',
  )
})

test('GET /api/auth/wecom/start：CAS 会话按 state 键控暂存（换票据时回放）', async (t) => {
  const { app, store } = makeApp()
  t.mock.method(globalThis, 'fetch', async () => new Response(null, {
    status: 302,
    headers: {
      Location:
        'https://app.bupt.edu.cn/uc/api/oauth/index?response_type=code&appid=200210806102757400'
        + '&state=TST-109420-8UngFvR',
      'set-cookie': 'JSESSIONID=cas-anon-session; Path=/; HttpOnly',
    },
  }))

  await app.request('/api/auth/wecom/start')

  // 实测根因（2026-10-24 真机 wecom-no-ticket）：CAS 的 TST state 绑定在发起
  // clientredirect 的会话上，换会话提交 code 只会拿到登录表单页
  const ctx = await store.get('wecomctx:TST-109420-8UngFvR')
  assert.ok(ctx, '应暂存与 state 绑定的 CAS 会话')
  assert.match(ctx.cookies, /JSESSIONID=cas-anon-session/)
  assert.ok(ctx.expiresAt > Date.now(), '15 分钟内有效')
})

test('GET /api/auth/wecom/callback：换票据带上暂存的 CAS 会话，用后即删', async (t) => {
  const { app, store } = makeApp()
  await store.set('wecomctx:TST-109420-abc', { cookies: 'JSESSIONID=keep-me', expiresAt: Date.now() + 900_000 })

  let seenCookie = ''
  t.mock.method(globalThis, 'fetch', async (url, options = {}) => {
    const target = String(url)
    if (target.includes('client_name=mc-wx') && target.includes('code=')) {
      seenCookie = typeof options.headers?.get === 'function' ? options.headers.get('Cookie') : (options.headers?.Cookie || '')
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
    headers: {
      Cookie:
        'bupt-week-frontend=' + encodeURIComponent('http://127.0.0.1:5173')
        + '; bupt-week-wecom-state=TST-109420-abc',
    },
  })

  assert.equal(response.status, 302)
  assert.match(response.headers.get('location'), /wecom=ok/)
  assert.match(seenCookie, /JSESSIONID=keep-me/, '换票据必须带上 start 时的 CAS 会话')
  assert.equal(await store.get('wecomctx:TST-109420-abc'), undefined, '上下文一次性使用')
})
