import { Router } from 'express'
import { runPreflight } from '../services/preflightService.js'
import { asyncRoute, sendOk } from '../utils/http.js'

const router = Router()

/**
 * 环境体检：这台机器具备哪些外部依赖，缺的会影响什么、怎么装。
 * ?refresh=1 强制重新探测（默认 30 秒缓存，避免频繁刷总览时反复起子进程）。
 */
router.get(
  '/',
  asyncRoute(async (req, res) => {
    sendOk(res, await runPreflight({ force: req.query.refresh === '1' }))
  }),
)

export default router
