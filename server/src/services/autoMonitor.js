import { serversRepo } from '../store/serversRepo.js'
import { monitorRepo, isCircuitOpen, MIN_INTERVAL_MS, MAX_INTERVAL_MS, DEFAULT_INTERVAL_MS } from '../store/monitorRepo.js'
import { monitorServer } from './serverMonitor.js'
import { nowIso } from '../utils/ids.js'

/**
 * SSH 自动刷新调度器（第七阶段·第二轮）。
 *
 * 设计约束：
 *  1. **默认关闭**：用户显式开启后才跑，不会一启动就连示例数据里的占位机器。
 *  2. **绝不并发打爆**：复用 serverMonitor 的并发上限（DSM_SSH_CONCURRENCY）与同机互斥，
 *     这里只负责"这一轮该采谁"。
 *  3. **熔断退避**：连续失败的机器进入退避期，到期才再试一次 —— 否则示例数据里那些
 *     连不上的 IP 会把 workbench.log 刷满失败记录。
 *  4. **一轮不许拖成长跑**：整轮有硬超时，超时的机器记为失败，不影响下一轮。
 *  5. **任何异常都不许冒出去**：定时器回调里全量 catch，采集失败不能让工作台挂掉。
 *  6. 定时器 unref，不阻止进程退出。
 */

const ROUND_TIMEOUT_MS = 90000

let timer = null
let running = false
let ticking = false
let stats = { ticks: 0, rounds: 0, skippedBusy: 0 }

function clampInterval(value) {
  const num = Number(value)
  if (!Number.isFinite(num) || num <= 0) return DEFAULT_INTERVAL_MS
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(num)))
}

/**
 * 决定这一轮要采集哪些服务器。
 * @param {Array} servers 全部服务器记录
 * @param {object} health monitorRepo 里的熔断状态
 * @param {number} now 当前时间戳
 */
export function selectTargets(servers, health = {}, { now = Date.now(), includeDocker = true } = {}) {
  const eligible = []
  const onHold = []
  for (const server of servers || []) {
    // 关闭了 SSH 监控的机器不参与自动刷新；includeDocker 只影响采集内容，不影响是否采集
    if (server.monitorEnabled === false) continue
    const entry = health[server.id]
    if (isCircuitOpen(entry, now)) {
      onHold.push({
        serverId: server.id,
        name: server.name,
        failures: entry.failures || 0,
        retryAfter: entry.retryAfter,
        lastError: entry.lastError || null,
      })
      continue
    }
    eligible.push(server)
  }
  return { eligible, onHold }
}

/** 给一批采集结果打分：成功/失败/缓存复用 */
function summarizeResults(results = []) {
  const ok = results.filter((item) => item.ok).length
  const failed = results.filter((item) => !item.ok).length
  return { ok, failed, total: results.length }
}

/**
 * 执行一轮自动采集。返回本轮摘要；并发保护：上一轮没结束就直接跳过。
 */
export async function runRound({ reason = 'timer' } = {}) {
  if (ticking) {
    stats.skippedBusy += 1
    return { skipped: 'busy', reason }
  }
  ticking = true
  const startedAt = Date.now()
  try {
    const [{ settings, health }, servers] = await Promise.all([monitorRepo.read(), serversRepo.list()])
    const { eligible, onHold } = selectTargets(servers, health, { includeDocker: settings.includeDocker })

    if (eligible.length === 0) {
      const summary = {
        reason,
        probed: 0,
        ok: 0,
        failed: 0,
        onHold: onHold.length,
        durationMs: Date.now() - startedAt,
        at: nowIso(),
      }
      await monitorRepo.setLastRun(summary)
      return summary
    }

    const settled = await Promise.race([
      Promise.all(
        eligible.map(async (server) => {
          try {
            const result = await monitorServer(server.id, { force: true, includeDocker: settings.includeDocker, source: 'auto' })
            // monitorServer 不抛错时也可能带回 error（连接失败走 catch 分支返回 error 字段）
            const ok = !result.error
            await monitorRepo.recordOutcome(server.id, { ok, error: result.error?.message || null })
            return { serverId: server.id, name: server.name, ok, error: result.error?.message || null, cached: Boolean(result.cached) }
          } catch (error) {
            // "已关闭 SSH 监控"这类配置性错误不该进入熔断退避
            const configIssue = error?.status === 400
            if (!configIssue) await monitorRepo.recordOutcome(server.id, { ok: false, error: error.message })
            return { serverId: server.id, name: server.name, ok: false, error: error.message, configIssue }
          }
        }),
      ),
      new Promise((resolve) => {
        const t = setTimeout(() => resolve(null), ROUND_TIMEOUT_MS)
        if (typeof t.unref === 'function') t.unref()
      }),
    ])

    if (settled === null) {
      const summary = {
        reason,
        probed: eligible.length,
        ok: 0,
        failed: eligible.length,
        onHold: onHold.length,
        timeout: true,
        durationMs: Date.now() - startedAt,
        at: nowIso(),
      }
      await monitorRepo.setLastRun(summary)
      return summary
    }

    const scores = summarizeResults(settled)
    const summary = {
      reason,
      probed: scores.total,
      ok: scores.ok,
      failed: scores.failed,
      onHold: onHold.length,
      heldNames: onHold.map((item) => item.name),
      durationMs: Date.now() - startedAt,
      at: nowIso(),
    }
    stats.rounds += 1
    await monitorRepo.setLastRun(summary)
    return summary
  } catch (error) {
    // 调度器自己出错也不能影响主流程
    return { reason, error: error.message, probed: 0, ok: 0, failed: 0, durationMs: Date.now() - startedAt, at: nowIso() }
  } finally {
    ticking = false
  }
}

function arm(intervalMs) {
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  timer = setInterval(() => {
    stats.ticks += 1
    runRound({ reason: 'timer' }).catch(() => {})
  }, intervalMs)
  if (typeof timer.unref === 'function') timer.unref()
}

/** 启动自动刷新（幂等：已在跑就只按需要调整间隔） */
export async function startAutoMonitor({ intervalMs } = {}) {
  const current = await monitorRepo.read()
  const nextInterval = clampInterval(intervalMs ?? current.settings.intervalMs)
  if (intervalMs !== undefined) await monitorRepo.updateSettings({ intervalMs: nextInterval })
  await monitorRepo.updateSettings({ enabled: true })

  const wasRunning = running
  running = true
  arm(nextInterval)
  // 开启后立刻采一轮，别让 UI 干等一个完整间隔
  const first = wasRunning ? null : runRound({ reason: 'start' })
  return {
    running: true,
    intervalMs: nextInterval,
    startedAt: nowIso(),
    firstRound: first ? await first : null,
  }
}

/** 停止自动刷新（保留设置，下次还能开） */
export async function stopAutoMonitor() {
  running = false
  if (timer) {
    clearInterval(timer)
    timer = null
  }
  await monitorRepo.updateSettings({ enabled: false })
  return { running: false, at: nowIso() }
}

/** 修改间隔：运行中则重新排期 */
export async function setAutoMonitorInterval(intervalMs) {
  const clamped = clampInterval(intervalMs)
  await monitorRepo.updateSettings({ intervalMs: clamped })
  if (running) arm(clamped)
  return { intervalMs: clamped, rearmed: running }
}

/** 调度器状态（UI 轮询用） */
export async function autoMonitorStatus() {
  const data = await monitorRepo.read()
  const servers = await serversRepo.list()
  const nameById = new Map(servers.map((server) => [server.id, server.name]))
  const held = Object.entries(data.health)
    .filter(([, entry]) => isCircuitOpen(entry))
    .map(([serverId, entry]) => ({
      serverId,
      name: nameById.get(serverId) || serverId,
      failures: entry.failures,
      retryAfter: entry.retryAfter,
      lastError: entry.lastError,
    }))
  return {
    running,
    ticking,
    settings: data.settings,
    lastRun: data.lastRun,
    held: held.length,
    heldServers: held,
    limits: { minIntervalMs: MIN_INTERVAL_MS, maxIntervalMs: MAX_INTERVAL_MS },
    stats: { ...stats },
  }
}

/** 进程启动时按持久化设置恢复自动刷新 */
export async function restoreAutoMonitor() {
  const data = await monitorRepo.read()
  if (!data.settings.enabled) return { running: false, reason: 'disabled' }
  running = true
  arm(data.settings.intervalMs)
  // 启动后延一点再采第一轮，避开 bootstrap 的端口扫描与启动对账
  const t = setTimeout(() => {
    runRound({ reason: 'startup' }).catch(() => {})
  }, 4000)
  if (typeof t.unref === 'function') t.unref()
  return { running: true, intervalMs: data.settings.intervalMs }
}

export const AUTO_MONITOR_DEFAULTS = { minIntervalMs: MIN_INTERVAL_MS, maxIntervalMs: MAX_INTERVAL_MS, defaultIntervalMs: DEFAULT_INTERVAL_MS }
