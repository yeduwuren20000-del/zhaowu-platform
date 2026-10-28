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

/** 临时查询某个端口的真实归属（不依赖任何记录） */
router.get(
  '/scan',
  asyncRoute(async (req, res) => {
    const port = Number(req.query.port)
    if (!Number.isInteger(port) || port < 1 || port > 65535) {
      res.status(400).json({ ok: false, error: { message: 'port 需要是 1-65535 的整数' } })
      return
    }
    const owners = await portScanner.getPortOwners(port, { force: true })
    sendOk(res, { port, listening: owners.length > 0, owners })
  }),
)

export default router
