import net from 'node:net'
import { PROBE_TIMEOUT_MS } from '../config.js'
import { serversRepo } from '../store/serversRepo.js'
import { logRepo } from '../store/logRepo.js'
import { nowIso } from '../utils/ids.js'
import { monitorStatusOf } from './serverMonitor.js'

/** TCP 连通性探测：判断服务器/端口是否真的可达（不依赖 SSH 客户端） */
export function probeTcp(host, port, timeoutMs = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const target = { host, port: Number(port) }
    let settled = false
    const finish = (online, error = null) => {
      if (settled) return
      settled = true
      socket.destroy()
      resolve({ ...target, online, latencyMs: online ? Date.now() - startedAt : null, error })
    }
    const socket = new net.Socket()
    socket.setTimeout(timeoutMs)
    socket.once('connect', () => finish(true))
    socket.once('timeout', () => finish(false, '连接超时'))
    socket.once('error', (error) => finish(false, error.code || error.message))
    try {
      socket.connect(Number(port) || 22, host)
    } catch (error) {
      finish(false, error.message)
    }
  })
}

/** TCP 探测 SSH 端口并落库（SSH 采集不可用时的兜底在线判定） */
export async function probeServer(server) {
  const result = await probeTcp(server.host, server.sshPort || 22)
  const updated = await serversRepo.setProbe(server.id, { online: result.online, latencyMs: result.latencyMs })
  await logRepo.append({
    level: result.online ? 'success' : 'warn',
    source: server.name,
    message: result.online
      ? `TCP ${server.host}:${server.sshPort || 22} 可达（${result.latencyMs}ms）`
      : `TCP ${server.host}:${server.sshPort || 22} 不可达（${result.error}）`,
  })
  return updated
}

/**
 * 批量 TCP 探测：只探测"没有新鲜 SSH 结果"的服务器，
 * 避免 SSH 监控正常时还去重复连一次。
 */
export async function probeServers({ force = false, staleMs = 60000 } = {}) {
  const servers = await serversRepo.list()
  const now = Date.now()
  const targets = servers.filter((server) => {
    const sshFresh = server.ssh?.at && now - Date.parse(server.ssh.at) < staleMs
    if (sshFresh) return false
    if (force) return true
    if (!server.lastCheckedAt) return true
    return now - Date.parse(server.lastCheckedAt) > staleMs
  })

  const results = await Promise.all(
    targets.map(async (server) => {
      try {
        return await probeServer(server)
      } catch (error) {
        return { ...server, online: false, probeError: error.message }
      }
    }),
  )
  return { probed: results.length, results }
}

/** 探测服务器下某个 APP 的端口是否可达（结果不落库，属于即时事实） */
export async function probeServerApp(server, app) {
  if (!app?.port) return { online: false, error: '该 APP 未记录端口' }
  const result = await probeTcp(server.host, app.port)
  await logRepo.append({
    level: result.online ? 'info' : 'warn',
    source: server.name,
    message: `${app.name} ${server.host}:${app.port} ${result.online ? `可达（${result.latencyMs}ms）` : `不可达（${result.error}）`}`,
  })
  return { ...result, checkedAt: nowIso() }
}

/** 单台服务器视图 */
export async function getServerView(id) {
  const views = await listServerViews()
  return views.find((view) => view.id === id) || null
}

/** 服务器视图：记录 + 监控状态（SSH 优先）+ 资源摘要 + 端口核对摘要 + Docker 摘要 */
export async function listServerViews() {
  const servers = await serversRepo.list()
  return servers.map((server) => {
    const monitor = monitorStatusOf(server)
    const metrics = server.metrics || null
    const audit = server.portAudit || null
    const docker = server.docker || null
    const apps = server.apps || []
    const primaryDisk = (metrics?.disk || []).find((item) => item.mount === '/') || metrics?.disk?.[0] || null

    // 容器发布的宿主机端口 -> 容器，供端口映射页标注来源
    const dockerPorts = new Map()
    for (const container of docker?.containers || []) {
      for (const port of container.ports || []) {
        if (!port.published || !port.hostPort) continue
        if (!dockerPorts.has(port.hostPort)) {
          dockerPorts.set(port.hostPort, {
            containerId: container.id,
            containerName: container.name,
            image: container.image,
            state: container.state,
            health: container.health,
            containerPort: port.containerPort,
            proto: port.proto,
            hostIp: port.hostIp,
          })
        }
      }
    }

    return {
      ...server,
      appCount: apps.length,
      runningApps: apps.filter((app) => app.status === 'running').length,
      monitor,
      // 兼容第一阶段字段：在线状态优先取 SSH 采集结果
      online: monitor.online,
      latencyMs: monitor.latencyMs,
      lastCheckedAt: monitor.at,
      auditSummary: audit?.summary || null,
      monitoredAt: server.lastMonitorAt || null,
      dockerSummary: docker?.summary || null,
      dockerInfo: docker
        ? {
            installed: docker.installed,
            daemonOk: docker.daemonOk,
            error: docker.error || null,
            version: docker.version || null,
            server: docker.server || null,
            collectedAt: docker.at || null,
            imageCount: (docker.images || []).length,
            audit: docker.audit?.summary || null,
          }
        : null,
      dockerPorts: Object.fromEntries(dockerPorts),
      resources: metrics
        ? {
            hostname: metrics.hostname || null,
            os: metrics.os || null,
            kernel: metrics.kernel || null,
            arch: metrics.arch || null,
            loginUser: metrics.loginUser || null,
            uptimeSec: metrics.uptimeSec ?? null,
            load: metrics.load || null,
            cpuCores: metrics.cpuCores ?? null,
            cpuUsagePercent: metrics.cpuUsagePercent ?? null,
            memory: metrics.memory || null,
            disk: primaryDisk,
            diskCount: (metrics.disk || []).length,
            portCount: (metrics.ports || []).length,
            collectedAt: metrics.collectedAt || null,
          }
        : null,
    }
  })
}
