import { test } from 'node:test'
import assert from 'node:assert/strict'
import { listCoursewareTree } from '../server/services/courseware.js'

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'Content-Type': 'application/json' },
  })
}

const TREE = [
  {
    id: 'node-1',
    resourceName: '第一章',
    children: [],
    attachmentVOs: [
      { type: '1', resource: { id: 'res-1', name: '讲义.pdf', ext: 'pdf', fileSizeUnit: '2.5MB' } },
    ],
  },
]

test('listCoursewareTree：POST tree/student 并透传树数组', async (t) => {
  let called = null
  const fetchImpl = async (url, options) => {
    called = { url, options }
    return jsonResponse({ code: 200, success: true, data: TREE })
  }

  const tree = await listCoursewareTree({ token: 't', siteId: 'site-1', userId: 'u-1', fetchImpl })

  assert.deepEqual(tree, TREE)
  assert.match(called.url, /\/ykt-site\/site-resource\/tree\/student\?siteId=site-1&userId=u-1$/)
  assert.equal(called.options.method, 'POST')
  assert.equal(called.options.body, '{}')
  assert.equal(called.options.headers['Blade-Auth'], 't')
})

test('listCoursewareTree：data 为空（这门课没传过资料）是正常态，返回 []', async () => {
  const fetchImpl = async () => jsonResponse({ code: 200, success: true, data: null })
  assert.deepEqual(await listCoursewareTree({ token: 't', siteId: 's', userId: 'u', fetchImpl }), [])
})

test('listCoursewareTree：上游 401 报会话过期（stage=ucloud-auth）', async () => {
  const fetchImpl = async () => jsonResponse({ code: 401, success: false, msg: 'Unauthorized' }, 401)
  await assert.rejects(
    () => listCoursewareTree({ token: 't', siteId: 's', userId: 'u', fetchImpl }),
    (error) => error.status === 401 && error.stage === 'ucloud-auth',
  )
})

test('listCoursewareTree：上游业务失败透出 msg', async () => {
  const fetchImpl = async () => jsonResponse({ code: 500, success: false, msg: '站点不存在' })
  await assert.rejects(
    () => listCoursewareTree({ token: 't', siteId: 's', userId: 'u', fetchImpl }),
    (error) => error.status === 502 && /站点不存在/.test(error.message),
  )
})

test('listCoursewareTree：网络异常报连接错', async () => {
  const fetchImpl = async () => {
    throw new TypeError('fetch failed')
  }
  await assert.rejects(
    () => listCoursewareTree({ token: 't', siteId: 's', userId: 'u', fetchImpl }),
    (error) => error.status === 502 && /无法连接云邮服务/.test(error.message),
  )
})

test('listCoursewareTree：没 token 先要登录，缺参数报 400', async () => {
  await assert.rejects(
    () => listCoursewareTree({ token: '', siteId: 's', userId: 'u' }),
    (error) => error.status === 401,
  )
  await assert.rejects(
    () => listCoursewareTree({ token: 't', siteId: '', userId: 'u' }),
    (error) => error.status === 400,
  )
})
