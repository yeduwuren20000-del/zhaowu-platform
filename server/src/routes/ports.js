import { Router } from 'express'
import { portScanner } from '../services/portScanner.js'
import { buildMappings } from '../services/mappingService.js'
import { observeMappingConflicts } from '../services/eventService.js'
import { asyncRoute, sendOk } from '../utils/http.js'

const router = Router()

/** 全局端口映射：端口 / APP / 环境 / 所属 / 路径 / 状态；顺带观察服务器侧端口冲突 */
router.get(
  '/',
  asyncRoute(async (req, res) => {
    const result = await buildMappings({ force: req.query.force === '1' })
    await observeMappingConflicts(result.conflicts)
    sendOk(res, result)
  }),
)

/** 轻量探活：只回答"这个端口现在能不能打开"，不枚举全机监听表（不 spawn PowerShell） */
router.get(
  '/probe',
  asyncRoute(async (req, res) => {
    const port = Number(req.query.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      res.status(400).json({ ok: false, error: { message: 'port 需要是 1-65535 的整数' } })
      return
    }
    const listening = await portScanner.probePort(port, { force: req.query.force === '1' })
    sendOk(res, { port, listening })
  }),
)

/** 查询某个端口的真实归属（进程详情）；默认走 10s 缓存，force=1 才重新枚举全机监听表 */
router.get(
  '/scan',
  asyncRoute(async (req, res) => {
    const port = Number(req.query.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      res.status(400).json({ ok: false, error: { message: 'port 需要是 1-65535 的整数' } })
      return
    }
    const owners = await portScanner.getPortOwners(port, { force: req.query.force === '1' })
    sendOk(res, { port, listening: owners.length > 0, owners })
  }),
)

export default router
