import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createBackend } from '../server/app.js'
import { MemorySessionStore } from '../server/storage/memory.js'
import { hashPassword, newSalt, verifyPassword } from '../server/services/password-hash.js'

/**
 * 班级功能：创建（班级号+密码）、凭密码加入、手动录入作业共享。
 * 存储契约：所有值必须带 expiresAt（存储层按它判活），测试里同样如此。
 */

function makeApp() {
  const sessionStore = new MemorySessionStore()
  const classStore = new MemorySessionStore()
  const app = createBackend({
    getSessionStore: () => sessionStore,
    getClassStore: () => classStore,
    allowedOrigins: [],
  })

  /** 建班（自动种子创建者会话），返回 { classId, code }。 */
  const seedClass = async ({ name = '软件 2301 班', password = 'class-pw', sessionId = 'uc', username = '2021001234' } = {}) => {
    await seedUcloud(sessionStore, sessionId, username)
    const response = await post(app, '/api/classes/create', { sessionId, name, password })
    const body = await response.json()
    assert.equal(body.success, true, `建班应成功：${JSON.stringify(body)}`)
    return body.data
  }

  return { app, sessionStore, classStore, seedClass }
}

function post(app, path, body) {
  return app.request(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
}

async function seedUcloud(sessionStore, id = 'uc', username = '2021001234') {
  await sessionStore.set(id, {
    kind: 'ucloud', accessToken: 'tk', userId: '1', username,
    expiresAt: Date.now() + 86400000,
  })
  return id
}

/** 建班助手在 makeApp 返回值里（自动种子创建者会话）。 */

// ── 密码哈希 ────────────────────────────────────────────────────────────────

test('password-hash：同盐同密码可验证，错密码/异盐不可', async () => {
  const salt = await newSalt()
  const hash = await hashPassword('class-pw', salt)

  assert.equal(await verifyPassword('class-pw', salt, hash), true)
  assert.equal(await verifyPassword('wrong-pw', salt, hash), false)
  assert.equal(await verifyPassword('class-pw', await newSalt(), hash), false, '换盐必须验证失败')
  assert.match(hash, /^[0-9a-f]{64}$/, '256 位 → 64 hex')
  assert.equal(hash.includes('class-pw'), false)
})

// ── 创建 / 加入 ──────────────────────────────────────────────────────────────

test('create：返回班级号（8 位无歧义字符表），密码不落明文', async () => {
  const { app, classStore, sessionStore, seedClass } = makeApp()
  await seedUcloud(sessionStore)
  const data = await seedClass()

  assert.match(data.code, /^[2-9A-HJ-NP-Z]{8}$/, '班级号 8 位且不含 0/O/1/I/L')
  assert.equal(data.name, '软件 2301 班')

  const stored = JSON.stringify(await classStore.get(`class:${data.classId}`))
  assert.equal(stored.includes('class-pw'), false, '密码明文绝不能进存储')
  assert.ok(stored.includes('"passHash"') && stored.includes('"salt"'))
})

test('create：缺名称/密码太短报 400；未登录报 401', async () => {
  const { app, sessionStore, seedClass } = makeApp()
  await seedUcloud(sessionStore)

  assert.equal((await post(app, '/api/classes/create', { sessionId: 'uc', name: '', password: 'abcd' })).status, 400)
  assert.equal((await post(app, '/api/classes/create', { sessionId: 'uc', name: '班级', password: 'abc' })).status, 400)
  assert.equal((await post(app, '/api/classes/create', { sessionId: 'nope', name: '班级', password: 'abcd' })).status, 401)
})

test('join：正确密码入班成为成员；错误密码 401 且不进成员', async () => {
  const { app, sessionStore, classStore, seedClass } = makeApp()
  const created = await seedClass()
  const joiner = await seedUcloud(sessionStore, 'uc2', '2021567890')

  const bad = await post(app, '/api/classes/join', { sessionId: 'uc2', code: created.code, password: 'nope' })
  assert.equal(bad.status, 401)
  const badBody = await bad.json()
  assert.equal(badBody.stage, 'class-password')

  const ok = await post(app, '/api/classes/join', { sessionId: 'uc2', code: created.code, password: 'class-pw' })
  const okBody = await ok.json()
  assert.equal(okBody.success, true)
  assert.equal(okBody.data.classId, created.classId)

  const members = (await classStore.get(`class:${created.classId}:members`)).members
  assert.deepEqual(members, ['2021001234', '2021567890'])

  // 重复加入不产生重复成员
  await post(app, '/api/classes/join', { sessionId: 'uc2', code: created.code, password: 'class-pw' })
  assert.equal((await classStore.get(`class:${created.classId}:members`)).members.length, 2)
})

test('join：小写班级号自动归一；不存在的班级号报 404', async () => {
  const { app, sessionStore, seedClass } = makeApp()
  const created = await seedClass()
  await seedUcloud(sessionStore, 'uc2', '2021567890')

  const lowered = await post(app, '/api/classes/join', { sessionId: 'uc2', code: created.code.toLowerCase(), password: 'class-pw' })
  assert.equal((await lowered.json()).success, true)

  const missing = await post(app, '/api/classes/join', { sessionId: 'uc2', code: '23456789', password: 'x' })
  assert.equal(missing.status, 404)
})

test('list：只返回我的班级，且不带密码哈希/盐', async () => {
  const { app, sessionStore, seedClass } = makeApp()
  const a = await seedClass({ name: '班级 A' })
  await seedClass({ name: '班级 B' })
  await seedUcloud(sessionStore, 'uc2', '2021567890')
  await post(app, '/api/classes/join', { sessionId: 'uc2', code: a.code, password: 'class-pw' })

  const mine = await (await post(app, '/api/classes/list', { sessionId: 'uc2' })).json()
  assert.equal(mine.data.classes.length, 1)
  assert.equal(mine.data.classes[0].name, '班级 A')
  assert.equal(mine.data.classes[0].memberCount, 2)
  assert.equal(mine.data.classes[0].code, a.code)
  assert.equal(JSON.stringify(mine.data).includes('passHash'), false, '列表绝不带出哈希')
})

// ── 作业 ────────────────────────────────────────────────────────────────────

test('assignment/add + assignments：录入后以云邮作业同形 record 返回', async () => {
  const { app, sessionStore, seedClass } = makeApp()
  const created = await seedClass()
  const joiner = await seedUcloud(sessionStore, 'uc2', '2021567890')
  await post(app, '/api/classes/join', { sessionId: joiner, code: created.code, password: 'class-pw' })

  const added = await post(app, '/api/classes/assignment/add', {
    sessionId: joiner,
    classId: created.classId,
    title: '第三章习题',
    subject: '高等数学',
    content: '完成教材 P55 1-10 题，拍照上传到班级群。',
    deadline: '2026-11-01T23:59',
  })
  assert.equal((await added.json()).success, true)

  const list = await (await post(app, '/api/classes/assignments', { sessionId: joiner, classId: created.classId })).json()
  const record = list.data.assignments[0]
  assert.equal(record.assignmentTitle, '第三章习题')
  assert.equal(record.chapterName, '高等数学', '科目在 chapterName')
  assert.equal(record.siteName, '软件 2301 班', '班级名是分组标题')
  assert.equal(record.assignmentEndTime, '2026-11-01 23:59', 'datetime-local 的 T 归一为空格')
  assert.equal(record.assignmentStatus, 99, '未提交语义')
  assert.equal(record.content, '完成教材 P55 1-10 题，拍照上传到班级群。')
  assert.ok(record.siteId.startsWith('class:'))
})

test('assignment/add：标题/科目/内容必填，截止可选；非成员 403', async () => {
  const { app, sessionStore, seedClass } = makeApp()
  const created = await seedClass()
  const outsider = await seedUcloud(sessionStore, 'uc2', '2021567890')

  const base = { sessionId: outsider, classId: created.classId }
  assert.equal((await post(app, '/api/classes/assignments', base)).status, 403, '非成员看不了班级作业')
  assert.equal((await post(app, '/api/classes/assignment/add', { ...base, title: 't', subject: 's', content: 'c' })).status, 403)

  await seedUcloud(sessionStore, 'uc', '2021001234') // 创建者
  const author = { sessionId: 'uc', classId: created.classId }
  const missing = [
    { subject: 's', content: 'c' },      // 缺标题
    { title: 't', content: 'c' },        // 缺科目
    { title: 't', subject: 's' },        // 缺内容
    { title: '', subject: 's', content: 'c' },
    { title: 't', subject: 's', content: 'c', deadline: 'not-a-date' },
  ]
  for (const body of missing) {
    assert.equal((await post(app, '/api/classes/assignment/add', { ...author, ...body })).status, 400, JSON.stringify(body))
  }
  const noDeadline = await post(app, '/api/classes/assignment/add', { ...author, title: 't', subject: 's', content: 'c' })
  assert.equal((await noDeadline.json()).success, true, '截止时间可选')
})

test('assignment/delete：录入者可删自己的；班级创建者可删任何；其他人 403', async () => {
  const { app, sessionStore, seedClass } = makeApp()
  const created = await seedClass({ sessionId: 'uc' })
  await seedUcloud(sessionStore, 'uc', '2021001234') // 班级创建者
  await seedUcloud(sessionStore, 'uc2', '2021567890')
  await seedUcloud(sessionStore, 'uc3', '2021999888')
  await post(app, '/api/classes/join', { sessionId: 'uc2', code: created.code, password: 'class-pw' })
  await post(app, '/api/classes/join', { sessionId: 'uc3', code: created.code, password: 'class-pw' })

  const added = await post(app, '/api/classes/assignment/add', {
    sessionId: 'uc2', classId: created.classId, title: 't', subject: 's', content: 'c',
  })
  const { assignmentId } = (await added.json()).data

  // 第三人（非录入者非班级创建者）不能删
  const forbidden = await post(app, '/api/classes/assignment/delete', { sessionId: 'uc3', classId: created.classId, assignmentId })
  assert.equal(forbidden.status, 403)

  // 录入者可以删自己的
  const ok = await post(app, '/api/classes/assignment/delete', { sessionId: 'uc2', classId: created.classId, assignmentId })
  assert.equal((await ok.json()).success, true)

  // 再录一条，班级创建者可以删别人的
  const second = await post(app, '/api/classes/assignment/add', {
    sessionId: 'uc2', classId: created.classId, title: 't2', subject: 's', content: 'c',
  })
  const secondId = (await second.json()).data.assignmentId
  const byCreator = await post(app, '/api/classes/assignment/delete', { sessionId: 'uc', classId: created.classId, assignmentId: secondId })
  assert.equal((await byCreator.json()).success, true, '班级创建者可删任何作业')

  const list = await (await post(app, '/api/classes/assignments', { sessionId: 'uc', classId: created.classId })).json()
  assert.equal(list.data.assignments.length, 0)
})

test('assignment/delete：不存在的作业报 404；存量的值都带 expiresAt（存储契约）', async () => {
  const { app, sessionStore, classStore, seedClass } = makeApp()
  const created = await seedClass()
  await seedUcloud(sessionStore, 'uc', '2021001234')

  const missing = await post(app, '/api/classes/assignment/delete', { sessionId: 'uc', classId: created.classId, assignmentId: 'ghost' })
  assert.equal(missing.status, 404)

  for (const key of Object.keys(classStore.map)) {
    const value = classStore.map.get(key)
    assert.ok(Number.isFinite(value.expiresAt) && value.expiresAt > Date.now(), `键 ${key} 必须带有效 expiresAt`)
  }
})

test('privacy：create/join/作业响应里绝不出现班级密码明文', async () => {
  const { app, seedClass } = makeApp()
  const created = await seedClass({ password: 'super-secret-pw' })

  for (const path of ['/api/classes/list', '/api/classes/assignments']) {
    const response = await post(app, path, { sessionId: 'uc', classId: created.classId })
    const text = await response.text()
    assert.equal(text.includes('super-secret-pw'), false, `${path} 泄露了班级密码`)
  }
})

// ── 多班与解散 ───────────────────────────────────────────────────────────────

test('join：加入一个班后还能继续加入别的班（用户索引累积）', async () => {
  const { app, sessionStore, classStore, seedClass } = makeApp()
  const a = await seedClass({ name: '班级 A' })
  const b = await seedClass({ name: '班级 B' })
  const joiner = await seedUcloud(sessionStore, 'uc2', '2021567890')

  await post(app, '/api/classes/join', { sessionId: joiner, code: a.code, password: 'class-pw' })
  await post(app, '/api/classes/join', { sessionId: joiner, code: b.code, password: 'class-pw' })

  const mine = (await classStore.get('user:2021567890:classes')).ids
  assert.equal(mine.length, 2, '两个班都应在「我的班级」里')
  const list = await (await post(app, '/api/classes/list', { sessionId: joiner })).json()
  assert.equal(list.data.classes.length, 2)
})

test('dissolve：创建者解散班级——所有键清理、成员索引剪除；非创建者 403', async () => {
  const { app, sessionStore, classStore, seedClass } = makeApp()
  const created = await seedClass()
  await seedUcloud(sessionStore, 'uc2', '2021567890')
  await post(app, '/api/classes/join', { sessionId: 'uc2', code: created.code, password: 'class-pw' })
  await post(app, '/api/classes/assignment/add', {
    sessionId: 'uc', classId: created.classId, title: 't', subject: 's', content: 'c',
  })

  const forbidden = await post(app, '/api/classes/dissolve', { sessionId: 'uc2', classId: created.classId })
  assert.equal(forbidden.status, 403, '成员不能解散班级')

  const ok = await post(app, '/api/classes/dissolve', { sessionId: 'uc', classId: created.classId })
  assert.equal((await ok.json()).success, true)

  for (const key of [
    `class:${created.classId}`,
    `class:${created.classId}:members`,
    `class:${created.classId}:assigns`,
    `code:${created.code}`,
  ]) {
    assert.equal(await classStore.get(key), undefined, `${key} 应被删除`)
  }
  const creatorIndex = await classStore.get('user:2021001234:classes')
  assert.equal(creatorIndex, undefined, '创建者索引清空后删除')
  const memberIndex = await classStore.get('user:2021567890:classes')
  assert.deepEqual(memberIndex?.ids ?? [], [], '成员索引应剪除')

  // 解散后班级号可以复用（code 索引已删）：同班号能再建
  const recreated = await seedClass({ name: '重建的班' })
  assert.ok(recreated.code, '解散后可正常再建班')
})
