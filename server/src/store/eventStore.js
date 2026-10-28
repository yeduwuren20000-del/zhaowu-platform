import { createJsonStore } from './jsonStore.js'
import { FILES, EVENT_MAX_ITEMS, EVENT_MAX_STATES } from '../config.js'
import { nowIso } from '../utils/ids.js'

/**
 * 服务生命周期事件仓储（第六阶段）：data/events.json
 *
 * 两份内容：
 *   - items：事件列表（只在状态变化 / 端口变化 / 新服务 / 冲突 / SSH 与 Docker 变化时追加，按时间正序）
 *   - states：每个被观察主体（项目 / 子服务 / 服务器 / 服务器 APP / 冲突端口）最近一次的状态指纹
 *
 * 事件与指纹在同一次 mutate 里落盘，不会出现"事件写了、指纹没写"的重复事件；
 * 指纹一致就不产生事件，因此不需要每秒快照也不会数据膨胀。
 */
const store = createJsonStore(FILES.events, {
  seed: () => ({ version: 1, items: [], states: {} }),
  isValid: (value) => Boolean(value) && Array.isArray(value?.items) && Boolean(value?.states) && typeof value.states === 'object',
})

function normalize(data) {
  if (!Array.isArray(data.items)) data.items = []
  if (!data.states || typeof data.states !== 'object') data.states = {}
  return data
}

/** 上限裁剪：事件超出丢最旧，状态指纹超出丢最久未更新的 */
function prune(data) {
  if (data.items.length > EVENT_MAX_ITEMS) data.items = data.items.slice(-EVENT_MAX_ITEMS)
  const keys = Object.keys(data.states)
  if (keys.length > EVENT_MAX_STATES) {
    const stale = keys
      .map((key) => ({ key, at: Date.parse(data.states[key]?.at || '') || 0 }))
      .sort((a, b) => a.at - b.at)
    for (const item of stale.slice(0, keys.length - EVENT_MAX_STATES)) delete data.states[item.key]
  }
  return data
}

function matches(event, filter) {
  if (filter.projectId && event.projectId !== filter.projectId) return false
  if (filter.serverId && event.serverId !== filter.serverId) return false
  if (filter.serviceId && event.serviceId !== filter.serviceId) return false
  if (filter.type) {
    const wanted = Array.isArray(filter.type) ? filter.type : String(filter.type).split(',').filter(Boolean)
    if (wanted.length > 0 && !wanted.includes(event.type)) return false
  }
  return true
}

export const eventStore = {
  file: FILES.events,

  async read() {
    return normalize(await store.read())
  },

  /** 过滤 + 最新的在前；limit<=0 表示不限条数（只受文件里现有条数约束） */
  async list({ projectId = null, serverId = null, serviceId = null, type = null, limit = 100 } = {}) {
    const data = await eventStore.read()
    const filter = { projectId, serverId, serviceId, type }
    const newestFirst = data.items.filter((event) => matches(event, filter)).reverse()
    return Number.isInteger(limit) && limit > 0 ? newestFirst.slice(0, limit) : newestFirst
  },

  /** 最新的若干条（首页"最近活动"用，不带过滤） */
  async latest(limit = 20) {
    return eventStore.list({ limit })
  },

  async getState(key) {
    const data = await eventStore.read()
    return data.states[key] || null
  },

  /** 只更新状态指纹、不产生事件（首次观察建立基线、以及"启动中"这类中间态用） */
  async setState(key, state) {
    return store.mutate((data) => {
      normalize(data)
      data.states[key] = { ...state, at: nowIso() }
      prune(data)
      return data.states[key]
    })
  },

  /**
   * 一次写入完成"追加事件 + 更新状态指纹"。
   * event 为空时等价于 setState；stateKey 为空时只追加事件。
   */
  async commit({ event = null, stateKey = null, state = null } = {}) {
    return store.mutate((data) => {
      normalize(data)
      let recorded = null
      if (event) {
        recorded = event
        data.items.push(event)
      }
      if (stateKey) data.states[stateKey] = { ...state, at: nowIso() }
      prune(data)
      return { recorded, count: data.items.length }
    })
  },

  /** 按类型计数（先按项目/服务器过滤，供筛选条显示数量） */
  async typeCounts({ projectId = null, serverId = null } = {}) {
    const data = await eventStore.read()
    const counts = {}
    for (const event of data.items) {
      if (!matches(event, { projectId, serverId })) continue
      counts[event.type] = (counts[event.type] || 0) + 1
    }
    return counts
  },

  /** 清空事件时间线（保留状态指纹，否则清空后会把当前状态当成"刚刚变化"重放一遍） */
  async clear() {
    return store.mutate((data) => {
      normalize(data)
      const removed = data.items.length
      data.items = []
      return { removed }
    })
  },

  async reset() {
    return store.reset()
  },
}
