import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildAssignmentUrl } from '../src/utils/assignment-url.js'

/**
 * 交作业深链的组装规则（2026-10-24 晚定稿：裸深链）。
 * CAS dev=1 入口方案已证伪（带 CAS cookie 的浏览器稳定 400），
 * 证据链见 docs/api-reference.md §3.2.1。
 */

test('buildAssignmentUrl：最小深链带 assignmentId，不带凭证、不经 CAS', () => {
  const url = buildAssignmentUrl('hw-1')
  assert.equal(
    url,
    'https://ucloud.bupt.edu.cn/uclass/course.html#/student/assignmentDetails_fullpage?activeTabName=first&assignmentId=hw-1',
  )
  assert.equal(url.includes('refresh_token'), false, '长效凭证不进 URL')
  assert.equal(url.includes('auth.bupt.edu.cn'), false, '不经 CAS 中转（其桌面登录页服务端故障）')
  assert.equal(url.includes('dev=1'), false, 'dev=1 已证伪：带 CAS cookie 的浏览器稳定 400')
})

test('buildAssignmentUrl：作业 ID 被编码', () => {
  const url = buildAssignmentUrl('2113509887497789442')
  assert.ok(url.endsWith('assignmentId=2113509887497789442'))
})
