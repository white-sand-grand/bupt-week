import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'

const ROOT = resolve(import.meta.dirname, '..')
const DIST = resolve(ROOT, 'dist')

test.before(() => {
  rmSync(DIST, { recursive: true, force: true })
  execFileSync('npm', ['run', 'build'], { cwd: ROOT, stdio: 'pipe' })
})

test.after(() => {
  rmSync(DIST, { recursive: true, force: true })
})

/**
 * GitHub Pages 可能挂在子路径（<user>.github.io/<repo>/）。
 * 资源引用必须是相对的，否则子路径部署全部 404。
 *
 * 这条现在靠 vite.config.js 的 base: './' 保证，但没有任何东西守着——
 * 谁把 base 改回 '/'，本地开发照样正常，一部署就全白屏。所以固化成测试。
 */
test('构建产物里的资源引用都是相对路径', () => {
  const html = readFileSync(resolve(DIST, 'index.html'), 'utf8')
  const references = [...html.matchAll(/(?:src|href)="([^"]+)"/g)].map((match) => match[1])

  assert.ok(references.length > 0, 'index.html 里应至少有一个资源引用')

  const bad = references.filter(
    (reference) => !reference.startsWith('./') && !/^[a-z][a-z0-9+.-]*:/i.test(reference),
  )
  assert.deepEqual(bad, [], '以下引用既不是相对路径也不是完整 URL，子路径部署会 404')
})

test('产物里没有绝对路径的 /assets 引用', () => {
  const html = readFileSync(resolve(DIST, 'index.html'), 'utf8')
  assert.equal(html.includes('"/assets/'), false, '出现了绝对路径 /assets/，子路径部署会 404')
  assert.equal(html.includes("'/assets/"), false, '出现了绝对路径 /assets/，子路径部署会 404')
})

test('.nojekyll 被拷进产物（让 Pages 跳过 Jekyll 处理）', () => {
  assert.ok(existsSync(resolve(DIST, '.nojekyll')), 'dist/.nojekyll 缺失，Jekyll 可能忽略下划线开头的文件')
})

test('产物形态符合预期：index.html + assets/', () => {
  assert.ok(existsSync(resolve(DIST, 'index.html')))
  assert.ok(existsSync(resolve(DIST, 'assets')), '缺少 assets/ 目录')
})
