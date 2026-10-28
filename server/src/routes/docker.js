import { Router } from 'express'
import { runFile } from '../utils/exec.js'
import { HttpError, asyncRoute, sendOk } from '../utils/http.js'
import { dockerDaemon } from '../services/dockerDaemonService.js'

/**
 * 本地 Docker 管理：容器列表 / 启停重启 / 日志尾部。
 * 与 ServerDetail 里的远程 Docker 面板同构（installed/daemonOk/version/containers），
 * 数据来自本机 docker CLI。工作台自身跑在 Node 上，不依赖 Docker。
 */
const router = Router()

const ACTIONS = new Set(['start', 'stop', 'restart'])

/** 执行 docker 命令（execFile 不经 shell，无注入风险）；失败时错误对象带 stderr */
async function docker(args, { timeout = 20000 } = {}) {
  const { stdout, stderr } = await runFile('docker', args, { timeout })
  return { stdout: stdout.trim(), stderr: stderr.trim() }
}

function parseJsonLines(text) {
  if (!text) return []
  const items = []
  for (const line of text.split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    try {
      items.push(JSON.parse(trimmed))
    } catch {
      /* docker 偶发输出非 JSON 行（警告等），跳过 */
    }
  }
  return items
}

/** docker ps 的 Ports 字段 "0.0.0.0:8080->80/tcp, 5432/tcp" 拆成结构化数组 */
function parsePorts(raw) {
  return String(raw || '')
    .split(',')
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => {
      const match = part.match(/^(?:(?:\d+\.\d+\.\d+\.\d+|\[::\]|localhost):(\d+)->)?(.+)$/)
      return { text: part, host: match?.[1] ? Number(match[1]) : null, container: match?.[2] || part }
    })
}

function toContainer(raw) {
  return {
    id: raw.ID,
    name: String(raw.Names || '').replace(/^\//, ''),
    image: raw.Image,
    state: raw.State,
    status: raw.Status,
    ports: parsePorts(raw.Ports),
    command: raw.Command ?? null,
    createdAt: raw.CreatedAt ?? null,
  }
}

/** 概览：Docker 可用性 + 全部容器（含已停止） */
router.get(
  '/',
  asyncRoute(async (req, res) => {
    let serverVersion = null
    try {
      const probe = await docker(['version', '--format', '{{.Server.Version}}'], { timeout: 10000 })
      serverVersion = probe.stdout || null
    } catch {
      serverVersion = null
    }
    if (!serverVersion) {
      // 区分「没装」和「装了没启动」——后者是新手的高频情况，提示要可操作
      let error = 'Docker 未安装或不在 PATH'
      try {
        await docker(['version', '--format', '{{.Client.Version}}'], { timeout: 10000 })
        error = 'Docker Desktop 未启动（看托盘鲸鱼图标是否稳定），或守护进程尚未就绪'
      } catch {
        /* 保持「未安装」结论 */
      }
      sendOk(res, { installed: null, daemonOk: false, version: null, containers: [], error })
      return
    }
    const list = await docker(['ps', '-a', '--no-trunc', '--format', '{{json .}}'], { timeout: 15000 })
    sendOk(res, {
      installed: true,
      daemonOk: true,
      version: serverVersion,
      containers: parseJsonLines(list.stdout).map(toContainer),
    })
  }),
)

/**
 * 守护进程状态（前端轮询用）。比 GET / 轻——不打容器列表，只探引擎。
 * phase: stopped | starting | ready | timeout | error
 */
router.get(
  '/daemon',
  asyncRoute(async (req, res) => {
    sendOk(res, await dockerDaemon.status())
  }),
)

/**
 * 一键拉起守护进程：只发起启动 + 挂后台等待器，立刻返回；
 * 进度靠前端轮询 GET /daemon，避免一个请求挂 3 分钟。
 */
router.post(
  '/daemon/start',
  asyncRoute(async (req, res) => {
    sendOk(res, await dockerDaemon.start())
  }),
)

/** 容器动作：start / stop / restart */
router.post(
  '/containers/:id/:action',
  asyncRoute(async (req, res) => {
    const { id, action } = req.params
    if (!ACTIONS.has(action)) throw new HttpError(400, `不支持的动作：${action}（可用 start/stop/restart）`)
    try {
      await docker([action, id], { timeout: 60000 })
    } catch (error) {
      const detail = String(error?.stderr || error?.message || error).split('\n')[0]
      throw new HttpError(502, `Docker ${action} 失败：${detail}。请确认 Docker Desktop 正在运行`)
    }
    sendOk(res, { ok: true, id, action })
  }),
)

/** 容器日志尾部 */
router.get(
  '/containers/:id/logs',
  asyncRoute(async (req, res) => {
    const lines = Math.min(Number(req.query.lines) || 100, 1000)
    try {
      const out = await docker(['logs', '--tail', String(lines), req.params.id], { timeout: 20000 })
      sendOk(res, { id: req.params.id, lines: out.stdout })
    } catch (error) {
      const detail = String(error?.stderr || error?.message || error).split('\n')[0]
      throw new HttpError(502, `读取容器日志失败：${detail}`)
    }
  }),
)

export default router
