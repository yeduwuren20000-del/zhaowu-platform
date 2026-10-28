import { Router } from 'express'
import dashboardRouter from './dashboard.js'
import discoveryRouter from './discovery.js'
import dockerRouter from './docker.js'
import eventsRouter from './events.js'
import healthRouter from './health.js'
import logsRouter from './logs.js'
import mediaRouter from './media.js'
import pansRouter from './pans.js'
import portsRouter from './ports.js'
import preflightRouter from './preflight.js'
import projectsRouter from './projects.js'
import searchRouter from './search.js'
import serversRouter from './servers.js'
import settingsRouter from './settings.js'
import vaultRouter from './vault.js'
import wslRouter from './wsl.js'
import converterRouter from './converter.js'
import uptimeRouter from './uptime.js'

const router = Router()

router.use('/health', healthRouter)
router.use('/dashboard', dashboardRouter)
router.use('/docker', dockerRouter)
router.use('/projects', projectsRouter)
router.use('/servers', serversRouter)
router.use('/ports', portsRouter)
router.use('/discovery', discoveryRouter)
router.use('/events', eventsRouter)
router.use('/logs', logsRouter)
router.use('/pans', pansRouter)
router.use('/media', mediaRouter)
router.use('/preflight', preflightRouter)
router.use('/search', searchRouter)
router.use('/settings', settingsRouter)
router.use('/vault', vaultRouter)
router.use('/wsl', wslRouter)
router.use('/converter', converterRouter)
router.use('/uptime', uptimeRouter)

export default router
