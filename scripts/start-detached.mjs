/**
 * 以 detached 方式启动后端：脱离当前终端会话，终端关闭/被杀也不影响它继续跑。
 *
 * 为什么需要：直接 `node server/src/index.js` 绑在当前会话上，会话一结束进程就没了。
 * 开发、自动化测试、后台任务场景都需要"启动完就撒手"。
 *
 * 用法：node scripts/start-detached.mjs
 */
import path from 'node:path'
import { spawn } from 'node:child_process'
import { ROOT } from './lib/run.mjs'

const child = spawn(process.execPath, [path.join(ROOT, 'server', 'src', 'index.js')], {
  cwd: ROOT,
  detached: true,
  stdio: 'ignore',
  windowsHide: true,
  env: { ...process.env },
})
child.unref()
console.log(`[dsm] 后端已在后台启动 (pid=${child.pid})`)
process.exit(0)