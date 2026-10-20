import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeInp, loginJwgl, validateJwglSession } from '../server/services/jwgl.js'

const LOGIN_PAGE = '<html><body><form id="Form1"><input name="userAccount" /></form></body></html>'
const OK_PAGE = '<html><head><title>教学评价</title></head><body>已登录</body></html>'

/** headers 传对象或 [name, value] 数组（后者用于同一响应下发多个 Set-Cookie）。 */
function html(body, status = 200, headers = {}) {
  const base = { 'Content-Type': 'text/html' }
  const merged = Array.isArray(headers) ? [...Object.entries(base), ...headers] : { ...base, ...headers }
  return new Response(body, { status, headers: merged })
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

// 第二步同时刷新 JSESSIONID 并新增 route——用来验证同名覆盖、异名追加
const happyPath = () =>
  scriptedFetch([
    html('', 200, { 'set-cookie': 'JSESSIONID=first; Path=/' }),
    html('', 200, [
      ['set-cookie', 'JSESSIONID=second; Path=/'],
      ['set-cookie', 'route=second; Path=/'],
    ]),
    html(OK_PAGE, 200, { 'set-cookie': 'JSESSIONID=third; Path=/' }),
  ])

test('loginJwgl：三步请求的 URL 与顺序正确', async () => {
  const { fetchImpl, calls } = happyPath()
  await loginJwgl({ username: '2021001234', password: 'pw', fetchImpl })

  assert.equal(calls.length, 3)
  assert.equal(calls[0].url, 'https://jwgl.bupt.edu.cn/jsxsd/')
  assert.equal(calls[1].url, 'https://jwgl.bupt.edu.cn/jsxsd/xk/LoginToXk')
  assert.equal(calls[1].options.method, 'POST')
  assert.equal(calls[2].url, 'https://jwgl.bupt.edu.cn/jsxsd/xspj/xspj_find.do')
})

test('loginJwgl：encoded 是 encodeInp(学号) + %%% + encodeInp(密码)，密码字段留空', async () => {
  const { fetchImpl, calls } = happyPath()
  await loginJwgl({ username: '2021001234', password: 'pw', fetchImpl })

  const body = new URLSearchParams(calls[1].options.body)
  assert.equal(body.get('userAccount'), '2021001234')
  assert.equal(body.get('userPassword'), '')
  assert.equal(body.get('encoded'), `${encodeInp('2021001234')}%%%${encodeInp('pw')}`)
})

test('loginJwgl：三步之间按名字合并 Cookie，同名不重复', async () => {
  const { fetchImpl, calls } = happyPath()
  const result = await loginJwgl({ username: 'u', password: 'p', fetchImpl })

  // 第二步带上第一步的 JSESSIONID
  assert.match(calls[1].options.headers.Cookie, /JSESSIONID=first/)
  // 第三步带上合并后的：JSESSIONID 被第二步刷新，route 追加
  assert.match(calls[2].options.headers.Cookie, /JSESSIONID=second/)
  assert.match(calls[2].options.headers.Cookie, /route=second/)
  // 最终会话里 JSESSIONID 是第三步的新值，且只出现一次
  assert.equal((result.cookies.match(/JSESSIONID=/g) || []).length, 1)
  assert.match(result.cookies, /JSESSIONID=third/)
})

test('loginJwgl：请求头带上 Origin 和 Referer', async () => {
  const { fetchImpl, calls } = happyPath()
  await loginJwgl({ username: 'u', password: 'p', fetchImpl })

  assert.equal(calls[1].options.headers.Origin, 'https://jwgl.bupt.edu.cn')
  assert.equal(calls[1].options.headers.Referer, 'https://jwgl.bupt.edu.cn/jsxsd/')
})

test('loginJwgl：成功时返回 username 与合并后的 Cookie', async () => {
  const { fetchImpl } = happyPath()
  const result = await loginJwgl({ username: '2021001234', password: 'pw', fetchImpl })

  assert.equal(result.username, '2021001234')
  assert.ok(result.cookies.includes('JSESSIONID=third'))
})

test('loginJwgl：学号或密码为空时报 400，不发任何请求', async () => {
  const { fetchImpl, calls } = scriptedFetch([])
  for (const payload of [{ username: '', password: 'p' }, { username: 'u', password: '' }]) {
    await assert.rejects(() => loginJwgl({ ...payload, fetchImpl }), (error) => error.status === 400)
  }
  assert.equal(calls.length, 0)
})

test('loginJwgl：验证页返回登录页时报 401，并拼出可读的原因', async () => {
  const { fetchImpl } = scriptedFetch([
    html('', 200, { 'set-cookie': 'a=1' }),
    html('', 200, { 'set-cookie': 'b=2' }),
    html(`<html><title>登录</title><body>${LOGIN_PAGE}<p>密码错误</p></body></html>`),
  ])

  await assert.rejects(
    () => loginJwgl({ username: 'u', password: 'bad', fetchImpl }),
    (error) => {
      assert.equal(error.status, 401)
      assert.equal(error.stage, 'jwgl-login')
      assert.match(error.message, /密码/)
      return true
    },
  )
})

test('loginJwgl：验证页是登录页但没有任何关键词时给兜底文案', async () => {
  const { fetchImpl } = scriptedFetch([
    html('', 200, { 'set-cookie': 'a=1' }),
    html('', 200, { 'set-cookie': 'b=2' }),
    html('<html><title>登录</title><body><form id="userAccount"></form></body></html>'),
  ])

  await assert.rejects(
    () => loginJwgl({ username: 'u', password: 'bad', fetchImpl }),
    (error) => error.status === 401 && /学号或密码有误/.test(error.message),
  )
})

test('loginJwgl：验证页非 200 时报 jwgl-verify', async () => {
  const { fetchImpl } = scriptedFetch([
    html('', 200, { 'set-cookie': 'a=1' }),
    html('', 200, { 'set-cookie': 'b=2' }),
    html('服务端错误', 500),
  ])
  await assert.rejects(
    () => loginJwgl({ username: 'u', password: 'p', fetchImpl }),
    (error) => error.status === 502 && error.stage === 'jwgl-verify',
  )
})

test('loginJwgl：第一步就连不上时报 jwgl-connect', async () => {
  const { fetchImpl } = scriptedFetch([new Error('connect ETIMEDOUT')])
  await assert.rejects(
    () => loginJwgl({ username: 'u', password: 'p', fetchImpl }),
    (error) => error.status === 502 && error.stage === 'jwgl-connect',
  )
})

test('validateJwglSession：有效时返回刷新后的 Cookie', async () => {
  const { fetchImpl } = scriptedFetch([html(OK_PAGE, 200, { 'set-cookie': 'JSESSIONID=fresh; Path=/' })])
  const cookies = await validateJwglSession('JSESSIONID=old', fetchImpl)
  assert.match(cookies, /JSESSIONID=fresh/)
})

test('validateJwglSession：会话失效（返回登录页）时报 401 + jwgl-auth', async () => {
  const { fetchImpl } = scriptedFetch([html(`<html><title>登录</title>${LOGIN_PAGE}</html>`)])
  await assert.rejects(
    () => validateJwglSession('JSESSIONID=old', fetchImpl),
    (error) => error.status === 401 && error.stage === 'jwgl-auth',
  )
})

test('validateJwglSession：没有 Cookie 时报 401，不发请求', async () => {
  const { fetchImpl, calls } = scriptedFetch([])
  await assert.rejects(
    () => validateJwglSession('', fetchImpl),
    (error) => error.status === 401 && error.stage === 'jwgl-auth',
  )
  assert.equal(calls.length, 0)
})
