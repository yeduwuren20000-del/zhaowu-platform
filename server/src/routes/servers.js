import { Router } from 'express'
import { logRepo } from '../store/logRepo.js'
import { serversRepo } from '../store/serversRepo.js'
import { monitorRepo } from '../store/monitorRepo.js'
import { getServerView, listServerViews, probeServer, probeServerApp, probeServers } from '../services/serverService.js'
import { checkServerLogPaths, limiterStats, monitorServer, monitorServers, readServerLog } from '../services/serverMonitor.js'
import { autoMonitorStatus, runRound, setAutoMonitorInterval, startAutoMonitor, stopAutoMonitor } from '../services/autoMonitor.js'
import { getHistory, parseWindow, RESOURCE_HISTORY_LIMITS } from '../services/resourceHistory.js'
import { asyncRoute, sendOk } from '../utils/http.js'
import { parseServerQuickFill } from '../utils/serverQuickFill.js'
import { sanitizeAppInput, sanitizeServerInput } from '../utils/validation.js'

const router = Router()

/**
 * 服务器「快速填入」：粘贴 ssh 命令 / 连接串 / .ssh/config 片段，自动拆成表单字段。
 * 固定路径，必须注册在 `/:id` 之前。
 */
router.post(
  '/quick-fill',
  asyncRoute(async (req, res) => {
    sendOk(res, parseServerQuickFill(req.body?.text))
  }),
)

router.get(
  '/',
  asyncRoute(async (req, res) => {
    sendOk(res, await listServerViews())
  }),
)

/** TCP 探测（不依赖 SSH，作为兜底在线判定） */
router.post(
  '/probe',
  asyncRoute(async (req, res) => {
    const result = await probeServers({ force: req.query.force === '1' || req.body?.force === true })
    sendOk(res, { ...result, servers: await listServerViews() })
  }),
)

/** SSH 只读采集：批量。默认只采集过期（60 秒）的数据，force=1 全量重采 */
router.post(
  '/probe-ssh',
  asyncRoute(async (req, res) => {
    const result = await monitorServers({
      force: req.query.force === '1' || req.body?.force === true,
      staleMs: Number(req.body?.staleMs) || 60000,
      ids: Array.isArray(req.body?.ids) ? req.body.ids : null,
    })
    sendOk(res, { ...result, limiter: limiterStats(), servers: await listServerViews() })
  }),
)

// ---- 自动刷新调度器（第七阶段·第二轮）----
// 注意：这些固定路径必须注册在下面的 `/:id` 之前，否则会被当成服务器 ID 匹配掉。

router.get(
  '/auto-monitor',
  asyncRoute(async (req, res) => {
    sendOk(res, await autoMonitorStatus())
  }),
)

router.post(
  '/auto-monitor/start',
  asyncRoute(async (req, res) => {
    const result = await startAutoMonitor({ intervalMs: req.body?.intervalMs })
    await logRepo.append({
      level: 'info',
      source: '自动采集',
      message: `已开启 SSH 自动刷新，间隔 ${Math.round(result.intervalMs / 1000)} 秒`,
    })
    sendOk(res, { ...result, servers: await listServerViews() })
  }),
)

router.post(
  '/auto-monitor/stop',
  asyncRoute(async (req, res) => {
    const result = await stopAutoMonitor()
    await logRepo.append({ level: 'info', source: '自动采集', message: '已停止 SSH 自动刷新' })
    sendOk(res, result)
  }),
)

router.post(
  '/auto-monitor/interval',
  asyncRoute(async (req, res) => {
    sendOk(res, await setAutoMonitorInterval(req.body?.intervalMs))
  }),
)

/** 立刻手动触发一轮（走同一套熔断规则，用于"立即采集"按钮） */
router.post(
  '/auto-monitor/run',
  asyncRoute(async (req, res) => {
    const round = await runRound({ reason: 'manual' })
    sendOk(res, { ...round, status: await autoMonitorStatus(), servers: await listServerViews() })
  }),
)

router.post(
  '/',
  asyncRoute(async (req, res) => {
    const created = await serversRepo.create(sanitizeServerInput(req.body))
    await logRepo.append({ level: 'info', source: created.name, message: `新增服务器 ${created.host}:${created.sshPort}` })
    sendOk(res, created)
  }),
)

router.get(
  '/:id',
  asyncRoute(async (req, res) => {
    sendOk(res, await serversRepo.get(req.params.id))
  }),
)

router.put(
  '/:id',
  asyncRoute(async (req, res) => {
    const updated = await serversRepo.update(req.params.id, sanitizeServerInput(req.body, { partial: true }))
    await logRepo.append({ level: 'info', source: updated.name, message: '服务器信息已更新' })
    sendOk(res, updated)
  }),
)

router.delete(
  '/:id',
  asyncRoute(async (req, res) => {
    const removed = await serversRepo.remove(req.params.id)
    // 顺带清掉自动采集的熔断记录，避免 monitor.json 的 health 表无限增长
    await monitorRepo.forgetServer(req.params.id)
    await logRepo.append({ level: 'warn', source: removed.name, message: '服务器记录已删除（含其 APP 记录）' })
    sendOk(res, { removed })
  }),
)

router.post(
  '/:id/probe',
  asyncRoute(async (req, res) => {
    const server = await serversRepo.get(req.params.id)
    sendOk(res, await probeServer(server))
  }),
)

/** SSH 只读采集：单台。返回指标、真实监听端口与端口核对结果 */
router.post(
  '/:id/probe-ssh',
  asyncRoute(async (req, res) => {
    const result = await monitorServer(req.params.id, { force: req.body?.force !== false })
    // 用户主动探测 = 明确想再试一次：成功就清掉自动采集的熔断退避，失败也记进熔断状态
    if (!result.error) await monitorRepo.clearFailure(req.params.id)
    else await monitorRepo.recordOutcome(req.params.id, { ok: false, error: result.error.message })
    sendOk(res, {
      cached: result.cached,
      error: result.error || null,
      metrics: result.metrics || null,
      audit: result.audit || null,
      server: await getServerView(req.params.id),
    })
  }),
)

/** 资源历史趋势（第三轮）：?window=1h|6h|24h|7d，只返回真实采样点与如实的空档 */
router.get(
  '/:id/history',
  asyncRoute(async (req, res) => {
    const windowMs = parseWindow(req.query.window)
    const history = await getHistory(req.params.id, { windowMs })
    const server = await serversRepo.get(req.params.id)
    sendOk(res, {
      serverId: req.params.id,
      serverName: server.name,
      limits: RESOURCE_HISTORY_LIMITS,
      ...history,
    })
  }),
)

/** 真实监听端口 + 与 APP 记录比对的三类状态（?live=1 会先重采一次） */
router.get(
  '/:id/ports',
  asyncRoute(async (req, res) => {
    if (req.query.live === '1') await monitorServer(req.params.id, { force: true }).catch(() => {})
    const server = await serversRepo.get(req.params.id)
    const audit = server.portAudit || { summary: null, items: [] }
    sendOk(res, {
      server: server.name,
      collectedAt: server.lastMonitorAt || null,
      online: Boolean(server.ssh?.ok),
      listeningPorts: server.listeningPorts || [],
      audit: { summary: audit.summary || null, items: audit.items || [] },
      apps: (server.apps || []).map((app) => ({ id: app.id, name: app.name, port: app.port, deployPath: app.deployPath, status: app.status })),
    })
  }),
)

/** Docker 只读视图：容器 / 镜像 / 资源占用 / 与 APP 的三类核对（?live=1 先重采一次） */
router.get(
  '/:id/docker',
  asyncRoute(async (req, res) => {
    if (req.query.live === '1') await monitorServer(req.params.id, { force: true }).catch(() => {})
    const server = await serversRepo.get(req.params.id)
    const docker = server.docker || null
    sendOk(res, {
      server: server.name,
      collectedAt: docker?.at || null,
      online: Boolean(server.ssh?.ok),
      installed: docker?.installed ?? null,
      daemonOk: docker?.daemonOk ?? null,
      error: docker?.error ?? null,
      version: docker?.version ?? null,
      daemon: docker?.server ?? null,
      summary: docker?.summary ?? null,
      containers: docker?.containers || [],
      images: docker?.images || [],
      audit: docker?.audit || { summary: null, items: [] },
      note: '只读采集：仅使用 docker ps / images / inspect / stats --no-stream / info / version',
    })
  }),
)

/** 读取远程日志：路径必须来自该服务器预先登记的 logPaths */
router.get(
  '/:id/log',
  asyncRoute(async (req, res) => {
    const lines = Math.min(Number(req.query.lines) || 200, 2000)
    sendOk(res, await readServerLog(req.params.id, req.query.path ? String(req.query.path) : null, { lines }))
  }),
)

/** 检查已登记日志路径是否存在（只读 stat，便于用户确认路径写对了） */
router.post(
  '/:id/log-check',
  asyncRoute(async (req, res) => {
    sendOk(res, await checkServerLogPaths(req.params.id))
  }),
)

router.post(
  '/:id/apps',
  asyncRoute(async (req, res) => {
    const server = await serversRepo.get(req.params.id)
    const app = await serversRepo.addApp(server.id, sanitizeAppInput(req.body))
    await logRepo.append({
      level: 'info',
      source: server.name,
      message: `新增应用记录：${app.name}（端口 ${app.port ?? '未记录'}，路径 ${app.deployPath || '未填写'}）`,
    })
    sendOk(res, app)
  }),
)

router.put(
  '/:id/apps/:appId',
  asyncRoute(async (req, res) => {
    const server = await serversRepo.get(req.params.id)
    const app = await serversRepo.updateApp(server.id, req.params.appId, sanitizeAppInput(req.body, { partial: true }))
    await logRepo.append({ level: 'info', source: server.name, message: `应用记录已更新：${app.name}` })
    sendOk(res, app)
  }),
)

router.delete(
  '/:id/apps/:appId',
  asyncRoute(async (req, res) => {
    const server = await serversRepo.get(req.params.id)
    const removed = await serversRepo.removeApp(server.id, req.params.appId)
    await logRepo.append({ level: 'warn', source: server.name, message: `应用记录已删除：${removed.name}` })
    sendOk(res, { removed })
  }),
)

router.post(
  '/:id/apps/:appId/probe',
  asyncRoute(async (req, res) => {
    const server = await serversRepo.get(req.params.id)
    const app = (server.apps || []).find((item) => item.id === req.params.appId)
    if (!app) {
      res.status(404).json({ ok: false, error: { message: 'APP 记录不存在' } })
      return
    }
    sendOk(res, await probeServerApp(server, app))
  }),
)

export default router
