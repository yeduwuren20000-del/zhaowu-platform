import { Router } from 'express'
import { clearEvents, EVENT_TYPE_LIST, EVENT_TYPE_TEXT, listEvents } from '../services/eventService.js'
import { asyncRoute, sendOk } from '../utils/http.js'

const router = Router()

/** 事件时间线：支持按项目 / 服务器 / 子服务 / 类型过滤，类型可以多选（type=a,b） */
router.get(
  '/',
  asyncRoute(async (req, res) => {
    sendOk(
      res,
      await listEvents({
        projectId: req.query.projectId ? String(req.query.projectId) : null,
        serverId: req.query.serverId ? String(req.query.serverId) : null,
        serviceId: req.query.serviceId ? String(req.query.serviceId) : null,
        type: req.query.type ? String(req.query.type) : null,
        limit: req.query.limit ? Number(req.query.limit) : 100,
      }),
    )
  }),
)

/** 类型字典（前端过滤条在没有事件时也要能渲染） */
router.get(
  '/types',
  asyncRoute(async (req, res) => {
    sendOk(res, EVENT_TYPE_LIST.map((value) => ({ value, label: EVENT_TYPE_TEXT[value] })))
  }),
)

/** 清空时间线（状态指纹保留，不会把当前状态重放成"刚刚变化"） */
router.delete(
  '/',
  asyncRoute(async (req, res) => {
    sendOk(res, await clearEvents())
  }),
)

export default router
