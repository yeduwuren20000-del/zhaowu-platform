import { createJsonStore } from './jsonStore.js'
import { FILES } from '../config.js'
import { nowIso } from '../utils/ids.js'
import { createSerialQueue } from '../utils/serialQueue.js'

/**
 * SSH 自动刷新的持久化（monitor.json）：
 *   - settings.enabled     是否开启后台定时采集（默认关，用户显式打开）
 *   - settings.intervalMs  采集间隔
 *   - settings.includeDocker  是否顺带采集 Docker
 *   - lastRun              最近一轮的结果摘要（UI 显示"上次自动采集于…"）
 *   - health               每台机器的熔断状态：连续失败次数、下次允许重试时间
 *
 * 为什么要持久化 health：占位机器（示例数据里那些连不上的 IP）如果每轮都重试，
 * 就会把 workbench.log 刷满"SSH 采集失败"。熔断后它们只在退避到期时才再试一次。
 */

export const MIN_INTERVAL_MS = 30000
export const MAX_INTERVAL_MS = 3600000
export const DEFAULT_INTERVAL_MS = 120000

/** 连续失败 N 次后开始退避，之后每次失败退避时间翻倍（上限 30 分钟） */
export const FAILURE_THRESHOLD = 2
export const BACKOFF_STEP_MS = 60000
export const BACKOFF_MAX_MS = 1800000

const store = createJsonStore(FILES.monitor, {
  seed: () => ({
    version: 1,
    settings: { enabled: false, intervalMs: DEFAULT_INTERVAL_MS, includeDocker: true },
    lastRun: null,
    health: {},
  }),
  isValid: (value) => Boolean(value) && typeof value === 'object' && typeof value.settings === 'object',
})

function clampInterval(value) {
  const num = Number(value)
  if (!Number.isFinite(num)) return DEFAULT_INTERVAL_MS
  return Math.min(MAX_INTERVAL_MS, Math.max(MIN_INTERVAL_MS, Math.round(num)))
}

/** 这台机器现在能不能采集（熔断退避判断） */
export function isCircuitOpen(healthEntry, now = Date.now()) {
  if (!healthEntry || !healthEntry.retryAfter) return false
  return now < Date.parse(healthEntry.retryAfter)
}

/** 失败后的退避时长：第 3 次失败 1 分钟，第 4 次 2 分钟……封顶 30 分钟 */
export function backoffMsFor(failures) {
  if (failures <= FAILURE_THRESHOLD) return 0
  return Math.min(BACKOFF_MAX_MS, BACKOFF_STEP_MS * 2 ** (failures - FAILURE_THRESHOLD - 1))
}

/**
 * 失败计数的"读-改-写"必须串行。
 *
 * jsonStore.mutate 只把**写盘**排进队列，读快照与 clone 是立刻发生的：
 * 三台机器并行 recordOutcome 时，它们基于同一份旧快照各自 +1，最后写入者覆盖前面的，
 * 结果失败次数被低估、该熔断的机器迟迟不熔断（实测：失败 4 次只记到 1 次）。
 * 串行化的通用做法已抽到 utils/serialQueue.js，这里直接复用。
 */
const serialize = createSerialQueue()

export const monitorRepo = {
  file: FILES.monitor,

  async read() {
    const data = await store.read()
    const settings = data.settings || {}
    return {
      version: data.version || 1,
      settings: {
        enabled: Boolean(settings.enabled),
        intervalMs: clampInterval(settings.intervalMs),
        includeDocker: settings.includeDocker !== false,
      },
      lastRun: data.lastRun || null,
      health: data.health && typeof data.health === 'object' ? data.health : {},
    }
  },

  /** 更新设置（只接受这三个字段，intervalMs 会被钳制到合法区间） */
  async updateSettings(patch = {}) {
    return serialize(() =>
      store.mutate((data) => {
        const settings = data.settings || (data.settings = { enabled: false, intervalMs: DEFAULT_INTERVAL_MS, includeDocker: true })
        if (typeof patch.enabled === 'boolean') settings.enabled = patch.enabled
        if (patch.intervalMs !== undefined) settings.intervalMs = clampInterval(patch.intervalMs)
        if (typeof patch.includeDocker === 'boolean') settings.includeDocker = patch.includeDocker
        return { ...settings }
      }),
    )
  },

  /** 记录一轮自动采集的结果摘要 */
  async setLastRun(summary) {
    return serialize(() =>
      store.mutate((data) => {
        data.lastRun = { ...summary, at: nowIso() }
        return data.lastRun
      }),
    )
  },

  /**
   * 记录某台机器本轮的成败：成功清零失败计数；失败累加并算出下次重试时间。
   * @returns {{ failures: number, retryAfter: string|null }}
   */
  async recordOutcome(serverId, { ok, error = null }) {
    return serialize(() =>
      store.mutate((data) => {
        const health = data.health || (data.health = {})
        const previous = health[serverId] || { failures: 0, retryAfter: null, lastError: null }
        if (ok) {
          health[serverId] = { failures: 0, retryAfter: null, lastError: null, lastOkAt: nowIso() }
          return health[serverId]
        }
        const failures = (previous.failures || 0) + 1
        const wait = backoffMsFor(failures)
        health[serverId] = {
          failures,
          retryAfter: wait > 0 ? new Date(Date.now() + wait).toISOString() : null,
          lastError: String(error || '采集失败').slice(0, 200),
          lastFailedAt: nowIso(),
        }
        return health[serverId]
      }),
    )
  },

  /** 手动采集成功后清掉该机器的熔断（用户主动点探测就该立刻再试） */
  async clearFailure(serverId) {
    return serialize(() =>
      store.mutate((data) => {
        const health = data.health || (data.health = {})
        health[serverId] = { failures: 0, retryAfter: null, lastError: null, lastOkAt: nowIso() }
        return health[serverId]
      }),
    )
  },

  /** 立即重试：清掉退避，让下一轮就再采一次（UI 的"立即重试"按钮用） */
  async resetCircuit(serverId) {
    return serialize(() =>
      store.mutate((data) => {
        const health = data.health || (data.health = {})
        health[serverId] = { failures: 0, retryAfter: null, lastError: null }
        return health[serverId]
      }),
    )
  },

  /**
   * 直接设置某台机器的熔断状态（运维/测试用）。
   * 只影响"什么时候再试"，不触碰任何事实数据，所以风险有限；
   * retryAfter 传 null 表示不熔断。
   */
  async setHealth(serverId, { failures = 0, retryAfter = null, lastError = null } = {}) {
    return serialize(() =>
      store.mutate((data) => {
        const health = data.health || (data.health = {})
        const wait = Number(failures) > 0 ? backoffMsFor(Number(failures)) : 0
        health[serverId] = {
          failures: Number(failures) || 0,
          retryAfter: retryAfter === undefined ? (wait > 0 ? new Date(Date.now() + wait).toISOString() : null) : retryAfter,
          lastError: lastError ? String(lastError).slice(0, 200) : null,
        }
        return health[serverId]
      }),
    )
  },

  /** 服务器被删除时清掉它的熔断记录，避免 health 表无限增长 */
  async forgetServer(serverId) {
    return serialize(() =>
      store.mutate((data) => {
        if (data.health) delete data.health[serverId]
        return true
      }),
    )
  },
}
