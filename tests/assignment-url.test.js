import { test } from 'node:test'
import assert from 'node:assert/strict'
import { buildAssignmentEntryUrl, buildAssignmentUrl } from '../src/utils/assignment-url.js'

/**
 * 交作业深链的组装规则。链接形态由 2026-10-24 的实测结论决定：
 * CAS 桌面皮肤从浏览器发起稳定 400（白屏），深链必须经 dev=1 入口绕开。
 */

test('buildAssignmentUrl：最小深链带 assignmentId，不带凭证', () => {
  const url = buildAssignmentUrl('hw-1')
  assert.equal(
    url,
    'https://ucloud.bupt.edu.cn/uclass/course.html#/student/assignmentDetails_fullpage?activeTabName=first&assignmentId=hw-1',
  )
  assert.equal(url.includes('refresh_token'), false, '长效凭证不进 URL')
})

test('buildAssignmentEntryUrl：经 CAS dev=1 入口，深链整体作 service', () => {
  const url = buildAssignmentEntryUrl('hw-1')
  assert.match(url, /^https:\/\/auth\.bupt\.edu\.cn\/authserver\/login\?service=/)
  assert.match(url, /&dev=1$/, '必须带 dev=1 绕开 CAS 皮肤 iframe 的 400 白屏')

  const service = decodeURIComponent(new URL(url).searchParams.get('service'))
  assert.equal(service, buildAssignmentUrl('hw-1'), 'service 就是完整深链（已实测 CAS 前缀匹配放行）')
  assert.equal(url.includes('refresh_token'), false, '长效凭证不进 URL')
})

test('buildAssignmentEntryUrl：作业 ID 里的特殊字符被整体编码', () => {
  const url = buildAssignmentEntryUrl('2113509887497789442')
  // service 是一个完整的编码值，反解回来必须无损
  const service = decodeURIComponent(new URL(url).searchParams.get('service'))
  assert.ok(service.endsWith('assignmentId=2113509887497789442'))
})
