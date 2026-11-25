import { isLive } from './is-live.js'

export const isLegacyBusinessKey = (key) => /^(?:class:|code:|user:.*:classes$)/.test(key)

/** 事务内的记录视图。null 是迁移墓碑，删除后不能从旧存储复活。 */
export function businessRecords(records, loadLegacy = async () => undefined) {
  for (const [key, value] of records) {
    if (!isLegacyBusinessKey(key) && !isLive(value)) records.delete(key)
  }
  return {
    async get(key) {
      if (!records.has(key) && isLegacyBusinessKey(key)) {
        const legacy = await loadLegacy(key)
        if (legacy) records.set(key, legacy)
      }
      const value = records.get(key)
      if (isLive(value)) return structuredClone(value)
      if (value) {
        if (isLegacyBusinessKey(key)) records.set(key, null)
        else records.delete(key)
      }
      return undefined
    },
    async set(key, value) {
      records.set(key, structuredClone(value))
    },
    async delete(key) {
      if (isLegacyBusinessKey(key)) records.set(key, null)
      else records.delete(key)
    },
  }
}
