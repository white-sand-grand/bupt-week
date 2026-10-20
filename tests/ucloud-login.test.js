import { test } from 'node:test'
import assert from 'node:assert/strict'
import { loginUcloud, refreshAccessToken, getUserInfo } from '../server/services/ucloud.js'

const CAS_PAGE = `<!DOCTYPE html><html><body><form>
  <input type="hidden" name="execution" value="e1s2e3" />
  <input type="hidden" name="_eventId" value="submit" />
  <input type="hidden" name="type" value="username_password" />
</form></body></html>`

const TOKEN_OK = {
  access_token: 'blade-access-token',
  refresh_token: 'blade-refresh-token',
  expires_in: 7199,
  token_type: 'bearer',
}

function json(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json' } })
}

/** 按顺序吐出响应的假 fetch，并把每次调用记录下来。 */
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

const happyPath = () =>
  scriptedFetch([
    new Response(CAS_PAGE, { headers: { 'set-cookie': 'JSESSIONID=abc; Path=/' } }),
    new Response(null, { status: 302, headers: { Location: 'https://ucloud.bupt.edu.cn?ticket=ST-xyz' } }),
    json(TOKEN_OK),
    json({ code: 200, success: true, data: { id: '2021001234', realName: '张三' } }),
  ])

test('loginUcloud：走完 CAS → ticket → OAuth → 用户信息', async () => {
  const { fetchImpl, calls } = happyPath()
  const result = await loginUcloud({ username: '2021001234', password: 'pw', fetchImpl })

  assert.deepEqual(
    {
      accessToken: result.accessToken,
      refreshToken: result.refreshToken,
      userId: result.userId,
      username: result.username,
      realName: result.realName,
    },
    {
      accessToken: 'blade-access-token',
      refreshToken: 'blade-refresh-token',
      userId: '2021001234',
      username: '2021001234',
      realName: '张三',
    },
  )

  // 四步都发生了，且顺序正确
  assert.equal(calls.length, 4)
  assert.match(calls[0].url, /^https:\/\/auth\.bupt\.edu\.cn\/authserver\/login\?service=/)
  assert.equal(calls[1].options.method, 'POST')
  assert.equal(calls[1].options.redirect, 'manual')
  assert.match(calls[2].url, /apiucloud\.bupt\.edu\.cn\/ykt-basics\/oauth\/token/)
  assert.match(calls[3].url, /apiucloud\.bupt\.edu\.cn\/ykt-basics\/info/)
})

test('loginUcloud：CAS 第一步的 Cookie 被带到第二步', async () => {
  const { fetchImpl, calls } = happyPath()
  await loginUcloud({ username: 'u', password: 'p', fetchImpl })
  assert.equal(calls[1].options.headers.Cookie, 'JSESSIONID=abc')
})

test('loginUcloud：CAS 表单带上实时取到的 execution', async () => {
  const { fetchImpl, calls } = happyPath()
  await loginUcloud({ username: 'u', password: 'p', fetchImpl })

  const body = new URLSearchParams(calls[1].options.body)
  assert.equal(body.get('execution'), 'e1s2e3')
  assert.equal(body.get('username'), 'u')
  assert.equal(body.get('password'), 'p')
  assert.equal(body.get('_eventId'), 'submit')
  assert.equal(body.get('submit'), 'LOGIN')
})

test('loginUcloud：ticket 用 grant_type=third 换', async () => {
  const { fetchImpl, calls } = happyPath()
  await loginUcloud({ username: 'u', password: 'p', fetchImpl })

  const body = new URLSearchParams(calls[2].options.body)
  assert.equal(body.get('grant_type'), 'third')
  assert.equal(body.get('ticket'), 'ST-xyz')
  assert.equal(calls[2].options.headers.Authorization, 'Basic cG9ydGFsOnBvcnRhbF9zZWNyZXQ=')
  assert.equal(calls[2].options.headers['Tenant-Id'], '000000')
})

test('loginUcloud：业务接口带的是 Blade-Auth，不是 OAuth 那个 client 头', async () => {
  const { fetchImpl, calls } = happyPath()
  await loginUcloud({ username: 'u', password: 'p', fetchImpl })

  assert.equal(calls[3].options.headers['Blade-Auth'], 'blade-access-token')
  assert.equal(calls[3].options.headers.Authorization, 'Basic c3dvcmQ6c3dvcmRfc2VjcmV0')
})

test('loginUcloud：学号或密码为空时报 400，不发任何请求', async () => {
  const { fetchImpl, calls } = scriptedFetch([])
  for (const payload of [
    { username: '', password: 'p' },
    { username: 'u', password: '' },
    { username: undefined, password: 'p' },
  ]) {
    await assert.rejects(() => loginUcloud({ ...payload, fetchImpl }), (error) => error.status === 400)
  }
  assert.equal(calls.length, 0)
})

test('loginUcloud：CAS 没返回 ticket 时报 401 且 stage 是 cas-login', async () => {
  const { fetchImpl } = scriptedFetch([
    new Response(CAS_PAGE, { headers: { 'set-cookie': 'JSESSIONID=abc' } }),
    new Response('<html><body><p>用户名或密码错误</p></body></html>', { status: 200 }),
  ])

  await assert.rejects(
    () => loginUcloud({ username: 'u', password: 'bad', fetchImpl }),
    (error) => {
      assert.equal(error.status, 401)
      assert.equal(error.stage, 'cas-login')
      assert.match(error.message, /用户名或密码错误/)
      return true
    },
  )
})

test('loginUcloud：CAS 登录页读不出 execution 时报 cas-get', async () => {
  const { fetchImpl } = scriptedFetch([new Response('<html>改版了</html>')])
  await assert.rejects(
    () => loginUcloud({ username: 'u', password: 'p', fetchImpl }),
    (error) => error.status === 502 && error.stage === 'cas-get',
  )
})

test('loginUcloud：ticket 换 token 失败时报 oauth-token', async () => {
  const { fetchImpl } = scriptedFetch([
    new Response(CAS_PAGE, { headers: { 'set-cookie': 'x=1' } }),
    new Response(null, { status: 302, headers: { Location: 'https://ucloud.bupt.edu.cn?ticket=ST-x' } }),
    json({ error_description: 'ticket 已用过' }, 400),
  ])
  await assert.rejects(
    () => loginUcloud({ username: 'u', password: 'p', fetchImpl }),
    (error) => {
      assert.equal(error.stage, 'oauth-token')
      assert.match(error.message, /ticket 已用过/)
      return true
    },
  )
})

test('loginUcloud：用户信息里没有 id 时报错（后续接口都用得到）', async () => {
  const { fetchImpl } = scriptedFetch([
    new Response(CAS_PAGE, { headers: { 'set-cookie': 'x=1' } }),
    new Response(null, { status: 302, headers: { Location: 'https://ucloud.bupt.edu.cn?ticket=ST-x' } }),
    json(TOKEN_OK),
    json({ code: 200, success: true, data: { realName: '没有 id' } }),
  ])
  await assert.rejects(
    () => loginUcloud({ username: 'u', password: 'p', fetchImpl }),
    (error) => error.stage === 'user-info' && /没有 id/.test(error.message),
  )
})

test('loginUcloud：CAS 连不上时报 cas-connect，且文案里带原因', async () => {
  const { fetchImpl } = scriptedFetch([
    Object.assign(new Error('fetch failed'), { cause: { code: 'ETIMEDOUT' } }),
  ])
  await assert.rejects(
    () => loginUcloud({ username: 'u', password: 'p', fetchImpl }),
    (error) => {
      assert.equal(error.status, 502)
      assert.equal(error.stage, 'cas-connect')
      assert.match(error.message, /连不上统一认证服务/)
      assert.match(error.message, /连接超时/)
      return true
    },
  )
})

test('loginUcloud：CAS 连接被拒绝时给出可读原因', async () => {
  const { fetchImpl } = scriptedFetch([
    Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNREFUSED' } }),
  ])
  await assert.rejects(
    () => loginUcloud({ username: 'u', password: 'p', fetchImpl }),
    (error) => error.stage === 'cas-connect' && /连接被拒绝/.test(error.message),
  )
})

test('loginUcloud：CAS POST 阶段网络失败也报 cas-connect', async () => {
  const { fetchImpl } = scriptedFetch([
    new Response(CAS_PAGE, { headers: { 'set-cookie': 'a=1' } }),
    Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } }),
  ])
  await assert.rejects(
    () => loginUcloud({ username: 'u', password: 'p', fetchImpl }),
    (error) => error.stage === 'cas-connect' && /连接被重置/.test(error.message),
  )
})

test('loginUcloud：token 接口连不上时报 oauth-connect', async () => {
  const { fetchImpl } = scriptedFetch([
    new Response(CAS_PAGE, { headers: { 'set-cookie': 'a=1' } }),
    new Response(null, { status: 302, headers: { Location: 'https://ucloud.bupt.edu.cn?ticket=ST-x' } }),
    Object.assign(new Error('fetch failed'), { cause: { code: 'ENOTFOUND' } }),
  ])
  await assert.rejects(
    () => loginUcloud({ username: 'u', password: 'p', fetchImpl }),
    (error) => error.stage === 'oauth-connect' && /域名解析失败/.test(error.message),
  )
})

test('getUserInfo：连不上时报 user-info-connect', async () => {
  const fetchImpl = async () => {
    throw Object.assign(new Error('fetch failed'), { cause: { code: 'ETIMEDOUT' } })
  }
  await assert.rejects(
    () => getUserInfo('token', fetchImpl),
    (error) => error.stage === 'user-info-connect' && /连接超时/.test(error.message),
  )
})

test('describeNetworkError：没有 cause 时也不会只吐一句 fetch failed', async () => {
  const fetchImpl = async () => {
    throw new Error('fetch failed')
  }
  await assert.rejects(
    () => loginUcloud({ username: 'u', password: 'p', fetchImpl }),
    (error) => {
      assert.equal(error.stage, 'cas-connect')
      // 关键是「不会把裸的 fetch failed 当作用户错误」：外面包了上下文和排查提示
      assert.notEqual(error.message, 'fetch failed')
      assert.match(error.message, /连不上统一认证服务/)
      assert.match(error.message, /HTTP_PROXY/)
      return true
    },
  )
})

test('loginUcloud：姓名回退到 name 或 account', async () => {
  for (const [data, expected] of [
    [{ id: '1', realName: '真名' }, '真名'],
    [{ id: '1', name: '备用名' }, '备用名'],
    [{ id: '1', account: 'account 名' }, 'account 名'],
  ]) {
    const { fetchImpl } = scriptedFetch([
      new Response(CAS_PAGE, { headers: { 'set-cookie': 'x=1' } }),
      new Response(null, { status: 302, headers: { Location: 'https://ucloud.bupt.edu.cn?ticket=ST-x' } }),
      json(TOKEN_OK),
      json({ code: 200, success: true, data }),
    ])
    const result = await loginUcloud({ username: 'u', password: 'p', fetchImpl })
    assert.equal(result.realName, expected)
  }
})

test('refreshAccessToken：用 refresh_token 换新的 access_token', async () => {
  const { fetchImpl, calls } = scriptedFetch([json({ ...TOKEN_OK, access_token: 'new-token' })])
  const token = await refreshAccessToken('old-refresh', fetchImpl)

  assert.equal(token.access_token, 'new-token')
  const body = new URLSearchParams(calls[0].options.body)
  assert.equal(body.get('grant_type'), 'refresh_token')
  assert.equal(body.get('refresh_token'), 'old-refresh')
})

test('refreshAccessToken：没有 refresh_token 时直接 401，不发请求', async () => {
  const { fetchImpl, calls } = scriptedFetch([])
  await assert.rejects(
    () => refreshAccessToken('', fetchImpl),
    (error) => error.status === 401 && error.stage === 'oauth-refresh',
  )
  assert.equal(calls.length, 0)
})

test('refreshAccessToken：上游拒绝时统一成 401 + oauth-refresh', async () => {
  const { fetchImpl } = scriptedFetch([json({ error_description: 'refresh 过期' }, 400)])
  await assert.rejects(
    () => refreshAccessToken('old', fetchImpl),
    (error) => {
      assert.equal(error.status, 401)
      assert.equal(error.stage, 'oauth-refresh')
      return true
    },
  )
})

test('getUserInfo：401 时带上 401 状态，供续期逻辑判断', async () => {
  const { fetchImpl } = scriptedFetch([json({ msg: 'token 过期' }, 401)])
  await assert.rejects(
    () => getUserInfo('expired', fetchImpl),
    (error) => error.status === 401 && error.stage === 'user-info',
  )
})

test('loginUcloud：CAS 登录页下发多个 Cookie 时全部带到下一步', async () => {
  const { fetchImpl, calls } = scriptedFetch([
    new Response(CAS_PAGE, {
      headers: [
        ['set-cookie', 'JSESSIONID=abc; Path=/; HttpOnly'],
        ['set-cookie', 'CASPRIVACY=\"ST-xxx\"; Path=/'],
      ],
    }),
    new Response(null, { status: 302, headers: { Location: 'https://ucloud.bupt.edu.cn?ticket=ST-xyz' } }),
    json(TOKEN_OK),
    json({ code: 200, success: true, data: { id: '1', realName: '张三' } }),
  ])

  await loginUcloud({ username: 'u', password: 'p', fetchImpl })

  const cookie = calls[1].options.headers.Cookie
  assert.match(cookie, /JSESSIONID=abc/)
  assert.match(cookie, /CASPRIVACY="ST-xxx"/)
  // 属性（Path/HttpOnly）不能带过去
  assert.equal(cookie.includes('Path='), false)
  assert.equal(cookie.includes('HttpOnly'), false)
})
