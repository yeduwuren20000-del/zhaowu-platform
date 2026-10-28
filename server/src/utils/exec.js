import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/** 让 PowerShell 输出 UTF-8，避免中文项目名/路径乱码 */
const PS_PREFIX =
  '$ErrorActionPreference="Stop";' +
  '$ProgressPreference="SilentlyContinue";' +
  '[Console]::OutputEncoding=[Text.Encoding]::UTF8;' +
  '$OutputEncoding=[Text.Encoding]::UTF8;'

export function isWindows() {
  return process.platform === 'win32'
}

/** 执行一段 PowerShell 并返回 stdout 文本 */
export async function runPowerShell(script, { timeout = 15000 } = {}) {
  const { stdout } = await execFileAsync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', PS_PREFIX + script],
    { timeout, windowsHide: true, maxBuffer: 8 * 1024 * 1024, encoding: 'utf8' },
  )
  return stdout
}

/** 执行一段 PowerShell 并把 stdout 当 JSON 解析 */
export async function runPowerShellJson(script, options) {
  const stdout = await runPowerShell(script, options)
  const text = stdout.trim()
  if (!text) return null
  return JSON.parse(text)
}

/** 执行外部程序（参数数组，不经过 shell，避免注入与转义问题） */
export async function runFile(file, args = [], { timeout = 15000 } = {}) {
  const { stdout, stderr } = await execFileAsync(file, args, {
    timeout,
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    encoding: 'utf8',
  })
  return { stdout, stderr }
}

/** 执行外部程序但忽略失败（结束进程、打开资源管理器这类调用） */
export async function runFileQuiet(file, args = [], { timeout = 15000 } = {}) {
  try {
    return await runFile(file, args, { timeout })
  } catch (error) {
    return { stdout: '', stderr: String(error?.message || error), failed: true }
  }
}

/** 以脱离父进程的方式启动（进程会继续存活，标准输出已重定向到文件） */
export function spawnDetached(command, { cwd, stdio = 'ignore' } = {}) {
  const child = spawn(command, {
    cwd,
    shell: true,
    detached: true,
    windowsHide: true,
    stdio,
  })
  child.unref()
  return child
}
