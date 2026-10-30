import net from 'node:net'
import { PORT_SCAN_TTL_MS } from '../config.js'
import { isWindows, runFile, runPowerShellJson } from '../utils/exec.js'

/**
 * 端口扫描：读取真实的监听表（PowerShell Get-NetTCPConnection，回退 netstat -ano）。
 * 带 TTL 缓存，避免一次页面刷新里反复调用 PowerShell。
 */

const PS_LISTEN = `
$rows = New-Object System.Collections.ArrayList
foreach ($c in Get-NetTCPConnection -State Listen -ErrorAction Stop) {
  $p = $null
  try { $p = Get-Process -Id $c.OwningProcess -ErrorAction Stop } catch { $p = $null }
  [void]$rows.Add([pscustomobject]@{
    port = [int]$c.LocalPort
    pid = [int]$c.OwningProcess
    address = [string]$c.LocalAddress
    processName = $(if ($p) { [string]$p.ProcessName } else { '' })
  })
}
ConvertTo-Json -InputObject @($rows) -Compress
`

let cache = { at: 0, entries: [] }
// 正在跑的那次扫描：并发请求共享同一个 Promise，避免几十个请求各 spawn 一个 PowerShell
// （实测 40 并发读会退化到 36 秒，因为 40 个 Get-NetTCPConnection 互相抢 CPU）
let inflight = null

function isLoopbackOrAny(address) {
  return address === '0.0.0.0' || address === '127.0.0.1' || address === '::' || address === '::1'
}

/** 同一端口可能同时有 IPv4/IPv6 两条监听记录，这里收敛成一条"有代表性的"记录 */
function pickRepresentative(entries) {
  const withName = entries.filter((entry) => entry.processName)
  const pool = withName.length > 0 ? withName : entries
  return pool.find((entry) => isLoopbackOrAny(entry.address)) || pool[0]
}

async function scanWithPowerShell() {
  const raw = await runPowerShellJson(PS_LISTEN, { timeout: 20000 })
  const list = Array.isArray(raw) ? raw : raw ? [raw] : []
  return list
    .map((row) => ({
      port: Number(row.port),
      pid: Number(row.pid),
      address: String(row.address || ''),
      processName: String(row.processName || ''),
    }))
    .filter((row) => Number.isInteger(row.port) && row.port > 0)
}

async function scanWithNetstat() {
  const { stdout } = await runFile('netstat', ['-ano'], { timeout: 20000 })
  const entries = []
  for (const line of stdout.split(/\r?\n/)) {
    const match = line.trim().match(/^TCP\s+(\S+):(\d+)\s+\S+\s+LISTENING\s+(\d+)$/)
    if (!match) continue
    entries.push({
      address: match[1].replace(/^\[|\]$/g, ''),
      port: Number(match[2]),
      pid: Number(match[3]),
      processName: '',
    })
  }
  if (entries.length === 0) return entries
  // netstat 不带进程名，用 tasklist 一次性补齐
  try {
    const { stdout: tasklist } = await runFile('tasklist', ['/FO', 'CSV', '/NH'], { timeout: 20000 })
    const names = new Map()
    for (const line of tasklist.split(/\r?\n/)) {
      const cells = line.match(/"([^"]*)"/g)
      if (!cells || cells.length < 2) continue
      const name = cells[0].replace(/"/g, '')
      const pid = Number(cells[1].replace(/"/g, ''))
      if (Number.isInteger(pid)) names.set(pid, name.replace(/\.exe$/i, ''))
    }
    for (const entry of entries) entry.processName = names.get(entry.pid) || ''
  } catch {
    // 拿不到进程名不影响端口状态展示
  }
  return entries
}

async function runScan() {
  if (!isWindows()) return []
  let entries
  try {
    entries = await scanWithPowerShell()
  } catch (error) {
    console.warn(`[ports] Get-NetTCPConnection 不可用，改用 netstat：${error.message}`)
    entries = await scanWithNetstat()
  }
  // 同端口去重（保留带进程名/通配地址的那条）
  const grouped = new Map()
  for (const entry of entries) {
    const list = grouped.get(entry.port) || []
    list.push(entry)
    grouped.set(entry.port, list)
  }
  return [...grouped.values()].map(pickRepresentative).sort((a, b) => a.port - b.port)
}

async function scan({ force = false } = {}) {
  const now = Date.now()
  if (!force && cache.entries.length > 0 && now - cache.at < PORT_SCAN_TTL_MS) return cache.entries
  // force 只用来"忽略旧缓存重新扫"，不代表必须自己扫：已经在跑就一起等
  if (inflight) return inflight
  inflight = runScan()
    .then((entries) => {
      cache = { at: Date.now(), entries }
      return entries
    })
    .finally(() => {
      inflight = null
    })
  return inflight
}

/** 端口 -> 记录 的索引 */
async function getPortIndex(options) {
  const entries = await scan(options)
  return new Map(entries.map((entry) => [entry.port, entry]))
}

async function getPortOwners(port, options) {
  if (!port) return []
  const entries = await scan(options)
  return entries.filter((entry) => entry.port === Number(port))
}

async function isPortListening(port, options) {
  if (!port) return false
  const owners = await getPortOwners(port, options)
  return owners.length > 0
}

/** 从 from 起找第一个空闲端口（避让用）；找不到返回 null
 *  只做一次全机扫描（拿到端口索引），循环里只查索引，避免逐个端口各扫一次（最坏 200 次扫描） */
async function findFreePort(from, { limit = 200 } = {}) {
  const index = await getPortIndex()
  const taken = new Set(index.keys())
  for (let port = Number(from); port <= Math.min(Number(from) + limit, 65535); port += 1) {
    if (!taken.has(port)) return port
  }
  return null
}

/** 轮询等待端口进入期望状态 */
async function waitForPort(port, { want = true, timeoutMs = 15000, intervalMs = 600 } = {}) {
  if (!port) return false
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const listening = await isPortListening(port)
    if (listening === want) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, intervalMs))
  }
}

/**
 * 轻量端口探针：直接对环回地址做一个 TCP connect，而不去枚举全机监听表。
 * 用于"这个端口现在能不能打开"（打开应用探活、端口页快速判断）这类高频、单端口的问题。
 *   - 命中缓存（默认 1.5s）时几乎零成本；
 *   - 命中（监听）时 ~1ms；未命中（未监听）时等超时（默认 500ms），仍远快于一次完整扫描（~4s）。
 * 同时试 IPv4/IPv6 环回：localhost 可能解析到任一，任一通即视为可打开。
 */
const probeCache = new Map()
const PROBE_TTL_MS = 1500

function tcpProbeOnce(host, port, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false
    const socket = net.connect({ host, port })
    const finish = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      socket.destroy()
      resolve(value)
    }
    const timer = setTimeout(() => finish(false), timeoutMs)
    socket.on('connect', () => finish(true))
    socket.on('error', () => finish(false))
    socket.on('close', () => finish(false))
  })
}

async function probePort(port, { timeoutMs = 500, force = false } = {}) {
  const portNum = Number(port)
  if (!Number.isInteger(portNum) || portNum < 1 || portNum > 65535) return false
  const cached = probeCache.get(portNum)
  if (!force && cached && Date.now() - cached.at < PROBE_TTL_MS) return cached.listening
  const [v4, v6] = await Promise.all([
    tcpProbeOnce('127.0.0.1', portNum, timeoutMs),
    tcpProbeOnce('::1', portNum, timeoutMs),
  ])
  const listening = v4 || v6
  probeCache.set(portNum, { at: Date.now(), listening })
  return listening
}

export const portScanner = {
  scan,
  getPortIndex,
  getPortOwners,
  isPortListening,
  findFreePort,
  waitForPort,
  probePort,
  /** 清端口状态缓存：同时清「全机监听表结果缓存」与「轻量探针缓存」。
   *  端口刚变过状态（启动 / 停止 / 注册 / 设置变更）时，两处陈旧的"在不在监听"判断都要失效——
   *  否则探活可能在 1.5s 内仍读到旧结论（比如刚启动的服务短暂被判为"没在运行"）。
   *  inflight 保持不动：正在跑的那次扫描本身就是新鲜的，让后来的请求共享它。 */
  invalidate() {
    cache = { at: 0, entries: [] }
    probeCache.clear()
  },
}
