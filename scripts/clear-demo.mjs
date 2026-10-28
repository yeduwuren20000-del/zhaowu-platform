import fs from 'node:fs'
import path from 'node:path'
import { ROOT } from './lib/run.mjs'

/**
 * 清除虚假 / 示例数据，保留真实数据（开始正式使用前跑一次）。
 *
 *   node scripts/clear-demo.mjs --dry-run     # 只看会删什么，不动文件
 *   node scripts/clear-demo.mjs               # 执行清除（自动备份）
 *   node scripts/clear-demo.mjs --keep-demo   # 额外保留本地演示用假 SSH 主机
 *
 * 判定口径（宁可保守，不误删真实数据）：
 *   项目：dir 不存在于磁盘 -> 视为示例数据；dir 真实存在 -> 保留。
 *   服务器：host 含占位符（XX / * / example）或属于内置示例 -> 清除；
 *           127.0.0.1:2299 是本地演示假 SSH 主机，默认一并清除（它不是你的真机），
 *           需要留着看 SSH/Docker/趋势效果时加 --keep-demo。
 *
 * 派生缓存一并处理：discovery 上次扫描、monitor 熔断表、被删项目的日志文件、
 * events 里指向已删对象的事件（保留状态指纹，避免清空后把当前状态当成"刚刚变化"重放一遍）。
 *
 * 重要：必须先停后端再改文件 —— jsonStore 有内存缓存，
 * 后端在跑时改磁盘，会在下一次写入时被内存里的旧数据覆盖回去。
 */

const DATA = path.join(ROOT, 'data')
const KEEP_DEMO = process.argv.includes('--keep-demo')
const DRY = process.argv.includes('--dry-run')

const DEMO_SSH = { host: '127.0.0.1', port: 2299 }

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

function dirExists(dir) {
  if (!dir) return false
  try {
    return fs.statSync(dir).isDirectory()
  } catch {
    return false
  }
}

function isPlaceholderHost(host) {
  return /xx|\*|example\.|localhost\.test/i.test(String(host || ''))
}

function isDemoSsh(server) {
  return String(server.host) === DEMO_SSH.host && Number(server.sshPort) === DEMO_SSH.port
}

/**
 * 示例服务器的判定：
 *   1. remark 以「示例数据」开头 —— 播种器写下的标记，最可靠（host 可能被人改过，不能只看 IP 形态）；
 *   2. host 含占位符（XX / * / example）；
 *   3. 内置示例的主机名 + 系统组合（防止用户把 remark 改掉）。
 * 注意 203.0.113.x / 192.168.1.20 这类文档/内网示例 IP 也算，但只在前两条命中时才认定，
 * 避免误删用户自己填的真实内网机器。
 */
const SEED_SERVER_SIGNATURES = [
  { name: '主服务器', os: 'Ubuntu 22.04' },
  { name: 'AI 实验服务器', os: 'Debian 12' },
  { name: '测试服务器', os: 'CentOS 7' },
]

function isSeedServer(server) {
  if (/^示例数据/.test(String(server.remark || '').trim())) return '示例数据标记'
  if (isPlaceholderHost(server.host)) return '占位 IP'
  const hit = SEED_SERVER_SIGNATURES.find((sig) => sig.name === server.name && (!server.os || sig.os === server.os))
  return hit ? '内置示例机器（名称+系统匹配）' : null
}

const projectsFile = path.join(DATA, 'projects.json')
const serversFile = path.join(DATA, 'servers.json')
const projects = readJson(projectsFile, { version: 1, items: [] })
const servers = readJson(serversFile, { version: 1, items: [] })

const keepProjects = []
const dropProjects = []
const ambiguousProjects = []
for (const project of projects.items || []) {
  const seeded = /^示例数据/.test(String(project.remark || '').trim())
  const real = dirExists(project.dir)
  if (real && seeded) {
    // 带示例标记但目录真实存在：用户可能把示例项改成自己的项目了 —— 保守保留并提示
    ambiguousProjects.push(project)
    keepProjects.push(project)
  } else if (real) keepProjects.push(project)
  else dropProjects.push(project)
}

const keepServers = []
const dropServers = []
for (const server of servers.items || []) {
  const seedWhy = isSeedServer(server)
  if (seedWhy) dropServers.push({ server, why: seedWhy })
  else if (isDemoSsh(server) && !KEEP_DEMO) dropServers.push({ server, why: '本地演示假 SSH 主机' })
  else keepServers.push(server)
}

console.log('=== 将保留 ===')
for (const p of keepProjects) console.log(`  项目  ${p.name.padEnd(20)} dir=${p.dir}`)
for (const s of keepServers) console.log(`  服务器 ${String(s.name).padEnd(20)} ${s.host}:${s.sshPort}`)
if (keepProjects.length === 0 && keepServers.length === 0) console.log('  （无 —— 清空后是全新状态）')

console.log('\n=== 将清除 ===')
for (const p of dropProjects) console.log(`  项目  ${p.name.padEnd(20)} dir 不存在：${p.dir}`)
for (const { server, why } of dropServers) console.log(`  服务器 ${String(server.name).padEnd(20)} ${server.host}:${server.sshPort}  <- ${why}`)
if (ambiguousProjects.length) {
  console.log('\n=== 需要你确认（带示例标记但目录真实存在，已保守保留） ===')
  for (const p of ambiguousProjects) console.log(`  项目  ${p.name.padEnd(20)} dir=${p.dir}`)
}

const droppedProjectIds = new Set(dropProjects.map((p) => p.id))
const droppedServerIds = new Set(dropServers.map((d) => d.server.id))

// 派生缓存
const discovery = readJson(path.join(DATA, 'discovery.json'), { version: 1, ignored: [], acknowledged: [], lastScan: null, aiCache: {} })
const monitor = readJson(path.join(DATA, 'monitor.json'), { version: 1, settings: { enabled: false, intervalMs: 120000, includeDocker: true }, lastRun: null, health: {} })
const events = readJson(path.join(DATA, 'events.json'), { version: 1, items: [], states: {} })
const resources = readJson(path.join(DATA, 'resources.json'), { version: 1, samples: {}, spikes: [] })

const eventsDropped = (events.items || []).filter((e) => droppedProjectIds.has(e.projectId) || droppedServerIds.has(e.serverId)).length
const healthDropped = Object.keys(monitor.health || {}).filter((id) => droppedServerIds.has(id)).length
const samplesDropped = Object.keys(resources.samples || {}).filter((id) => droppedServerIds.has(id)).length
const orphanLogs = fs.existsSync(path.join(DATA, 'logs')) ? fs.readdirSync(path.join(DATA, 'logs')).filter((name) => /^prj_[\w-]+\.log$/.test(name) && droppedProjectIds.has(name.replace(/\.log$/, ''))) : []

console.log('\n=== 派生缓存 ===')
console.log(`  discovery.lastScan      : 重置（下次扫描重建）`)
console.log(`  discovery.aiCache       : 清空（键是被删项目的指纹）`)
console.log(`  events.items            : 丢弃 ${eventsDropped} 条指向已删对象（保留状态指纹，避免重放）`)
console.log(`  monitor.health          : 清理 ${healthDropped} 项已删服务器的熔断记录`)
console.log(`  resources.samples       : 清理 ${samplesDropped} 台已删服务器的采样历史`)
console.log(`  孤立项目日志            : ${orphanLogs.length ? orphanLogs.join(', ') : '无'}`)

if (DRY) {
  console.log('\n[dry-run] 未改动任何文件。')
  process.exit(0)
}

// 备份整个 data 目录
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
const backup = path.join(ROOT, `data-backup-${stamp}`)
fs.cpSync(DATA, backup, { recursive: true })
console.log(`\n已备份整个 data/ 到：${backup}`)

// 写入：空数组而非删文件 —— jsonStore 的 isValid 只要求 items 是数组，
// 文件缺失会被自动重新播种成示例数据，等于白清。
fs.writeFileSync(projectsFile, JSON.stringify({ version: 1, items: keepProjects }, null, 2), 'utf8')
fs.writeFileSync(
  serversFile,
  JSON.stringify({ ...servers, items: keepServers.map((s) => ({ ...s, metrics: droppedServerIds.has(s.id) ? null : s.metrics })) }, null, 2),
  'utf8',
)

fs.writeFileSync(
  path.join(DATA, 'discovery.json'),
  JSON.stringify({ version: 1, ignored: discovery.ignored || [], acknowledged: discovery.acknowledged || [], lastScan: null, aiCache: {} }, null, 2),
  'utf8',
)

fs.writeFileSync(
  path.join(DATA, 'monitor.json'),
  JSON.stringify(
    {
      version: 1,
      settings: monitor.settings,
      lastRun: null,
      health: Object.fromEntries(Object.entries(monitor.health || {}).filter(([id]) => !droppedServerIds.has(id))),
    },
    null,
    2,
  ),
  'utf8',
)

fs.writeFileSync(
  path.join(DATA, 'events.json'),
  JSON.stringify(
    {
      version: 1,
      items: (events.items || []).filter((e) => !droppedProjectIds.has(e.projectId) && !droppedServerIds.has(e.serverId)),
      states: events.states || {},
    },
    null,
    2,
  ),
  'utf8',
)

fs.writeFileSync(
  path.join(DATA, 'resources.json'),
  JSON.stringify(
    {
      version: 1,
      samples: Object.fromEntries(Object.entries(resources.samples || {}).filter(([id]) => !droppedServerIds.has(id))),
      spikes: (resources.spikes || []).filter((s) => !droppedServerIds.has(s.serverId)),
    },
    null,
    2,
  ),
  'utf8',
)

for (const name of orphanLogs) fs.rmSync(path.join(DATA, 'logs', name), { force: true })

// 追加一条审计记录（不谎报：明确写了是谁清的、清了什么、备份在哪）
const logFile = path.join(DATA, 'logs', 'workbench.log')
const entry = {
  at: new Date().toISOString(),
  level: 'info',
  source: 'workbench',
  message: `清除示例/虚假数据：项目 ${dropProjects.length} 条、服务器 ${dropServers.length} 台、事件 ${eventsDropped} 条、孤立日志 ${orphanLogs.length} 个；备份在 ${path.basename(backup)}`,
}
fs.appendFileSync(logFile, JSON.stringify(entry) + '\n', 'utf8')

console.log('\n完成。保留：项目 ' + keepProjects.length + ' 条、服务器 ' + keepServers.length + ' 台。')
console.log('恢复示例数据：设置页「恢复示例数据」，或从备份目录整体拷回 data/。')
