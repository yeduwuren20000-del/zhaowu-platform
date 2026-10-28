#!/usr/bin/env node
import { run, spawnService, killTree, describeError, toArgv } from '../server/src/utils/executor.js'
import path from 'node:path'

/**
 * 本地命令执行器 CLI（"能本地拉起"）：
 *   node scripts/exec.mjs "echo 你好"
 *   node scripts/exec.mjs --cwd D:/projects/foo --timeout 8000 "npm run build"
 *   node scripts/exec.mjs --detach --log data/logs/foo.log "node server/src/index.js"
 *
 * 可选参数：
 *   --cwd <dir>        工作目录
 *   --timeout <ms>     超时（默认 15000）
 *   --shell / --no-shell   是否经 shell（默认经 shell）
 *   --detach           以脱离进程的方式启动（长驻服务，输出进日志文件）
 *   --log <file>       --detach 时指定日志文件
 *   --env K=V          追加环境变量（可多次）
 */

function parseArgs(argv) {
  const opts = { cwd: process.cwd(), timeout: 15000, shell: true, detach: false, log: null, env: {}, commandParts: [] }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--cwd') opts.cwd = argv[++i]
    else if (arg === '--timeout') opts.timeout = Number(argv[++i])
    else if (arg === '--shell') opts.shell = true
    else if (arg === '--no-shell') opts.shell = false
    else if (arg === '--detach') opts.detach = true
    else if (arg === '--log') opts.log = argv[++i]
    else if (arg === '--env') {
      const kv = argv[++i]
      const eq = kv.indexOf('=')
      if (eq > 0) opts.env[kv.slice(0, eq)] = kv.slice(eq + 1)
    } else if (arg === '--help' || arg === '-h') {
      opts.help = true
    } else {
      opts.commandParts.push(arg)
    }
  }
  return opts
}

const opts = parseArgs(process.argv.slice(2))

if (opts.help || opts.commandParts.length === 0) {
  console.log(`本地命令执行器

用法：
  node scripts/exec.mjs [选项] -- <命令>

选项：
  --cwd <dir>       工作目录
  --timeout <ms>    超时毫秒（默认 15000）
  --shell/--no-shell  是否经 shell（默认经 shell）
  --detach          脱离进程启动长驻服务，输出写进日志文件
  --log <file>      --detach 时指定日志文件
  --env K=V         追加环境变量（可多次）
  --help            显示帮助

示例：
  node scripts/exec.mjs "echo 你好"
  node scripts/exec.mjs --cwd D:/projects/foo "npm run build"
  node scripts/exec.mjs --detach --log data/logs/svc.log "node server/src/index.js"
`)
  process.exit(opts.help ? 0 : 2)
}

const command = opts.commandParts.join(' ')

if (opts.detach) {
  const result = await spawnService(command, {
    cwd: opts.cwd,
    logFile: opts.log ? path.resolve(opts.log) : null,
    env: { ...process.env, ...opts.env },
    note: 'CLI 拉起',
  })
  if (result.ok) {
    console.log(`[executor] 已拉起 PID=${result.pid}`)
    console.log(`[executor] 日志：${result.logFile}`)
    process.exit(0)
  }
  console.error(`[executor] 启动失败：${describeError(result.error)}`)
  process.exit(1)
}

const started = Date.now()
const result = await run(command, {
  cwd: opts.cwd,
  timeout: opts.timeout,
  shell: opts.shell,
  env: { ...process.env, ...opts.env },
})

if (result.stdout) process.stdout.write(result.stdout)
if (result.stderr) process.stderr.write(result.stderr)

if (result.timedOut) {
  console.error(`\n[executor] 超时（${opts.timeout}ms），已终止，耗时 ${result.durationMs}ms`)
  process.exit(124)
}
if (!result.ok) {
  const reason = result.error ? describeError(result.error) : `进程以退出码 ${result.code ?? '未知'} 结束`
  console.error(`\n[executor] 失败：${reason}（code=${result.code ?? 'null'} signal=${result.signal ?? 'null'}，耗时 ${result.durationMs}ms）`)
  process.exit(result.code ?? 1)
}
console.error(`\n[executor] 成功（耗时 ${result.durationMs}ms）`)
