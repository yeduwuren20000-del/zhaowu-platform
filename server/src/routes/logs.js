import { Router } from 'express'
import { LOG_STREAM_INTERVAL_MS } from '../config.js'
import { logRepo } from '../store/logRepo.js'
import { asyncRoute, sendOk } from '../utils/http.js'

const router = Router()

/** 工作台事件日志（JSON 结构，前端按等级着色） */
router.get(
  '/',
  asyncRoute(async (req, res) => {
    const limit = Math.min(Number(req.query.lines) || 100, 1000)
    sendOk(res, { file: logRepo.workbenchLogFile, events: await logRepo.tail(limit) })
  }),
)

router.delete(
  '/',
  asyncRoute(async (req, res) => {
    await logRepo.clear()
    sendOk(res, { cleared: true })
  }),
)

/**
 * SSE 实时追踪：source=workbench 或 source=project:<id>
 * 每秒比对一次内容，有变化才推送，浏览器端 EventSource 直接消费。
 */
router.get('/stream', (req, res) => {
  const source = String(req.query.source || 'workbench')
  const limit = Math.min(Number(req.query.lines) || 200, 2000)
  const projectId = source.startsWith('project:') ? source.slice('project:'.length) : null

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no',
  })
  res.write('retry: 2000\n\n')

  let closed = false
  let lastPayload = ''

  async function readLines() {
    if (projectId) {
      // 项目进程日志：纯文本行
      return { source, lines: await logRepo.readProjectLog(projectId, limit) }
    }
    // 工作台事件：结构化对象，前端按等级着色
    return { source, events: await logRepo.tail(limit) }
  }

  async function tick() {
    if (closed) return
    try {
      const payload = JSON.stringify(await readLines())
      if (payload !== lastPayload) {
        lastPayload = payload
        res.write(`data: ${payload}\n\n`)
      } else {
        res.write(': keep-alive\n\n')
      }
    } catch (error) {
      res.write(`data: ${JSON.stringify({ source, error: error.message, lines: [], events: [] })}\n\n`)
    }
    if (!closed) setTimeout(tick, LOG_STREAM_INTERVAL_MS)
  }

  req.on('close', () => {
    closed = true
    res.end()
  })

  tick()
})

export default router
