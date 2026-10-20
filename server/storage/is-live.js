/**
 * 会话是否仍然有效。
 *
 * 三种存储共用同一条规则：过期即不存在。放在这里而不是各写一遍，
 * 是为了避免某一种存储忘了剔除过期项——那会变成"退出登录了但还能用"。
 */
export function isLive(session) {
  return Boolean(session) && Number.isFinite(session.expiresAt) && session.expiresAt > Date.now()
}
