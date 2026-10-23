// 门禁编排：单元测试 → 安全门禁 → 构建 → 浏览器测试 → 性能门禁。
// 快失败：任何一步非零退出立即停，后面不再跑。
//
// 本机：npm run gate（浏览器步骤自动用 BROWSER_EXECUTABLE 指定的系统 Edge）
// CI：.github/workflows/gate.yml 跑同一条命令（chromium 由 Actions 下载）。
import { spawn } from 'node:child_process'

const ROOT = new URL('../..', import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1')

const steps = [
  { name: '单元测试', command: ['npm', 'test'], note: '199 个' },
  { name: '安全门禁', command: [process.execPath, 'scripts/gate/security.mjs'], note: 'audit + 密钥扫描 + 响应头' },
  { name: '生产构建', command: ['npm', 'run', 'build'], note: 'vite build' },
  { name: '浏览器测试', command: ['npm', 'run', 'test:browser'], note: '33 个（需浏览器）' },
  { name: '性能门禁', command: [process.execPath, 'scripts/gate/performance.mjs'], note: '体积预算 + 运行时冒烟' },
]

function run(command) {
  // npm 在 Windows 是 .cmd shim（Node 24 禁止直接 spawn），node 用 execPath 免 shell
  const needsShell = command[0] === 'npm' && process.platform === 'win32'
  return new Promise((resolve) => {
    const child = spawn(command[0], command.slice(1), {
      cwd: ROOT,
      shell: needsShell,
      stdio: 'inherit',
      env: process.env,
    })
    child.on('exit', (code) => resolve(code ?? 1))
    child.on('error', (error) => {
      console.error(`无法启动 ${command[0]}：${error.message}`)
      resolve(1)
    })
  })
}

console.log('── BUPT-week 门禁 ─────────────────────────────────────────')
const startedAt = Date.now()
let failed = null

for (const step of steps) {
  console.log(`\n▶ ${step.name}（${step.note}）`)
  const code = await run(step.command)
  if (code !== 0) {
    failed = step.name
    break
  }
}

const seconds = ((Date.now() - startedAt) / 1000).toFixed(0)
console.log('\n──────────────────────────────────────────────────────────')
if (failed) {
  console.log(`✗ 门禁未通过：${failed} 失败（耗时 ${seconds}s）`)
  process.exit(1)
}
console.log(`✓ 门禁全部通过（${steps.length} 步，耗时 ${seconds}s）`)
