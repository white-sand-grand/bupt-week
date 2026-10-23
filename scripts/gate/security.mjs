// 安全门禁：依赖审计 + 密钥扫描 + 响应头探活。
// 由 scripts/gate/run.mjs 编排，也可单独跑：node scripts/gate/security.mjs
// 任何一项失败即非零退出，CI 上挡住合并。
import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { createBackend } from '../../server/app.js'
import { MemorySessionStore } from '../../server/storage/memory.js'

const failures = []
const warnings = []
const ok = (name) => console.log(`  ✓ ${name}`)
const fail = (name, detail) => {
  failures.push(name)
  console.log(`  ✗ ${name}\n    ${detail}`)
}
const warn = (name, detail) => {
  warnings.push(name)
  console.log(`  ⚠ ${name}: ${detail}`)
}

/** Windows 上 npm 是 .cmd shim 且 Node 24 不允许直接 spawn，须过 shell；
 *  参数都是本脚本写死的固定串，没有注入面。CI（linux）同样兼容。 */
const npmRun = (args) => execFileSync('npm', args, {
  shell: true,
  encoding: 'utf8',
  stdio: ['ignore', 'pipe', 'ignore'],
})

// ── 1. 依赖审计 ──────────────────────────────────────────────────────────────

function auditGate() {
  console.log('\n[1/3] 依赖审计（npm audit）')
  const raw = npmRun(['audit', '--omit=dev', '--json'])
  const report = JSON.parse(raw)
  const vulnerabilities = Object.values(report.vulnerabilities || {})
  const blocking = vulnerabilities.filter((v) => v.severity === 'high' || v.severity === 'critical')
  if (blocking.length === 0) {
    const rest = vulnerabilities.length
    ok(`生产依赖无高危/严重漏洞${rest ? `（${rest} 个中低危仅记录）` : ''}`)
    if (rest) warn('生产依赖存在中低危', vulnerabilities.map((v) => `${v.name}(${v.severity})`).join(', '))
  } else {
    fail('生产依赖存在高危/严重漏洞', blocking.map((v) => `${v.name}: ${v.severity} → ${v.fixAvailable?.name || '无修复版本'}`).join('; '))
  }

  // 开发依赖只报告不拦截：vite/esbuild 的历史洞不影响线上产物
  try {
    const devRaw = npmRun(['audit', '--json'])
    const dev = Object.values(JSON.parse(devRaw).vulnerabilities || {})
    const devHigh = dev.filter((v) => v.severity === 'high' || v.severity === 'critical')
    if (devHigh.length) warn('开发依赖高危（不拦截）', devHigh.map((v) => v.name).join(', '))
  } catch {
    // 审计接口偶发 5xx 不该挡门禁
  }
}

// ── 2. 密钥/凭证扫描 ─────────────────────────────────────────────────────────
// 只扫高信号模式：宁可漏报不可误报成灾——误报会让门禁被人绕过。

const SECRET_PATTERNS = [
  { name: '私钥块', pattern: /-----BEGIN (RSA|EC|OPENSSH|PGP|DSA) PRIVATE KEY-----/ },
  { name: 'GitHub 令牌', pattern: /\bgh[pousr]_[A-Za-z0-9]{20,}/ },
  { name: 'AWS 访问键', pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'JWT 字面量', pattern: /\beyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]{20,}\./ },
  { name: 'Cloudflare API 令牌', pattern: /\b[A-Za-z0-9_-]{40}\b(?=.*cloudflare)/i },
]

// 硬编码学号（10 位、20 开头）：出现在 src/server/scripts 里就是往代码里塞真实账号
const STUDENT_ID = /^\D(20\d{8})\D/

function isTextFile(path) {
  return /\.(js|mjs|cjs|vue|json|yml|yaml|toml|md|html|css|env)$/i.test(path) || path.endsWith('Dockerfile')
}

function secretsGate() {
  console.log('\n[2/3] 密钥与凭证扫描（git 跟踪文件）')
  const tracked = execFileSync(process.platform === 'win32' ? 'git.exe' : 'git', ['ls-files'], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    // 测试与文档里的示例值（2021001234 / fake token）是合法的；产物不扫
    .filter((path) => isTextFile(path) && !path.startsWith('tests/') && !path.startsWith('docs/')
      && !path.startsWith('dist/') && !path.endsWith('package-lock.json'))

  let hits = 0
  for (const path of tracked) {
    let content
    try {
      content = readFileSync(path, 'utf8')
    } catch {
      continue
    }
    for (const { name, pattern } of SECRET_PATTERNS) {
      const match = content.match(pattern)
      if (match) {
        hits += 1
        fail(`发现${name}`, `${path}: …${String(match[0]).slice(0, 24)}…`)
      }
    }
    // 学号只扫源码与配置目录（tests/docs 上面已排除）
    if (/^(src|server|scripts)\//.test(path)) {
      const match = content.match(STUDENT_ID)
      if (match) {
        hits += 1
        fail('源码里硬编码了疑似学号', `${path}: ${match[1]}（测试数据只允许出现在 tests/）`)
      }
    }
  }
  if (hits === 0) ok(`扫描 ${tracked.length} 个文件，未发现泄漏模式`)
}

// ── 3. 响应头探活（起真实应用） ──────────────────────────────────────────────

async function headersGate() {
  console.log('\n[3/3] 响应头探活（进程内起后端应用）')
  const store = new MemorySessionStore()
  const app = createBackend({ getSessionStore: () => store, allowedOrigins: [] })
  const response = await app.request('/api/health')

  const expected = {
    'cache-control': 'no-store',
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'no-referrer',
  }
  let allGood = true
  for (const [header, want] of Object.entries(expected)) {
    const got = response.headers.get(header)
    if (got !== want) {
      allGood = false
      fail(`响应头 ${header}`, `期望 ${want}，实际 ${got ?? '缺失'}`)
    }
  }
  if (response.headers.get('x-powered-by')) {
    allGood = false
    fail('暴露实现栈', 'X-Powered-By 不该出现')
  }
  if (allGood) ok('no-store / nosniff / no-referrer 全部到位')
}

// ── 汇总 ────────────────────────────────────────────────────────────────────

auditGate()
secretsGate()
await headersGate()

console.log(`\n安全门禁：${failures.length === 0 ? '通过' : `${failures.length} 项失败`}${warnings.length ? `，${warnings.length} 项警告` : ''}`)
process.exit(failures.length === 0 ? 0 : 1)
