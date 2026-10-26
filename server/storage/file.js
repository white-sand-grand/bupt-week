import { createHash } from 'node:crypto'
import { access, mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { isLive } from './is-live.js'

/**
 * Node 单实例文件存储：每个键一个文件，异步原子替换，不随全库大小放大写入。
 * 旧 .sessions.local JSON 在首次访问时迁移到 .sessions.local.d/。
 * 目录 0700、记录 0600，均被 .gitignore 挡住；Workers 不引用此模块。
 */
export class FileSessionStore {
  constructor(file = resolve('.sessions.local')) {
    this.file = file
    this.directory = `${file}.d`
    this.ready = null
    this.pending = new Map()
  }

  recordPath(id) {
    // 键含 class:/user: 等前缀；哈希同时避免路径穿越与文件名长度限制。
    return join(this.directory, `${createHash('sha256').update(id).digest('hex')}.json`)
  }

  async write(file, data) {
    const temporary = `${file}.tmp`
    try {
      await writeFile(temporary, data, { mode: 0o600 })
      await rename(temporary, file)
    } finally {
      await unlink(temporary).catch(() => {})
    }
  }

  async initialize() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    let records
    try {
      records = Object.entries(JSON.parse(await readFile(this.file, 'utf8')))
    } catch (error) {
      if (error.code === 'ENOENT') return
      // 损坏的旧文件保留供恢复；权限或 I/O 错误必须交给调用方。
      if (!(error instanceof SyntaxError || error instanceof TypeError)) throw error
      console.warn(`[storage] 无法恢复 ${this.file}：${error.message}`)
      return
    }

    for (const [id, session] of records) {
      if (!isLive(session)) continue
      const file = this.recordPath(id)
      try {
        await access(file)
      } catch (error) {
        if (error.code !== 'ENOENT') throw error
        await this.write(file, JSON.stringify(session))
      }
    }
    // 全部迁移成功才删旧文件；中途退出可重试，已有记录优先，不覆盖新值。
    await unlink(this.file)
  }

  run(id, operation) {
    // 同键按调用顺序执行，防止旧写入迟到覆盖新值或登出后复活；异键可并行。
    const previous = this.pending.get(id) || Promise.resolve()
    const task = previous.catch(() => {}).then(async () => {
      await (this.ready ||= this.initialize().catch((error) => {
        this.ready = null
        throw error
      }))
      return operation(this.recordPath(id))
    })
    this.pending.set(id, task)
    const cleanup = () => {
      if (this.pending.get(id) === task) this.pending.delete(id)
    }
    task.then(cleanup, cleanup)
    return task
  }

  async get(id) {
    if (typeof id !== 'string') return undefined
    return this.run(id, async (file) => {
      let session
      try {
        session = JSON.parse(await readFile(file, 'utf8'))
      } catch (error) {
        if (error.code === 'ENOENT') return undefined
        throw error
      }
      if (isLive(session)) return session
      await unlink(file)
      return undefined
    })
  }

  async set(id, session) {
    return this.run(id, async (file) => {
      await this.write(file, JSON.stringify(session))
      return session
    })
  }

  async delete(id) {
    if (typeof id !== 'string') return false
    return this.run(id, async (file) => {
      try {
        await unlink(file)
        return true
      } catch (error) {
        if (error.code === 'ENOENT') return false
        throw error
      }
    })
  }
}
