import { resourceStore } from '../store/resourceStore.js'
import {
  RESOURCE_MIN_GAP_MS,
  RESOURCE_SPIKE_COOLDOWN_MS,
  RESOURCE_SPIKE_CPU_PERCENT,
  RESOURCE_SPIKE_MEMORY_PERCENT,
} from '../config.js'
import { logRepo } from '../store/logRepo.js'

/**
 * 资源历史趋势（第七阶段·第三轮）。
 *
 * 三条口径（与本项目一贯做法一致）：
 *  1. **只记真实采样，绝不插值**：两次采集之间的空档如实返回 `gaps`，前端画断点而不是假连线；
 *  2. **采样去抖**：两次采样间隔小于 RESOURCE_MIN_GAP_MS 就跳过，手动连点「SSH 检测」不会把历史刷爆；
 *  3. **告警冷却**：同一台机器同一指标在 RESOURCE_SPIKE_COOLDOWN_MS 内只报一次，
 *     持续高负载不会每轮刷一条告警。
 *
 * 尖峰告警**不进 events.json**：CPU 高不是"服务生命周期变化"，混进时间线会污染第六阶段的语义。
 */

/** 从一次采集结果里抽出可入库的水位（全部来自已采集字段，不做任何推算） */
export function extractSample(server, { source = 'manual', at = null } = {}) {
  const metrics = server?.metrics || null
  const docker = server?.docker || null
  if (!metrics && !docker) return null

  const rootDisk = (metrics?.disk || []).find((item) => item.mount === '/') || (metrics?.disk || [])[0] || null

  return {
    at: at || metrics?.collectedAt || metrics?.at || new Date().toISOString(),
    source: source === 'auto' ? 'auto' : 'manual',
    cpuPercent: numberOrNull(metrics?.cpuUsagePercent),
    memoryUsedBytes: numberOrNull(metrics?.memory?.usedBytes),
    memoryTotalBytes: numberOrNull(metrics?.memory?.totalBytes),
    memoryUsedPercent: numberOrNull(metrics?.memory?.usedPercent),
    load1: numberOrNull(metrics?.load?.one),
    // 容器侧：只有采到 stats 才有值，采不到就是 null（不是 0）
    containerCpuPercent: numberOrNull(docker?.summary?.cpuPercentTotal),
    containerMemoryBytes: numberOrNull(docker?.summary?.memoryUsedBytes),
    containerCount: numberOrNull(docker?.summary?.running),
    diskUsedPercent: numberOrNull(rootDisk?.usePercent),
  }
}

/**
 * 只有真正的数值才算数。
 * 注意不能写成 `Number(value)` 再判有限：`Number(null)`、`Number('')` 都等于 0，
 * 会把"这一项没采到"伪造成"CPU 0%"画进趋势图。
 */
function numberOrNull(value) {
  if (value === null || value === undefined || value === '') return null
  if (typeof value === 'boolean') return null
  const num = Number(value)
  return Number.isFinite(num) ? num : null
}

/** 判定本轮是否触发尖峰；返回需要记录的告警列表 */
export function detectSpikes(serverId, serverName, sample, { now = Date.now(), lastSpikeTimes = {} } = {}) {
  const rules = [
    {
      metric: 'cpu',
      value: sample.cpuPercent,
      threshold: RESOURCE_SPIKE_CPU_PERCENT,
      message: `CPU 使用率 ${sample.cpuPercent}%（阈值 ${RESOURCE_SPIKE_CPU_PERCENT}%）`,
    },
    {
      metric: 'memory',
      value: sample.memoryUsedPercent,
      threshold: RESOURCE_SPIKE_MEMORY_PERCENT,
      message: `内存使用率 ${sample.memoryUsedPercent}%（阈值 ${RESOURCE_SPIKE_MEMORY_PERCENT}%）`,
    },
  ]

  const spikes = []
  for (const rule of rules) {
    if (rule.value === null || rule.value === undefined) continue // 采不到就不判定，绝不猜
    if (rule.value < rule.threshold) continue
    const lastAt = lastSpikeTimes[rule.metric]
    // 从未告警过时 lastAt 是 undefined/0：必须直接放行，
    // 不能拿 `now - 0` 去比冷却（那等于拿纪元时间做差，语义完全错）。
    if (lastAt && now - lastAt < RESOURCE_SPIKE_COOLDOWN_MS) continue // 冷却中，不重复报
    spikes.push({
      at: new Date(now).toISOString(),
      serverId,
      serverName,
      metric: rule.metric,
      value: rule.value,
      threshold: rule.threshold,
      message: rule.message,
    })
  }
  return spikes
}

/**
 * 记录一次采集的资源水位。
 * @returns {{ recorded: boolean, reason?: string, sample?: object, spikes?: object[] }}
 */
export async function recordSample(server, { source = 'manual' } = {}) {
  if (!server?.id) return { recorded: false, reason: 'no-server' }
  try {
    const sample = extractSample(server, { source })
    if (!sample) return { recorded: false, reason: 'no-metrics' }
    if (sample.cpuPercent === null && sample.memoryUsedPercent === null && sample.containerCount === null) {
      // 一个可用水位都没有：存进去也只是噪声，直接跳过
      return { recorded: false, reason: 'no-usable-values' }
    }

    const last = await resourceStore.lastSample(server.id)
    if (last) {
      const gap = Date.parse(sample.at) - Date.parse(last.at)
      if (Number.isFinite(gap) && gap >= 0 && gap < RESOURCE_MIN_GAP_MS) {
        return { recorded: false, reason: 'too-soon', gapMs: gap, minGapMs: RESOURCE_MIN_GAP_MS }
      }
    }

    const stored = await resourceStore.addSample(server.id, sample)

    // 告警判定：读最近一次同指标告警时间做冷却
    const existing = await resourceStore.spikes({ serverId: server.id, limit: 20 })
    const lastSpikeTimes = {}
    for (const item of existing) {
      const at = Date.parse(item.at) || 0
      if (at > (lastSpikeTimes[item.metric] || 0)) lastSpikeTimes[item.metric] = at
    }
    const spikes = detectSpikes(server.id, server.name || '', stored, { lastSpikeTimes })
    for (const spike of spikes) {
      await resourceStore.addSpike(spike)
      await logRepo.append({ level: 'warn', source: server.name || server.id, message: `资源尖峰：${spike.message}` })
    }

    return { recorded: true, sample: stored, spikes }
  } catch (error) {
    // 记录历史属于旁路：任何失败都不能影响采集主流程
    return { recorded: false, reason: 'error', error: error.message }
  }
}

/** 把采样点整理成前端可直接画的序列，并如实标出空档 */
export function buildSeries(samples, { windowMs = null, now = Date.now(), gapFactor = 3 } = {}) {
  const points = (samples || []).map((item) => ({ at: item.at, ts: Date.parse(item.at) || 0 }))
  const gaps = []
  if (points.length > 1) {
    // 期望间隔：取相邻间隔的中位数，放大 3 倍仍没数据才算断档
    const deltas = []
    for (let i = 1; i < points.length; i += 1) {
      const delta = points[i].ts - points[i - 1].ts
      if (delta > 0) deltas.push(delta)
    }
    const median = deltas.length ? deltas.slice().sort((a, b) => a - b)[Math.floor(deltas.length / 2)] : 0
    const threshold = Math.max(RESOURCE_MIN_GAP_MS * gapFactor, median * gapFactor)
    for (let i = 1; i < points.length; i += 1) {
      if (points[i].ts - points[i - 1].ts > threshold) {
        gaps.push({ from: points[i - 1].at, to: points[i].at, ms: points[i].ts - points[i - 1].ts })
      }
    }
  }

  const spanOf = (key) => {
    const values = (samples || []).map((item) => item[key]).filter((value) => typeof value === 'number' && Number.isFinite(value))
    if (values.length === 0) return null
    return {
      min: Math.min(...values),
      max: Math.max(...values),
      avg: Math.round((values.reduce((sum, value) => sum + value, 0) / values.length) * 100) / 100,
      last: values[values.length - 1],
      samples: values.length,
    }
  }

  return {
    windowMs: windowMs ?? null,
    from: points[0]?.at || null,
    to: points[points.length - 1]?.at || null,
    count: points.length,
    gaps,
    // 采集是否还在继续：最后一个点太旧就说明自动采集停了，前端要提示"数据不新鲜"
    stale: points.length > 0 ? now - points[points.length - 1].ts > Math.max(RESOURCE_MIN_GAP_MS * 10, 1800000) : true,
    stats: {
      cpuPercent: spanOf('cpuPercent'),
      memoryUsedPercent: spanOf('memoryUsedPercent'),
      load1: spanOf('load1'),
      containerCpuPercent: spanOf('containerCpuPercent'),
      containerMemoryBytes: spanOf('containerMemoryBytes'),
      diskUsedPercent: spanOf('diskUsedPercent'),
    },
  }
}

/**
 * 解析时间窗口参数：支持 `30m` / `1h` / `6h` / `24h` / `7d` 与裸毫秒数字。
 * 无法识别时返回 null（表示不限窗口，返回文件里现存的全部采样点）。
 */
export function parseWindow(value) {
  if (value === null || value === undefined || value === '') return null
  const text = String(value).trim().toLowerCase()
  if (/^\d+$/.test(text)) {
    const ms = Number(text)
    return ms > 0 && ms <= 365 * 24 * 3600000 ? ms : null
  }
  const match = text.match(/^(\d+(?:\.\d+)?)\s*(s|m|h|d|w)$/)
  if (!match) return null
  const unit = { s: 1000, m: 60000, h: 3600000, d: 86400000, w: 604800000 }[match[2]]
  const ms = Math.round(Number(match[1]) * unit)
  return Number.isFinite(ms) && ms > 0 && ms <= 365 * 24 * 3600000 ? ms : null
}

/** 查询某台机器的历史（面板用） */
export async function getHistory(serverId, { windowMs = null, limit = 0 } = {}) {
  const samples = await resourceStore.samplesFor(serverId, { windowMs, limit })
  const spikes = await resourceStore.spikes({ serverId, limit: 20 })
  return { serverId, samples, series: buildSeries(samples, { windowMs }), spikes }
}

/** 批量查询（项目资源面板一次要看好几台机器） */
export async function getHistories(serverIds = [], { windowMs = null } = {}) {
  const out = {}
  for (const serverId of serverIds) {
    out[serverId] = await getHistory(serverId, { windowMs })
  }
  return out
}

export const RESOURCE_HISTORY_LIMITS = {
  minGapMs: RESOURCE_MIN_GAP_MS,
  spikeCooldownMs: RESOURCE_SPIKE_COOLDOWN_MS,
  spikeCpuPercent: RESOURCE_SPIKE_CPU_PERCENT,
  spikeMemoryPercent: RESOURCE_SPIKE_MEMORY_PERCENT,
}
