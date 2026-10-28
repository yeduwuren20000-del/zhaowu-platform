import { Router } from 'express'
import { start, status, stop, logTail, mediaLibraryDir } from '../services/mediaService.js'
import { openDirectory } from '../services/processManager.js'
import { asyncRoute, badRequest, sendOk } from '../utils/http.js'

/**
 * 本地影院（mediaserver）：海报墙 + 点开即播 + AI 修复 + 聚合搜索 + 下载入库。
 * 前端整页内嵌影院自己的 Web 界面（iframe），这里只做托管四件事：
 *   状态 / 启动 / 停止 / 日志，外加「打开片库目录」。
 */

const router = Router()

router.get(
  '/',
  asyncRoute(async (req, res) => {
    sendOk(res, await status())
  }),
)

router.post(
  '/start',
  asyncRoute(async (req, res) => {
    sendOk(res, await start())
  }),
)

router.post(
  '/stop',
  asyncRoute(async (req, res) => {
    sendOk(res, await stop())
  }),
)

router.get(
  '/log',
  asyncRoute(async (req, res) => {
    const lines = Math.min(500, Math.max(10, Number(req.query.lines) || 100))
    sendOk(res, { log: logTail(lines) })
  }),
)

/** 打开片库目录（放视频的文件夹，Windows 资源管理器） */
router.post(
  '/open-dir',
  asyncRoute(async (req, res) => {
    const dir = mediaLibraryDir()
    if (!dir) throw badRequest('未配置片库目录')
    sendOk(res, await openDirectory(dir))
  }),
)

export default router
