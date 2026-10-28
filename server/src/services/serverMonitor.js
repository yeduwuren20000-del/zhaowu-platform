import { createLimiter } from '../utils/limiter.js'
import { isSafeRemotePath } from '../utils/validation.js'
import { badRequest, HttpError } from '../utils/http.js'
import { nowIso } from '../utils/ids.js'
import { serversRepo } from '../store/serversRepo.js'
import { logRepo } from '../store/logRepo.js'
import { closeSsh, connectSsh, execSsh, sshPathInfo, sshReadFileTail } from './sshClient.js'
import { METRICS_COMMAND, auditPorts, parseMetrics } from './sshMetrics.js'
import { DOCKER_COMMAND, auditContainers, parseDockerSnapshot } from './dockerMetrics.js'
import { observeServerMonitor } from './eventService.js'
import { recordSample } from './resourceHistory.js'

/**
 * SSH 只读监控编排：
 *  - 并发上限（默认 3，可用 DSM_SSH_CONCURRENCY 调整），同一台服务器同一时刻只跑一次采集；
 *  - 每次采集都是一条固定脚本，没有任何外部拼接命令；
 *  - 采集结果落到 servers.json 的 ssh / metrics / listeningPorts / portAudit 字段。
 */

export const SSH_CONCURRENCY = Math.max(1, Number(process.env.DSM_SSH_CONCURRENCY || 3))
const limiter = createLimiter(SSH_CONCURRENCY)
const inFlight = new Map()

/** 服务器当前的监控状态（SSH 优先，其次 TCP 探测结果） */
export function monitorStatusOf(server) {
  const ssh = server.ssh || null
  if (ssh?.at) {
    return {
      mode: 'ssh',
      online: Boolean(ssh.ok),
      latencyMs: ssh.latencyMs ?? null,
      at: ssh.at,
      error: ssh.error || null,
      code: ssh.code || null,
    }
  }
  if (server.lastCheckedAt) {
    return {
      mode: 'tcp',
      online: Boolean(server.online),
      latencyMs: server.latencyMs ?? null,
      at: server.lastCheckedAt,
      error: null,
      code: null,
    }
  }
  return { mode: 'none', online: false, latencyMs: null, at: null, error: null, code: null }
}

export function limiterStats() {
  return { limit: limiter.limit, active: limiter.active, pending: limiter.pending }
}

/** 单台服务器：一次完整只读采集（系统指标 + Docker 容器） */
async function probeOnce(server, { includeDocker = true, source = 'manual' } = {}) {
  const startedAt = Date.now()
  let client = null
  try {
    const connection = await connectSsh(server)
    client = connection.client
    const execTimeout = Math.max(15000, (Number(server.connectTimeout) || 8000) + 15000)
    const result = await execSsh(client, METRICS_COMMAND, { timeoutMs: execTimeout })

    const metrics = parseMetrics(result.stdout)
    const audit = auditPorts(server.apps || [], metrics.ports)

    // Docker 采集复用同一条连接；失败不影响系统指标
    let docker = null
    let dockerError = null
    if (includeDocker) {
      try {
        const dockerResult = await execSsh(client, DOCKER_COMMAND, { timeoutMs: execTimeout })
        const snapshot = parseDockerSnapshot(dockerResult.stdout)
        const containerAudit = auditContainers(server.apps || [], snapshot.containers)
        docker = {
          installed: snapshot.installed,
          daemonOk: snapshot.daemonOk,
          error: snapshot.daemonError,
          version: snapshot.version,
          server: snapshot.server,
          containers: snapshot.containers,
          images: snapshot.images,
          summary: snapshot.summary,
          audit: { summary: containerAudit.summary, items: containerAudit.items },
        }
      } catch (error) {
        dockerError = error.message
        docker = {
          installed: null,
          daemonOk: false,
          error: `Docker 采集失败：${error.message}`,
          version: null,
          server: null,
          containers: [],
          images: [],
          summary: null,
          audit: null,
        }
      }
    }

    const ssh = {
      ok: true,
      latencyMs: connection.latencyMs,
      durationMs: Date.now() - startedAt,
      error: null,
      code: null,
      authType: connection.authType,
      loginUser: metrics.loginUser || server.username || null,
      at: nowIso(),
    }
    const updated = await serversRepo.setSshMonitor(server.id, {
      ssh,
      metrics: { ...metrics, collectedAt: nowIso() },
      listeningPorts: metrics.ports,
      portAudit: { summary: audit.summary, items: audit.items },
      docker,
    })
    await logRepo.append({
      level: 'success',
      source: server.name,
      message:
        `SSH 采集成功（${connection.latencyMs}ms）：${metrics.hostname || server.host} · ` +
        `监听端口 ${audit.summary.totalListening} 个 · 未登记 ${audit.summary.listeningNotRecorded} 个 · 未监听 ${audit.summary.recordedNotListening} 个` +
        (docker
          ? docker.installed
            ? ` · Docker 容器 ${docker.summary?.total ?? 0} 个（运行 ${docker.summary?.running ?? 0}、异常 ${(docker.summary?.unhealthy ?? 0) + (docker.summary?.restarting ?? 0)}）`
            : ' · 未安装 Docker'
          : ''),
    })
    if (dockerError) {
      await logRepo.append({ level: 'warn', source: server.name, message: `Docker 采集失败：${dockerError}` })
    } else if (docker?.installed && !docker.daemonOk) {
      await logRepo.append({ level: 'warn', source: server.name, message: `Docker 不可用：${docker.error}` })
    }
    await observeServerMonitor(updated)

    // 第三轮：只有采集成功才记历史水位。
    // 失败路径不能记 —— setSshMonitor 在失败时保留上一次的 metrics，
    // 拿它当新采样点会让趋势图出现"假稳定"（同一个旧值反复出现）。
    await recordSample(updated, { source }).catch(() => {})

    return { server: updated, metrics, audit, docker, cached: false }
  } catch (error) {
    const ssh = {
      ok: false,
      latencyMs: null,
      durationMs: Date.now() - startedAt,
      error: error.message,
      code: error.code || 'SSH_ERROR',
      authType: server.authType || 'key',
      loginUser: null,
      at: nowIso(),
    }
    const updated = await serversRepo.setSshMonitor(server.id, { ssh })
    await observeServerMonitor(updated).catch(() => {})
    await logRepo.append({ level: 'warn', source: server.name, message: `SSH 采集失败：${error.message}` })
    return { server: updated, error: { message: error.message, code: ssh.code }, cached: false }
  } finally {
    if (client) closeSsh(client)
  }
}

/** 采集某台服务器（带 30 秒内的结果缓存与并发去重） */
export async function monitorServer(id, { force = false, staleMs = 30000, includeDocker = true, source = 'manual' } = {}) {
  const server = await serversRepo.get(id)
  if (server.monitorEnabled === false) throw badRequest('该服务器已关闭 SSH 监控')

  const fresh = server.lastMonitorAt && Date.now() - Date.parse(server.lastMonitorAt) < staleMs
  if (!force && fresh) {
    const audit = server.portAudit ? { summary: server.portAudit.summary, items: server.portAudit.items || [] } : null
    const containerAudit = server.docker?.audit ? { summary: server.docker.audit.summary, items: server.docker.audit.items || [] } : null
    return { server, metrics: server.metrics || null, audit, docker: server.docker || null, containerAudit, cached: true }
  }

  const running = inFlight.get(id)
  if (running) return running

  const withDocker = includeDocker && server.dockerMonitorEnabled !== false
  const task = limiter
    .run(() => probeOnce(server, { includeDocker: withDocker, source }))
    .finally(() => inFlight.delete(id))
  inFlight.set(id, task)
  return task
}

/** 批量采集（首页/服务器页刷新按钮）。默认只采集过期数据，force=true 全量重采。 */
export async function monitorServers({ force = false, staleMs = 60000, ids = null, includeDocker = true } = {}) {
  const servers = await serversRepo.list()
  const scope = servers.filter((server) => server.monitorEnabled !== false && (!ids || ids.includes(server.id)))
  const targets = force
    ? scope
    : scope.filter((server) => !server.lastMonitorAt || Date.now() - Date.parse(server.lastMonitorAt) > staleMs)

  const results = await Promise.all(
    targets.map((server) =>
      monitorServer(server.id, { force: true, includeDocker }).catch((error) => ({
        server,
        error: { message: error.message, code: error.code || 'SSH_ERROR' },
      })),
    ),
  )

  return {
    probed: targets.length,
    skipped: scope.length - targets.length,
    failed: results.filter((item) => item.error).length,
    concurrency: SSH_CONCURRENCY,
    results,
  }
}

/**
 * 读取远程日志：路径必须来自服务器配置里的 logPaths 允许列表，
 * 走 SFTP 直接读文件尾部，不经过 shell，也没有任何自由命令入口。
 */
export async function readServerLog(id, remotePath, { lines = 200 } = {}) {
  const server = await serversRepo.get(id)
  const allowed = server.logPaths || []
  const target = remotePath || allowed[0]
  if (!target) {
    throw badRequest('这台服务器还没有配置可读日志路径，请先在「编辑服务器」里添加，例如 /var/log/nginx/error.log')
  }
  if (!allowed.includes(target) || !isSafeRemotePath(target)) {
    throw new HttpError(403, '只允许读取该服务器配置里预先登记的日志路径')
  }

  let client = null
  try {
    const connection = await connectSsh(server)
    client = connection.client
    const result = await sshReadFileTail(client, target, { lines })
    await serversRepo.setLogRead(id, { path: target, lines: result.lines.length, size: result.size })
    await logRepo.append({
      level: 'info',
      source: server.name,
      message: `读取远程日志 ${target}（最后 ${result.lines.length} 行，文件 ${result.size} 字节）`,
    })
    return {
      server: server.name,
      path: target,
      size: result.size,
      mtime: result.mtime,
      truncated: result.truncated,
      lines: result.lines,
      allowed,
    }
  } catch (error) {
    await serversRepo.setLogRead(id, { path: target, lines: 0, size: null, error: error.message })
    throw error instanceof HttpError ? error : new HttpError(502, `读取远程日志失败：${error.message}`)
  } finally {
    if (client) closeSsh(client)
  }
}

/** 检查已登记日志路径是否存在、大小、最后修改时间（只读 stat） */
export async function checkServerLogPaths(id) {
  const server = await serversRepo.get(id)
  const allowed = server.logPaths || []
  if (allowed.length === 0) return { paths: [] }

  let client = null
  try {
    const connection = await connectSsh(server)
    client = connection.client
    const paths = []
    for (const remotePath of allowed) {
      try {
        const info = await sshPathInfo(client, remotePath)
        paths.push({ path: remotePath, ...info })
      } catch (error) {
        paths.push({ path: remotePath, exists: false, error: error.message })
      }
    }
    return { server: server.name, paths }
  } finally {
    if (client) closeSsh(client)
  }
}
