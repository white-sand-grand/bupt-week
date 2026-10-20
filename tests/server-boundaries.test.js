import { test } from 'node:test'
import assert from 'node:assert/strict'
import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join, relative, resolve, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const SERVER_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'server')
const WORKER_ENTRY = join(SERVER_DIR, 'entries', 'worker.js')
const ONLY_NATIVE_FILE = join(SERVER_DIR, 'storage', 'file.js')

// 覆盖 import ... from、export ... from、import '...'、import('...')
const IMPORT_RE =
  /\bfrom\s*['"]([^'"]+)['"]|\bimport\s*\(\s*['"]([^'"]+)['"]|\bimport\s*['"]([^'"]+)['"]/g

function collect(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = join(dir, entry.name)
    return entry.isDirectory() ? collect(full) : [full]
  })
}

const FILES = collect(SERVER_DIR).filter((file) => file.endsWith('.js'))

function specifiersOf(file) {
  const source = readFileSync(file, 'utf8')
  return [...source.matchAll(IMPORT_RE)].map((match) => match[1] ?? match[2] ?? match[3])
}

function nativeSpecifiersOf(file) {
  return specifiersOf(file).filter((specifier) => specifier.startsWith('node:'))
}

/** 相对 import 才解析；裸包名返回 null。 */
function resolveSpecifier(fromFile, specifier) {
  if (!specifier.startsWith('.')) return null
  const base = resolve(dirname(fromFile), specifier)
  for (const candidate of [base, `${base}.js`, join(base, 'index.js')]) {
    if (existsSync(candidate)) return candidate
  }
  return base
}

/** 从 entry 出发沿相对 import 遍历，返回可达文件集合。 */
function reachableFrom(entry) {
  const seen = new Set()
  const queue = [entry]
  while (queue.length > 0) {
    const file = queue.pop()
    if (seen.has(file)) continue
    seen.add(file)
    for (const specifier of specifiersOf(file)) {
      const target = resolveSpecifier(file, specifier)
      if (target?.startsWith(`${SERVER_DIR}${sep}`)) queue.push(target)
    }
  }
  return seen
}

test('server/ 下只有 storage/file.js 可以引用 node: 内置模块', () => {
  const offenders = FILES.filter((file) => file !== ONLY_NATIVE_FILE)
    .filter((file) => nativeSpecifiersOf(file).length > 0)
    .map((file) => relative(SERVER_DIR, file))

  assert.deepEqual(offenders, [], `以下文件引用了 node: 内置模块：${offenders.join(', ')}`)
})

test('storage/file.js 确实引用 node: 内置模块（否则上一条断言是空转）', () => {
  assert.ok(nativeSpecifiersOf(ONLY_NATIVE_FILE).length > 0, 'file.js 应当引用 node:fs')
})

test('worker 入口沿 import 图不可达任何 node: 内置模块', () => {
  assert.ok(existsSync(WORKER_ENTRY), '缺少 server/entries/worker.js')

  const offenders = [...reachableFrom(WORKER_ENTRY)].flatMap((file) =>
    nativeSpecifiersOf(file).map((specifier) => `${relative(SERVER_DIR, file)} → ${specifier}`),
  )

  assert.deepEqual(offenders, [], `worker 入口传递依赖到了 node: 内置模块：${offenders.join(', ')}`)
})

test('worker 入口确实能到达 app.js（否则上一条断言是空转）', () => {
  const reachable = [...reachableFrom(WORKER_ENTRY)].map((file) => relative(SERVER_DIR, file))
  assert.ok(reachable.includes('app.js'), `worker 可达集合异常：${reachable.join(', ')}`)
})
