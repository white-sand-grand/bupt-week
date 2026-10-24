/**
 * 班级密码哈希（PBKDF2-SHA256，Web Crypto）。
 *
 * 迭代次数刻意取 1 万：Workers 免费版单请求 10ms CPU 预算，原生 WebCrypto
 * 跑 1 万次 ≈ 3-6ms，安全余量充足；真正的爆破刹车是加入路由的限速
 * （10 分钟 10 次密码错）。班级密码保护的是作业共享，不是支付凭证——
 * 用迭代次数换部署稳定性，值得。
 *
 * 只用全局 crypto（Workers 与 Node 18+ 都内置），不引 node:——
 * tests/server-boundaries.test.js 守着这条。
 */

const PBKDF2_ITERATIONS = 10_000
const KEY_BITS = 256
const SALT_BYTES = 16

function bytesToHex(bytes) {
  return [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('')
}

function hexToBytes(hex) {
  const bytes = new Uint8Array(hex.length / 2)
  for (let i = 0; i < bytes.length; i += 1) {
    bytes[i] = Number.parseInt(hex.slice(i * 2, i * 2 + 2), 16)
  }
  return bytes
}

/** 每班级独立盐（16 字节随机）。 */
export async function newSalt() {
  return bytesToHex(crypto.getRandomValues(new Uint8Array(SALT_BYTES)))
}

/** PBKDF2 派生（十六进制返回）。 */
export async function hashPassword(password, saltHex) {
  const key = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits'],
  )
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt: hexToBytes(saltHex), iterations: PBKDF2_ITERATIONS },
    key,
    KEY_BITS,
  )
  return bytesToHex(new Uint8Array(bits))
}

/** 校验：重算后常数时间比较，不因前缀提前返回。 */
export async function verifyPassword(password, saltHex, expectedHex) {
  const actual = await hashPassword(password, saltHex)
  if (actual.length !== expectedHex.length) return false
  let diff = 0
  for (let i = 0; i < actual.length; i += 1) {
    diff |= actual.charCodeAt(i) ^ expectedHex.charCodeAt(i)
  }
  return diff === 0
}
