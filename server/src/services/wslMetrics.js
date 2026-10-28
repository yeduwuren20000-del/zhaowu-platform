import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * WSL 只读采集。
 *
 * 为什么必须单独走 WSL：WSL2 有**独立的网络命名空间**，里面监听的服务
 * 在 Windows 侧完全查不到 —— 实测 WSL 内 `ss` 显示 `LISTEN 0.0.0.0:18099`，
 * 而 Windows 的 `Get-NetTCPConnection` 完全看不到 18099。
 * 所以工作台只能**主动进入每个发行版**去问。
 *
 * 实测特征（决定了下面这些设计）：
 *  - 单个发行版冷启动约 3 秒 → 必须并行，且必须有超时保护；
 *  - `wsl.exe` 会往 stderr 写 localhost 代理警告，退出码非 0 但**命令其实成功了**，
 *    所以不能用退出码判断成败，只能看 stdout；
 *  - 输出是 UTF-16LE（`wsl --list`），需要单独解码；
 *  - `ss` 输出里有 `127.0.0.54%lo:53` 这种带接口名的地址，需要容错解析。
 *
 * 只读约束：不执行任何来自前端的命令，脚本是常量字符串；
 * 不做 start/stop/exec/rm —— WSL 只做"看见"，不做"控制"。
 */

const DEFAULT_TIMEOUT_MS = 20000

/** Docker Desktop 的内部发行版，不是用户的开发环境 */
const HIDDEN_DISTROS = new Set(['docker-desktop', 'docker-desktop-data'])

/** WSL 内部基础设施端口：DNS 解析器等，不该当成用户的项目服务 */
const WSL_SYSTEM_PORTS = new Set([53])

/** 采集脚本：常量字符串，只做查询 */
const SCRIPT = [
  'ss -tlnpH 2>/dev/null | head -n 300',
  'echo "@@SEP"',
  'ps -eo pid=,comm=,args= --no-headers 2>/dev/null | grep -vE "grep|/bin/sh -c|bash -lc" | head -n 300',
].join('; ')

/** decode('buffer') 下 wsl.exe 输出是 UTF-16LE，要单独转；失败回退 utf8 */
function decodeOutput(buf) {
  if (!buf || buf.length === 0) return ''
  if (buf.length >= 2 && buf[0] === 0xff && buf[1] === 0xfe) return buf.subarray(2).toString('utf16le')
  // 部分版本即使不加 -l 也可能输出 UTF-16LE：特征是每两个字节高位为 0
  const looksUtf16 = buf.length >= 8 && buf[1] === 0 && buf[3] === 0
  if (looksUtf16) return Buffer.from(buf).toString('utf16le')
  return buf.toString('utf8')
}

async function runWsl(args, { timeout = DEFAULT_TIMEOUT_MS } = {}) {
  try {
    const { stdout } = await execFileAsync('wsl.exe', args, {
      windowsHide: true,
      timeout,
      maxBuffer: 8 * 1024 * 1024,
      encoding: 'buffer',
    })
    return { ok: true, out: decodeOutput(stdout) }
  } catch (error) {
    // 关键：wsl.exe 会因为 stderr 有警告而返回非 0，但 stdout 里往往已经有我们要的内容，
    // 所以失败时也把 stdout 带出来，由调用方判断"有没有有效数据"。
    return {
      ok: false,
      out: error.stdout ? decodeOutput(error.stdout) : '',
      error: error.message || String(error),
      killed: Boolean(error.killed),
    }
  }
}

/**
 * 解析 `ss -tlnpH` 的输出。
 * 典型行：
 *   LISTEN 0  4096  0.0.0.0:8080  0.0.0.0:*  users:(("node",pid=1234,fd=20))
 *   LISTEN 0  1000  127.0.0.54%lo:53  0.0.0.0:*          ← 带接口名，必须容错
 *   LISTEN 0  128   [::]:5173       [::]:*                 ← IPv6
 */
export function parseSsOutput(text) {
  const rows = []
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || !/^LISTEN/i.test(line)) continue

    // 拆成列：State Recv-Q Send-Q Local Peer [Process]
    const cols = line.split(/\s+/)
    if (cols.length < 4) continue
    const local = cols[3]
    const peer = cols[4] || ''

    // 本地地址：可能带 %接口名（127.0.0.54%lo:53）
    const localPart = String(local).replace(/\]$/, '')
    const lastColon = localPart.lastIndexOf(':')
    if (lastColon <= 0) continue
    const portText = localPart.slice(lastColon + 1)
    const port = Number(portText)
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue
    // 去掉 %iface，并处理 IPv6 的 [::]
    let address = localPart.slice(0, lastColon).split('%')[0]
    if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1)

    // 进程：users:(("name",pid=123,fd=20))
    let processName = ''
    let pid = null
    const procMatch = line.match(/users:\(\("([^"]+)"(?:,pid=(\d+))?/)
    if (procMatch) {
      processName = procMatch[1] || ''
      if (procMatch[2]) pid = Number(procMatch[2])
    }

    rows.push({ port, address, peer: String(peer).split('%')[0], processName, pid })
  }
  return rows
}

/** 解析 `ps -eo pid=,comm=,args=` 输出 */
export function parsePsOutput(text) {
  const rows = []
  for (const rawLine of String(text || '').split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    const m = line.match(/^(\d+)\s+(\S+)\s*(.*)$/)
    if (!m) continue
    rows.push({ pid: Number(m[1]), processName: m[2], commandLine: (m[3] || '').trim() })
  }
  return rows
}

/** 列出所有发行版（跳过 Docker Desktop 内部发行版） */
export async function listDistros() {
  const { ok, out, error } = await runWsl(['--list', '--quiet'], { timeout: 10000 })
  if (!out.trim()) return { distros: [], error: error || null }
  const all = out
    .split(/\r?\n/)
    .map((item) => item.replace(/\0/g, '').trim())
    .filter(Boolean)
  return {
    distros: all.filter((name) => !HIDDEN_DISTROS.has(name.toLowerCase())),
    hidden: all.filter((name) => HIDDEN_DISTROS.has(name.toLowerCase())),
  }
}

/** 采集单个发行版 */
export async function collectDistro(name, { timeout = DEFAULT_TIMEOUT_MS } = {}) {
  const startedAt = Date.now()
  const { out, error, killed } = await runWsl(['-d', name, '--', 'bash', '-lc', SCRIPT], { timeout })

  if (killed) {
    return { name, ok: false, error: `采集超时（${timeout}ms）`, ports: [], processes: [], durationMs: Date.now() - startedAt }
  }

  const [netText = '', psText = ''] = out.split('@@SEP')
  const allPorts = parseSsOutput(netText)
  const processes = parsePsOutput(psText)

  // 端口对应的进程名：ss 只对有权限的进程显示 users:()，这里用 ps 补齐
  const procByPid = new Map(processes.map((item) => [item.pid, item]))
  const ports = allPorts
    .filter((row) => !WSL_SYSTEM_PORTS.has(row.port))
    .map((row) => {
      const proc = row.pid ? procByPid.get(row.pid) : null
      return {
        ...row,
        processName: row.processName || proc?.processName || '',
        commandLine: proc?.commandLine || '',
        isSystem: WSL_SYSTEM_PORTS.has(row.port),
      }
    })
    .sort((a, b) => a.port - b.port)

  return {
    name,
    ok: ports.length > 0 || processes.length > 0,
    error: error || null,
    ports,
    processes,
    durationMs: Date.now() - startedAt,
  }
}

/**
 * 并行采集所有发行版。
 * 实测单个约 3 秒，串行会叠加到 6+ 秒，所以必须并行。
 */
export async function collectAllDistros({ timeout = DEFAULT_TIMEOUT_MS, includeProcesses = true } = {}) {
  const { distros, error: listError } = await listDistros()
  if (!distros.length) {
    return { distros: [], results: [], error: listError || '没有找到 WSL 发行版' }
  }
  const results = await Promise.all(
    distros.map((name) => collectDistro(name, { timeout }).then((r) => (includeProcesses ? r : { ...r, processes: [] }))),
  )
  return { distros, results, error: null }
}

/** wsl.exe 是否可用（没装 WSL / 旧版 Windows 时给出可读提示） */
export async function wslAvailable() {
  const { ok, out, error } = await runWsl(['--status'], { timeout: 8000 })
  const text = `${out}\n${error || ''}`
  if (/install|not installed|不是内部|安装/i.test(text) && !ok) {
    return { available: false, reason: '这台机器没有可用的 WSL（可在 PowerShell 执行 wsl --install 安装）' }
  }
  return { available: true, reason: null }
}