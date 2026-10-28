import { Router } from 'express'
import { runFile, spawnDetached } from '../utils/exec.js'
import { portScanner } from '../services/portScanner.js'
import { HttpError, asyncRoute, sendOk } from '../utils/http.js'
import { PROJECT_ROOT } from '../config.js'
import { projectsRepo } from '../store/projectsRepo.js'
import { serversRepo } from '../store/serversRepo.js'

/**
 * 服务监控：把 GitHub 上最火的自托管监控工具 Uptime Kuma（86k+ ★，MIT）接进工作台。
 * 它本质是「一个 Docker 容器 + 一套监控看板 + 掉线告警（邮件 / Telegram / Webhook 等 90+ 渠道）」。
 *
 * 这里只负责把容器「一键拉起 / 停止 / 查状态」，并按工作台已登记的数据
 * （本地项目 + 远程服务器）生成「建议监控项」清单——用户复制地址粘进 Kuma 即可，
 * 不需要自己回忆每个服务跑在哪个端口。
 *
 * 为什么不自动写监控：Uptime Kuma 首次打开必须由用户创建管理员账号（无 env 初始化通道），
 * 在用户建号之前任何 API 写入都无从谈起；与其猜 schema 硬写 sqlite，不如给一份
 * 「来自单一事实来源的清单 + 一键复制」。监控数据本身存在命名卷里，重建容器不丢。
 */

const router = Router()

const CONTAINER = 'workbench-uptime-kuma'
const IMAGE = 'louislam/uptime-kuma:1'
const CONTAINER_PORT = 3001
const DEFAULT_HOST_PORT = 3001
const VOLUME = 'workbench-uptime-kuma-data'

/** 执行 docker 命令（execFile 不经 shell，无注入风险） */
async function docker(args, opts) {
  return runFile('docker', args, opts)
}

/** Docker 是否可用：true / 'daemon-down'（装了没启动）/ false（没装） */
async function dockerState() {
  try {
    await docker(['version', '--format', '{{.Server.Version}}'], { timeout: 10000 })
    return true
  } catch {
    try {
      await docker(['version', '--format', '{{.Client.Version}}'], { timeout: 10000 })
      return 'daemon-down'
    } catch {
      return false
    }
  }
}

/** 本地是否已存在该镜像（用来区分「首次拉取」和「直接创建容器」） */
async function imagePresent() {
  try {
    await docker(['image', 'inspect', IMAGE], { timeout: 10000 })
    return true
  } catch {
    return false
  }
}

/** 解析 docker ps 的 Ports 字段，取出映射到容器 3001 的宿主端口 */
function hostPortOf(rawPorts) {
  const text = String(rawPorts || '')
  const match = text.match(/:(\d+)->(?:0\.0\.0\.0:)?\d+\/tcp/)
  return match ? Number(match[1]) : null
}

/** 查容器现状 */
async function inspectContainer() {
  const { stdout } = await docker(['ps', '-a', '--filter', `name=^${CONTAINER}$`, '--format', '{{json .}}'], {
    timeout: 15000,
  })
  const line = stdout.trim().split('\n').find(Boolean)
  if (!line) return { exists: false, running: false, hostPort: null, url: null }
  let raw
  try {
    raw = JSON.parse(line)
  } catch {
    return { exists: false, running: false, hostPort: null, url: null }
  }
  const state = String(raw.State || '')
  const running = state === 'running'
  const hostPort = hostPortOf(raw.Ports)
  return { exists: true, running, hostPort, url: hostPort ? `http://localhost:${hostPort}` : null }
}

/** 等待容器处于「存在且运行中」，返回最新状态 */
async function waitRunning(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const info = await inspectContainer()
    if (info.exists && info.running && info.url) return info
    if (Date.now() >= deadline) return info
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}

/**
 * 建议监控项：完全由工作台已登记的数据推导（单一事实来源）——
 *   1. 本地项目：url / port / 子服务端口 → HTTP 监控；
 *   2. 远程服务器：主机 → Ping 监控（SSH 端口连通性更有意义，但 Ping 无需开放 Web 端口）；
 *      其下登记的应用（有端口的）→ HTTP 监控。
 * Kuma 自己也在列里（监控「监控器」是否还活着是经典操作）。
 */
async function buildSuggestions() {
  const out = []
  const seen = new Set()
  const push = (item) => {
    if (!item.url) return
    // 同一 URL 只留第一条（如「DevServerManager」与其子项目组都登记了 5180）
    if (seen.has(item.url)) return
    seen.add(item.url)
    out.push({ monitorType: 'http', note: '', ...item })
  }

  let projects = []
  let servers = []
  try {
    projects = await projectsRepo.list()
  } catch {
    /* 项目数据读不了就不给本机建议，不影响容器管理 */
  }
  try {
    servers = await serversRepo.list()
  } catch {
    /* 同上 */
  }

  for (const p of projects) {
    const port = Number(p.port)
    if (!port) continue
    const url = String(p.url || 'http://localhost:{port}').replace('{port}', String(port))
    push({ name: p.name, url, port, note: '本地项目' })
    // 项目下的子服务（多端口项目：API / 前端分开监控更有用）
    for (const svc of Array.isArray(p.services) ? p.services : []) {
      const svcPort = Number(svc.port)
      if (!svcPort || svcPort === port) continue
      push({ name: `${p.name} · ${svc.name || `端口 ${svcPort}`}`, url: `http://localhost:${svcPort}`, port: svcPort, note: '本地服务' })
    }
  }

  push({ name: 'Uptime Kuma（监控自身）', url: `http://localhost:${CONTAINER_PORT}`, port: CONTAINER_PORT, note: '监控服务' })

  for (const s of servers) {
    if (!s.host) continue
    out.push({
      name: `${s.name || s.host}（Ping）`,
      url: s.host,
      monitorType: 'ping',
      note: s.online === false ? '远程服务器（当前离线，添加后确认网络）' : '远程服务器',
    })
    for (const app of Array.isArray(s.apps) ? s.apps : []) {
      const appPort = Number(app.port)
      if (!appPort) continue
      push({ name: `${s.name || s.host} · ${app.name || `端口 ${appPort}`}`, url: `http://${s.host}:${appPort}`, port: appPort, note: '远程应用' })
    }
  }

  return out
}

// ---- 状态 ----
router.get(
  '/',
  asyncRoute(async (req, res) => {
    const state = await dockerState()
    if (state !== true) {
      sendOk(res, {
        installed: state === 'daemon-down' ? null : false,
        daemonOk: false,
        imagePresent: false,
        container: { exists: false, running: false, hostPort: null, url: null },
        suggestions: [],
        error:
          state === 'daemon-down'
            ? 'Docker Desktop 未启动（看托盘鲸鱼图标是否稳定），或守护进程尚未就绪'
            : 'Docker 未安装或不在 PATH',
      })
      return
    }
    const [container, hasImage, suggestions] = await Promise.all([inspectContainer(), imagePresent(), buildSuggestions()])
    sendOk(res, { installed: true, daemonOk: true, imagePresent: hasImage, container, suggestions, error: null })
  }),
)

// ---- 启动（一键拉起）----
// 响应结构统一为 { phase, imagePresent?, container: {exists, running, hostPort, url} }：
// 所有分支都嵌套 container，前端不必为不同分支写两套读取路径。
router.post(
  '/start',
  asyncRoute(async (req, res) => {
    const state = await dockerState()
    if (state !== true) {
      throw new HttpError(502, state === 'daemon-down' ? 'Docker Desktop 未启动' : 'Docker 未安装或不在 PATH')
    }

    const info = await inspectContainer()
    if (info.exists && info.running && info.url) {
      sendOk(res, { container: info, phase: 'running' })
      return
    }

    // 已存在但停了：直接起（秒级，数据在卷里不会丢）
    if (info.exists) {
      await docker(['start', CONTAINER], { timeout: 60000 })
      const ready = await waitRunning(60000)
      sendOk(res, { container: ready, phase: ready.running ? 'running' : 'starting' })
      return
    }

    // 不存在：先看镜像在不在
    const hasImage = await imagePresent()
    if (!hasImage) {
      // 首次使用：后台拉镜像，立刻返回让前端轮询，避免 HTTP 长阻塞（镜像约数百 MB）
      spawnDetached(`docker pull ${IMAGE}`, { cwd: PROJECT_ROOT })
      sendOk(res, { container: info, phase: 'pulling', imagePresent: false })
      return
    }

    const hostPort = await portScanner.findFreePort(DEFAULT_HOST_PORT, { limit: 200 })
    if (!hostPort) throw new HttpError(500, `找不到可用端口来映射 Uptime Kuma（期望 ${DEFAULT_HOST_PORT} 起）`)
    await docker(
      [
        'run',
        '-d',
        '--name',
        CONTAINER,
        '-p',
        `${hostPort}:${CONTAINER_PORT}`,
        '-v',
        `${VOLUME}:/app/data`, // 监控配置 / 历史 / 告警渠道全在卷里：删容器不丢数据
        '-e',
        'UPTIME_KUMA_DISABLE_FRAME_SAMEORIGIN=true', // 默认 X-Frame-Options: SAMEORIGIN 会挡住工作台 iframe（端口不同即跨源）；本地单用户工具，关掉才能内嵌
        '--restart',
        'unless-stopped', // 工作台重启后 Docker 起来时它跟着起来
        IMAGE,
      ],
      { timeout: 120000 },
    )
    const ready = await waitRunning(90000)
    sendOk(res, { container: ready, phase: ready.running ? 'running' : 'starting' })
  }),
)

// ---- 停止 ----
router.post(
  '/stop',
  asyncRoute(async (req, res) => {
    const info = await inspectContainer()
    if (!info.exists) {
      sendOk(res, { container: info, phase: 'stopped' })
      return
    }
    try {
      await docker(['stop', CONTAINER], { timeout: 60000 })
    } catch (error) {
      const detail = String(error?.stderr || error?.message || error).split('\n')[0]
      throw new HttpError(502, `停止容器失败：${detail}`)
    }
    const after = await inspectContainer()
    sendOk(res, { container: after, phase: 'stopped' })
  }),
)

export default router
