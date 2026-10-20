import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBackend } from '../server/app.js'

const ALLOWED_ORIGIN = 'https://example.github.io'
const app = createBackend({ allowedOrigins: [ALLOWED_ORIGIN] })

function mockUpstream(t, handler) {
  t.mock.method(globalThis, 'fetch', handler)
}

test('/file 代理：构造目标 URL，透传 Range，剥掉鉴权头', async (t) => {
  let incoming
  mockUpstream(t, async (request) => {
    incoming = request
    return new Response('abc', {
      status: 206,
      headers: { 'Content-Range': 'bytes 0-2/99', 'Content-Length': '3', 'Content-Type': 'video/mp4' },
    })
  })

  const response = await app.request('/file/ucloud/video/test.mp4?name=%E4%B8%AD&signature=a%2Fb', {
    headers: {
      Range: 'bytes=0-2',
      Authorization: 'secret',
      'Blade-Auth': 'token',
      'Tenant-Id': '000000',
      Host: 'localhost:5173',
    },
  })

  assert.equal(incoming.url, 'https://fileucloud.bupt.edu.cn/ucloud/video/test.mp4?name=%E4%B8%AD&signature=a%2Fb')
  assert.equal(incoming.headers.get('Range'), 'bytes=0-2')
  assert.equal(incoming.headers.get('Origin'), 'https://ucloud.bupt.edu.cn')
  assert.equal(incoming.headers.get('Referer'), 'https://ucloud.bupt.edu.cn/')

  for (const header of ['Authorization', 'Blade-Auth', 'Tenant-Id', 'Host']) {
    assert.equal(incoming.headers.has(header), false, `${header} 应被剥掉`)
  }

  assert.equal(response.status, 206)
  assert.equal(response.headers.get('Content-Range'), 'bytes 0-2/99')
  assert.equal(response.headers.get('Content-Type'), 'video/mp4')
  assert.equal(await response.text(), 'abc')
})

test('/file 代理：剥掉上游 CORS 头，补上本后端自己的', async (t) => {
  mockUpstream(t, async () =>
    new Response('ok', {
      headers: {
        'Access-Control-Allow-Origin': 'https://ucloud.bupt.edu.cn',
        'Access-Control-Expose-Headers': 'Date, Etag',
      },
    }),
  )

  const response = await app.request('/file/x.pdf', { headers: { Origin: ALLOWED_ORIGIN } })

  assert.equal(response.headers.get('access-control-allow-origin'), ALLOWED_ORIGIN)
  assert.equal(response.headers.get('access-control-expose-headers'), null)
})

test('/file 代理：来源不在白名单时不放行，但仍能透传文件', async (t) => {
  mockUpstream(t, async () => new Response('ok'))

  const response = await app.request('/file/x.pdf', { headers: { Origin: 'https://evil.example.com' } })

  assert.equal(response.status, 200)
  assert.equal(response.headers.get('access-control-allow-origin'), null)
  assert.equal(await response.text(), 'ok')
})

test('/file 代理：直接返回流，不等完整文件下载', async (t) => {
  let source
  mockUpstream(t, async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          source = controller
        },
      }),
    ),
  )

  const response = await app.request('/file/large.zip')

  // 上游流还没 close。如果能拿到 reader，说明没有被缓冲。
  const reader = response.body.getReader()
  source.enqueue(new TextEncoder().encode('chunk'))
  source.close()

  const { value } = await reader.read()
  assert.equal(new TextDecoder().decode(value), 'chunk')
})

test('/file 代理：不能借助路径把请求送到别的域名', async (t) => {
  const received = []
  mockUpstream(t, async (request) => {
    received.push(request.url)
    return new Response('ok')
  })

  // 前两条能进入 handler；后两条会被 URL 规范化掉（`..` 被折叠），
  // 根本到不了代理，直接 404。两层都得挡住。
  const reachable = ['/file//other.example/secret', '/file/https://evil.example/x']
  const normalized = ['/file/../../escape', '/file/ucloud/../../etc/passwd']

  for (const path of reachable) {
    const response = await app.request(path)
    assert.equal(response.status, 200, `${path} 应被代理`)
  }
  for (const path of normalized) {
    const response = await app.request(path)
    assert.equal(response.status, 404, `${path} 应在路由层就被挡掉`)
  }

  assert.equal(received.length, reachable.length, `应只发出 ${reachable.length} 个请求，实际 ${received.length}`)
  for (const url of received) {
    assert.equal(new URL(url).origin, 'https://fileucloud.bupt.edu.cn', url)
  }
})

test('/file 代理：上游不可达时返回 502 且带可读信息', async (t) => {
  mockUpstream(t, async () => {
    throw Object.assign(new Error('connect ECONNREFUSED'), { cause: { code: 'ECONNREFUSED' } })
  })

  const response = await app.request('/file/x.pdf')
  assert.equal(response.status, 502)
  const body = await response.json()
  assert.match(body.msg, /无法连接上游服务 fileucloud\.bupt\.edu\.cn/)
})

test('/file 代理：只接受 GET', async () => {
  const response = await app.request('/file/x.pdf', { method: 'POST', body: 'x' })
  assert.equal(response.status, 404)
})
