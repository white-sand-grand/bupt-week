/**
 * 401 清会话的并发守卫。
 *
 * 背景：探活/业务路由在校验失败时直接删会话，但校验是异步的——并发请求
 * 里另一个可能已经续期并回写（refresh token 轮换后，手里这份旧快照必然
 * 校验失败），迟到的失败若照删，会把别人刚续活的会话连带删掉，表现为
 * 用户被随机强制登出（多标签页恢复 + 心跳探活重叠时最容易触发）。
 *
 * 判据：删前重读存储，只有「仍然是我们手里这份未变动的快照」才删；期间
 * 被任何人写过（续期/滑动/换凭证）都不删——多留一拍无害，下一次校验
 * 失败还会走到这里再清。快照与存储同源（都是 store.get 的 JSON 解析结果），
 * 键序一致，整对象序列化比对即逐字段比对。
 */
export async function deleteSessionIfUnchanged(store, sessionId, snapshot) {
  try {
    const latest = await store.get(sessionId)
    if (!latest || JSON.stringify(latest) !== JSON.stringify(snapshot)) return
    await store.delete(sessionId)
  } catch {
    // 清理是尽力而为：删不掉不影响 401 的语义
  }
}
