import { test } from 'node:test'
import assert from 'node:assert/strict'
import { encodeInp } from '../server/services/jwgl.js'

const KEY = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/='

/**
 * encodeInp 从 MYUCLOUD 的 Python 版 auto_evalued 原样移植（diff 过，逐字一致）。
 *
 * 实测结论：它就是一个手写的**标准 base64**——65 个字符的 key 只是为了把下标 64
 * 映射到 '='，省掉单独写 padding 常量。位运算和标准算法完全一致。
 *
 * 它和 Buffer.toString('base64') 的唯一差别是输入解释：这里按 UTF-16 code unit
 * 逐字节走，Buffer 按 UTF-8。所以对 ASCII（学号、密码）两者相同，对非拉丁字符
 * 才会分叉——而 code unit > 255 时 enc1 会超出 63，KEY[enc1] 是 undefined。
 * 教务处要的就是这个行为，别去"修"它。
 *
 * 下面这些断言的真实用途是抓转录错误：位运算抄错一位，立刻和标准 base64 分叉。
 */
test('encodeInp：ASCII 输入与标准 base64 完全一致', () => {
  for (const value of ['a', 'ab', 'abc', 'abcd', 'hello world', '20210001', '2021001234', 'p@ss w0rd!#']) {
    assert.equal(encodeInp(value), Buffer.from(value).toString('base64'), `不一致：${value}`)
  }
})

test('encodeInp：长度是 4*ceil(n/3)', () => {
  for (const value of ['', 'a', 'ab', 'abc', 'abcd', '20210001', '12345678901234567890']) {
    assert.equal(encodeInp(value).length, 4 * Math.ceil(value.length / 3), `长度不对：${value}`)
  }
})

test('encodeInp：空串得到空串', () => {
  assert.equal(encodeInp(''), '')
})

test('encodeInp：只输出 base64 字符集内的字符', () => {
  for (const value of ['a', 'hello', '20210001', 'p@ss w0rd!#']) {
    for (const char of encodeInp(value)) {
      assert.ok(KEY.includes(char), `出现字符集外字符 ${char}（输入 ${value}）`)
    }
  }
})

test('encodeInp：确定性，同一输入同一输出', () => {
  assert.equal(encodeInp('20210001'), encodeInp('20210001'))
  assert.notEqual(encodeInp('20210001'), encodeInp('20210002'))
})
