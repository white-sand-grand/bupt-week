/**
 * 日志脱敏。
 *
 * 登录链路会把学号、密码、CAS ticket、access_token 打出来用于排查，但明文进日志
 * 就等于把凭证写进了日志文件。这里统一收敛成「长度 + 前后各 10 个字符」，
 * 够区分是哪个值，又不足以拿去用。
 *
 * 注意 `cookie` 也在敏感名单里：教务会话就是一堆 Set-Cookie，泄露了等于泄露登录态。
 */
const SENSITIVE_KEY = /password|passwd|ticket|token|cookie|secret|authorization|encoded/i

export function redact(value) {
  if (typeof value !== 'string') return value
  return { length: value.length, prefix: value.slice(0, 10), suffix: value.slice(-10) }
}

export function redactSensitive(value) {
  if (Array.isArray(value)) return value.map(redactSensitive)
  if (!value || typeof value !== 'object') return value

  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      SENSITIVE_KEY.test(key) ? redact(item) : redactSensitive(item),
    ]),
  )
}
