import path from 'node:path'
import { createJsonStore } from './jsonStore.js'
import { FILES, LOG_DIR } from '../config.js'
import { nowIso } from '../utils/ids.js'

/**
 * 运行态：项目 -> { pid, port, startedAt, command, logFile }。
 * port 是「实际监听端口」——端口被占自动避让后可能与配置端口不同，停止/对账都以它为准。
 * 服务重启后会与真实进程对账（见 reconcile），避免出现"假运行中"。
 */
const store = createJsonStore(FILES.runtime, {
  seed: () => ({ version: 1, items: {} }),
  isValid: (value) => Boolean(value) && Boolean(value?.items) && typeof value.items === 'object' && !Array.isArray(value.items),
})

export const runtimeRepo = {
  file: FILES.runtime,

  async all() {
    const data = await store.read()
    return data.items
  },

  async get(projectId) {
    const items = await runtimeRepo.all()
    return items[projectId] || null
  },

  async set(projectId, value) {
    return store.mutate((data) => {
      data.items[projectId] = { ...value, updatedAt: nowIso() }
      return data.items[projectId]
    })
  },

  async clear(projectId) {
    return store.mutate((data) => {
      const existing = data.items[projectId] || null
      delete data.items[projectId]
      return existing
    })
  },

  /**
   * 对账：isAlive(entry, projectId) 返回 false 的记录清除。
   * 收整个 entry 和 projectId——compose 型项目（docker compose up -d）的启动器
   * 发射完容器就退出，PID 已死但端口还在听，调用方需要按「PID 活 或 端口在听」判定。
   */
  async reconcile(isAlive) {
    return store.mutate((data) => {
      const dropped = []
      for (const [projectId, entry] of Object.entries(data.items)) {
        const alive = entry ? Boolean(isAlive(entry, projectId)) : false
        if (!alive) {
          dropped.push(projectId)
          delete data.items[projectId]
        }
      }
      return dropped
    })
  },

  async reset() {
    return store.reset()
  },
}

export function projectLogFile(projectId) {
  return path.join(LOG_DIR, `${projectId}.log`)
}
