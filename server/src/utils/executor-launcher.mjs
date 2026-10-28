import fs from 'node:fs'
import { spawn } from 'node:child_process'

/**
 * executor.spawnService 的启动器（被 executor 以 detached 方式拉起，独立进程组运行）。
 *   用法：node executor-launcher.mjs <命令> <工作目录> <日志文件> [备注]
 *
 * 职责只有一个：执行一条命令并把它的 stdout/stderr 写进日志文件（含退出码与 PID）。
 * 不读项目任何文件、不加载项目代码。
 */
const [command, cwd, logFile, note] = process.argv.slice(2)
const timestamp = () => new Date().toISOString()

function write(fd, text) {
  try {
    fs.writeSync(fd, text)
  } catch {
    /* 日志写不进去也不该影响命令运行 */
  }
}

if (!command || !logFile) {
  console.error('[executor-launcher] 参数不足：node executor-launcher.mjs <命令> <工作目录> <日志文件>')
  process.exit(2)
}

let fd
try {
  fd = fs.openSync(logFile, 'a')
} catch (error) {
  console.error(`[executor-launcher] 打不开日志文件 ${logFile}：${error.message}`)
  process.exit(2)
}

write(fd, `\n===== ${timestamp()} 启动${note ? `（${note}）` : ''} =====\n$ ${command}\n目录：${cwd || '(未指定)'}\n`)

let child
try {
  child = spawn(command, {
    cwd,
    shell: true,
    detached: false,
    windowsHide: true,
    stdio: ['ignore', fd, fd],
  })
} catch (error) {
  write(fd, `[executor-launcher ${timestamp()}] 启动失败：${error.message}\n`)
  try {
    fs.closeSync(fd)
  } catch {
    /* 忽略 */
  }
  process.exit(1)
}

write(fd, `[executor-launcher ${timestamp()}] 子进程 PID=${child.pid}\n`)

child.on('error', (error) => {
  write(fd, `[executor-launcher ${timestamp()}] 启动失败：${error.message}\n`)
  try {
    fs.closeSync(fd)
  } catch {
    /* 忽略 */
  }
  process.exit(1)
})

child.on('exit', (code, signal) => {
  write(fd, `[executor-launcher ${timestamp()}] 进程退出：code=${code ?? 'null'} signal=${signal ?? 'null'}\n`)
  try {
    fs.closeSync(fd)
  } catch {
    /* 忽略 */
  }
  process.exit(code ?? 0)
})

// 启动器收到终止信号时把子进程一起带走（外层 killTree 走 taskkill /T，这里是兜底）
for (const sig of ['SIGTERM', 'SIGINT', 'SIGBREAK']) {
  process.on(sig, () => {
    try {
      child.kill()
    } catch {
      /* 忽略 */
    }
  })
}
