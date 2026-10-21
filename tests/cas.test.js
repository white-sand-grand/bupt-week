import { test } from 'node:test'
import assert from 'node:assert/strict'
import { casAuthenticate, casClientRedirect, CAS_CLIENTS } from '../server/services/cas.js'

const CAS_PAGE = '<input type="hidden" name="execution" value="e1s2e3" />'
const OK_PAGE = '<html><head><title>教学评价</title></head><body>已登录</body></html>'

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

// ── CAS 认证 ────────────────────────────────────────────────────────────────

test('casAuthenticate：走完 CAS 并取出 ticket', async () => {
  const { fetchImpl, calls } = scriptedFetch([
    new Response(CAS_PAGE, { headers: { 'set-cookie': 'CASTGC=abc; Path=/' } }),
    new Response(null, { status: 302, headers: { Location: 'https://ucloud.bupt.edu.cn?ticket=ST-xyz' } }),
  ])

  const { cookies, ticket } = await casAuthenticate({
    username: '2021001234',
    password: 'pw',
    service: 'https://ucloud.bupt.edu.cn',
    fetchImpl,
  })

  assert.equal(ticket, 'ST-xyz')
  assert.match(cookies, /CASTGC=abc/)

  // service 被编进登录 URL
  assert.match(calls[0].url, /service=https%3A%2F%2Fucloud\.bupt\.edu\.cn/)
  assert.equal(calls[1].options.redirect, 'manual')
  assert.equal(calls[1].options.headers.Cookie, 'CASTGC=abc')
})

test('casAuthenticate：service 未注册时给出可读原因，而不是网络错误', async () => {
  const { fetchImpl } = scriptedFetch([
    new Response('<title>Application Not Authorized to Use CAS</title>'),
  ])

  await assert.rejects(
    () =>
      casAuthenticate({
        username: 'u',
        password: 'p',
        service: 'http://127.0.0.1:9999/cb',
        fetchImpl,
      }),
    (error) => {
      assert.equal(error.stage, 'cas-get')
      assert.match(error.message, /不识别该服务/)
      assert.match(error.message, /127\.0\.0\.1/)
      return true
    },
  )
})

test('casAuthenticate：缺学号或密码时报 400，不发请求', async () => {
  const { fetchImpl, calls } = scriptedFetch([])
  for (const payload of [{}, { username: 'u' }, { password: 'p' }]) {
    await assert.rejects(
      () => casAuthenticate({ ...payload, service: 'https://x', fetchImpl }),
      (error) => error.status === 400,
    )
  }
  assert.equal(calls.length, 0)
})

test('casAuthenticate：没有 service 时报 500（这是配置错误，不是用户错误）', async () => {
  const { fetchImpl } = scriptedFetch([])
  await assert.rejects(
    () => casAuthenticate({ username: 'u', password: 'p', fetchImpl }),
    (error) => error.status === 500 && /CAS service/.test(error.message),
  )
})

test('casAuthenticate：连不上时报 cas-connect 且提示代理', async () => {
  const { fetchImpl } = scriptedFetch([
    Object.assign(new Error('fetch failed'), { cause: { code: 'ETIMEDOUT' } }),
  ])
  await assert.rejects(
    () => casAuthenticate({ username: 'u', password: 'p', service: 'https://x', fetchImpl }),
    (error) => {
      assert.equal(error.stage, 'cas-connect')
      assert.match(error.message, /连接超时/)
      assert.match(error.message, /HTTP_PROXY/)
      return true
    },
  )
})

test('casAuthenticate：凭证错误时报 cas-login 并带上 CAS 的原文', async () => {
  const { fetchImpl } = scriptedFetch([
    new Response(CAS_PAGE, { headers: { 'set-cookie': 'a=1' } }),
    new Response('<html><body><p>Invalid credentials.</p></body></html>'),
  ])
  await assert.rejects(
    () => casAuthenticate({ username: 'u', password: 'bad', service: 'https://x', fetchImpl }),
    (error) => {
      assert.equal(error.status, 401)
      assert.equal(error.stage, 'cas-login')
      assert.match(error.message, /Invalid credentials\./)
      return true
    },
  )
})

test('casAuthenticate：教务和云邮可以用不同的 service 各取一个 ticket', async () => {
  // 这正是统一登录的基础：两个系统都是注册过的 CAS service
  const ucloud = scriptedFetch([
    new Response(CAS_PAGE, { headers: { 'set-cookie': 'CASTGC=x' } }),
    new Response(null, { status: 302, headers: { Location: 'https://ucloud.bupt.edu.cn?ticket=ST-uc' } }),
  ])
  const jwgl = scriptedFetch([
    new Response(CAS_PAGE, { headers: { 'set-cookie': 'CASTGC=x' } }),
    new Response(null, { status: 302, headers: { Location: 'https://jwgl.bupt.edu.cn/?ticket=ST-jw' } }),
  ])

  const a = await casAuthenticate({
    username: 'u', password: 'p', service: 'https://ucloud.bupt.edu.cn', fetchImpl: ucloud.fetchImpl,
  })
  const b = await casAuthenticate({
    username: 'u', password: 'p', service: 'https://jwgl.bupt.edu.cn/', fetchImpl: jwgl.fetchImpl,
  })

  assert.equal(a.ticket, 'ST-uc')
  assert.equal(b.ticket, 'ST-jw')
  assert.match(jwgl.calls[0].url, /jwgl\.bupt\.edu\.cn/)
})

// ── 企业微信跳转 ────────────────────────────────────────────────────────────

test('casClientRedirect：返回 CAS 给出的第三方跳转和它生成的 state', async () => {
  const { fetchImpl, calls } = scriptedFetch([
    new Response(null, {
      status: 302,
      headers: {
        Location:
          'https://app.bupt.edu.cn/uc/api/oauth/index?response_type=code&appid=200210806102757400'
          + '&redirect=https%3A%2F%2Fauth.bupt.edu.cn%2Fauthserver%2Flogin%3Fclient_name%3Dmc-wx'
          + '&state=TST-109420-8UngFvR',
      },
    }),
  ])

  const { redirectUrl, state } = await casClientRedirect({
    clientName: CAS_CLIENTS.wecom,
    service: 'https://ucloud.bupt.edu.cn',
    fetchImpl,
  })

  assert.equal(state, 'TST-109420-8UngFvR')
  assert.match(redirectUrl, /^https:\/\/app\.bupt\.edu\.cn\/uc\/api\/oauth\/index/)
  assert.match(calls[0].url, /client_name=mc-wx/)
  assert.match(calls[0].url, /service=https%3A%2F%2Fucloud\.bupt\.edu\.cn/)
})

test('casClientRedirect：CAS 没给跳转地址时报错', async () => {
  const { fetchImpl } = scriptedFetch([new Response(null, { status: 200 })])
  await assert.rejects(
    () => casClientRedirect({ clientName: 'mc-wx', service: 'https://x', fetchImpl }),
    (error) => error.stage === 'wecom-start',
  )
})

test('casClientRedirect：连不上时报 wecom-connect', async () => {
  const { fetchImpl } = scriptedFetch([
    Object.assign(new Error('fetch failed'), { cause: { code: 'ECONNRESET' } }),
  ])
  await assert.rejects(
    () => casClientRedirect({ clientName: 'mc-wx', service: 'https://x', fetchImpl }),
    (error) => error.stage === 'wecom-connect' && /连接被重置/.test(error.message),
  )
})
