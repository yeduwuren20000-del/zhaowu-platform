import { spawn } from 'node:child_process'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { DATA_DIR, LOG_DIR, PROJECT_ROOT } from '../config.js'
import { HttpError, badRequest } from '../utils/http.js'
import { pathExistsSync } from '../utils/fsx.js'
import { isWindows, runFileQuiet } from '../utils/exec.js'
import { processInfo } from './processInfo.js'
import { portScanner } from './portScanner.js'

/**
 * 本地影院（mediaserver）：把之前做的「本地私人影院 2.0」接进工作台。
 *
 * 为什么不起一个 Node 重写：那是一套已经调通的纯标准库 Python 应用
 * （海报墙 + Range 流式播放 + Real-ESRGAN 超分任务队列 + Apple CMS
 * 聚合搜索代理 + yt-dlp 下载入库，约 2700 行），重写等于把踩过的坑
 * 再踩一遍。这里只做「托管」：拉起 / 停止 / 探活 / 认领 / 日志。
 *
 * 关键设计（都对应真实翻车点）：
 *   1. 子进程 detached + 输出写日志文件：工作台退出不影响影院继续放；
 *      运行态落盘 data/media.json，工作台重启后能重新认领（PID 活或端口在听）。
 *   2. 端口避让：默认 8888，被占用就顺延找空闲端口，用 PORT 环境变量通知子进程。
 *   3. 认领已在运行的实例：用户可能自己双击过 start.bat。探测端口时看响应头
 *      Server: LocalCinema/2.0——是自家应用就认领，不重复起一份。
 *   4. 探测本机服务一律用 node:http，不用全局 fetch：本机若设了 HTTP_PROXY，
 *      undici 的 EnvHttpProxyAgent 会把 127.0.0.1 也误导向代理（aria2Service 踩过）。
 *   5. 能力标志（AI 修复 / 缩略图 / yt-dlp）以影院自己的 /api/list、/api/dl
 *      返回为准——单一事实来源，避免工作台和 Python 侧各判一遍产生漂移。
 */

export const MEDIA_DIR = process.env.DSM_MEDIA_DIR
  ? path.resolve(process.env.DSM_MEDIA_DIR)
  : path.join(PROJECT_ROOT, 'tools', 'mediaserver')

export const MEDIA_PYTHON = process.env.DSM_PYTHON || 'python'

/** 默认端口；被占用时顺延（可用 DSM_MEDIA_PORT 改默认值） */
export const MEDIA_DEFAULT_PORT = Number(process.env.DSM_MEDIA_PORT || 8888)

/** 片库目录：mediaserver 支持 MEDIA_LIBRARY_DIR 覆盖，缺省 <MEDIA_DIR>/library */
export function mediaLibraryDir() {
  return process.env.DSM_MEDIA_LIBRARY
    ? path.resolve(process.env.DSM_MEDIA_LIBRARY)
    : path.join(MEDIA_DIR, 'library')
}

const STATE_FILE = path.join(DATA_DIR, 'media.json')
const LOG_FILE = path.join(LOG_DIR, 'mediaserver.log')

/**
 * 给 mediaserver 子进程的临时目录。
 * 为什么单独指定：mediaserver / upscaler 用 `tempfile.gettempdir()` 当超分帧工作目录，
 * 而本机 TEMP 常指向 E:\Temp 之类「无写权限」的盘——超分第一步 os.makedirs 就
 * WinError 5 崩（实测踩过）。
 * 关键坑：Python 的 tempfile 优先级是 `TMPDIR` > `TEMP` > `TMP`，本机 TMPDIR 也指向
 * E:\Temp，只改 TEMP/TMP 没用（实测仍回退到 E:\Temp）。必须三个一起覆盖。
 */
const MEDIA_TMP_DIR = path.join(DATA_DIR, 'media-tmp')

/** 启动后等待端口就绪的总时长（Python 起 HTTP 服务很快，给 15s 足够） */
const START_TIMEOUT_MS = 15000
/** 单次能力探测超时 */
const PROBE_TIMEOUT_MS = 4000

/** mediaserver 的 BaseHTTPRequestHandler.server_version，用于认领自运行实例 */
const SERVER_SIGNATURE = 'LocalCinema/2.0'

// ---------------------------------------------------------------- 状态持久化

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, 'utf8'))
  } catch {
    return null
  }
}

function writeState(state) {
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const tmp = `${STATE_FILE}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), 'utf8')
  fs.renameSync(tmp, STATE_FILE)
}

function clearState() {
  try {
    fs.unlinkSync(STATE_FILE)
  } catch {
    /* 没有就算了 */
  }
}

// ---------------------------------------------------------------- HTTP 探测

/** GET 本机 JSON 接口；返回 { status, headers, json }，失败返回 null（不抛）。
 *  强制 Connection: close：这些是内部探活请求，不值得复用一个 localhost 长连接；
 *  复用 keep-alive socket 时，先 probeMedia 探过 /api/list、再 probeCapabilities 并发
 *  探 /api/list+/api/dl 会出现竞态，第二次 /api/list 被静默丢弃（真实 Python 与 node
 *  假服务都会触发）。每次新连接最稳。 */
function httpGetJson(url, timeout = PROBE_TIMEOUT_MS) {
  return new Promise((resolve) => {
    const req = http.get(url, { timeout, headers: { Connection: 'close' }, agent: false }, (res) => {
      const chunks = []
      res.on('data', (chunk) => chunks.push(chunk))
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8')
        let json = null
        try {
          json = JSON.parse(raw)
        } catch {
          /* 非 JSON 就算了，调用方自己兜 */
        }
        resolve({ status: res.statusCode, headers: res.headers, json, raw })
      })
    })
    req.on('timeout', () => {
      req.destroy()
      resolve(null)
    })
    req.on('error', () => resolve(null))
  })
}

/**
 * 探测端口上是不是「我们自己家的影院」。
 * 认领信号优先级：响应头 Server: LocalCinema/* > /api/list 可返回 JSON。
 * 前者是 mediaserver 的 server_version，伪造不了也不会误判（别的服务不会带这个头）。
 */
async function probeMedia(port) {
  const hit = await httpGetJson(`http://127.0.0.1:${port}/api/list`)
  if (!hit) return null
  const signature = String(hit.headers.server || '')
  if (!signature.startsWith('LocalCinema')) return null
  return hit
}

/** 拉能力标志：影院自己的 /api/list 与 /api/dl（它说算，不是我们猜） */
async function probeCapabilities(port) {
  const [list, dlInfo] = await Promise.all([
    httpGetJson(`http://127.0.0.1:${port}/api/list`),
    httpGetJson(`http://127.0.0.1:${port}/api/dl`),
  ])
  return {
    upscaler: Boolean(list?.json?.upscaler),
    ffmpeg: Boolean(list?.json?.ffmpeg),
    ytdlp: Boolean(dlInfo?.json?.ok),
    ytdlpVersion: dlInfo?.json?.version || null,
    videoCount: Array.isArray(list?.json?.items) ? list.json.items.length : null,
  }
}

// ---------------------------------------------------------------- 进程管理

function pythonSpawnArgs() {
  return ['server.py']
}

function spawnMedia(port) {
  fs.mkdirSync(LOG_DIR, { recursive: true })
  fs.mkdirSync(path.join(MEDIA_DIR, 'library'), { recursive: true })
  fs.mkdirSync(path.join(MEDIA_DIR, '.cache'), { recursive: true })
  // 超分帧工作目录（见 MEDIA_TMP_DIR 说明）：必须先建好，否则子进程继承的 TEMP 指向不可写盘
  fs.mkdirSync(MEDIA_TMP_DIR, { recursive: true })

  // stdout/stderr 全量进日志文件：Python 默认块缓冲，重定向到文件时 banner 会
  // 滞留在缓冲区里——用 -u 关掉缓冲，启动横幅和后续输出都能实时落盘。
  const logFd = fs.openSync(LOG_FILE, 'a')
  const header = `\n===== ${new Date().toISOString()} 启动 =====\n$ ${MEDIA_PYTHON} server.py（PORT=${port}）\n目录：${MEDIA_DIR}\n`
  fs.writeSync(logFd, header)

  const child = spawn(MEDIA_PYTHON, pythonSpawnArgs(), {
    cwd: MEDIA_DIR,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', logFd, logFd],
    env: {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
      PORT: String(port),
      // 固定临时目录到可写目录，根治超分帧目录 WinError 5（见 MEDIA_TMP_DIR 注释）。
      // 必须 TMPDIR/TEMP/TMP 三个一起覆盖：Python tempfile 优先级 TMPDIR 最高。
      TMPDIR: MEDIA_TMP_DIR,
      TEMP: MEDIA_TMP_DIR,
      TMP: MEDIA_TMP_DIR,
    },
  })
  child.unref()
  fs.closeSync(logFd)
  return child
}

/** 结束进程树：mediaserver 会派生子进程（ffmpeg 抽帧 / yt-dlp / 超分），必须连锅端 */
async function killMediaTree(pid) {
  if (!pid) return false
  if (!isWindows()) {
    try {
      process.kill(Number(pid), 'SIGTERM')
      return true
    } catch {
      return false
    }
  }
  const result = await runFileQuiet('taskkill', ['/PID', String(Number(pid)), '/T', '/F'], { timeout: 20000 })
  return !result.failed
}

/**
 * 等端口进入期望状态。自写轮询（不走 portScanner.waitForPort）以便每次都用 force 实时读——
 * 托管刚拉起 / 刚停止的服务时，10s TTL 缓存会让我们白等一整轮。
 */
async function waitPort(port, { want = true, timeoutMs = START_TIMEOUT_MS } = {}) {
  if (!port) return !want
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const listening = await portScanner.isPortListening(port, { force: true })
    if (listening === want) return true
    if (Date.now() >= deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 400))
  }
}

// ---------------------------------------------------------------- 对外接口

/**
 * 当前状态。判定「在跑」的条件：记录过的 PID 还活着，或配置端口上有
 * LocalCinema 在响应（用户自己双击 start.bat 起过一份的情况）。
 */
export async function status() {
  const state = readState()
  const port = state?.port || MEDIA_DEFAULT_PORT
  // 强制实时读端口：刚被拉起 / 刚被杀的瞬间，10s TTL 缓存会误判，导致「启动后一直显示未运行」
  // 或「杀了还在显示运行中」。托管自有服务的探活必须看当前真相，不能看缓存。
  const listening = await portScanner.isPortListening(port, { force: true })
  const own = listening ? await probeMedia(port) : null

  const pidAlive = Boolean(state?.pid && processInfo.isPidAlive(state.pid))
  const running = Boolean(own) || (pidAlive && listening)

  if (!running) {
    // 清掉过期状态：记录的 PID 已死，且端口上要么没人听、要么听着的是别人（不是我们的
    // LocalCinema）。这种状态是误导性的，留着会让 UI 卡在「启动中」或显示错误的占用者。
    // PID 还活着时不在此清——可能正在启动，下一轮 status 就能认领。
    if (state && !pidAlive && !own) clearState()
    return {
      running: false,
      port,
      url: null,
      pid: null,
      startedAt: null,
      libraryDir: mediaLibraryDir(),
      capabilities: null,
      adopted: false,
    }
  }

  const capabilities = own ? await probeCapabilities(port) : null
  return {
    running: true,
    port,
    url: `http://127.0.0.1:${port}`,
    pid: state?.pid ?? null,
    startedAt: state?.startedAt || null,
    libraryDir: mediaLibraryDir(),
    capabilities,
    // adopted = 端口上是别处拉起的实例（不是本服务记录的 PID 拉起的）
    adopted: Boolean(own) && !pidAlive,
  }
}

/**
 * 启动（或认领）。返回 { running, port, url, adopted, message }。
 * 端口策略：先试默认端口；被别的进程占用就顺延；若占用者就是 LocalCinema，直接认领。
 */
export async function start() {
  const current = await status()
  if (current.running) {
    return { ...current, message: current.adopted ? '已认领正在运行的影院实例' : '影院已在运行' }
  }

  if (!pathExistsSync(MEDIA_DIR)) {
    throw badRequest(`影院目录不存在：${MEDIA_DIR}`)
  }
  if (!pathExistsSync(path.join(MEDIA_DIR, 'server.py'))) {
    throw badRequest(`影院入口不存在：${path.join(MEDIA_DIR, 'server.py')}`)
  }

  // 端口：默认被占就先看看占用者是不是自家实例（双击过 start.bat），是则认领
  const owners = await portScanner.getPortOwners(MEDIA_DEFAULT_PORT, { force: true })
  let port = MEDIA_DEFAULT_PORT
  if (owners.length > 0) {
    const foreign = await probeMedia(MEDIA_DEFAULT_PORT)
    if (foreign) {
      writeState({ pid: null, port: MEDIA_DEFAULT_PORT, startedAt: new Date().toISOString(), adopted: true })
      const capabilities = await probeCapabilities(MEDIA_DEFAULT_PORT)
      return {
        running: true,
        port: MEDIA_DEFAULT_PORT,
        url: `http://127.0.0.1:${MEDIA_DEFAULT_PORT}`,
        pid: null,
        startedAt: new Date().toISOString(),
        libraryDir: mediaLibraryDir(),
        capabilities,
        adopted: true,
        message: '已认领正在运行的影院实例',
      }
    }
    const free = await portScanner.findFreePort(MEDIA_DEFAULT_PORT + 1)
    if (!free) throw new HttpError(500, `默认端口 ${MEDIA_DEFAULT_PORT} 被占用，且找不到可用端口`)
    port = free
  }

  const child = spawnMedia(port)
  writeState({ pid: child.pid, port, startedAt: new Date().toISOString(), adopted: false })

  const ready = await waitPort(port, { want: true })
  if (!ready) {
    const alive = processInfo.isPidAlive(child.pid)
    if (!alive) {
      clearState()
      throw new HttpError(500, `影院进程启动后立即退出（PID ${child.pid}），请查看日志：${LOG_FILE}`)
    }
    // 进程活着但端口没起：保留状态，让 status() 后续能认领
    return {
      running: false,
      port,
      url: null,
      pid: child.pid,
      startedAt: new Date().toISOString(),
      libraryDir: mediaLibraryDir(),
      capabilities: null,
      adopted: false,
      message: `进程已启动（PID ${child.pid}），但端口 ${port} 尚未就绪，请稍后刷新`,
    }
  }

  const capabilities = await probeCapabilities(port)
  return {
    running: true,
    port,
    url: `http://127.0.0.1:${port}`,
    pid: child.pid,
    startedAt: new Date().toISOString(),
    libraryDir: mediaLibraryDir(),
    capabilities,
    adopted: false,
    message: port === MEDIA_DEFAULT_PORT ? '影院已启动' : `默认端口被占用，已改用 ${port}`,
  }
}

/** 停止：结束记录的进程树 + 兜底结束占用端口的所有进程，然后等端口释放 */
export async function stop() {
  const state = readState()
  const port = state?.port || MEDIA_DEFAULT_PORT
  const owners = await portScanner.getPortOwners(port, { force: true })

  const targets = new Map()
  if (state?.pid) targets.set(Number(state.pid), '影院进程')
  for (const owner of owners) {
    // 不杀自己（理论上不可能撞上，防呆）
    if (Number(owner.pid) === Number(process.pid)) continue
    targets.set(Number(owner.pid), `占用端口 ${port} 的进程`)
  }

  for (const [pid] of targets) {
    await killMediaTree(pid)
  }

  const released = port ? await waitPort(port, { want: false, timeoutMs: 8000 }) : true
  clearState()
  return { stopped: true, port, portReleased: released }
}

/** 日志尾部（工作台自己的日志视图复用；影院输出全量在 data/logs/mediaserver.log） */
export function logTail(lines = 100) {
  try {
    const text = fs.readFileSync(LOG_FILE, 'utf8')
    return text.split(/\r?\n/).slice(-Number(lines)).join('\n')
  } catch {
    return ''
  }
}
