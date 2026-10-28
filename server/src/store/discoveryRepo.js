import { createJsonStore } from './jsonStore.js'
import { FILES } from '../config.js'
import { nowIso } from '../utils/ids.js'

/**
 * 自动发现的持久化：
 *   - ignored：用户忽略过的服务指纹（后续扫描默认不再提示，可恢复）
 *   - acknowledged：已经在首页提示过的新服务指纹（避免重复提醒）
 *   - lastScan：最近一次扫描的候选/过滤结果（登记时的事实来源）
 *   - aiCache：AI 建议缓存（按指纹，避免重复调用）
 */
const MAX_CANDIDATES = 200
const MAX_AI_CACHE = 80

const store = createJsonStore(FILES.discovery, {
  seed: () => ({ version: 1, ignored: [], acknowledged: [], lastScan: null, aiCache: {} }),
  isValid: (value) => Boolean(value) && Array.isArray(value?.ignored) && Array.isArray(value?.acknowledged),
})

/**
 * 已过滤服务只保留"能解释为什么被过滤"的最小字段。
 *
 * 实测发现：过滤段（通常 50+ 条）里 chain（父进程链）单条就 557 字节，
 * 加上 commandLine / exePath / reasons 共占该段体积的 48%，使 discovery.json
 * 涨到 130 KB —— 而这些字段对"已过滤"的服务毫无用途（用户不会去登记它们，
 * 前端也只用到 summary.filtered 这个数字）。父进程链只在 candidates 段有意义：
 * 登记时要靠它推断项目目录。
 */
const FILTERED_KEEP_FIELDS = ['fingerprint', 'serviceName', 'port', 'processName', 'filterReason', 'category', 'type']

function slimFilteredEntry(item) {
  const out = {}
  for (const key of FILTERED_KEEP_FIELDS) {
    if (item?.[key] !== undefined) out[key] = item[key]
  }
  return out
}

export const discoveryRepo = {
  file: FILES.discovery,

  async read() {
    const data = await store.read()
    if (!Array.isArray(data.ignored)) data.ignored = []
    if (!Array.isArray(data.acknowledged)) data.acknowledged = []
    if (!data.aiCache || typeof data.aiCache !== 'object') data.aiCache = {}
    return data
  },

  async saveScan(scan) {
    return store.mutate((data) => {
      data.lastScan = {
        at: scan.at || nowIso(),
        durationMs: scan.durationMs ?? null,
        summary: scan.summary || null,
        aiNote: scan.aiNote || null,
        aiSummary: scan.aiSummary || null,
        candidates: (scan.candidates || []).slice(0, MAX_CANDIDATES),
        filtered: (scan.filtered || []).slice(0, MAX_CANDIDATES).map(slimFilteredEntry),
        ignored: (scan.ignored || []).slice(0, MAX_CANDIDATES),
        // 首页提醒依赖这两个列表，更新扫描状态时必须保留
        newCandidates: scan.newCandidates || [],
        firstSeen: scan.firstSeen || [],
      }
      return data.lastScan
    })
  },

  async getLastScan() {
    const data = await store.read()
    return data.lastScan || null
  },

  async listIgnored() {
    const data = await store.read()
    return data.ignored
  },

  async ignore(entries = []) {
    return store.mutate((data) => {
      for (const entry of entries) {
        if (!entry?.fingerprint) continue
        if (data.ignored.some((item) => item.fingerprint === entry.fingerprint)) continue
        data.ignored.push({ fingerprint: entry.fingerprint, label: entry.label || '', note: entry.note || '', at: nowIso() })
      }
      return data.ignored
    })
  },

  async restore(fingerprints = []) {
    return store.mutate((data) => {
      const set = new Set(fingerprints)
      data.ignored = data.ignored.filter((item) => !set.has(item.fingerprint))
      data.acknowledged = data.acknowledged.filter((item) => !set.has(item))
      return data.ignored
    })
  },

  async acknowledge(fingerprints = []) {
    return store.mutate((data) => {
      for (const fingerprint of fingerprints) {
        if (fingerprint && !data.acknowledged.includes(fingerprint)) data.acknowledged.push(fingerprint)
      }
      return data.acknowledged
    })
  },

  async getAiCache(fingerprint) {
    const data = await store.read()
    return data.aiCache[fingerprint] || null
  },

  async setAiCache(fingerprint, entry) {
    return store.mutate((data) => {
      data.aiCache[fingerprint] = entry
      const keys = Object.keys(data.aiCache)
      if (keys.length > MAX_AI_CACHE) {
        for (const key of keys.slice(0, keys.length - MAX_AI_CACHE)) delete data.aiCache[key]
      }
      return data.aiCache[fingerprint]
    })
  },

  async reset() {
    return store.reset()
  },
}
