import { Router } from 'express'
import { globalSearch } from '../services/searchService.js'
import { asyncRoute, sendOk } from '../utils/http.js'

const router = Router()

router.get(
  '/',
  asyncRoute(async (req, res) => {
    sendOk(res, await globalSearch(req.query.q))
  }),
)

export default router
