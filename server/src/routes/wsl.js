import { Router } from 'express'
import { collectAllDistros, collectDistro, listDistros, wslAvailable } from '../services/wslMetrics.js'
import { asyncRoute, sendOk } from '../utils/http.js'

const router = Router()

/**
 * WSL 只读采集。
 *
 * 存在的理由：WSL2 有独立网络命名空间，里面监听的服务在 Windows 侧**完全查不到**
 * （实测 WSL 内 ss 显示 LISTEN 0.0.0.0:18099，Windows 的 Get-NetTCPConnection 一片空白）。
 * 所以只能主动进每个发行版去问。
 */

/** WSL 是否可用 */
router.get(
  '/available',
  asyncRoute(async (req, res) => {
    sendOk(res, await wslAvailable())
  }),
)

/** 发行版列表（跳过 Docker Desktop 内部发行版） */
router.get(
  '/distros',
  asyncRoute(async (req, res) => {
    sendOk(res, await listDistros())
  }),
)

/** 采集所有发行版（并行；单个发行版实测约 0.3~3 秒） */
router.get(
  '/collect',
  asyncRoute(async (req, res) => {
    const timeout = Math.min(60000, Math.max(3000, Number(req.query.timeout) || 20000))
    const includeProcesses = req.query.processes !== '0'
    sendOk(res, await collectAllDistros({ timeout, includeProcesses }))
  }),
)

/** 采集单个发行版 */
router.get(
  '/collect/:name',
  asyncRoute(async (req, res) => {
    const timeout = Math.min(60000, Math.max(3000, Number(req.query.timeout) || 20000))
    sendOk(res, await collectDistro(req.params.name, { timeout }))
  }),
)

export default router