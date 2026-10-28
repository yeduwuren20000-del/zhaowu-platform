import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'

export async function ensureDir(dir) {
  await fsp.mkdir(dir, { recursive: true })
}

export async function pathExists(target) {
  try {
    await fsp.access(target)
    return true
  } catch {
    return false
  }
}

export function pathExistsSync(target) {
  try {
    return fs.existsSync(target)
  } catch {
    return false
  }
}

/** 读取 JSON；文件不存在返回 fallback；内容损坏抛出（由调用方备份重建） */
export async function readJson(file, fallback = null) {
  let raw
  try {
    raw = await fsp.readFile(file, 'utf8')
  } catch (error) {
    if (error.code === 'ENOENT') return fallback
    throw error
  }
  if (!raw.trim()) return fallback
  return JSON.parse(raw)
}

let tmpSeq = 0

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
/** Windows 上刚写完的文件会被杀毒软件 / 索引服务短暂占用，rename 会以这些错误码失败 */
const RETRYABLE_RENAME = new Set(['EPERM', 'EACCES', 'EBUSY'])

async function renameWithRetry(from, to) {
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fsp.rename(from, to)
      return
    } catch (error) {
      if (!RETRYABLE_RENAME.has(error.code) || attempt >= 6) throw error
      await sleep(20 * (attempt + 1))
    }
  }
}

/** 原子写入：先写临时文件再改名，避免崩溃时留下半个 JSON */
export async function writeJsonAtomic(file, data) {
  await ensureDir(path.dirname(file))
  // 临时名必须每次唯一：同一进程内两次写重叠时，共用 tmp 会让先完成的 rename 把文件搬走
  const tmp = `${file}.${process.pid}.${tmpSeq++}.${Math.random().toString(36).slice(2, 8)}.tmp`
  try {
    await fsp.writeFile(tmp, `${JSON.stringify(data, null, 2)}\n`, 'utf8')
    await renameWithRetry(tmp, file)
  } catch (error) {
    await fsp.unlink(tmp).catch(() => {})
    throw error
  }
}

export async function appendLine(file, line) {
  await ensureDir(path.dirname(file))
  await fsp.appendFile(file, line.endsWith('\n') ? line : `${line}\n`, 'utf8')
}

export async function truncateFile(file) {
  await ensureDir(path.dirname(file))
  await fsp.writeFile(file, '', 'utf8')
}

/** 读取文件末尾若干行（最多回看 512KB，足够覆盖最近的日志） */
export async function readTailLines(file, limit = 200) {
  let stat
  try {
    stat = await fsp.stat(file)
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
  const maxBytes = 512 * 1024
  const start = Math.max(0, stat.size - maxBytes)
  const length = stat.size - start
  if (length <= 0) return []
  const handle = await fsp.open(file, 'r')
  try {
    const buffer = Buffer.alloc(length)
    await handle.read(buffer, 0, length, start)
    const lines = buffer.toString('utf8').split(/\r?\n/)
    if (start > 0) lines.shift()
    return lines.filter((line) => line.trim().length > 0).slice(-limit)
  } finally {
    await handle.close()
  }
}
