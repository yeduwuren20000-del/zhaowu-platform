/**
 * 按项目组归集资源占用（第七阶段）。
 *
 * 目标：把「本地项目组」和「远程服务器 / Docker 容器」已有的只读采集结果关联起来，
 * 让「这个项目一共占了多少 CPU / 内存」在一处看得见。
 *
 * 三条硬规则（与前几阶段一致）：
 *  1. **只归集已有采集结果**，不发起任何新采集、不补任何估算值；
 *     没有采集过的服务器 / 容器一律不出现（宁可少，不可编）。
 *  2. **自动关联只用端口**。本地 `projectDir`（Windows 路径）和远程 `deployPath`（Linux 路径）
 *     本来就不可比，容器名 / compose 名也属于"按名称猜"——这两类一律不做自动关联，
 *     改由用户在项目上**显式登记远程关联**（见 `remoteLinks`），那是记录下来的事实，不是猜测。
 *  3. 系统级 CPU / 内存 / 磁盘属于**整台机器**，不算到任何一个项目头上（否则就是虚构归因），
 *     只作为参照单独列出。
 */

/** 自动关联依据 */
export const AUTO_BASIS = { port: '端口一致' }

/** 显式关联依据（用户在项目上手工登记的关联） */
export const LINK_BASIS = {
  port: '端口一致',
  explicit: '手工登记的关联',
  system: '系统级（不归到项目）',
}

function normalizePath(value) {
  if (!value) return ''
  return String(value)
    .trim()
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase()
}

function normalizeName(value) {
  if (!value) return ''
  return String(value).trim().replace(/[-_.]+/g, '-').toLowerCase()
}

/** 取项目组里所有"自己声明过"的端口（主端口 + 子服务端口 + 监听中的新子服务） */
export function groupPorts(group) {
  const ports = new Set()
  const project = group?.project || null
  if (project?.port) ports.add(Number(project.port))
  for (const service of project?.services || []) {
    if (service?.port) ports.add(Number(service.port))
  }
  for (const service of group?.services || []) {
    if (service?.live && service?.port) ports.add(Number(service.port))
  }
  return [...ports].filter((port) => Number.isInteger(port) && port > 0).sort((a, b) => a - b)
}

/** 容器发布到宿主机的端口集合 */
function containerPublishedPorts(container) {
  return new Set((container.ports || []).map((item) => Number(item.published)).filter((port) => Number.isInteger(port)))
}

/** 项目上手工登记的远程关联：[{ serverId, appId?, containerName?, note? }] */
export function projectRemoteLinks(group) {
  const links = group?.project?.remoteLinks
  return Array.isArray(links) ? links.filter((link) => link && link.serverId) : []
}

function matchesExplicit(group, server, { appId = null, containerName = null } = {}) {
  return projectRemoteLinks(group).some((link) => {
    if (normalizeName(link.serverId) !== normalizeName(server.id)) return false
    if (appId) return normalizeName(link.appId) === normalizeName(appId)
    if (containerName) return normalizeName(link.containerName) === normalizeName(containerName)
    return true // 只写了 serverId：表示这台机整体与项目相关
  })
}

/**
 * 把一台服务器的采集结果关联到某个项目组。
 * 自动关联只看端口；显式关联优先。
 */
export function linkServerToGroup(group, server) {
  const servers = []
  const containers = []
  if (!server || !group) return { servers, containers }

  const ports = new Set(groupPorts(group))
  const metrics = server.metrics || null
  const docker = server.docker || null
  const online = Boolean(server.ssh?.ok)

  // ---- 1) 容器：端口命中，或用户显式登记了这个容器 ----
  for (const container of docker?.containers || []) {
    if (container.state !== 'running') continue

    const published = containerPublishedPorts(container)
    const portHit = [...ports].some((port) => published.has(port))
    const explicitHit = matchesExplicit(group, server, { containerName: container.name })
    if (!portHit && !explicitHit) continue

    containers.push({
      serverId: server.id,
      serverName: server.name,
      name: container.name,
      image: container.image,
      state: container.state,
      health: container.health,
      basis: portHit ? AUTO_BASIS.port : LINK_BASIS.explicit,
      auto: portHit,
      cpuPercent: container.cpuPercent ?? null,
      memoryUsedBytes: container.memoryUsedBytes ?? null,
      memoryPercent: container.memoryPercent ?? null,
      ports: [...published].sort((a, b) => a - b),
    })
  }

  // ---- 2) 服务器 APP 记录：端口命中，或用户显式登记了这个 APP ----
  const apps = []
  for (const app of server.apps || []) {
    const port = Number(app.port) || null
    const portHit = Boolean(port && ports.has(port))
    const explicitHit = matchesExplicit(group, server, { appId: app.id })
    if (!portHit && !explicitHit) continue
    apps.push({
      appId: app.id,
      appName: app.name,
      port: app.port ?? null,
      deployPath: app.deployPath || '',
      status: app.status,
      basis: portHit ? AUTO_BASIS.port : LINK_BASIS.explicit,
      auto: portHit,
    })
  }

  const explicitServerLink = projectRemoteLinks(group).some((link) => normalizeName(link.serverId) === normalizeName(server.id))

  if (containers.length === 0 && apps.length === 0 && !explicitServerLink) return { servers, containers }

  servers.push({
    serverId: server.id,
    serverName: server.name,
    host: server.host,
    online,
    collectedAt: metrics?.at || server.ssh?.at || null,
    basis: containers.find((item) => item.auto)?.basis || apps.find((item) => item.auto)?.basis || LINK_BASIS.explicit,
    apps,
    // 系统级指标：明确标注"整台机器"，不计入项目合计
    system: metrics
      ? {
          scope: 'system',
          note: '整机指标，不计入项目合计',
          cpuUsagePercent: metrics.cpuUsagePercent ?? null,
          cpuCores: metrics.cpuCores ?? null,
          memoryTotalBytes: metrics.memory?.totalBytes ?? null,
          memoryUsedBytes: metrics.memory?.usedBytes ?? null,
          memoryUsedPercent: metrics.memory?.usedPercent ?? null,
          load: metrics.load ?? null,
          disks: (metrics.disk || []).map((item) => ({
            mount: item.mount,
            totalBytes: item.totalBytes ?? null,
            usedBytes: item.usedBytes ?? null,
            usedPercent: item.usedPercent ?? null,
          })),
        }
      : null,
  })

  return { servers, containers }
}

/**
 * 把所有服务器的采集结果归集到所有项目组。
 * @param {object} input
 * @param {Array} input.groups   项目分组（需要带 project 字段，含 port / services / remoteLinks）
 * @param {Array} input.servers  servers.json 里的服务器记录（带 metrics / docker / apps）
 */
export function aggregateProjectResources({ groups = [], servers = [] } = {}) {
  // 只看"采集过"的服务器：没有 metrics 也没有容器的一律不算数
  const collected = servers.filter((server) => server.metrics || server.docker?.containers?.length)

  const items = groups.map((group) => {
    const serversOut = []
    const containersOut = []
    const unlinkedServers = []

    for (const server of collected) {
      const linked = linkServerToGroup(group, server)
      if (linked.servers.length > 0) {
        serversOut.push(...linked.servers)
        containersOut.push(...linked.containers)
      } else if (server.metrics) {
        unlinkedServers.push({
          serverId: server.id,
          serverName: server.name,
          host: server.host,
          reason: '端口没对上，也没登记手工关联',
        })
      }
    }

    const running = containersOut.filter((item) => item.state === 'running')
    const cpuPercent = running.reduce((sum, item) => sum + (item.cpuPercent || 0), 0)
    const memoryUsedBytes = running.reduce((sum, item) => sum + (item.memoryUsedBytes || 0), 0)

    return {
      groupId: group.id,
      groupName: group.name,
      projectId: group.registeredProjectId || null,
      projectDir: group.projectDir || null,
      ports: groupPorts(group),
      servers: serversOut,
      containers: containersOut,
      unlinkedServers,
      totals: {
        // 只累加容器指标（可归因到项目）；系统指标不计入
        scope: 'containers-only',
        note: '合计只统计能归因到本项目的容器；整机指标不计入',
        serverCount: serversOut.length,
        containerCount: containersOut.length,
        runningContainerCount: running.length,
        cpuPercent: Math.round(cpuPercent * 10) / 10,
        memoryUsedBytes,
        hasData: running.length > 0,
      },
    }
  })

  return {
    items,
    summary: {
      groups: items.length,
      withContainers: items.filter((item) => item.totals.containerCount > 0).length,
      containers: items.reduce((sum, item) => sum + item.totals.containerCount, 0),
      cpuPercent: Math.round(items.reduce((sum, item) => sum + item.totals.cpuPercent, 0) * 10) / 10,
      memoryUsedBytes: items.reduce((sum, item) => sum + item.totals.memoryUsedBytes, 0),
      collectedServers: collected.length,
      totalServers: servers.length,
    },
  }
}

export { normalizePath, normalizeName }
