export function formatBytes(bytes) {
  if (bytes === null || bytes === undefined || Number.isNaN(Number(bytes))) return '—'
  const value = Number(bytes)
  if (value < 1024) return `${value} B`
  if (value < 1024 * 1024) return `${(value / 1024).toFixed(0)} KB`
  if (value < 1024 * 1024 * 1024) return `${(value / 1024 / 1024).toFixed(0)} MB`
  return `${(value / 1024 / 1024 / 1024).toFixed(2)} GB`
}

export function formatDuration(ms) {
  if (ms === null || ms === undefined || Number.isNaN(Number(ms))) return '—'
  const totalSeconds = Math.max(0, Math.floor(Number(ms) / 1000))
  const days = Math.floor(totalSeconds / 86400)
  const hours = Math.floor((totalSeconds % 86400) / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60
  if (days > 0) return `${days}天 ${hours}小时`
  if (hours > 0) return `${hours}小时 ${minutes}分`
  if (minutes > 0) return `${minutes}分 ${seconds}秒`
  return `${seconds}秒`
}

export function formatClock(iso) {
  if (!iso) return '--:--:--'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '--:--:--'
  const pad = (value) => String(value).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export function formatDateTime(iso) {
  if (!iso) return '—'
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return '—'
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export function timeAgo(iso) {
  if (!iso) return '从未'
  const diff = Date.now() - Date.parse(iso)
  if (Number.isNaN(diff)) return '从未'
  return `${formatDuration(Math.max(0, diff))}前`
}

/** 状态短词：全站统一中文（仅前端展示层，不影响接口字段与筛选值） */
const STATUS_TEXT = {
  running: '运行中',
  starting: '启动中',
  stopped: '已停止',
  conflict: '端口冲突',
  // 父子目录的项目声明了同一端口 —— 更像是同一个服务登记了两次，不是真的抢端口
  'possible-duplicate': '疑似重复登记',
  unregistered: '未登记',
  unknown: '未知',
}

export function statusMeta(status) {
  return { text: STATUS_TEXT[status] || STATUS_TEXT.unknown }
}

/** 项目组聚合状态（后端 projectGrouping 的 status 枚举）-> 中文短词 */
const GROUP_STATUS_TEXT = {
  'all-running': '全部运行',
  'partial-running': '部分运行',
  'all-stopped': '全部停止',
  conflict: '存在冲突',
  'possible-duplicate': '疑似重复登记',
}

export function groupStatusWord(status) {
  return GROUP_STATUS_TEXT[status] || status || '未知'
}

/** 项目访问地址：{port} 占位符替换成实际监听端口（自动避让后以运行态为准） */
export function localUrl(project) {
  const port = project.runtime?.port ?? project.port
  if (project.url) {
    if (project.url.includes('{port}')) return project.url.replace(/\{port\}/g, String(port ?? ''))
    // 端口被避让过（配置 5301 -> 实际 5302）：地址里的旧端口要跟着换，
    // 否则"打开"按钮会指向一个没人监听的端口。
    const declared = Number(project.port)
    const actual = Number(port)
    if (declared && actual && declared !== actual) {
      return project.url.replace(new RegExp(`:${declared}(?=[/?#]|$)`), `:${actual}`)
    }
    return project.url
  }
  if (port) return `http://localhost:${port}`
  return ''
}

export function formatPercent(value, digits = 0) {
  if (value === null || value === undefined || Number.isNaN(Number(value))) return '—'
  return `${Number(value).toFixed(digits)}%`
}

export function formatUptime(seconds) {
  if (seconds === null || seconds === undefined || Number.isNaN(Number(seconds))) return '—'
  return formatDuration(Number(seconds) * 1000)
}

export function formatLatency(ms) {
  if (ms === null || ms === undefined || Number.isNaN(Number(ms))) return '—'
  return `${Math.round(Number(ms))} ms`
}

export function formatLoad(load) {
  if (!load) return '—'
  return `${load.one.toFixed(2)} / ${load.five.toFixed(2)} / ${load.fifteen.toFixed(2)}`
}

/** 使用率 -> 颜色：正常留中性灰，只有偏高/危险才上色 */
export function usageTone(percent) {
  if (!Number.isFinite(percent)) return 'gray'
  if (percent >= 90) return 'red'
  if (percent >= 75) return 'amber'
  return 'gray'
}

/**
 * 资源「超标」阈值：与首页资源卡片 RES_TONE（≥70 琥珀 / ≥85 红）对齐。
 * 首页卡片点了超标档位后，服务器页据此筛出该指标 ≥ 此值的服务器。
 */
export const RES_OVER_THRESHOLD = 70

/** 取某台服务器在指定资源指标上的占用率（与首页资源卡片同口径） */
export function serverMetricPercent(server, metric) {
  const resources = server?.resources
  if (!resources) return null
  if (metric === 'cpu') return resources.cpuUsagePercent ?? null
  if (metric === 'mem') return resources.memory?.usedPercent ?? null
  if (metric === 'disk') return resources.disk?.usePercent ?? null
  return null
}

export const AUDIT_META = {
  ok: { text: '正常', tone: 'green', hint: '已登记且正在监听' },
  recordedNotListening: { text: '记录未监听', tone: 'amber', hint: '工作台里登记了，但远程没有监听' },
  listeningNotRecorded: { text: '监听未登记', tone: 'red', hint: '远程在监听，工作台里还没有登记' },
}

export function auditMeta(state) {
  return AUDIT_META[state] || { text: '未知', tone: 'gray', hint: '' }
}

/** 核对状态 -> status-word 类名（正常不上色，异常才用琥珀 / 红） */
export function auditClass(state) {
  return { green: 'muted', gray: 'muted', amber: 'is-warn', red: 'is-error' }[auditMeta(state).tone] || 'muted'
}

/** 端口来源：Docker 容器 / Docker 代理 / 宿主机进程 */
export const SOURCE_META = {
  docker: { text: 'Docker 容器', hint: '端口由容器发布（docker ps 的 Ports 字段）' },
  'docker-proxy': { text: 'Docker 代理', hint: '监听进程是 docker-proxy，通常是容器发布端口' },
  host: { text: '宿主机进程', hint: '端口由宿主机上的普通进程监听' },
  unknown: { text: '未确认', hint: '还没有采集到端口来源' },
}

export function sourceMeta(source) {
  return SOURCE_META[source] || SOURCE_META.unknown
}

/**
 * 服务生命周期事件类型 -> 中文标签（配色由 level 决定，见 eventDotColor）。
 * 标签口径与后端 server/src/services/eventService.js 的 EVENT_TYPE_TEXT 保持一致。
 */
export const EVENT_META = {
  started: '开始运行',
  stopped: '已停止',
  crashed: '异常退出',
  recovered: '恢复运行',
  port_conflict: '端口冲突',
  port_changed: '端口变化',
  new_service_found: '发现新服务',
  ssh_online: 'SSH 在线',
  ssh_offline: 'SSH 离线',
  docker_changed: 'Docker 变化',
}

export function eventMeta(type) {
  return { text: EVENT_META[type] || type || '未知' }
}

/** 事件等级 -> 时间线圆点：正常事件用中性灰，只有告警/异常才上色 */
export function eventDotColor(level) {
  if (level === 'error') return 'var(--red)'
  if (level === 'warn') return 'var(--amber)'
  if (level === 'success') return 'var(--green)'
  return 'var(--muted-2)'
}

/** 时间线日期锚点：今天 / 昨天 / 年-月-日。接收 'YYYY-MM-DD' 串、ISO 串或 Date */
export function formatDayLabel(value) {
  const d = value instanceof Date ? value : new Date(value)
  if (Number.isNaN(d.getTime())) return '未知日期'
  const now = new Date()
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate())
  const that = new Date(d.getFullYear(), d.getMonth(), d.getDate())
  const diff = Math.round((today - that) / 86400000)
  if (diff === 0) return '今天'
  if (diff === 1) return '昨天'
  const pad = (n) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`
}
