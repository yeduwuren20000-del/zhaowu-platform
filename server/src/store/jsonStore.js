import fsp from 'node:fs/promises'
import { readJson, writeJsonAtomic, pathExistsSync } from '../utils/fsx.js'
import path from 'node:path'

/**
 * 通用 JSON 仓储：内存缓存 + 串行原子写。
 * 文件损坏时备份为 *.corrupt-<时间戳> 并用种子数据重建，保证工作台永远能启动。
 */
export function createJsonStore(file, { seed = () => ({}), isValid = (value) => Boolean(value) && typeof value === 'object' } = {}) {
  let cache = null
  let chain = Promise.resolve()      // 写盘队列（供 write/persist 用）
  let mutateChain = Promise.resolve() // 读-改-写整段队列（mutate 用，见下）

  async function load() {
    if (cache) return cache
    let parsed = null
    try {
      parsed = await readJson(file, null)
    } catch (error) {
      const backup = `${file}.corrupt-${Date.now()}`
      await fsp.rename(file, backup).catch(() => {})
      console.error(`[store] ${path.basename(file)} 解析失败，已备份为 ${path.basename(backup)}：${error.message}`)
      parsed = null
    }
    if (!isValid(parsed)) {
      parsed = seed()
      cache = parsed
      await queueWrite(parsed)
    } else {
      cache = parsed
    }
    return cache
  }

  /**
   * 所有落盘（包括首次种子写入）都排到同一条链上，避免两条写并发 rename 到同一个文件。
   * 写失败必须向上抛给调用方：如果在这里吞掉，mutate/create 会"假成功"，
   * 内存缓存已经改了、磁盘却没变，进程重启后数据就丢了。
   */
  function queueWrite(data) {
    const task = chain.then(() => writeJsonAtomic(file, data))
    chain = task.catch(() => {})
    return task
  }

  function persist(data) {
    cache = data
    return queueWrite(data)
  }

  /**
   * 读取 -> 修改 -> 落盘，在快照副本上执行 fn，写盘成功后才替换内存缓存。
   *
   * **整个读-改-写必须串行**（不只是写盘）：
   * 早期实现只把 writeJsonAtomic 排队，而 load / structuredClone / fn(snapshot) 是并发执行的，
   * 于是 N 个并发 mutate 会基于**同一份旧快照**各自修改、依次落盘，后写者覆盖先写者 ——
   * 实测「并发创建 10 条」全部返回 200，但磁盘上只剩 1 条（静默丢数据）。
   * 现在把整段放进 mutateChain，后到的请求一定读到前一个的结果。
   *
   * 快照用结构化克隆（本项目所有仓储数据都是可序列化的纯 JSON 值）。
   */
  async function mutate(fn) {
    const task = mutateChain.then(async () => {
      const current = await load()
      const snapshot = structuredClone(current)
      const result = await fn(snapshot)
      await writeJsonAtomic(file, snapshot)
      cache = snapshot
      return result
    })
    // 链上保留失败尾巴：一次写失败不能卡死后续所有写入（错误照常抛给调用方）
    mutateChain = task.catch(() => {})
    return task
  }

  /** 恢复初始状态：原文件重命名备份，再用种子数据重建 */
  async function reset() {
    cache = null
    if (pathExistsSync(file)) {
      await fsp.rename(file, `${file}.bak-${Date.now()}`).catch(() => {})
    }
    return load()
  }

  return { file, read: load, write: persist, mutate, reset }
}
