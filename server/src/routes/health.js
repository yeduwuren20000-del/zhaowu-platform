import { Router } from 'express'
import { PORT } from '../config.js'
import { asyncRoute, sendOk } from '../utils/http.js'

const router = Router()

router.get(
  '/',
  asyncRoute(async (req, res) => {
    sendOk(res, {
      ok: true,
      service: 'dev-server-manager',
      apiPort: PORT,
      node: process.version,
      uptimeSec: Math.round(process.uptime()),
      at: new Date().toISOString(),
    })
  }),
)

export default router
