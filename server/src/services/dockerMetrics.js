/**
 * Docker 只读采集：固定命令取回容器 / 镜像 / 健康状态 / 端口映射 / CPU 与内存占用。
 *
 * 只读约束（第一版严格只读）：
 *  - 只使用 ps、images、inspect、stats --no-stream、info、version 这些**查询类**命令；
 *  - 命令是常量字符串，不拼接任何来自前端或数据库的内容；
 *  - 没有 exec / run / start / stop / restart / rm / kill / prune / build / pull 等写操作。
 *
 * 与 sshMetrics 共用 @@ 分段协议（这里用 @@D:），任何一段失败都不影响其它段。
 */
import { parseSections as parseMetricsSections } from './sshMetrics.js'

export const DOCKER_SECTION_PREFIX = '@@D'

export const DOCKER_COMMAND = [
  'echo "@@D:docker"',
  '(command -v docker >/dev/null 2>&1 && echo yes) || echo no',
  'echo "@@D:daemon"',
  'docker info --format "{{.ServerVersion}}|{{.Containers}}|{{.ContainersRunning}}|{{.ContainersStopped}}|{{.Images}}|{{.Driver}}|{{.OperatingSystem}}" 2>&1 | head -n 3',
  'echo "@@D:version"',
  '(docker version --format "{{.Server.Version}}" 2>/dev/null || docker --version 2>/dev/null) | head -n 1',
  'echo "@@D:ps"',
  'docker ps -a --no-trunc --format "{{.ID}}|{{.Names}}|{{.Image}}|{{.State}}|{{.Status}}|{{.Ports}}|{{.RunningFor}}|{{.Labels}}" 2>/dev/null | head -n 200',
  'echo "@@D:inspect"',
  'docker inspect --format "{{.Id}}|{{.Name}}|{{.State.Status}}|{{.State.StartedAt}}|{{if .State.Health}}{{.State.Health.Status}}{{else}}none{{end}}|{{.RestartCount}}|{{index .Config.Labels \\"com.docker.compose.project\\"}}|{{index .Config.Labels \\"com.docker.compose.service\\"}}" $(docker ps -aq 2>/dev/null | head -n 200) 2>/dev/null | head -n 200',
  'echo "@@D:stats"',
  'docker stats --no-stream --format "{{.ID}}|{{.Name}}|{{.CPUPerc}}|{{.MemUsage}}|{{.MemPerc}}|{{.NetIO}}|{{.BlockIO}}|{{.PIDs}}" 2>/dev/null | head -n 200',
  'echo "@@D:images"',
  'docker images --format "{{.Repository}}:{{.Tag}}|{{.ID}}|{{.Size}}|{{.CreatedSince}}" 2>/dev/null | head -n 50',
  'echo "@@D:end"',
].join('\n')

/** 云主机上常见的 docker 守护进程访问错误，翻译成可执行的提示 */
export function describeDockerDaemonError(text) {
  const raw = String(text || '')
  if (!raw.trim()) return null
  if (/permission denied/i.test(raw)) {
    return '当前用户无权访问 Docker（把用户加入 docker 组，或改用有权限的账号）'
  }
  if (/cannot connect to the docker daemon|is the docker daemon running/i.test(raw)) {
    return 'Docker 守护进程未运行或 socket 不可达'
  }
  if (/command not found/i.test(raw)) return '远程没有 docker 命令'
  return raw.split(/\r?\n/)[0].slice(0, 300)
}

function toInt(value, fallback = 0) {
  const number = Number.parseInt(String(value ?? '').trim(), 10)
  return Number.isFinite(number) ? number : fallback
}

function toFloat(value, fallback = null) {
  const number = Number.parseFloat(String(value ?? '').replace('%', '').trim())
  return Number.isFinite(number) ? number : fallback
}

/** Docker 的体积写法：512MiB / 2GiB / 142MB / 1.5kB / 0B */
export function parseSize(text) {
  const raw = String(text || '').trim()
  if (!raw) return null
  const match = raw.match(/^([\d.]+)\s*([a-zA-Z]+)?$/)
  if (!match) return null
  const value = Number.parseFloat(match[1])
  if (!Number.isFinite(value)) return null
  const unit = (match[2] || 'B').toLowerCase()
  const factors = {
    b: 1,
    kb: 1000,
    mb: 1000 ** 2,
    gb: 1000 ** 3,
    tb: 1000 ** 4,
    kib: 1024,
    mib: 1024 ** 2,
    gib: 1024 ** 3,
    tib: 1024 ** 4,
    k: 1024,
    m: 1024 ** 2,
    g: 1024 ** 3,
  }
  const factor = factors[unit]
  return factor ? Math.round(value * factor) : null
}

/** `0.0.0.0:8080->3000/tcp, :::8080->3000/tcp, 5001/tcp` -> 端口映射数组 */
export function parseDockerPorts(text) {
  const ports = []
  const seen = new Set()
  for (const rawPart of String(text || '').split(',')) {
    const part = rawPart.trim()
    if (!part) continue
    // 宿主机地址可能是 0.0.0.0 / 127.0.0.1 / :: / [::1]，统一用贪婪匹配取最后一个冒号前的部分
    const published = part.match(/^(.+):(\d+)->(\d+)\/(\w+)$/)
    if (published) {
      const hostIp = published[1].trim()
      const hostPort = toInt(published[2], 0)
      const containerPort = toInt(published[3], 0)
      const proto = published[4].toLowerCase()
      const key = `${hostIp}:${hostPort}->${containerPort}/${proto}`
      if (seen.has(key)) continue
      seen.add(key)
      ports.push({ hostIp, hostPort, containerPort, proto, published: true })
      continue
    }
    const exposed = part.match(/^(\d+)\/(\w+)$/)
    if (exposed) {
      const containerPort = toInt(exposed[1], 0)
      const proto = exposed[2].toLowerCase()
      const key = `exposed:${containerPort}/${proto}`
      if (seen.has(key)) continue
      seen.add(key)
      ports.push({ hostIp: '', hostPort: null, containerPort, proto, published: false })
    }
  }
  return ports
}

/** `Up 3 days (healthy)` / `Exited (0) 2 days ago` / `Restarting (1) 5 seconds ago` */
export function parseContainerStatus(statusText, stateText) {
  const status = String(statusText || '').trim()
  const state = String(stateText || '').trim().toLowerCase() || 'unknown'
  let health = 'none'
  if (/\(healthy\)/i.test(status)) health = 'healthy'
  else if (/\(unhealthy\)/i.test(status)) health = 'unhealthy'
  else if (/\(health: starting\)/i.test(status)) health = 'starting'

  let runningFor = ''
  const up = status.match(/^Up\s+(.+?)(?:\s*\((?:healthy|unhealthy|health: starting)\))?$/i)
  if (up) runningFor = up[1].trim()
  const exited = status.match(/^Exited\s+\((\d+)\)\s*(.*)$/i)
  if (exited) runningFor = exited[2] ? `已退出 ${exited[2]}` : '已退出'

  return { state, health, runningFor, statusText: status }
}

/** 把 "Up 3 days" 这类人类可读时长换算成秒（拿不到精确 StartedAt 时的兜底） */
export function parseHumanDuration(text) {
  const raw = String(text || '').trim()
  if (!raw) return null
  const units = { second: 1, minute: 60, hour: 3600, day: 86400, week: 604800, month: 2592000, year: 31536000 }
  let total = 0
  let matched = false
  const pattern = /(\d+(?:\.\d+)?)\s*(second|minute|hour|day|week|month|year)s?/gi
  let match
  while ((match = pattern.exec(raw)) !== null) {
    total += Number.parseFloat(match[1]) * (units[match[2].toLowerCase()] || 0)
    matched = true
  }
  if (matched) return Math.round(total)
  const short = raw.match(/^(\d+):(\d+):(\d+)$/)
  if (short) return toInt(short[1]) * 3600 + toInt(short[2]) * 60 + toInt(short[3])
  if (/^less than a second/i.test(raw)) return 0
  return null
}

/** docker inspect：一行一个容器 */
export function parseInspectRows(text) {
  const map = new Map()
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || !trimmed.startsWith('sha256:')) continue
    const parts = trimmed.split('|')
    if (parts.length < 6) continue
    const [fullId, name, state, startedAt, health, restartCount, composeProject, composeService] = parts
    map.set(fullId.replace(/^sha256:/, ''), {
      id: fullId.replace(/^sha256:/, ''),
      name: String(name || '').replace(/^\//, ''),
      state: String(state || '').toLowerCase(),
      startedAt: startedAt && startedAt !== '<no value>' ? startedAt : null,
      health: health && health !== '<no value>' ? health : 'none',
      restartCount: toInt(restartCount, 0),
      composeProject: composeProject && composeProject !== '<no value>' ? composeProject : '',
      composeService: composeService && composeService !== '<no value>' ? composeService : '',
    })
  }
  return map
}

/** docker stats --no-stream：按容器名与短 ID 均可检索 */
export function parseStatsRows(text) {
  const byName = new Map()
  const byId = new Map()
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed || trimmed.startsWith('CONTAINER ID')) continue
    const parts = trimmed.split('|')
    if (parts.length < 5) continue
    const [id, name, cpu, memUsage, memPercent, netIo, blockIo, pids] = parts
    const [usedText, limitText] = String(memUsage || '').split('/').map((item) => item.trim())
    const entry = {
      cpuPercent: toFloat(cpu),
      memoryUsedBytes: parseSize(usedText),
      memoryLimitBytes: parseSize(limitText),
      memoryPercent: toFloat(memPercent),
      netIo: netIo || '',
      blockIo: blockIo || '',
      pids: toInt(pids, 0),
    }
    if (name) byName.set(String(name).trim().replace(/^\//, ''), entry)
    if (id) byId.set(String(id).trim(), entry)
  }
  return { byName, byId }
}

/** docker images */
export function parseImages(text) {
  const images = []
  for (const line of String(text || '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parts = trimmed.split('|')
    if (parts.length < 3) continue
    const [repositoryTag, id, size, createdSince] = parts
    const [repository, tag] = String(repositoryTag || '').split(':')
    images.push({
      repository: repository || repositoryTag || 'unknown',
      tag: tag || 'latest',
      id: String(id || ''),
      shortId: String(id || '').slice(0, 12),
      sizeBytes: parseSize(size),
      sizeText: size || '',
      createdSince: createdSince || '',
    })
  }
  return images
}

/** docker info：判断守护进程是否可用 */
export function parseDaemonInfo(text) {
  const raw = String(text || '').trim()
  const error = describeDockerDaemonError(raw)
  const line = raw.split(/\r?\n/).find((item) => item.includes('|')) || ''
  if (!line) return { ok: false, error: error || 'Docker 守护进程无响应', serverVersion: null }
  const [serverVersion, containers, running, stopped, images, driver, os] = line.split('|')
  return {
    ok: true,
    error: null,
    serverVersion: serverVersion || null,
    containers: toInt(containers, 0),
    containersRunning: toInt(running, 0),
    containersStopped: toInt(stopped, 0),
    images: toInt(images, 0),
    driver: driver || '',
    os: (os || '').trim(),
  }
}

/** 整段 docker 输出 -> 快照 */
export function parseDockerSnapshot(stdout) {
  const sections = parseMetricsSections(stdout, DOCKER_SECTION_PREFIX)
  const installed = /yes/i.test((sections.docker || '').trim())
  const daemon = parseDaemonInfo(sections.daemon)
  const inspect = parseInspectRows(sections.inspect)
  const stats = parseStatsRows(sections.stats)

  const containers = []
  for (const line of String(sections.ps || '').split(/\r?\n/)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const parts = trimmed.split('|')
    if (parts.length < 6) continue
    const [fullId, names, image, state, status, portsText, runningFor, labels] = parts
    const id = String(fullId || '').replace(/^sha256:/, '')
    const shortId = id.slice(0, 12)
    const name = String(names || '').replace(/^\//, '')
    const extra = inspect.get(id) || {}
    const stat = stats.byName.get(name) || stats.byId.get(shortId) || stats.byId.get(id) || null
    const parsedStatus = parseContainerStatus(status, state)

    let labelMap = {}
    try {
      for (const pair of String(labels || '').split(',')) {
        const index = pair.indexOf('=')
        if (index > 0) labelMap[pair.slice(0, index).trim()] = pair.slice(index + 1).trim()
      }
    } catch {
      labelMap = {}
    }

    const startedAt = extra.startedAt || null
    const uptimeFromStarted = startedAt ? Math.max(0, Math.round((Date.now() - Date.parse(startedAt)) / 1000)) : null

    containers.push({
      id,
      shortId,
      name,
      image: String(image || ''),
      state: parsedStatus.state,
      statusText: parsedStatus.statusText,
      health: extra.health && extra.health !== 'none' ? extra.health : parsedStatus.health,
      startedAt,
      uptimeSec: Number.isFinite(uptimeFromStarted) ? uptimeFromStarted : parseHumanDuration(parsedStatus.runningFor),
      runningFor: parsedStatus.runningFor,
      restartCount: extra.restartCount ?? 0,
      composeProject: extra.composeProject || labelMap['com.docker.compose.project'] || '',
      composeService: extra.composeService || labelMap['com.docker.compose.service'] || '',
      ports: parseDockerPorts(portsText),
      cpuPercent: stat?.cpuPercent ?? null,
      memoryUsedBytes: stat?.memoryUsedBytes ?? null,
      memoryLimitBytes: stat?.memoryLimitBytes ?? null,
      memoryPercent: stat?.memoryPercent ?? null,
      pids: stat?.pids ?? null,
    })
  }

  const images = parseImages(sections.images)
  const running = containers.filter((item) => item.state === 'running')
  const unhealthy = containers.filter((item) => item.health === 'unhealthy')
  const restarting = containers.filter((item) => item.state === 'restarting')

  return {
    installed,
    daemonOk: daemon.ok,
    daemonError: daemon.error,
    version: (sections.version || '').trim() || daemon.serverVersion || null,
    server: daemon.ok
      ? {
          serverVersion: daemon.serverVersion,
          driver: daemon.driver,
          os: daemon.os,
          containers: daemon.containers,
          running: daemon.containersRunning,
          stopped: daemon.containersStopped,
          images: daemon.images,
        }
      : null,
    containers,
    images,
    summary: {
      total: containers.length,
      running: running.length,
      exited: containers.filter((item) => ['exited', 'created', 'dead'].includes(item.state)).length,
      restarting: restarting.length,
      paused: containers.filter((item) => item.state === 'paused').length,
      unhealthy: unhealthy.length,
      healthy: containers.filter((item) => item.health === 'healthy').length,
      withPublishedPorts: containers.filter((item) => item.ports.some((port) => port.published)).length,
      cpuPercentTotal: Math.round(running.reduce((sum, item) => sum + (item.cpuPercent || 0), 0) * 10) / 10,
      memoryUsedBytes: running.reduce((sum, item) => sum + (item.memoryUsedBytes || 0), 0),
    },
  }
}

/** 容器与 APP 记录的三类核对状态 */
export const CONTAINER_AUDIT_STATES = {
  ok: '已登记且运行',
  recordedStopped: '已登记但停止',
  containerNotRecorded: '容器存在但未登记',
}

function normalizeName(value) {
  return String(value || '')
    .toLowerCase()
    .replace(/[^a-z0-9]/g, '')
}

function findContainerForApp(app, containers) {
  const appPort = Number(app.port) || null
  if (appPort) {
    const byPort = containers.find((container) => container.ports.some((port) => port.published && port.hostPort === appPort))
    if (byPort) return byPort
  }
  const appName = normalizeName(app.name)
  if (!appName) return null
  const exact = containers.find((container) => normalizeName(container.name) === appName)
  if (exact) return exact
  const service = containers.find((container) => normalizeName(container.composeService) === appName)
  if (service) return service
  return (
    containers.find((container) => {
      const name = normalizeName(container.name)
      return name.length > 2 && (name.includes(appName) || appName.includes(name))
    }) || null
  )
}

/**
 * 核对：容器 vs 已登记的 APP/端口
 *   ok                     —— 已登记且运行
 *   recordedStopped        —— 已登记但停止
 *   containerNotRecorded   —— 容器存在但未登记
 */
export function auditContainers(apps = [], containers = []) {
  const items = []
  const usedContainerIds = new Set()

  for (const app of apps) {
    const container = findContainerForApp(app, containers)
    if (container) usedContainerIds.add(container.id)
    const publishedPort = container?.ports.find((port) => port.published) || null
    const running = container?.state === 'running'
    const state = container ? (running ? 'ok' : 'recordedStopped') : null

    if (!container) {
      items.push({
        state: 'recordedStopped',
        matched: false,
        appId: app.id,
        appName: app.name,
        port: app.port ?? null,
        deployPath: app.deployPath || '',
        container: null,
        detail: `工作台登记了「${app.name}」，但没有找到对应的 Docker 容器（可能不是容器部署，或容器已被删除）`,
      })
      continue
    }

    items.push({
      state,
      matched: true,
      appId: app.id,
      appName: app.name,
      port: app.port ?? null,
      deployPath: app.deployPath || '',
      container: {
        id: container.id,
        shortId: container.shortId,
        name: container.name,
        image: container.image,
        state: container.state,
        health: container.health,
        uptimeSec: container.uptimeSec,
        ports: container.ports,
      },
      hostPort: publishedPort?.hostPort ?? null,
      detail: running
        ? `容器 ${container.name} 正在运行${container.health === 'unhealthy' ? '（健康检查异常）' : ''}`
        : `容器 ${container.name} 存在但未运行（${container.statusText || container.state}）`,
    })
  }

  for (const container of containers) {
    if (usedContainerIds.has(container.id)) continue
    const published = container.ports.filter((port) => port.published)
    items.push({
      state: 'containerNotRecorded',
      matched: false,
      appId: null,
      appName: container.name,
      port: published[0]?.hostPort ?? null,
      deployPath: '',
      container: {
        id: container.id,
        shortId: container.shortId,
        name: container.name,
        image: container.image,
        state: container.state,
        health: container.health,
        uptimeSec: container.uptimeSec,
        ports: container.ports,
      },
      hostPort: published[0]?.hostPort ?? null,
      detail: `容器 ${container.name}（${container.image}）${
        container.state === 'running' ? '正在运行' : `未运行：${container.statusText || container.state}`
      }，但工作台里没有登记`,
    })
  }

  items.sort((a, b) => (a.port ?? 99999) - (b.port ?? 99999) || String(a.appName).localeCompare(String(b.appName)))

  return {
    items,
    summary: {
      ok: items.filter((item) => item.state === 'ok').length,
      recordedStopped: items.filter((item) => item.state === 'recordedStopped').length,
      containerNotRecorded: items.filter((item) => item.state === 'containerNotRecorded').length,
    },
  }
}
