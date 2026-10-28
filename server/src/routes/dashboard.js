import { Router } from 'express'
import { buildDashboard } from '../services/dashboardService.js'
import { monitorServers } from '../services/serverMonitor.js'
import { probeServers } from '../services/serverService.js'
import { portScanner } from '../services/portScanner.js'
import { asyncRoute, sendOk } from '../utils/http.js'

const router = Router()

router.get(
  '/',
  asyncRoute(async (req, res) => {
    const force = req.query.force === '1'
    if (force) portScanner.invalidate()
    sendOk(res, await buildDashboard({ force }))
  }),
)

/**
 * 打开页面后由前端异步触发：SSH 只读采集过期的服务器，
 * 对没有 SSH 结果的服务器再补一次 TCP 探测，避免首屏等待。
 */
router.post(
  '/probe-servers',
  asyncRoute(async (req, res) => {
    const force = req.body?.force === true
    const staleMs = Number(req.body?.staleMs) || 60000
    const ssh = await monitorServers({ force, staleMs })
    const tcp = await probeServers({ force: false, staleMs })
    sendOk(res, {
      probed: ssh.probed,
      skipped: ssh.skipped,
      failed: ssh.failed,
      concurrency: ssh.concurrency,
      tcpProbed: tcp.probed,
    })
  }),
)

export default router
