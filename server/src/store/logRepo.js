import { FILES, LOG_DIR } from '../config.js'
import { appendLine, readTailLines, ensureDir, truncateFile } from '../utils/fsx.js'
import { nowIso } from '../utils/ids.js'
import path from 'node:path'

const LEVELS = ['info', 'warn', 'error', 'success']

/**
 * 工作台事件日志：JSON Lines 落盘，便于前端按等级着色展示与搜索。
 */
async function append({ level = 'info', source = 'workbench', message = '' }) {
  const entry = {
    at: nowIso(),
    level: LEVELS.includes(level) ? level : 'info',
    source,
    message,
  }
  await appendLine(FILES.workbenchLog, JSON.stringify(entry))
  return entry
}

async function tail(limit = 50) {
  const lines = await readTailLines(FILES.workbenchLog, limit)
  return lines
    .map((line) => {
      try {
        return JSON.parse(line)
      } catch {
        return { at: null, level: 'info', source: 'workbench', message: line }
      }
    })
    .filter(Boolean)
}

async function clear() {
  await truncateFile(FILES.workbenchLog)
}

function projectFile(projectId) {
  return path.join(LOG_DIR, `${projectId}.log`)
}

async function readProjectLog(projectId, limit = 200) {
  return readTailLines(projectFile(projectId), limit)
}

async function clearProjectLog(projectId) {
  await ensureDir(LOG_DIR)
  await truncateFile(projectFile(projectId))
}

export const logRepo = {
  workbenchLogFile: FILES.workbenchLog,
  projectFile,
  append,
  tail,
  clear,
  readProjectLog,
  clearProjectLog,
}
