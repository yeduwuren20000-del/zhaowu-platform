import { eventStore } from '../store/eventStore.js'
import { makeId, nowIso } from '../utils/ids.js'

/**
 * 服务生命周期事件（第六阶段）：只记录"变化"，不记录每秒快照。
 *
 * 事件产生点：
 *   - 启停动作（processManager）：started / stopped / crashed
 *   - 页面刷新时的状态观察（routes：项目列表、总览）：started / crashed / recovered / port_conflict / port_changed
 *   - 本地服务发现（localDiscoveryService）：new_service_found
 *   - SSH / Docker 采集（serverMonitor）：ssh_online / ssh_offline / docker_changed / 服务器 APP 端口变化
 *
 * 去重依据是 eventStore.states 里的状态指纹：观察结果与上次一致就不产生事件。
 * 首次观察只建立基线（避免刚打开页面就把现存服务全记成"刚启动"）。
 */

export const EVENT_TYPES = {
  STARTED: 'started',
  STOPPED: 'stopped',
  CRASHED: 'crashed',
  RECOVERED: 'recovered',
  PORT_CONFLICT: 'port_conflict',
  PORT_CHANGED: 'port_changed',
  NEW_SERVICE_FOUND: 'new_service_found',
  SSH_ONLINE: 'ssh_online',
  SSH_OFFLINE: 'ssh_offline',
  DOCKER_CHANGED: 'docker_changed',
}

export const EVENT_TYPE_LIST = Object.values(EVENT_TYPES)

/** 中文标签（前端过滤条与消息文案共用同一口径） */
export const EVENT_TYPE_TEXT = {
  [EVENT_TYPES.STARTED]: '开始运行',
  [EVENT_TYPES.STOPPED]: '已停止',
  [EVENT_TYPES.CRASHED]: '异常退出',
  [EVENT_TYPES.RECOVERED]: '恢复运行',
  [EVENT_TYPES.PORT_CONFLICT]: '端口冲突',
  [EVENT_TYPES.PORT_CHANGED]: '端口变化',
  [EVENT_TYPES.NEW_SERVICE_FOUND]: '发现新服务',
  [EVENT_TYPES.SSH_ONLINE]: 'SSH 在线',
  [EVENT_TYPES.SSH_OFFLINE]: 'SSH 离线',
  [EVENT_TYPES.DOCKER_CHANGED]: 'Docker 变化',
}

const DEFAULT_LEVEL = {
  [EVENT_TYPES.STARTED]: 'success',
  [EVENT_TYPES.STOPPED]: 'info',
  [EVENT_TYPES.CRASHED]: 'error',
  [EVENT_TYPES.RECOVERED]: 'success',
  [EVENT_TYPES.PORT_CONFLICT]: 'warn',
  [EVENT_TYPES.PORT_CHANGED]: 'info',
  [EVENT_TYPES.NEW_SERVICE_FOUND]: 'info',
  [EVENT_TYPES.SSH_ONLINE]: 'success',
  [EVENT_TYPES.SSH_OFFLINE]: 'error',
  [EVENT_TYPES.DOCKER_CHANGED]: 'warn',
}

/** 这些异常之后再次运行，记为"恢复运行"而不是普通启动 */
const RECOVER_AFTER = new Set([EVENT_TYPES.CRASHED, EVENT_TYPES.PORT_CONFLICT, EVENT_TYPES.SSH_OFFLINE])

/** 一次扫描最多逐条记录几个新服务，超出合并成一条汇总，避免数据膨胀 */
const MAX_DISCOVERY_EVENTS_PER_SCAN = 12

const LEVELS = new Set(['info', 'success', 'warn', 'error'])

/** 字段白名单 + 长度上限：事件文件不会因某个字段过长而膨胀（level 走白名单校验，不在这张表里） */
const TEXT_FIELDS = {
  type: 32,
  source: 20,
  message: 400,
  detail: 300,
  code: 40,
  status: 20,
  previousStatus: 20,
  projectId: 40,
  projectName: 120,
  serviceId: 40,
  serviceName: 120,
  serverId: 40,
  serverName: 120,
  processName: 80,
  address: 60,
  command: 300,
  fingerprint: 40,
}

function clamp(value, max) {
  if (value === undefined || value === null || value === '') return null
  return String(value).slice(0, max)
}

function toPort(value) {
  const port = Number(value)
  return Number.isInteger(port) && port > 0 && port < 65536 ? port : null
}

function toPid(value) {
  const pid = Number(value)
  return Number.isInteger(pid) && pid > 0 ? pid : null
}

/** 组装一条事件（未知类型直接拒绝，保证过滤口径稳定） */
export function buildEvent(input = {}) {
  if (!EVENT_TYPE_LIST.includes(input.type)) {
    console.warn(`[events] 忽略未知事件类型：${input.type}`)
    return null
  }
  const event = { id: makeId('evt'), at: input.at || nowIso(), type: input.type }
  event.level = LEVELS.has(input.level) ? input.level : DEFAULT_LEVEL[input.type] || 'info'
  for (const [field, max] of Object.entries(TEXT_FIELDS)) {
    if (field === 'type' || field === 'at') continue
    const value = clamp(input[field], max)
    if (value !== null) event[field] = value
  }
  event.port = toPort(input.port)
  event.pid = toPid(input.pid)
  if (!event.source) event.source = 'observe'
  if (!event.message) event.message = EVENT_TYPE_TEXT[event.type] || event.type
  return event
}

/** 状态指纹：只包含"会变的事实"。PID 不参与（进程重启不算一次状态变化） */
function signatureOf(facts = {}) {
  return [facts.status || 'stopped', toPort(facts.port) ?? '', facts.conflictKey || ''].join('|')
}

/** states 里存的内容：指纹 + 最近一次的事实，供下一次判定与消息使用 */
function stateOf(facts = {}, signature, lastType = null) {
  return {
    signature,
    status: facts.status || 'stopped',
    port: toPort(facts.port),
    pid: toPid(facts.pid),
    processName: clamp(facts.processName, 80) || '',
    address: clamp(facts.address, 60) || '',
    lastType: lastType || null,
  }
}

/** 事件记录是旁路能力：任何失败都不能影响启停、扫描、采集这些主流程 */
async function guard(fn) {
  try {
    return await fn()
  } catch (error) {
    console.warn(`[events] 记录失败：${error.message}`)
    return null
  }
}

/**
 * 通用"观察一个主体"：
 *   无历史 -> 只建基线；指纹一致 -> 什么都不做；有变化 -> 交给 decide 决定事件类型。
 */
async function observeSubject(key, facts, { decide, source = 'observe' }) {
  const previous = await eventStore.getState(key)
  const signature = signatureOf(facts)
  if (previous && previous.signature === signature) return null
  if (!previous) {
    await eventStore.setState(key, stateOf(facts, signature))
    return null
  }
  const draft = decide(previous, facts)
  const event = draft ? buildEvent({ ...draft, ...facts, source }) : null
  await eventStore.commit({
    event,
    stateKey: key,
    state: stateOf(facts, signature, event ? event.type : previous.lastType),
  })
  return event
}

function subjectLabel(facts) {
  if (facts.serviceName) return `子服务「${facts.serviceName}」`
  if (facts.projectName) return `项目「${facts.projectName}」`
  if (facts.serverName) return `服务器「${facts.serverName}」`
  return '服务'
}

/** 本地项目 / 子服务的状态转移表 */
function decideLifecycleTransition(previous, facts) {
  const label = subjectLabel(facts)
  const from = previous.status || 'stopped'
  const to = facts.status || 'stopped'
  const prevPort = previous.port ?? null
  const port = toPort(facts.port)
  const pid = toPid(facts.pid)

  if (to === 'conflict') {
    return {
      type: EVENT_TYPES.PORT_CONFLICT,
      message: facts.conflictMessage || `${label} 端口 ${port ?? '未记录'} 存在冲突`,
      detail: facts.conflictMessage || null,
    }
  }
  if (from === 'conflict' && to === 'running') {
    return {
      type: EVENT_TYPES.RECOVERED,
      message: `${label} 冲突已解除，端口 ${port ?? '未记录'} 恢复监听${pid ? `（PID ${pid}）` : ''}`,
      detail: facts.conflictMessage ? `此前的冲突：${facts.conflictMessage}` : null,
    }
  }
  if (to === 'running') {
    if (from === 'running') {
      if (prevPort && port && prevPort !== port) {
        return {
          type: EVENT_TYPES.PORT_CHANGED,
          message: `${label} 监听端口从 ${prevPort} 变为 ${port}${pid ? `（PID ${pid}）` : ''}`,
        }
      }
      return null
    }
    if (RECOVER_AFTER.has(previous.lastType)) {
      return {
        type: EVENT_TYPES.RECOVERED,
        message: `${label} 已恢复运行（端口 ${port ?? '未记录'}${pid ? `，PID ${pid}` : ''}）`,
        detail: `上一次异常：${EVENT_TYPE_TEXT[previous.lastType] || previous.lastType}`,
      }
    }
    return {
      type: EVENT_TYPES.STARTED,
      message: `${label} 开始监听端口 ${port ?? '未记录'}${pid ? `（PID ${pid}` : ''}${facts.processName ? `，进程 ${facts.processName}` : ''}`,
    }
  }
  // 进程已拉起但端口还没监听（编译中）：不值得单独记一条，等它真的监听再说
  if (to === 'starting') return null
  if (from === 'running' || from === 'starting') {
    return {
      type: EVENT_TYPES.CRASHED,
      level: from === 'running' ? 'error' : 'warn',
      message: `${label} 异常退出：此前${from === 'running' ? `正在监听端口 ${prevPort ?? '未记录'}` : '处于启动中'}${previous.pid ? `（PID ${previous.pid}）` : ''}，现在端口不再监听`,
      detail: facts.conflictMessage || null,
    }
  }
  return null
}

/** 项目视图（buildProjectViews 的结果）-> 逐个项目与子服务判定 */
export async function observeProjectStates(views = [], { source = 'observe' } = {}) {
  return guard(async () => {
    const emitted = []
    for (const view of views) {
      const projectFacts = {
        projectId: view.id,
        projectName: view.name,
        status: view.status || 'stopped',
        port: view.live?.port ?? null,
        pid: view.live?.pid ?? null,
        processName: view.live?.processName || view.processName || '',
        address: view.live?.address || '',
        conflictMessage: view.conflict?.message || null,
        conflictKey: view.conflict ? `${view.conflict.type || 'foreign'}:${view.conflict.message || ''}` : '',
      }
      const event = await observeSubject(`project:${view.id}`, projectFacts, { decide: decideLifecycleTransition, source })
      if (event) emitted.push(event)

      for (const service of view.services || []) {
        const serviceFacts = {
          projectId: view.id,
          projectName: view.name,
          serviceId: service.id,
          serviceName: service.name || `子服务 ${service.port ?? ''}`,
          status: service.live ? 'running' : 'stopped',
          port: service.live ? service.port ?? null : null,
          pid: service.livePid ?? null,
          processName: service.liveProcessName || service.processName || '',
          address: service.liveAddress || service.address || '',
        }
        const serviceEvent = await observeSubject(`service:${view.id}:${service.id}`, serviceFacts, {
          decide: decideLifecycleTransition,
          source,
        })
        if (serviceEvent) emitted.push(serviceEvent)
      }
    }
    return emitted
  })
}

/** 全局端口映射里"同一台服务器上多个 APP 声明同一端口"的冲突（本地冲突已由项目视图覆盖） */
export async function observeMappingConflicts(conflicts = [], { source = 'observe' } = {}) {
  return guard(async () => {
    const emitted = []
    const serverConflicts = conflicts.filter((item) => item.scope === 'server')
    const keyOf = (item) => `conflict:${item.serverId || item.owner}:${item.port}`
    const activeKeys = new Set(serverConflicts.map(keyOf))
    for (const item of serverConflicts) {
      const key = keyOf(item)
      const facts = {
        serverId: item.serverId || null,
        serverName: item.serverName || item.owner,
        port: item.port,
        status: 'conflict',
        conflictMessage: item.message,
        conflictKey: `${item.type || 'duplicate'}:${item.message || ''}`,
      }
      const previous = await eventStore.getState(key)
      const signature = signatureOf(facts)
      if (previous && previous.signature === signature) continue
      // 这个 key 只在"确实冲突"时存在，所以第一次看到就是要通知，不走"建基线"
      const label = facts.serverName ? `服务器「${facts.serverName}」` : '端口冲突'
      const event = buildEvent({
        type: previous?.status === 'conflict' ? EVENT_TYPES.PORT_CHANGED : EVENT_TYPES.PORT_CONFLICT,
        source,
        ...facts,
        message: `${label}：${facts.conflictMessage || `端口 ${facts.port ?? '未记录'} 被多个应用重复声明`}`,
        level: previous?.status === 'conflict' ? 'info' : 'warn',
      })
      await eventStore.commit({ event, stateKey: key, state: stateOf(facts, signature, event ? event.type : previous?.lastType) })
      if (event) emitted.push(event)
    }
    // 冲突已经消失：把指纹退回"未冲突"，这样下次真冲突还能记出来（只在状态真是 conflict 时写一次）
    const known = await eventStore.read()
    for (const [key, state] of Object.entries(known.states)) {
      if (!key.startsWith('conflict:') || activeKeys.has(key)) continue
      if (state?.status !== 'conflict') continue
      await eventStore.setState(key, { signature: 'resolved', status: 'stopped' })
    }
    return emitted
  })
}

/**
 * 自动发现扫描结果 -> new_service_found。
 * firstSeen 已经与上一次扫描比过对；首次扫描（没有上次结果）只记一条汇总，不逐条刷事件。
 */
export async function observeDiscoveryScan(scan, { firstScan = false, source = 'discovery' } = {}) {
  return guard(async () => {
    const emitted = []
    if (!scan?.at) return emitted
    const byFingerprint = new Map((scan.candidates || []).map((item) => [item.fingerprint, item]))
    const fresh = scan.firstSeen || []

    if (firstScan || fresh.length === 0) {
      if (firstScan && fresh.length > 0) {
        const event = buildEvent({
          type: EVENT_TYPES.NEW_SERVICE_FOUND,
          level: 'info',
          source,
          message: `首次扫描发现 ${fresh.length} 个未登记的监听服务（端口 ${fresh
            .slice(0, 10)
            .map((item) => item.port)
            .filter(Boolean)
            .join('、')}${fresh.length > 10 ? '…' : ''}）`,
          detail: fresh
            .slice(0, 10)
            .map((item) => `${item.serviceName || '未知'}:${item.port ?? '?'}`)
            .join('，'),
        })
        if (event) {
          await eventStore.commit({ event })
          emitted.push(event)
        }
      }
      return emitted
    }

    const listed = fresh.slice(0, MAX_DISCOVERY_EVENTS_PER_SCAN)
    for (const item of listed) {
      const candidate = byFingerprint.get(item.fingerprint) || item
      const projectId = candidate.sameDirectoryProjectId || null
      const projectName = candidate.sameDirectoryProjectName || null
      const facts = {
        projectId,
        projectName,
        port: candidate.port ?? null,
        pid: candidate.pid ?? null,
        processName: candidate.processName || '',
        address: candidate.address || '',
        fingerprint: candidate.fingerprint,
      }
      const event = buildEvent({
        type: EVENT_TYPES.NEW_SERVICE_FOUND,
        level: 'info',
        source,
        ...facts,
        message: projectId
          ? `项目「${projectName}」下发现新的子服务端口 ${candidate.port ?? '未记录'}（进程 ${candidate.processName || '未知'}，PID ${candidate.pid ?? '未知'}）`
          : `发现未登记的监听服务「${candidate.serviceName || '未知'}」：端口 ${candidate.port ?? '未记录'}（进程 ${candidate.processName || '未知'}，PID ${candidate.pid ?? '未知'}）`,
        detail: candidate.projectDir ? `项目目录：${candidate.projectDir}` : null,
      })
      if (event) {
        await eventStore.commit({ event })
        emitted.push(event)
      }
    }
    if (fresh.length > listed.length) {
      const event = buildEvent({
        type: EVENT_TYPES.NEW_SERVICE_FOUND,
        level: 'info',
        source,
        message: `另有 ${fresh.length - listed.length} 个新发现的监听服务未逐条记录（见自动发现页）`,
      })
      if (event) {
        await eventStore.commit({ event })
        emitted.push(event)
      }
    }
    return emitted
  })
}

function dockerSignature(docker) {
  if (!docker) return 'none'
  const summary = docker.summary || {}
  const containers = (docker.containers || [])
    .map((item) => `${item.name}:${item.state}:${item.health || 'none'}`)
    .sort()
    .join(',')
  return [docker.installed ? '1' : '0', docker.daemonOk ? '1' : '0', summary.total ?? 0, summary.running ?? 0, containers].join('|')
}

/** 容器集合差异：新增 / 消失 / 状态变化，消息里只列前几个 */
function diffContainers(previous = [], current = []) {
  const label = (item) => `${item.state || 'unknown'}${item.health && item.health !== 'none' ? `(${item.health})` : ''}`
  const prev = new Map(previous.map((item) => [item.name, label(item)]))
  const next = new Map(current.map((item) => [item.name, label(item)]))
  const added = []
  const removed = []
  const changed = []
  for (const [name, state] of next) {
    if (!prev.has(name)) added.push(`${name}(${state})`)
    else if (prev.get(name) !== state) changed.push(`${name}: ${prev.get(name)} → ${state}`)
  }
  for (const name of prev.keys()) if (!next.has(name)) removed.push(name)
  return { added, removed, changed }
}

/** 服务器 APP 端口核对状态（SSH 采集成功时才有意义） */
function decideServerAppTransition(previous, facts) {
  const from = previous.status || 'stopped'
  const to = facts.status || 'stopped'
  const label = `${facts.serverName || '服务器'} 的 APP「${facts.serviceName || facts.port}」（端口 ${facts.port ?? '未记录'}）`
  if (from === to) return null
  if (to === 'running') {
    return {
      type: EVENT_TYPES.STARTED,
      level: 'success',
      message: `${label} 在远程开始监听${facts.processName ? `（进程 ${facts.processName}${facts.pid ? `，PID ${facts.pid}` : ''}）` : ''}`,
    }
  }
  return { type: EVENT_TYPES.STOPPED, level: 'warn', message: `${label} 在远程不再监听` }
}

/** SSH 在线状态 + Docker 容器集合 + 服务器 APP 端口核对 */
export async function observeServerMonitor(server, { source = 'monitor' } = {}) {
  return guard(async () => {
    const emitted = []
    if (!server?.id) return emitted
    const ssh = server.ssh || null

    if (ssh?.at) {
      const facts = {
        serverId: server.id,
        serverName: server.name,
        status: ssh.ok ? 'running' : 'stopped',
        address: server.host || '',
        port: toPort(server.sshPort),
        code: ssh.code || null,
        detail: ssh.error || null,
      }
      const event = await observeSubject(`server:${server.id}`, facts, {
        decide: (previous, current) =>
          current.status === 'running'
            ? {
                type: EVENT_TYPES.SSH_ONLINE,
                message: `服务器「${current.serverName}」(${current.address}:${current.port ?? 22}) SSH 采集恢复${RECOVER_AFTER.has(previous.lastType) ? `（此前：${EVENT_TYPE_TEXT[previous.lastType] || previous.lastType}）` : ''}`,
              }
            : {
                type: EVENT_TYPES.SSH_OFFLINE,
                message: `服务器「${current.serverName}」(${current.address}:${current.port ?? 22}) SSH 采集失败：${current.detail || '未知原因'}`,
                code: current.code,
              },
        source,
      })
      if (event) emitted.push(event)
    }

    if (server.docker?.at) {
      const signature = dockerSignature(server.docker)
      const previous = await eventStore.getState(`server:${server.id}:docker`)
      if (!previous) {
        await eventStore.setState(`server:${server.id}:docker`, {
          signature,
          status: server.docker.daemonOk ? 'running' : 'stopped',
          containers: containerStateList(server.docker),
        })
      } else if (previous.signature !== signature) {
        const diff = diffContainers(previous.containers || [], containerStateList(server.docker))
        const parts = []
        if (diff.added.length) parts.push(`新增 ${diff.added.slice(0, 4).join('、')}`)
        if (diff.removed.length) parts.push(`消失 ${diff.removed.slice(0, 4).join('、')}`)
        if (diff.changed.length) parts.push(`状态变化 ${diff.changed.slice(0, 4).join('、')}`)
        if (!server.docker.installed) parts.unshift('这台服务器没有安装 Docker')
        else if (!server.docker.daemonOk) parts.unshift('Docker 守护进程不可用')
        const event = buildEvent({
          type: EVENT_TYPES.DOCKER_CHANGED,
          source,
          serverId: server.id,
          serverName: server.name,
          status: server.docker.daemonOk ? 'running' : 'stopped',
          message: `服务器「${server.name}」的 Docker 状态变化：容器 ${server.docker.summary?.total ?? 0} 个（运行 ${server.docker.summary?.running ?? 0}）`,
          detail: parts.join('；') || '容器列表有变化',
        })
        await eventStore.commit({
          event,
          stateKey: `server:${server.id}:docker`,
          state: {
            signature,
            status: server.docker.daemonOk ? 'running' : 'stopped',
            containers: containerStateList(server.docker),
            lastType: event ? event.type : previous.lastType,
          },
        })
        if (event) emitted.push(event)
      }
    }

    if (ssh?.ok) {
      const auditByApp = new Map((server.portAudit?.items || []).filter((item) => item.appId).map((item) => [item.appId, item]))
      for (const app of server.apps || []) {
        if (!app.port) continue
        const audit = auditByApp.get(app.id)
        const facts = {
          serverId: server.id,
          serverName: server.name,
          serviceName: app.name,
          status: audit?.state === 'ok' ? 'running' : 'stopped',
          port: toPort(app.port),
          pid: audit?.listen?.pid ?? null,
          processName: audit?.listen?.process || '',
          address: server.host || '',
        }
        const event = await observeSubject(`app:${server.id}:${app.id}`, facts, { decide: decideServerAppTransition, source })
        if (event) emitted.push(event)
      }
    }

    return emitted
  })
}

function containerStateList(docker) {
  return (docker?.containers || []).map((item) => ({ name: item.name || item.shortId || item.id, state: item.state || 'unknown', health: item.health || 'none' }))
}

/** 启停动作直接记录（不需要等下一次观察），并把状态指纹对齐，避免同一件事被记两遍 */
export async function recordProjectAction(project, { type, level, message, detail = null, facts = {}, state = null } = {}) {
  return guard(async () => {
    const event = buildEvent({
      type,
      level,
      message,
      detail,
      source: 'action',
      projectId: project?.id || null,
      projectName: project?.name || null,
      ...facts,
    })
    if (!event) return null
    if (!state) {
      await eventStore.commit({ event })
      return event
    }
    const signature = signatureOf(state)
    await eventStore.commit({ event, stateKey: `project:${project.id}`, state: stateOf(state, signature, event.type) })
    return event
  })
}


/** 只对齐状态指纹、不产生事件（"启动中"这类中间态不值得单独记一条） */
export async function markProjectState(project, state) {
  return guard(async () => {
    const previous = await eventStore.getState(`project:${project.id}`)
    const signature = signatureOf(state)
    await eventStore.setState(`project:${project.id}`, stateOf(state, signature, previous?.lastType || null))
  })
}

/** 时间线查询：过滤（项目 / 服务器 / 子服务 / 类型）+ 最新在前 + 类型计数 */
export async function listEvents({ projectId = null, serverId = null, serviceId = null, type = null, limit = 100 } = {}) {
  const safeLimit = Math.min(Number(limit) || 100, 1000)
  const [items, typeCounts, all] = await Promise.all([
    eventStore.list({ projectId, serverId, serviceId, type, limit: safeLimit }),
    eventStore.typeCounts({ projectId, serverId }),
    eventStore.read(),
  ])
  return {
    generatedAt: nowIso(),
    file: eventStore.file,
    items,
    total: all.items.length,
    returned: items.length,
    typeCounts,
    typeOptions: EVENT_TYPE_LIST.map((value) => ({ value, label: EVENT_TYPE_TEXT[value], count: typeCounts[value] || 0 })),
  }
}

export async function recentActivity(limit = 12) {
  const items = await guard(() => eventStore.list({ limit }))
  return items || []
}

export async function clearEvents() {
  return eventStore.clear()
}
