import { logRepo } from '../store/logRepo.js'
import { nowIso } from '../utils/ids.js'
import { observeMappingConflicts, observeProjectStates, recentActivity } from './eventService.js'
import { buildMappings } from './mappingService.js'
import { buildProjectViews } from './projectService.js'
import { listServerViews } from './serverService.js'
import { getDiscoveryState } from './localDiscoveryService.js'
import { getLocalResources } from './localResourceService.js'

/** 首页总览：四张统计卡 + Docker 统计 + 项目/服务器/端口/日志区块 + 自动发现提醒 */
export async function buildDashboard({ force = false } = {}) {
  const projectViews = await buildProjectViews({ force })
  const servers = await listServerViews()
  const { rows, conflicts, stats: portStats } = await buildMappings({ projectViews, servers })
  const events = await logRepo.tail(15)
  const discovery = await getDiscoveryState().catch(() => null)
  // 刷新总览 = 观察一次所有主体：只有与上次指纹不同才产生事件
  await observeProjectStates(projectViews)
  await observeMappingConflicts(conflicts)
  const timeline = await recentActivity(12)
  // 本机资源：独立采集、失败静默降级，不拖累首页
  const local = await getLocalResources({ force }).catch(() => null)

  const runningProjects = projectViews.filter((view) => view.status === 'running')
  const onlineServers = servers.filter((server) => server.online)
  const sshMonitored = servers.filter((server) => server.monitor?.mode === 'ssh')
  const sshHealthy = sshMonitored.filter((server) => server.monitor.online)
  const latencyList = sshHealthy.map((server) => server.monitor.latencyMs).filter((value) => Number.isFinite(value))
  const avgLatency = latencyList.length ? Math.round(latencyList.reduce((sum, value) => sum + value, 0) / latencyList.length) : null

  const resourceList = sshHealthy.map((server) => server.resources).filter(Boolean)
  const avg = (values) => {
    const list = values.filter((value) => Number.isFinite(value))
    return list.length ? Math.round((list.reduce((sum, value) => sum + value, 0) / list.length) * 10) / 10 : null
  }
  const auditTotals = servers.reduce(
    (acc, server) => {
      const summary = server.auditSummary
      if (summary) {
        acc.ok += summary.ok || 0
        acc.recordedNotListening += summary.recordedNotListening || 0
        acc.listeningNotRecorded += summary.listeningNotRecorded || 0
      }
      return acc
    },
    { ok: 0, recordedNotListening: 0, listeningNotRecorded: 0 },
  )

  // Docker 容器统计（只统计采集成功且 Docker 可用的服务器）
  const dockerServers = servers.filter((server) => server.dockerInfo?.installed && server.dockerInfo?.daemonOk)
  const dockerTotals = dockerServers.reduce(
    (acc, server) => {
      const summary = server.dockerSummary || {}
      acc.containers += summary.total || 0
      acc.running += summary.running || 0
      acc.stopped += (summary.exited || 0) + (summary.paused || 0) + (summary.restarting || 0)
      acc.unhealthy += summary.unhealthy || 0
      acc.restarting += summary.restarting || 0
      acc.images += server.dockerInfo?.imageCount || 0
      acc.cpuPercent += summary.cpuPercentTotal || 0
      acc.memoryUsedBytes += summary.memoryUsedBytes || 0
      return acc
    },
    { containers: 0, running: 0, stopped: 0, unhealthy: 0, restarting: 0, images: 0, cpuPercent: 0, memoryUsedBytes: 0 },
  )
  const dockerContainerAudit = servers.reduce(
    (acc, server) => {
      const summary = server.dockerInfo?.audit
      if (summary) {
        acc.ok += summary.ok || 0
        acc.recordedStopped += summary.recordedStopped || 0
        acc.containerNotRecorded += summary.containerNotRecorded || 0
      }
      return acc
    },
    { ok: 0, recordedStopped: 0, containerNotRecorded: 0 },
  )

  return {
    generatedAt: nowIso(),
    stats: {
      localRunning: { value: runningProjects.length, total: projectViews.length, label: '本地运行中', hint: `共 ${projectViews.length} 个本地项目` },
      serversOnline: {
        value: onlineServers.length,
        total: servers.length,
        label: '在线服务器',
        hint: sshMonitored.length
          ? `SSH 监控 ${sshHealthy.length}/${sshMonitored.length}${avgLatency !== null ? ` · 平均 ${avgLatency}ms` : ''}`
          : servers.length
            ? '尚未做 SSH 采集（点「SSH 检测」）'
            : '尚未添加服务器',
      },
      recordedPorts: {
        value: Math.max(0, portStats.total - (portStats.unregistered || 0)),
        label: '已记录端口',
        hint: `本地 ${portStats.local} · 服务器 ${portStats.server}${portStats.unregistered ? ` · 未登记 ${portStats.unregistered}` : ''}`,
      },
      conflicts: { value: conflicts.length, label: '端口冲突', hint: conflicts.length ? '点击查看冲突明细' : '当前没有冲突' },
    },
    ssh: {
      monitored: sshMonitored.length,
      online: sshHealthy.length,
      avgLatencyMs: avgLatency,
      avgCpuUsagePercent: avg(resourceList.map((item) => item.cpuUsagePercent)),
      avgMemoryUsedPercent: avg(resourceList.map((item) => item.memory?.usedPercent)),
      maxDiskUsedPercent: resourceList.length
        ? Math.max(...resourceList.map((item) => item.disk?.usePercent ?? 0))
        : null,
      avgDiskUsedPercent: avg(resourceList.map((item) => item.disk?.usePercent)),
      audit: auditTotals,
    },
    docker: {
      servers: servers.length,
      monitoredServers: dockerServers.length,
      installedServers: servers.filter((server) => server.dockerInfo?.installed).length,
      unavailableServers: servers.filter((server) => server.dockerInfo?.installed && !server.dockerInfo.daemonOk).length,
      containers: dockerTotals.containers,
      running: dockerTotals.running,
      stopped: dockerTotals.stopped,
      unhealthy: dockerTotals.unhealthy,
      restarting: dockerTotals.restarting,
      images: dockerTotals.images,
      cpuPercentTotal: Math.round(dockerTotals.cpuPercent * 10) / 10,
      memoryUsedBytes: dockerTotals.memoryUsedBytes,
      audit: dockerContainerAudit,
      // 首页容器列表：按 CPU 占用排序，最多 8 个
      top: dockerServers
        .flatMap((server) =>
          (server.docker?.containers || []).map((container) => ({
            serverId: server.id,
            serverName: server.name,
            name: container.name,
            image: container.image,
            state: container.state,
            health: container.health,
            uptimeSec: container.uptimeSec,
            cpuPercent: container.cpuPercent,
            memoryUsedBytes: container.memoryUsedBytes,
            memoryPercent: container.memoryPercent,
            ports: (container.ports || []).filter((port) => port.published).map((port) => port.hostPort),
          })),
        )
        .sort((a, b) => (b.cpuPercent || 0) - (a.cpuPercent || 0))
        .slice(0, 8),
    },
    projects: projectViews,
    servers,
    ports: rows,
    portStats,
    conflicts,
    events,
    timeline,
    discovery,
    local,
  }
}
