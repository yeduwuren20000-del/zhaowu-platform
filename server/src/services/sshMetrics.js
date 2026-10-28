/**
 * 只读采集：一条固定的 POSIX 脚本取回 hostname / OS / uptime / CPU / 内存 / 磁盘 / 负载 / 监听端口。
 *
 * 设计约束：
 *  - 命令是**常量**，不接受任何来自前端或数据库的拼接文本（没有任意命令执行入口）；
 *  - 全部为读取类命令，带多级回退（ss -> netstat，free -> /proc/meminfo，df -PT -> df -Pk …）；
 *  - 用 @@S: 标记分段，解析端按段取值，任何一段失败都不影响其它段。
 */

export const METRICS_COMMAND = [
  'echo "@@S:hostname"',
  'hostname 2>/dev/null || cat /proc/sys/kernel/hostname 2>/dev/null',
  'echo "@@S:user"',
  'id -un 2>/dev/null || whoami 2>/dev/null',
  'echo "@@S:os"',
  '(. /etc/os-release 2>/dev/null && printf "%s\\n" "$PRETTY_NAME") 2>/dev/null || uname -sr',
  'echo "@@S:kernel"',
  'uname -sr 2>/dev/null',
  'echo "@@S:arch"',
  'uname -m 2>/dev/null',
  'echo "@@S:uptime"',
  'cut -d" " -f1 /proc/uptime 2>/dev/null || uptime 2>/dev/null',
  'echo "@@S:load"',
  'cat /proc/loadavg 2>/dev/null || uptime 2>/dev/null',
  'echo "@@S:cores"',
  'nproc 2>/dev/null || getconf _NPROCESSORS_ONLN 2>/dev/null || echo 0',
  'echo "@@S:cpu1"',
  'head -n 1 /proc/stat 2>/dev/null',
  'sleep 1',
  'echo "@@S:cpu2"',
  'head -n 1 /proc/stat 2>/dev/null',
  'echo "@@S:mem"',
  'free -b 2>/dev/null || cat /proc/meminfo 2>/dev/null',
  'echo "@@S:disk"',
  'df -PT -B1 2>/dev/null || df -P -B1 2>/dev/null || df -Pk / 2>/dev/null',
  'echo "@@S:ports"',
  '(command -v ss >/dev/null 2>&1 && ss -lntup 2>/dev/null) || (netstat -lntup 2>/dev/null || netstat -lnt 2>/dev/null)',
  'echo "@@S:end"',
].join('\n')

/** 把标记分段解析成 { hostname: '…', os: '…' }；prefix 可复用给 docker 采集输出 */
export function parseSections(stdout, prefix = '@@S') {
  const sections = {}
  let current = null
  const buffer = []
  const flush = () => {
    if (current) sections[current] = buffer.join('\n').trim()
    buffer.length = 0
  }
  const markerPattern = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}:([a-z0-9]+)\\s*$`)
  for (const line of String(stdout || '').split(/\r?\n/)) {
    const marker = line.match(markerPattern)
    if (marker) {
      flush()
      current = marker[1]
      continue
    }
    if (current) buffer.push(line)
  }
  flush()
  return sections
}

function toInt(value, fallback = 0) {
  const number = Number.parseInt(value, 10)
  return Number.isFinite(number) ? number : fallback
}

export function parseUptime(text) {
  const raw = String(text || '').trim()
  const first = raw.split(/\s+/)[0]
  // /proc/uptime 是纯数字；`uptime` 文本以时间开头（10:20:30），必须走文本分支
  if (first && /^\d+(\.\d+)?$/.test(first)) {
    const seconds = Number.parseFloat(first)
    if (Number.isFinite(seconds)) return Math.round(seconds)
  }
  const match = raw.match(/up\s+(?:(\d+)\s+day[s]?,?\s*)?(\d+):(\d+)/i)
  if (match) {
    return toInt(match[1]) * 86400 + toInt(match[2]) * 3600 + toInt(match[3]) * 60
  }
  return null
}

export function parseLoad(text) {
  const raw = String(text || '')
  const loadMatch = raw.match(/load average[s]?:\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)/i)
  if (loadMatch) return { one: Number(loadMatch[1]), five: Number(loadMatch[2]), fifteen: Number(loadMatch[3]) }
  const parts = raw.trim().split(/\s+/)
  if (parts.length >= 3 && parts.slice(0, 3).every((part) => Number.isFinite(Number(part)))) {
    return { one: Number(parts[0]), five: Number(parts[1]), fifteen: Number(parts[2]) }
  }
  return null
}

/** /proc/stat 的 cpu 行 -> 忙/总 jiffies */
function parseCpuLine(line) {
  const parts = String(line || '').trim().split(/\s+/)
  if (parts[0] !== 'cpu' || parts.length < 5) return null
  const values = parts.slice(1, 11).map((value) => toInt(value))
  const total = values.reduce((sum, value) => sum + value, 0)
  const idle = (values[3] || 0) + (values[4] || 0) // idle + iowait
  return { total, idle, busy: total - idle }
}

/** 两次采样算 CPU 使用率（%） */
export function parseCpuUsage(stat1, stat2) {
  const first = parseCpuLine(stat1)
  const second = parseCpuLine(stat2)
  if (!first || !second) return null
  const totalDiff = second.total - first.total
  const idleDiff = second.idle - first.idle
  if (totalDiff <= 0) return null
  const usage = ((totalDiff - idleDiff) / totalDiff) * 100
  return Math.max(0, Math.min(100, Math.round(usage * 10) / 10))
}

/** free -b 或 /proc/meminfo 两种格式都能解析 */
export function parseMemory(text) {
  const raw = String(text || '')
  if (!raw.trim()) return null

  const meminfo = (key) => {
    const match = raw.match(new RegExp(`^${key}:\\s+(\\d+)\\s*kB`, 'm'))
    return match ? toInt(match[1]) * 1024 : null
  }

  if (/MemTotal:/.test(raw)) {
    const total = meminfo('MemTotal')
    if (!total) return null
    const available = meminfo('MemAvailable') ?? meminfo('MemFree')
    const used = Math.max(0, total - (available ?? 0))
    const swapTotal = meminfo('SwapTotal') ?? 0
    const swapFree = meminfo('SwapFree') ?? 0
    return {
      totalBytes: total,
      usedBytes: used,
      availableBytes: available ?? 0,
      usedPercent: total > 0 ? Math.round((used / total) * 1000) / 10 : 0,
      swapTotalBytes: swapTotal,
      swapUsedBytes: Math.max(0, swapTotal - swapFree),
    }
  }

  const lineOf = (prefix) => raw.split(/\r?\n/).find((line) => line.trim().startsWith(prefix)) || ''
  const numbers = (line) => line.trim().split(/\s+/).slice(1).map((value) => Number.parseFloat(value) || 0)
  const mem = numbers(lineOf('Mem:'))
  if (mem.length < 6) return null
  const [total, , , , , available] = mem
  const swap = numbers(lineOf('Swap:'))
  // 与 meminfo 分支保持一致：以 "可用内存" 计算占用，而不是 free 的 used 列
  const used = Math.max(0, total - (available ?? 0))
  return {
    totalBytes: Math.round(total),
    usedBytes: Math.round(used),
    availableBytes: Math.round(available ?? 0),
    usedPercent: total > 0 ? Math.round((used / total) * 1000) / 10 : 0,
    swapTotalBytes: Math.round(swap[0] || 0),
    swapUsedBytes: Math.round(swap[1] || 0),
  }
}

/** df -PT -B1 / df -P -B1 / df -Pk 三种输出都能解析 */
export function parseDisk(text) {
  const lines = String(text || '').split(/\r?\n/).filter((line) => line.trim())
  if (lines.length < 2) return []
  const header = lines[0]
  const hasType = /type/i.test(header)
  const inKb = !/-B1/.test(header) && /1k-blocks/i.test(header)
  const result = []
  for (const line of lines.slice(1)) {
    const parts = line.trim().split(/\s+/)
    if (parts.length < 5) continue
    const filesystem = parts[0]
    if (filesystem.startsWith('map ') || filesystem === 'Filesystem') continue
    const offset = hasType ? 1 : 0
    const type = hasType ? parts[1] : ''
    const size = Number.parseFloat(parts[1 + offset]) || 0
    const used = Number.parseFloat(parts[2 + offset]) || 0
    const avail = Number.parseFloat(parts[3 + offset]) || 0
    const percentRaw = parts[4 + offset] || ''
    const mount = parts.slice(5 + offset).join(' ') || '/'
    if (!Number.isFinite(size) || size <= 0) continue
    const factor = inKb ? 1024 : 1
    result.push({
      filesystem,
      type,
      mount,
      sizeBytes: Math.round(size * factor),
      usedBytes: Math.round(used * factor),
      availBytes: Math.round(avail * factor),
      usePercent: Number.parseFloat(percentRaw.replace('%', '')) || (size > 0 ? Math.round((used / size) * 1000) / 10 : 0),
    })
  }
  return result
}

function normalizeAddress(rawAddress) {
  let address = String(rawAddress || '').trim()
  let port = null
  const bracket = address.match(/^\[(.+)\]:(\d+)$/)
  if (bracket) {
    address = bracket[1]
    port = toInt(bracket[2])
  } else if (address.startsWith('*:')) {
    // ss 的通配写法：*:9100
    port = toInt(address.slice(2), NaN)
    address = '*'
  } else {
    const index = address.lastIndexOf(':')
    if (index > 0) {
      port = toInt(address.slice(index + 1), NaN)
      address = address.slice(0, index)
    }
  }
  if (!Number.isFinite(port) || port <= 0) return null
  return { address: address || '*', port }
}

function parseProcessField(text) {
  const raw = String(text || '')
  const ssMatch = raw.match(/users:\(\(\s*"([^"]+)"\s*,\s*pid=(\d+)/)
  if (ssMatch) return { process: ssMatch[1], pid: toInt(ssMatch[2]) }
  const netstatMatch = raw.match(/(\d+)\/(\S+)/)
  if (netstatMatch) return { process: netstatMatch[2], pid: toInt(netstatMatch[1]) }
  return { process: '', pid: null }
}

/** ss -lntup 与 netstat -lntup 都能解析：先看表头判断格式，再按格式取列 */
export function parseListeningPorts(text) {
  const lines = String(text || '').split(/\r?\n/)
  const ports = []
  const seen = new Set()

  // 表头判定：ss 以 "Netid" 开头，netstat 表头含 "PID/Program"
  const headText = lines.slice(0, 8).join('\n')
  const isSs = /^\s*Netid\b/im.test(headText)
  const isNetstat = /PID\/Program|Proto\s+Recv-Q/i.test(headText)
  let format = isSs ? 'ss' : isNetstat ? 'netstat' : 'auto'

  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed) continue
    if (/^(Netid|Proto|Active|State|Recv-Q)/i.test(trimmed)) continue

    const parts = trimmed.split(/\s+/)
    let proto = ''
    let addressField = ''
    let processField = ''
    let lineFormat = format

    if (lineFormat === 'auto') {
      // 无法从表头判断时，看第 4 列是不是 地址:端口
      lineFormat = (parts[4] || '').includes(':') && !(parts[3] || '').includes(':') ? 'ss' : 'netstat'
    }

    if (lineFormat === 'netstat') {
      // Proto Recv-Q Send-Q Local Foreign State PID/Program
      proto = (parts[0] || '').toLowerCase().replace('6', '')
      if (!['tcp', 'udp', 'raw', 'sctp'].includes(proto)) continue
      addressField = parts[3] || ''
      processField = parts.slice(6).join(' ')
      if (parts[5] && !/LISTEN|UNCONN|ESTAB|SYN/i.test(parts[5])) processField = parts.slice(5).join(' ')
    } else {
      // Netid State Recv-Q Send-Q Local Peer Process
      proto = (parts[0] || '').toLowerCase().replace('6', '')
      if (!['tcp', 'udp', 'raw', 'sctp'].includes(proto)) continue
      addressField = parts[4] || ''
      processField = parts.slice(6).join(' ')
    }

    const normalized = normalizeAddress(addressField)
    if (!normalized) continue
    const { process, pid } = parseProcessField(processField)
    const key = `${proto}:${normalized.address}:${normalized.port}`
    if (seen.has(key)) continue
    seen.add(key)
    ports.push({ proto, address: normalized.address, port: normalized.port, process, pid })
  }
  return ports.sort((a, b) => a.port - b.port)
}

/** 解析整段输出为一份监控快照 */
export function parseMetrics(stdout) {
  const sections = parseSections(stdout)
  const disk = parseDisk(sections.disk)
  return {
    hostname: (sections.hostname || '').split(/\r?\n/)[0].trim() || null,
    os: (sections.os || '').split(/\r?\n/)[0].trim() || null,
    kernel: (sections.kernel || '').trim() || null,
    arch: (sections.arch || '').trim() || null,
    loginUser: (sections.user || '').trim() || null,
    uptimeSec: parseUptime(sections.uptime),
    load: parseLoad(sections.load),
    cpuCores: toInt(sections.cores, 0) || null,
    cpuUsagePercent: parseCpuUsage(sections.cpu1, sections.cpu2),
    memory: parseMemory(sections.mem),
    disk: disk.filter((item) => item.mount === '/' || /^\/[^/]/.test(item.mount)).slice(0, 8),
    diskAll: disk.slice(0, 12),
    ports: parseListeningPorts(sections.ports),
  }
}

/** 端口核对：把真实监听端口与已登记的 APP/端口做比对 */
export const PORT_AUDIT_STATES = {
  ok: '正常',
  recordedNotListening: '记录存在但未监听',
  listeningNotRecorded: '监听但未登记',
}

export function auditPorts(apps = [], listeningPorts = []) {
  // 一个端口可能同时有 tcp/udp、0.0.0.0/127.0.0.1 多条记录，按端口收敛
  const liveByPort = new Map()
  for (const entry of listeningPorts) {
    const existing = liveByPort.get(entry.port)
    if (!existing) {
      liveByPort.set(entry.port, entry)
      continue
    }
    // 优先保留对外监听(tcp + 0.0.0.0/::)的那条
    const isPublic = (item) => item.proto === 'tcp' && (item.address === '0.0.0.0' || item.address === '::' || item.address === '*')
    if (isPublic(entry) && !isPublic(existing)) liveByPort.set(entry.port, entry)
  }

  const items = []
  const matchedPorts = new Set()

  for (const app of apps) {
    const port = Number(app.port) || null
    if (!port) {
      items.push({
        state: 'recordedNotListening',
        appId: app.id,
        appName: app.name,
        port: null,
        listen: null,
        detail: '未登记端口，无法核对监听状态',
      })
      continue
    }
    const live = liveByPort.get(port) || null
    if (live) matchedPorts.add(port)
    items.push({
      state: live ? 'ok' : 'recordedNotListening',
      appId: app.id,
      appName: app.name,
      port,
      deployPath: app.deployPath || '',
      listen: live ? { proto: live.proto, address: live.address, process: live.process, pid: live.pid } : null,
      detail: live
        ? `已登记且正在监听（${live.proto.toUpperCase()} ${live.address}:${live.port}${live.process ? ` · ${live.process}` : ''}）`
        : `记录为 ${port}，但远程没有该端口的监听`,
    })
  }

  for (const [port, live] of [...liveByPort.entries()].sort((a, b) => a[0] - b[0])) {
    if (matchedPorts.has(port)) continue
    items.push({
      state: 'listeningNotRecorded',
      appId: null,
      appName: live.process || '未知进程',
      port,
      deployPath: '',
      listen: { proto: live.proto, address: live.address, process: live.process, pid: live.pid },
      detail: `正在监听 ${live.proto.toUpperCase()} ${live.address}:${live.port}${live.process ? ` · ${live.process}` : ''}，但工作台里没有登记`,
    })
  }

  items.sort((a, b) => (a.port ?? 99999) - (b.port ?? 99999))

  return {
    items,
    summary: {
      ok: items.filter((item) => item.state === 'ok').length,
      recordedNotListening: items.filter((item) => item.state === 'recordedNotListening').length,
      listeningNotRecorded: items.filter((item) => item.state === 'listeningNotRecorded').length,
      totalListening: liveByPort.size,
    },
    livePorts: [...liveByPort.values()].sort((a, b) => a.port - b.port),
  }
}
