import { readFileSync, writeFileSync, renameSync } from 'node:fs'
import { resolve } from 'node:path'
import { isLive } from './is-live.js'

/**
 * 文件存储，用于本机 `npm run server`。
 *
 * 这是 server/ 下唯一允许 import node:* 的文件——tests/server-boundaries.test.js
 * 守着这条规则。Workers 没有文件系统，一旦别处引用了 node:fs，本地一切正常、
 * 部署直接挂，所以用测试前置防御。
 *
 * 权限 0600、后缀 .local（被 .gitignore 挡住）。会话里含上游 Cookie 和
 * token，不能是可读的。
 */
export class FileSessionStore {
  constructor(file = resolve('.sessions.local')) {
    this.file = file
    this.map = new Map()
    try {
      for (const [id, session] of Object.entries(JSON.parse(readFileSync(file, 'utf8')))) {
        if (typeof id === 'string' && isLive(session)) this.map.set(id, session)
      }
    } catch (error) {
      // 文件不存在是首次启动的正常情况；损坏则警告并当空处理，不阻塞启动。
      if (error.code !== 'ENOENT') {
        console.warn(`[storage] 无法恢复 ${file}：${error.message}`)
      }
    }
  }

  async get(id) {
    const session = this.map.get(id)
    if (!session) return undefined
    if (!isLive(session)) {
      this.map.delete(id)
      return undefined
    }
    return session
  }

  async set(id, session) {
    this.map.set(id, session)
    this.save()
    return session
  }

  async delete(id) {
    const removed = this.map.delete(id)
    this.save()
    return removed
  }

  save() {
    const temporary = `${this.file}.tmp`
    writeFileSync(temporary, JSON.stringify(Object.fromEntries(this.map)), { mode: 0o600 })
    renameSync(temporary, this.file)
  }
}
