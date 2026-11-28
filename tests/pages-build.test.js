import { test } from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { resolve } from 'node:path'
import { cspPlugin } from '../vite.config.js'

const ROOT = resolve(import.meta.dirname, '..')
const DIST = resolve(ROOT, 'dist')

test.before(() => {
  rmSync(DIST, { recursive: true, force: true })
  // shell 只在 Windows 下需要（npm 是 npm.cmd，execFileSync 不做 PATHEXT 解析）；
  // Unix 上多一层 shell 反而引号处理变脆。
  execFileSync('npm', ['run', 'build'], {
    cwd: ROOT,
    stdio: 'pipe',
    shell: process.platform === 'win32',
  })
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

// ── Content-Security-Policy ─────────────────────────────────────────────────

test('CSP 插件：内联主题脚本算进 script-src hash，后端来源只在部署构建出现', () => {
  const sample = '<!DOCTYPE html><html><head><script>const x = 1</script></head><body></body></html>'
  const local = cspPlugin({}).transformIndexHtml.handler(sample)
  const hash = createHash('sha256').update('const x = 1').digest('base64')
  assert.match(local, new RegExp(`script-src 'self' 'sha256-${hash.replace(/[+/=]/g, '\\$&')}'`))
  assert.doesNotMatch(local, /unsafe-inline/, 'script-src 不允许 unsafe-inline 兜底')
  assert.doesNotMatch(local, /VITE_BACKEND_URL/, '本地构建不带后端来源')
  // meta 必须在内联脚本之前：CSP 从解析到它的位置开始生效
  assert.ok(local.indexOf('Content-Security-Policy') < local.indexOf('<script>'), 'CSP meta 应在脚本之前')

  const deployed = cspPlugin({ VITE_BACKEND_URL: 'https://backend.example/' }).transformIndexHtml.handler(sample)
  assert.match(deployed, /connect-src 'self' https:\/\/backend\.example/)
  assert.match(deployed, /img-src 'self' data: https:\/\/backend\.example/)

  // dev server 用 JS 注入 <style>，必须放行 unsafe-inline，否则样式全死；
  // 构建形态保持严格——这条差别本身就是「生产不留内联样式通道」的守卫。
  const dev = cspPlugin({}).transformIndexHtml.handler(sample, { server: {} })
  assert.match(dev, /style-src 'self' 'unsafe-inline'/)
  assert.doesNotMatch(local, /style-src 'self' 'unsafe-inline'/)
})

test('产物带 CSP meta，hash 与产物里实际的内联脚本一致', () => {
  const html = readFileSync(resolve(DIST, 'index.html'), 'utf8')
  const meta = /<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)
  assert.ok(meta, '产物里应注入 CSP meta')
  const csp = meta[1]

  const inline = /<script>([\s\S]*?)<\/script>/.exec(html)
  assert.ok(inline, '产物应保留内联主题脚本')
  const hash = createHash('sha256').update(inline[1]).digest('base64')
  assert.ok(csp.includes(`'sha256-${hash}'`), 'script-src hash 必须与内联脚本逐字节对应，否则主题预置脚本被 CSP 拦掉')
  assert.ok(html.indexOf('Content-Security-Policy') < html.indexOf('<script>'), 'CSP meta 应在内联脚本之前')

  // 部署构建由 deploy.yml 设 VITE_BACKEND_URL；本机构建没有它，CSP 也不该出现占位符
  assert.ok(!csp.includes('%'), 'CSP 里不该有未展开的占位符')
})
