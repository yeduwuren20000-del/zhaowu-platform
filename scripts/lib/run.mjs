import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
export const ROOT = path.resolve(here, '..', '..')

const COLORS = {
  api: '\u001b[36m',
  web: '\u001b[35m',
  sys: '\u001b[32m',
  reset: '\u001b[0m',
}

/** 以继承 stdio 的方式运行子进程（保留颜色与实时输出）
 *  Windows 上 .cmd/.bat（例如 npm.cmd）必须经过 shell，此时把参数拼成一条命令字符串，
 *  避免 child_process 在 shell:true + args 下的 DEP0190 警告与转义歧义。 */
export function run(label, command, args = [], options = {}) {
  const { shell, ...rest } = options
  const needsShell = shell ?? (process.platform === 'win32' && /\.(cmd|bat)$/i.test(command))
  const child = needsShell
    ? spawn(
        [command, ...args].map((part) => (/\s/.test(part) ? `"${part}"` : part)).join(' '),
        { stdio: 'inherit', ...rest, shell: true },
      )
    : spawn(command, args, { stdio: 'inherit', ...rest })
  child.label = label
  return child
}

export function log(label, message) {
  const color = COLORS[label] || COLORS.sys
  console.log(`${color}[${label}]${COLORS.reset} ${message}`)
}

export function npmCommand() {
  return process.platform === 'win32' ? 'npm.cmd' : 'npm'
}

export function onExit(child, handler) {
  child.on('exit', (code) => handler(code))
}
