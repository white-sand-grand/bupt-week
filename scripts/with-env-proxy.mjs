#!/usr/bin/env node
/**
 * 跨平台地给子进程带上 NODE_USE_ENV_PROXY=1。
 *
 * npm script 里写 `NODE_USE_ENV_PROXY=1 node ...` 只在 Unix shell 下成立，
 * Windows 的 cmd.exe 会把它当成命令名直接报错。`--use-env-proxy` 命令行
 * 旗标又要求 Node 24+（engines 允许 20/22），所以用这个薄包装：不改语义，
 * 只是把「设环境变量」这一步从 shell 语法挪进 JS。
 *
 * 用法：node scripts/with-env-proxy.mjs <原本的命令…>
 */
import { spawn } from 'node:child_process'

const child = spawn(process.execPath, process.argv.slice(2), {
  stdio: 'inherit',
  env: { ...process.env, NODE_USE_ENV_PROXY: '1' },
})

child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal)
  else process.exit(code ?? 0)
})
