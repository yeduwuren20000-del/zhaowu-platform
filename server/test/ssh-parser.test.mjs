/**
 * 解析器单元测试（不联网、不连 SSH）：
 *   node server/test/ssh-parser.test.mjs
 * 覆盖 Linux 主流程与各种回退格式（netstat / meminfo / df -Pk）。
 */
import {
  DF_KB,
  MEMINFO,
  NETSTAT_PORTS,
  SECTION_DATA,
  buildMetricsStdout,
} from './fixtures/ssh-output.mjs'
import {
  auditPorts,
  parseCpuUsage,
  parseDisk,
  parseListeningPorts,
  parseLoad,
  parseMemory,
  parseMetrics,
  parseSections,
  parseUptime,
} from '../src/services/sshMetrics.js'

let passed = 0
const failures = []

function check(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failures.push({ name, detail })
    console.log(`  ✗ ${name}${detail ? ` -> ${JSON.stringify(detail)}` : ''}`)
  }
}

function approx(actual, expected, tolerance = 0.15) {
  return typeof actual === 'number' && Math.abs(actual - expected) <= tolerance
}

console.log('\n[1] 分段解析')
const sections = parseSections(buildMetricsStdout())
check('取到 hostname', sections.hostname === SECTION_DATA.hostname, sections.hostname)
check('取到 os', sections.os === SECTION_DATA.os, sections.os)
check('段数完整', Object.keys(sections).length === 14, Object.keys(sections).length)

console.log('\n[2] 基础字段')
check('uptime -> 秒（四舍五入）', parseUptime(SECTION_DATA.uptime) === 432101, parseUptime(SECTION_DATA.uptime))
check('uptime 文本回退', parseUptime(' 10:20:30 up 3 days,  2:31,  1 user') === 3 * 86400 + 2 * 3600 + 31 * 60, parseUptime(' 10:20:30 up 3 days,  2:31,  1 user'))
const load = parseLoad(SECTION_DATA.load)
check('load average 三值', load.one === 0.42 && load.five === 0.58 && load.fifteen === 0.61, load)
check('load 从 uptime 文本回退', parseLoad(' 10:20:30 up 3 days, load average: 1.20, 0.90, 0.75')?.fifteen === 0.75)

console.log('\n[3] CPU')
const cpuUsage = parseCpuUsage(SECTION_DATA.cpu1, SECTION_DATA.cpu2)
check('两次采样算出使用率 ≈49.4%', approx(cpuUsage, 49.4, 0.2), cpuUsage)
check('stat 缺失时返回 null', parseCpuUsage('', '') === null)

console.log('\n[4] 内存')
const memory = parseMemory(SECTION_DATA.mem)
check('free -b 解析 total', memory.totalBytes === 16702988288, memory.totalBytes)
check('free -b 解析 available', memory.availableBytes === 10384384000, memory.availableBytes)
check('free -b 使用率（按可用内存）≈37.8%', approx(memory.usedPercent, 37.8, 0.3), memory.usedPercent)
check('swap 已用', memory.swapUsedBytes === 52428800, memory.swapUsedBytes)
const meminfo = parseMemory(MEMINFO)
check('/proc/meminfo 回退 total', meminfo.totalBytes === 16303776 * 1024, meminfo.totalBytes)
check('/proc/meminfo 回退 available', meminfo.availableBytes === 10140000 * 1024, meminfo.availableBytes)
check('空输入返回 null', parseMemory('') === null)

console.log('\n[5] 磁盘')
const disks = parseDisk(SECTION_DATA.disk)
check('解析出 3 个挂载点', disks.length === 3, disks.map((item) => item.mount))
check('根分区容量正确', disks[0].sizeBytes === 107374182400, disks[0].sizeBytes)
check('通过 type 列偏移识别 /data', disks[2].mount === '/data' && disks[2].usePercent === 75, disks[2])
const dfKb = parseDisk(DF_KB)
check('df -Pk 按 KB 换算', dfKb[0].sizeBytes === 104857600 * 1024, dfKb[0].sizeBytes)

console.log('\n[6] 监听端口（ss）')
const ports = parseListeningPorts(SECTION_DATA.ports)
check('解析出 6 条监听', ports.length === 6, ports.length)
const port80 = ports.find((item) => item.port === 80)
check('tcp 80 地址与进程正确', port80.proto === 'tcp' && port80.address === '0.0.0.0' && port80.process === 'nginx' && port80.pid === 1337, port80)
const port53 = ports.find((item) => item.port === 53)
check('udp 53 识别为 udp', port53.proto === 'udp' && port53.process === 'systemd-resolve', port53)
const port9100 = ports.find((item) => item.port === 9100)
check('通配地址 *:9100 解析', port9100.address === '*' && port9100.port === 9100, port9100)
check('按端口升序', ports[0].port === 22 && ports[ports.length - 1].port === 9100, ports.map((p) => p.port))

console.log('\n[7] 监听端口（netstat 回退）')
const netstatPorts = parseListeningPorts(NETSTAT_PORTS)
check('netstat 解析出 4 条', netstatPorts.length === 4, netstatPorts.length)
check('netstat 进程与 PID', netstatPorts.find((item) => item.port === 22)?.process === 'sshd', netstatPorts.find((item) => item.port === 22))

console.log('\n[8] 整段快照')
const snapshot = parseMetrics(buildMetricsStdout())
check('hostname/os/内核/架构', snapshot.hostname === 'prod-web-01' && snapshot.os === OS_LABEL() && snapshot.arch === 'x86_64', snapshot)
check('cpu 核数', snapshot.cpuCores === 8, snapshot.cpuCores)
check('uptime 与负载', snapshot.uptimeSec === 432101 && snapshot.load.one === 0.42, { uptime: snapshot.uptimeSec, load: snapshot.load })
check('磁盘摘要只保留真实挂载', snapshot.disk.length === 3, snapshot.disk)
check('端口数量', snapshot.ports.length === 6, snapshot.ports.length)

console.log('\n[9] 端口核对（三类状态）')
const apps = [
  { id: 'a1', name: 'Nginx', port: 80, deployPath: '/etc/nginx' },
  { id: 'a2', name: 'MySQL', port: 3306, deployPath: '/var/lib/mysql' },
  { id: 'a3', name: 'Dify Web', port: 8080, deployPath: '/opt/dify' },
  { id: 'a4', name: 'Redis', port: 6379, deployPath: '/var/lib/redis' },
  { id: 'a5', name: 'Ollama', port: 11434, deployPath: '/opt/ollama' },
]
const audit = auditPorts(apps, snapshot.ports)
check('正常 3 个', audit.summary.ok === 3, audit.summary)
check('记录存在但未监听 2 个', audit.summary.recordedNotListening === 2, audit.summary)
check('监听但未登记 3 个（22/53/9100）', audit.summary.listeningNotRecorded === 3, audit.summary)
const unregistered = audit.items.filter((item) => item.state === 'listeningNotRecorded').map((item) => item.port).sort((a, b) => a - b)
check('未登记端口列表正确', JSON.stringify(unregistered) === JSON.stringify([22, 53, 9100]), unregistered)
check('Nginx 标为正常', audit.items.find((item) => item.appName === 'Nginx').state === 'ok')
check('Redis 标为未监听', audit.items.find((item) => item.appName === 'Redis').state === 'recordedNotListening')
check('Redis 提示含端口号', audit.items.find((item) => item.appName === 'Redis').detail.includes('6379'))
check('去重后的真实端口 6 个', audit.summary.totalListening === 6, audit.summary.totalListening)

function OS_LABEL() {
  return SECTION_DATA.os
}

console.log(`\n结果：通过 ${passed} 项，失败 ${failures.length} 项`)
if (failures.length > 0) {
  console.log(JSON.stringify(failures, null, 2))
  process.exitCode = 1
}
