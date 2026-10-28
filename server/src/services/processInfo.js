import { isWindows, runPowerShellJson, runFile } from '../utils/exec.js'

/**
 * 进程信息：PID -> 进程名 / 内存 / 启动时间 / 可执行路径。
 * 存活判断用 process.kill(pid, 0)，无进程创建开销。
 */

/** 该进程是否是本项目之外不该动的系统进程（停止操作的安全护栏） */
const PROTECTED_NAMES = new Set([
  'system', 'idle', 'registry', 'smss', 'csrss', 'wininit', 'winlogon', 'services',
  'lsass', 'svchost', 'explorer', 'dwm', 'fontdrvhost', 'spoolsv', 'taskhostw',
  'sihost', 'ctfmon', 'searchindexer', 'securityhealthservice', 'audiodg',
])

export function isPidAlive(pid) {
  const numeric = Number(pid)
  if (!Number.isInteger(numeric) || numeric <= 0) return false
  try {
    process.kill(numeric, 0)
    return true
  } catch (error) {
    // EPERM：进程存在但当前用户无权限（例如系统进程）
    return error.code === 'EPERM'
  }
}

export function isProtectedProcessName(name) {
  if (!name) return false
  return PROTECTED_NAMES.has(String(name).toLowerCase().replace(/\.exe$/i, ''))
}

const PS_STATS = (pids) => `
$ids = @(${pids.join(',')})
$rows = foreach ($id in $ids) {
  $p = Get-Process -Id $id -ErrorAction SilentlyContinue
  if ($p) {
    $started = ''
    try { $started = $p.StartTime.ToUniversalTime().ToString('o') } catch { $started = '' }
    $exe = ''
    try { $exe = [string]$p.Path } catch { $exe = '' }
    [pscustomobject]@{
      pid = [int]$p.Id
      name = [string]$p.ProcessName
      memory = [long]$p.WorkingSet64
      startedAt = $started
      path = $exe
    }
  }
}
ConvertTo-Json -InputObject @($rows) -Compress
`

/** 批量查询进程统计：返回 Map<pid, {name, memory, startedAt, path}> */
async function getProcessStats(pids = []) {
  const wanted = [...new Set(pids.map(Number).filter((pid) => Number.isInteger(pid) && pid > 0))]
  const result = new Map()
  if (wanted.length === 0 || !isWindows()) return result
  try {
    const raw = await runPowerShellJson(PS_STATS(wanted), { timeout: 20000 })
    const list = Array.isArray(raw) ? raw : raw ? [raw] : []
    for (const row of list) {
      result.set(Number(row.pid), {
        pid: Number(row.pid),
        name: String(row.name || ''),
        memory: Number(row.memory || 0),
        startedAt: row.startedAt ? String(row.startedAt) : null,
        path: row.path ? String(row.path) : '',
      })
    }
  } catch (error) {
    console.warn(`[process] 读取进程信息失败：${error.message}`)
  }
  return result
}

/** 单个 PID 的进程名（用于判断端口归属是否就是项目自身） */
async function getProcessName(pid) {
  if (!isPidAlive(pid)) return ''
  if (!isWindows()) return ''
  try {
    const { stdout } = await runFile('tasklist', ['/FI', `PID eq ${Number(pid)}`, '/FO', 'CSV', '/NH'], { timeout: 10000 })
    const cells = stdout.match(/"([^"]*)"/g)
    if (!cells || cells.length === 0) return ''
    return cells[0].replace(/"/g, '').replace(/\.exe$/i, '')
  } catch {
    return ''
  }
}

/**
 * 向上追溯父进程链（含自身）。
 * 启动命令通常由 shell（cmd.exe）拉起，真正的监听进程是它的子进程，
 * 判断"端口是不是我的"必须沿着父进程链比对，而不能只看 PID 相等。
 */
async function getAncestorPids(pid, maxDepth = 8) {
  const start = Number(pid)
  const chain = []
  if (!Number.isInteger(start) || start <= 0 || !isWindows()) return chain
  let current = start
  for (let depth = 0; depth < maxDepth && current > 0; depth += 1) {
    chain.push(current)
    try {
      const raw = await runPowerShellJson(
        `$p = Get-CimInstance Win32_Process -Filter "ProcessId=${current}" -ErrorAction SilentlyContinue;` +
          'if ($p) { [int]$p.ParentProcessId } else { 0 }',
        { timeout: 10000 },
      )
      const parent = Number(raw)
      if (!Number.isInteger(parent) || parent <= 0 || parent === current) break
      current = parent
    } catch {
      break
    }
  }
  return chain
}

export const processInfo = {
  isPidAlive,
  isProtectedProcessName,
  getProcessStats,
  getProcessName,
  getAncestorPids,
}
