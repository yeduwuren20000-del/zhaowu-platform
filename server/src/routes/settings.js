import os from 'node:os'
import path from 'node:path'
import { Router } from 'express'
import { DATA_DIR, FILES, LOG_DIR, PORT, WEB_DIST_DIR } from '../config.js'
import { pathExistsSync } from '../utils/fsx.js'
import { projectsRepo } from '../store/projectsRepo.js'
import { serversRepo } from '../store/serversRepo.js'
import { runtimeRepo } from '../store/runtimeRepo.js'
import { logRepo } from '../store/logRepo.js'
import { portScanner } from '../services/portScanner.js'
import { asyncRoute, sendOk } from '../utils/http.js'

const router = Router()

router.get(
  '/',
  asyncRoute(async (req, res) => {
    sendOk(res, {
      dataDir: DATA_DIR,
      logDir: LOG_DIR,
      files: FILES,
      webDistDir: WEB_DIST_DIR,
      webDistExists: pathExistsSync(WEB_DIST_DIR),
      apiPort: PORT,
      platform: process.platform,
      node: process.version,
      hostname: os.hostname(),
      pid: process.pid,
      cwd: process.cwd(),
    })
  }),
)

/** 重置运行态（清理已死亡进程的记录） */
router.post(
  '/reset-runtime',
  asyncRoute(async (req, res) => {
    const dropped = await runtimeRepo.reconcile(() => false)
    portScanner.invalidate()
    await logRepo.append({ level: 'warn', source: '设置', message: `运行态已重置（清理 ${dropped.length} 条记录）` })
    sendOk(res, { dropped })
  }),
)

/** 恢复示例数据：删除数据文件后用种子重建（会先备份原文件） */
router.post(
  '/reseed',
  asyncRoute(async (req, res) => {
    await projectsRepo.reset()
    await serversRepo.reset()
    await runtimeRepo.reset()
    portScanner.invalidate()
    await logRepo.append({ level: 'warn', source: '设置', message: '数据已恢复为示例内容' })
    sendOk(res, { reseeded: true, dataDir: DATA_DIR, backupHint: '原文件已重命名保留在同目录（*.bak-* 或 *.corrupt-*）' })
  }),
)

router.post(
  '/open-data-dir',
  asyncRoute(async (req, res) => {
    const { openDirectory } = await import('../services/processManager.js')
    sendOk(res, await openDirectory(path.resolve(DATA_DIR)))
  }),
)

export default router
