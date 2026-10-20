import { test } from 'node:test'
import assert from 'node:assert/strict'
import { toFileProxyPath, resolveResourceDownload } from '../server/services/resources.js'

const FILE_DIRECT = 'https://fileucloud.bupt.edu.cn/ucloud/document/abc-123.pdf?response-content-disposition=attachment'

function jsonResponse(body, status = 200) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

test('toFileProxyPath：改写 fileucloud 直链', () => {
  assert.equal(toFileProxyPath(FILE_DIRECT), '/file/ucloud/document/abc-123.pdf?response-content-disposition=attachment')
})

test('toFileProxyPath：已是 /file 路径则原样返回', () => {
  assert.equal(toFileProxyPath('/file/ucloud/document/a.pdf'), '/file/ucloud/document/a.pdf')
})

test('toFileProxyPath：拒绝其他域名，避免代理被当成开放转发', () => {
  for (const url of [
    'https://evil.example.com/x.pdf',
    'http://fileucloud.bupt.edu.cn.evil.example/x.pdf',
    'https://apiucloud.bupt.edu.cn/x.pdf',
    'not-a-url',
    '',
    null,
    undefined,
  ]) {
    assert.equal(toFileProxyPath(url), '', `应拒绝 ${url}`)
  }
})

test('resolveResourceDownload：走 preview-url 并返回 /file 路径', async (t) => {
  const calls = []
  const fetchImpl = async (url, options) => {
    calls.push({ url, options })
    return jsonResponse({ code: 200, success: true, data: { previewUrl: FILE_DIRECT } })
  }

  const fileUrl = await resolveResourceDownload({ token: 'blade-token', resourceId: 'res-1', fetchImpl })

  assert.equal(fileUrl, '/file/ucloud/document/abc-123.pdf?response-content-disposition=attachment')
  assert.equal(calls.length, 1)
  assert.match(calls[0].url, /^https:\/\/apiucloud\.bupt\.edu\.cn\/blade-source\/resource\/preview-url\?resourceId=res-1$/)
  assert.equal(calls[0].options.headers['Blade-Auth'], 'blade-token')
  assert.equal(calls[0].options.headers.Authorization, 'Basic c3dvcmQ6c3dvcmRfc2VjcmV0')
  assert.equal(calls[0].options.headers['Tenant-Id'], '000000')
})

test('resolveResourceDownload：没有 token 时先要登录', async () => {
  await assert.rejects(
    () => resolveResourceDownload({ token: '', resourceId: 'res-1' }),
    (error) => error.status === 401 && error.stage === 'ucloud-auth',
  )
})

test('resolveResourceDownload：缺少 resourceId 时报参数错', async () => {
  await assert.rejects(
    () => resolveResourceDownload({ token: 'blade-token', resourceId: '' }),
    (error) => error.status === 400,
  )
})

test('resolveResourceDownload：上游 success=false 时透出 msg', async (t) => {
  const fetchImpl = async () => jsonResponse({ code: 500, success: false, msg: '资源不存在' })
  await assert.rejects(
    () => resolveResourceDownload({ token: 't', resourceId: 'r', fetchImpl }),
    (error) => error.status === 502 && /资源不存在/.test(error.message),
  )
})

test('resolveResourceDownload：上游返回非 200 时透出状态码', async () => {
  const fetchImpl = async () => jsonResponse({ msg: 'boom' }, 503)
  await assert.rejects(
    () => resolveResourceDownload({ token: 't', resourceId: 'r', fetchImpl }),
    (error) => error.status === 502 && /503/.test(error.message),
  )
})

test('resolveResourceDownload：上游地址不在文件存储域名上时报错', async () => {
  const fetchImpl = async () => jsonResponse({ code: 200, data: { previewUrl: 'https://evil.example.com/x' } })
  await assert.rejects(
    () => resolveResourceDownload({ token: 't', resourceId: 'r', fetchImpl }),
    (error) => error.status === 502 && /文件存储域名/.test(error.message),
  )
})

test('resolveResourceDownload：网络异常时报连接错', async () => {
  const fetchImpl = async () => {
    throw new Error('network down')
  }
  await assert.rejects(
    () => resolveResourceDownload({ token: 't', resourceId: 'r', fetchImpl }),
    (error) => error.status === 502 && /无法连接上游服务/.test(error.message),
  )
})

test('resolveResourceDownload：上游返回的不是 JSON 时报错', async () => {
  const fetchImpl = async () => new Response('<html>gateway</html>', { status: 200 })
  await assert.rejects(
    () => resolveResourceDownload({ token: 't', resourceId: 'r', fetchImpl }),
    (error) => error.status === 502,
  )
})
