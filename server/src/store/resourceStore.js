import { createJsonStore } from './jsonStore.js'
import { FILES, RESOURCE_MAX_SAMPLES, RESOURCE_MAX_SPIKES } from '../config.js'
import { createSerialQueue } from '../utils/serialQueue.js'

/**
 * 资源采样历史（第七阶段·第三轮）：data/resources.json
 *
 * 结构：
 *   { version, samples: { [serverId]: [ {at, cpuPercent, ...} ] }, spikes: [ ... ] }
 *
 * 设计约束（与本项目一贯口径一致）：
 *   - **只存真实采样点，绝不插值补点**：某段时间没采集就是空档，查询时会把空档如实返回；
 *   - 按服务器分桶存环形数组，超出 RESOURCE_MAX_SAMPLES 丢最旧的，文件不会无限增长；
 *   - 尖峰告警单独一份列表，带冷却时间，避免高负载期间每 2 分钟刷一条。
 *
 * 与 events.json 的分工：events 记「服务生命周期变化」（启动/停止/冲突/上下线），
 * 这里记「资源水位」，两者不互相污染 —— CPU 高不是生命周期事件。
 */

const store = createJsonStore(FILES.resources, {
  seed: () => ({ version: 1, samples: {}, spikes: [] }),
  isValid: (value) => Boolean(value) && typeof value === 'object' && typeof value.samples === 'object',
})

function normalize(data) {
  if (!data.samples || typeof data.samples !== 'object') data.samples = {}
  if (!Array.isArray(data.spikes)) data.spikes = []
  return data
}

/** 环形裁剪：每台服务器只保留最近 N 个采样点 */
function prune(data) {
  for (const key of Object.keys(data.samples)) {
    const list = data.samples[key]
    if (!Array.isArray(list)) {
      data.samples[key] = []
      continue
    }
    if (list.length > RESOURCE_MAX_SAMPLES) data.samples[key] = list.slice(-RESOURCE_MAX_SAMPLES)
  }
  if (data.spikes.length > RESOURCE_MAX_SPIKES) data.spikes = data.spikes.slice(-RESOURCE_MAX_SPIKES)
  return data
}

/** 读-改-写串行化：一轮里多台机器同时采样会并发写同一份快照（见 utils/serialQueue.js） */
const serialize = createSerialQueue()

/** 采样点字段白名单：只收数字与时间，其它一律不进历史文件 */
function pickSample(input = {}) {
  const num = (value) => (typeof value === 'number' && Number.isFinite(value) ? Math.round(value * 100) / 100 : null)
  return {
    at: typeof input.at === 'string' ? input.at : new Date().toISOString(),
    source: input.source === 'auto' ? 'auto' : 'manual',
    cpuPercent: num(input.cpuPercent),
    memoryUsedBytes: num(input.memoryUsedBytes),
    memoryTotalBytes: num(input.memoryTotalBytes),
    memoryUsedPercent: num(input.memoryUsedPercent),
    load1: num(input.load1),
    containerCpuPercent: num(input.containerCpuPercent),
    containerMemoryBytes: num(input.containerMemoryBytes),
    containerCount: num(input.containerCount),
    diskUsedPercent: num(input.diskUsedPercent),
  }
}

export const resourceStore = {
  file: FILES.resources,

  async read() {
    return normalize(await store.read())
  },

  /** 追加一个采样点（同一台机器） */
  async addSample(serverId, sample) {
    if (!serverId) return null
    const point = pickSample(sample)
    return serialize(() =>
      store.mutate((data) => {
        normalize(data)
        const list = data.samples[serverId] || (data.samples[serverId] = [])
        list.push(point)
        prune(data)
        return point
      }),
    )
  },

  /** 最近一次采样（面板显示"数据新鲜度"用） */
  async lastSample(serverId) {
    const data = await resourceStore.read()
    const list = data.samples[serverId] || []
    return list.length > 0 ? list[list.length - 1] : null
  },

  /**
   * 取某台机器一段时间内的采样点（时间正序）。
   * @param {number} [windowMs] 只看最近多久；不传则返回全部已存
   */
  async samplesFor(serverId, { windowMs = null, limit = 0 } = {}) {
    const data = await resourceStore.read()
    let list = data.samples[serverId] || []
    if (windowMs && windowMs > 0) {
      const from = Date.now() - windowMs
      list = list.filter((item) => Date.parse(item.at) >= from)
    }
    if (Number.isInteger(limit) && limit > 0) list = list.slice(-limit)
    return list.slice()
  },

  /** 记录一条尖峰告警 */
  async addSpike(spike) {
    return serialize(() =>
      store.mutate((data) => {
        normalize(data)
        const entry = {
          at: typeof spike.at === 'string' ? spike.at : new Date().toISOString(),
          serverId: String(spike.serverId || ''),
          serverName: String(spike.serverName || '').slice(0, 120),
          metric: String(spike.metric || 'cpu'),
          value: typeof spike.value === 'number' && Number.isFinite(spike.value) ? Math.round(spike.value * 100) / 100 : null,
          threshold: typeof spike.threshold === 'number' ? spike.threshold : null,
          message: String(spike.message || '').slice(0, 300),
        }
        data.spikes.push(entry)
        prune(data)
        return entry
      }),
    )
  },

  async spikes({ serverId = null, limit = 50 } = {}) {
    const data = await resourceStore.read()
    const filtered = serverId ? data.spikes.filter((item) => item.serverId === serverId) : data.spikes
    const newestFirst = filtered.slice().reverse()
    return Number.isInteger(limit) && limit > 0 ? newestFirst.slice(0, limit) : newestFirst
  },

  /** 最近一次尖峰（冷却判断用） */
  async lastSpikeAt(serverId, metric) {
    const data = await resourceStore.read()
    for (let i = data.spikes.length - 1; i >= 0; i -= 1) {
      const item = data.spikes[i]
      if (item.serverId === serverId && item.metric === metric) return Date.parse(item.at) || 0
    }
    return 0
  },

  /** 清空某台机器的历史（删除服务器时用），不传 serverId 表示全清 */
  async clear(serverId = null) {
    return serialize(() =>
      store.mutate((data) => {
        normalize(data)
        if (serverId) {
          const removed = (data.samples[serverId] || []).length
          delete data.samples[serverId]
          data.spikes = data.spikes.filter((item) => item.serverId !== serverId)
          return { removed }
        }
        const total = Object.values(data.samples).reduce((sum, list) => sum + (list?.length || 0), 0)
        data.samples = {}
        data.spikes = []
        return { removed: total }
      }),
    )
  },

  /** 概览：各机器存了多少点（设置页/排障用） */
  async stats() {
    const data = await resourceStore.read()
    const servers = Object.entries(data.samples).map(([serverId, list]) => ({
      serverId,
      samples: (list || []).length,
      firstAt: list?.[0]?.at || null,
      lastAt: list?.[list.length - 1]?.at || null,
    }))
    return { servers, spikes: data.spikes.length, capacityPerServer: RESOURCE_MAX_SAMPLES }
  },

  async reset() {
    return store.reset()
  },
}
