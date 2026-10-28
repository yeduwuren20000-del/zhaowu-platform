import fs from 'node:fs'
import path from 'node:path'
import { runPowerShellJson } from '../utils/exec.js'

/**
 * 进程事实采集（只读）：
 *   - 一次 PowerShell 调用取回整张进程表（PID / 名称 / exe / 完整命令行 / 父进程 / 启动时间）；
 *   - 据此构建父进程链、推断工作目录与候选项目目录。
 *
 * 注意：部分进程（沙箱、其他用户、受保护进程）的 exe 与命令行读不到，
 * 这里如实返回空值，绝不用推断结果冒充事实字段。
 */

const PS_PROCESS_TABLE = `
$rows = foreach ($p in Get-CimInstance Win32_Process) {
  $started = ''
  try { if ($p.CreationDate) { $started = $p.CreationDate.ToUniversalTime().ToString('o') } } catch { $started = '' }
  [pscustomobject]@{
    pid = [int]$p.ProcessId
    name = [string]$p.Name
    exe = [string]$p.ExecutablePath
    cmd = [string]$p.CommandLine
    ppid = [int]$p.ParentProcessId
    started = $started
  }
}
ConvertTo-Json -InputObject @($rows) -Compress
`

let cache = { at: 0, table: new Map() }

/** 整张进程表（带 3 秒缓存，一次扫描内复用） */
export async function getProcessTable({ force = false, ttlMs = 3000 } = {}) {
  if (!force && cache.table.size > 0 && Date.now() - cache.at < ttlMs) return cache.table
  let rows = []
  try {
    const raw = await runPowerShellJson(PS_PROCESS_TABLE, { timeout: 30000 })
    rows = Array.isArray(raw) ? raw : raw ? [raw] : []
  } catch (error) {
    console.warn(`[process] 读取进程表失败：${error.message}`)
    return new Map()
  }
  const table = new Map()
  for (const row of rows) {
    const pid = Number(row.pid)
    if (!Number.isInteger(pid) || pid <= 0) continue
    table.set(pid, {
      pid,
      name: String(row.name || ''),
      exePath: String(row.exe || ''),
      commandLine: String(row.cmd || ''),
      parentPid: Number(row.ppid) || 0,
      startedAt: row.started ? String(row.started) : null,
    })
  }
  cache = { at: Date.now(), table }
  return table
}

/** 父进程链（含自身），最多 maxDepth 层 */
export function buildParentChain(pid, table, maxDepth = 6) {
  const chain = []
  let current = Number(pid)
  const seen = new Set()
  for (let depth = 0; depth < maxDepth && current > 0 && !seen.has(current); depth += 1) {
    seen.add(current)
    const entry = table.get(current)
    if (!entry) {
      chain.push({ pid: current, name: '', exePath: '', commandLine: '' })
      break
    }
    chain.push({ pid: entry.pid, name: entry.name, exePath: entry.exePath, commandLine: entry.commandLine })
    if (!entry.parentPid || entry.parentPid === current) break
    current = entry.parentPid
  }
  return chain
}

/** 按引号切分命令行（只做字符串处理，不执行任何东西） */
export function tokenizeCommandLine(commandLine) {
  const tokens = []
  const pattern = /"([^"]*)"|'([^']*)'|(\S+)/g
  let match
  while ((match = pattern.exec(String(commandLine || ''))) !== null) {
    const token = match[1] ?? match[2] ?? match[3] ?? ''
    if (token) tokens.push(token)
  }
  return tokens
}

const PATH_FLAGS = new Set(['--prefix', '-c', '--cwd', '--project', '--app-dir', '--chdir', '--root', '--config', '-p', '--directory', '-w'])
const WINDOWS_ABSOLUTE = /^[a-zA-Z]:[\\/]/
const UNC = /^\\\\[^\\]+\\/
const RELATIVE = /^\.{1,2}[\\/]/
const KNOWN_EXTENSIONS = /\.(js|mjs|cjs|ts|tsx|jsx|py|json|toml|yml|yaml|jar|exe|rb|go|rs|php|sh|bat|cmd|ps1)$/i

function looksLikePath(token) {
  if (!token || token.length > 400) return false
  if (token.startsWith('-') || token.startsWith('/') === false && token.includes('=')) return false
  return WINDOWS_ABSOLUTE.test(token) || UNC.test(token) || RELATIVE.test(token) || (token.includes('\\') && KNOWN_EXTENSIONS.test(token))
}

function safeStat(target) {
  try {
    return fs.statSync(target)
  } catch {
    return null
  }
}

/** 从命令行里提取真实存在的路径候选（绝对路径才会被采信） */
export function extractPathCandidates(commandLine) {
  const tokens = tokenizeCommandLine(commandLine)
  const candidates = []
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index]
    let value = token
    if (PATH_FLAGS.has(token.toLowerCase()) && tokens[index + 1]) {
      value = tokens[index + 1]
      index += 1
    } else if (!looksLikePath(token)) {
      continue
    }
    if (!WINDOWS_ABSOLUTE.test(value) && !UNC.test(value)) continue // 相对路径没有 cwd 依据，不猜
    const stat = safeStat(value)
    if (!stat) continue
    candidates.push(stat.isDirectory() ? { dir: value, kind: 'dir' } : { dir: path.dirname(value), kind: 'file', file: value })
  }
  return candidates
}

/**
 * 从 cmd / powershell 的父进程命令行里找 cd / Set-Location 提示。
 *
 * 两条硬规则（都是踩过坑之后加的）：
 *  1. 只看**直接父进程**：进程继承的是直接父进程的工作目录；祖父级 shell 的 cwd 与它无关，
 *     否则会出现"某个很久以前的终端 cd 到过项目 A，于是所有进程都被算到项目 A"。
 *  2. 必须**验证**：目录里得真的存在该进程命令行中的相对路径（例如 `node server/src/index.js`），
 *     或者进程 exe 就在该目录下；否则这条提示直接丢弃。
 */
export function extractCdHints(chain, process = {}) {
  const hints = []
  const parent = (chain || [])[1]
  if (!parent) return hints

  const commandLine = parent.commandLine || ''
  if (!commandLine) return hints

  const processTokens = process.commandLine ? tokenizeCommandLine(process.commandLine) : []
  const relativeTokens = processTokens.filter(
    (token) => !WINDOWS_ABSOLUTE.test(token) && !UNC.test(token) && !token.startsWith('-') && (token.includes('/') || token.includes('\\')),
  )

  const patterns = [
    /cd\s+\/d\s+"([^"]+)"/i,
    /cd\s+\/d\s+([^\s&]+)/i,
    /cd\s+"([^"]+)"/i,
    /Set-Location\s+(?:-Path\s+)?["']?([^"';&]+)["']?/i,
    /--prefix\s+"?([^"\s]+)"?/i,
  ]

  for (const pattern of patterns) {
    const match = commandLine.match(pattern)
    if (!match || !match[1]) continue
    const dir = match[1].trim()
    if ((!WINDOWS_ABSOLUTE.test(dir) && !UNC.test(dir)) || !safeStat(dir)?.isDirectory()) continue

    const normalized = path.resolve(dir)
    const hasRelative = relativeTokens.some((token) => safeStat(path.join(normalized, token)))
    const exeInside = Boolean(process.exePath) && path.resolve(process.exePath).toLowerCase().startsWith(`${normalized.toLowerCase()}\\`)
    if (!hasRelative && !exeInside) continue // 无法验证，宁可不给结论

    hints.push({ dir: normalized, source: `父进程 ${parent.name || parent.pid} 的工作目录（已用命令行验证）` })
    break
  }
  return hints
}

/** 从 exe 路径推断项目目录（venv / node_modules / target 等常见结构） */
export function inferDirsFromExe(exePath) {
  const out = []
  if (!exePath) return out
  const normalized = exePath.replace(/\//g, '\\')
  const lower = normalized.toLowerCase()
  const patterns = [
    { marker: '\\node_modules\\', source: 'exe 位于 node_modules 内' },
    { marker: '\\.venv\\', source: 'exe 位于 .venv 虚拟环境内' },
    { marker: '\\venv\\', source: 'exe 位于 venv 虚拟环境内' },
    { marker: '\\target\\debug\\', source: 'exe 位于 Rust target 目录内' },
    { marker: '\\target\\release\\', source: 'exe 位于 Rust target 目录内' },
    { marker: '\\bin\\debug\\', source: 'exe 位于 .NET bin 目录内' },
    { marker: '\\build\\libs\\', source: 'exe 位于 Gradle 构建目录内' },
  ]
  for (const pattern of patterns) {
    const index = lower.indexOf(pattern.marker)
    if (index > 0) out.push({ dir: normalized.slice(0, index), source: pattern.source })
  }
  if (out.length === 0) out.push({ dir: path.dirname(normalized), source: 'exe 所在目录' })
  return out
}

/**
 * 汇总一个进程的"可能项目目录"候选（去重、按可信度排序）。
 * 这些只是**推断**，最终目录由 projectDetector 在该候选及其上级目录里找项目标记文件确认。
 */
export function inferCandidateDirs(process, chain = [], { limit = 6 } = {}) {
  const found = []
  const push = (dir, source, confidence) => {
    if (!dir) return
    const normalized = path.resolve(dir)
    if (found.some((item) => item.dir.toLowerCase() === normalized.toLowerCase())) return
    found.push({ dir: normalized, source, confidence })
  }

  for (const candidate of extractPathCandidates(process.commandLine)) {
    push(candidate.dir, candidate.kind === 'file' ? `命令行中的文件 ${candidate.file}` : '命令行中的目录参数', 0.9)
  }
  for (const hint of extractCdHints(chain, process)) push(hint.dir, hint.source, 0.85)
  for (const item of inferDirsFromExe(process.exePath)) push(item.dir, item.source, item.source === 'exe 所在目录' ? 0.4 : 0.7)

  return found.sort((a, b) => b.confidence - a.confidence).slice(0, limit)
}

/** 命名空间导出（便于在服务层整体引用与测试注入） */
export const processInspector = {
  getProcessTable,
  buildParentChain,
  tokenizeCommandLine,
  extractPathCandidates,
  extractCdHints,
  inferDirsFromExe,
  inferCandidateDirs,
}
