import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { TextDecoder } from 'node:util'

/**
 * 本地命令执行器（executor）—— 把 `child_process` 封装成一套干净、可复用、跨平台的本地执行原语，
 * 解决 Windows 下几个反复踩过的坑：
 *   - detached + shell 直接 spawn 会丢子进程输出（日志捕获靠启动器脚本绕开）
 *   - cmd.exe 不认识反斜杠转义，参数引号需要按 cmd 语义处理
 *   - PowerShell 输出默认非 UTF-8，中文会乱码
 *   - 超时需要连进程树一起杀，不能只杀壳
 *   - ENOENT / EPERM / EACCES 等要翻译成能看懂的中文原因
 *
 * 用法（库）：
 *   import { run, runQuiet, spawnService, killTree, normalizeError } from './executor.js'
 *
 * 用法（本地拉起，CLI）：
 *   node scripts/exec.mjs "node -e \"console.log('你好')\""
 *   node scripts/exec.mjs --cwd D:/somewhere --timeout 8000 "npm run dev"
 */

export function isWindows() {
  return process.platform === 'win32'
}

const ERROR_LABELS = {
  ENOENT: '找不到可执行文件（命令或程序不存在，或不在 PATH 里）',
  EACCES: '没有执行权限',
  EPERM: '权限不足（可能是杀毒软件或沙箱拦截了子进程）',
  ETIMEDOUT: '执行超时',
  EBUSY: '文件或进程被占用',
}

/** 把系统错误翻译成带原始 code 的可读对象 */
export function normalizeError(error) {
  if (!error) return null
  const code = error?.code || ''
  return {
    code,
    message: error?.message || String(error),
    hint: ERROR_LABELS[code] || null,
    stdout: error?.stdout || '',
    stderr: error?.stderr || '',
  }
}

/** 把错误转成一行中文（给日志/提示用） */
export function describeError(error) {
  const normalized = normalizeError(error)
  if (!normalized) return '未知错误'
  return normalized.hint ? `${normalized.hint}（${normalized.code}: ${normalized.message}）` : normalized.message
}

/** 归一化参数：命令字符串 -> { command, args }（拆空白、尊重引号） */
export function toArgv(command) {
  if (Array.isArray(command)) return command
  const tokens = String(command).match(/(?:[^\s"']+|"[^"]*"|'[^']*')+/g) || []
  return tokens.map((token) => token.replace(/^["']|["']$/g, ''))
}

/** 把子进程输出按 UTF-8 解码，遇到替换字符（说明是 GBK 等本地代码页）就回退 GBK */
function decodeChunks(chunks) {
  const buffer = Buffer.concat(chunks)
  const utf8 = buffer.toString('utf8')
  if (!utf8.includes('\uFFFD')) return utf8
  try {
    return new TextDecoder('gbk').decode(buffer)
  } catch {
    return utf8
  }
}

// 各种 shell 报"命令不存在"的措辞（中英文 / 大小写）
const NOT_FOUND_PATTERNS = [/不是内部或外部命令/, /不是可运行的程序/, /is not recognized as an internal or external command/i, /command not found/i, /No such file or directory/i]

/**
 * 执行一条命令并捕获 stdout/stderr。
 *   - shell=true（默认）：`command` 是整条命令字符串，`args` 忽略；
 *   - shell=false：`command` 是可执行文件，`args` 是精确参数数组（含空格也不拆、不注入）。
 * @returns {Promise<{ ok, code, signal, stdout, stderr, durationMs, pid, timedOut, error }>}
 * 永不 throw（参数错误除外），错误统一放进 `error` 字段。
 */
export async function run(command, options = {}) {
  const {
    args,
    cwd,
    env,
    timeout = 15000,
    shell = true,
    maxBuffer = 8 * 1024 * 1024,
    windowsHide = true,
    killTreeOnTimeout = true,
  } = options

  const startedAt = Date.now()
  const result = {
    ok: false,
    code: null,
    signal: null,
    stdout: '',
    stderr: '',
    durationMs: 0,
    pid: null,
    timedOut: false,
    error: null,
  }

  return new Promise((resolve) => {
    let settled = false
    let timedOut = false
    const finish = (patch = {}) => {
      if (settled) return
      settled = true
      Object.assign(result, patch, { durationMs: Date.now() - startedAt })
      resolve(result)
    }

    let child
    try {
      child = spawn(shell ? command : command, shell ? [] : args ?? [], {
        cwd,
        env,
        shell,
        windowsHide,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (error) {
      return finish({ error: normalizeError(error) })
    }

    result.pid = child.pid

    const stdoutChunks = []
    const stderrChunks = []
    let overflowed = false
    child.stdout?.on('data', (chunk) => {
      const total = stdoutChunks.reduce((sum, item) => sum + item.length, 0)
      if (total + chunk.length > maxBuffer) overflowed = true
      else stdoutChunks.push(chunk)
    })
    child.stderr?.on('data', (chunk) => {
      const total = stderrChunks.reduce((sum, item) => sum + item.length, 0)
      if (total + chunk.length > maxBuffer) overflowed = true
      else stderrChunks.push(chunk)
    })

    child.on('error', (error) => {
      if (timedOut) return
      finish({ error: normalizeError(error), stdout: decodeChunks(stdoutChunks), stderr: decodeChunks(stderrChunks) })
    })

    child.on('exit', (code, signal) => {
      if (timedOut) return
      const stdout = decodeChunks(stdoutChunks)
      const stderr = decodeChunks(stderrChunks)
      const tail = overflowed ? '\n[输出超出上限已截断]' : ''
      let error = null
      // shell 报"命令不存在"会以 code 1 + stderr 措辞返回，而不是 ENOENT；这里补一道识别
      if (code !== 0 && shell && NOT_FOUND_PATTERNS.some((pattern) => pattern.test(stderr))) {
        error = normalizeError(Object.assign(new Error('命令未找到：' + (command || '').split(/\s+/)[0]), { code: 'ENOENT', stderr }))
      }
      finish({ ok: code === 0, code, signal, stdout: stdout + tail, stderr: stderr + tail, error })
    })

    if (timeout && timeout > 0) {
      const timer = setTimeout(() => {
        if (settled) return
        timedOut = true
        if (killTreeOnTimeout) killTree(child.pid).catch(() => {})
        else {
          try {
            child.kill()
          } catch {
            /* 忽略 */
          }
        }
        finish({
          timedOut: true,
          error: normalizeError(Object.assign(new Error(`执行超过 ${timeout}ms 已终止`), { code: 'ETIMEDOUT', stdout: decodeChunks(stdoutChunks), stderr: decodeChunks(stderrChunks) })),
          stdout: decodeChunks(stdoutChunks),
          stderr: decodeChunks(stderrChunks),
        })
      }, timeout)
      timer.unref?.()
    }
  })
}

/** 执行命令，失败不 throw，只返回结构体（适合"尽力而为"的调用） */
export async function runQuiet(command, options = {}) {
  return run(command, options)
}

/** 结束一棵进程树（Windows 用 taskkill /T，其它平台回退到 kill） */
export async function killTree(pid, { signal = 'SIGKILL' } = {}) {
  if (!pid || !Number.isInteger(pid)) return { killed: false, reason: 'invalid-pid' }
  if (isWindows()) {
    return runQuiet('taskkill', {
      args: ['/PID', String(pid), '/T', '/F'],
      shell: false,
      timeout: 8000,
    }).then((r) => ({ killed: r.ok, code: r.code, stderr: r.stderr }))
  }
  try {
    process.kill(pid, signal)
    return { killed: true }
  } catch (error) {
    return { killed: false, reason: error?.code || String(error) }
  }
}

/**
 * 以脱离父进程的方式启动一个长驻服务，输出（含子进程真实 stdout/stderr）写入日志文件。
 *
 * 为什么用启动器脚本：Windows 上 `shell:true + detached:true` 直接 spawn 时，子进程输出不会写进
 * 继承的文件句柄（实测），日志会丢；而不 detached 又会让服务跟着父进程控制台一起收到 Ctrl+C。
 * 折中：启动器自身 detached（独立进程组，父进程退出/ Ctrl+C 都不影响服务），它在内部用
 * shell + 文件句柄跑真实命令 —— 这条路径日志捕获是可靠的。
 *
 * @returns {{ pid, logFile, ok, error }}
 */
export async function spawnService(command, options = {}) {
  const { cwd, logFile, env, note = '' } = options
  if (!command) return { ok: false, pid: null, logFile: null, error: { code: 'NO_COMMAND', message: '缺少要启动的命令', hint: null } }

  const launcherPath = path.join(path.dirname(fileURLToPath(import.meta.url)), 'executor-launcher.mjs')

  let resolvedLog = logFile
  if (!resolvedLog) {
    // 默认写到临时目录，避免在项目里乱建文件
    const dir = process.env.DSM_DATA_DIR || path.join(process.cwd(), 'data', 'logs')
    fs.mkdirSync(dir, { recursive: true })
    resolvedLog = path.join(dir, `executor-${Date.now()}-${Math.random().toString(16).slice(2, 6)}.log`)
  } else {
    fs.mkdirSync(path.dirname(path.resolve(resolvedLog)), { recursive: true })
  }

  try {
    const child = spawn(process.execPath, [launcherPath, command, cwd || process.cwd(), resolvedLog, note], {
      detached: true,
      windowsHide: true,
      stdio: 'ignore',
      env,
    })
    child.unref()
    return { ok: true, pid: child.pid, logFile: resolvedLog, error: null }
  } catch (error) {
    return { ok: false, pid: null, logFile: resolvedLog, error: normalizeError(error) }
  }
}

export default { isWindows, run, runQuiet, spawnService, killTree, normalizeError, describeError, toArgv }
