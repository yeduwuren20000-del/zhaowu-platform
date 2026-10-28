/**
 * Docker 守护进程「一键拉起」。
 *
 * 为什么单独一个服务：routes/docker.js 管的是**容器**（ps/start/stop/logs），
 * 而新手最常见的卡点是**引擎根本没起**——Docker Desktop 没开，或开了还在转圈。
 * 这一层只负责「把引擎叫起来 + 等到真的能连上」，容器操作仍归 docker 路由。
 *
 * 设计要点（每条都是踩过坑才加的）：
 *  - 不阻塞 HTTP：start() 只发起启动并挂后台等待器，前端轮询 status() 看进度；
 *  - 并发去重：连点按钮不会再拉起第二个 Docker Desktop；
 *  - **不抢功**：记录自己 spawn 的 pid，就绪时若 pid 已退出，origin 记成 external——
 *    那条引擎不是这次工作台拉起来的（很可能是用户自己点了桌面版），界面要如实说；
 *  - **不干等**：自己拉起的进程早早退出且引擎没起来，立刻报错，不耗满超时；
 *  - 双版本：桌面版是 4.x、引擎是 29.x 两套编号，两个都报，避免「版本对不上」的误会；
 *  - 依赖全部可注入，单测不需要真 Docker、也不需要真弹窗。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { runFile, runPowerShell } from '../utils/exec.js'
import { HttpError } from '../utils/http.js'

export const DEFAULT_TIMEOUT_MS = 180000
export const DEFAULT_POLL_MS = 1500

const WINDOWS_DESKTOP_RELATIVE = ['Docker', 'Docker', 'Docker Desktop.exe']

export function firstLine(value) {
  return (
    String(value || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .find(Boolean) || ''
  )
}

/** 默认存在性判断；注入后单测可完全脱离文件系统 */
function defaultExists(candidate) {
  try {
    return fs.statSync(candidate).isFile()
  } catch {
    return false
  }
}

/**
 * Windows 上 Docker Desktop 的可能安装位置（从最可信到兜底）。
 * 支持 DSM_DOCKER_DESKTOP 显式覆盖（装在非默认盘/便携版时用）。
 */
export function desktopCandidates(env = process.env) {
  const join = path.win32.join
  const list = []
  if (env.DSM_DOCKER_DESKTOP) list.push(env.DSM_DOCKER_DESKTOP)
  for (const key of ['ProgramW6432', 'ProgramFiles', 'ProgramFiles(x86)']) {
    if (env[key]) list.push(join(env[key], ...WINDOWS_DESKTOP_RELATIVE))
  }
  if (env.LOCALAPPDATA) list.push(join(env.LOCALAPPDATA, 'Docker', 'Docker Desktop.exe'))
  list.push('C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe')
  return [...new Set(list.filter(Boolean))]
}

export function resolveDesktopPath({ env = process.env, exists = defaultExists } = {}) {
  return desktopCandidates(env).find((candidate) => exists(candidate)) || null
}

/**
 * 该平台该怎么拉起引擎。返回 null 表示「找不到可拉起的入口」。
 * 这里不判断 docker CLI 是否存在——那属于「装没装」，由调用方探测。
 */
export function resolveLaunchPlan({ platform = process.platform, env = process.env, exists = defaultExists } = {}) {
  if (platform === 'win32') {
    const exe = resolveDesktopPath({ env, exists })
    return exe ? { kind: 'windows-desktop', label: 'Docker Desktop', target: exe } : null
  }
  if (platform === 'darwin') {
    return { kind: 'macos-open', label: 'Docker Desktop', target: 'Docker' }
  }
  if (platform === 'linux') {
    return { kind: 'linux-service', label: 'docker 服务', target: 'docker' }
  }
  return null
}

/** 没有入口时给用户的下一步：不是「未知错误」，而是「按这个做」 */
export function describeMissingPlan(platform) {
  if (platform === 'win32') {
    return (
      '没找到 Docker Desktop（默认在 C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe）。' +
      '装在别处的话，把环境变量 DSM_DOCKER_DESKTOP 指向 Docker Desktop.exe；' +
      '还没装就先去 https://www.docker.com/products/docker-desktop 装一个。'
    )
  }
  if (platform === 'linux') {
    return '当前系统的启动方式不认识：请手动执行 `sudo systemctl start docker`，并确认当前用户已加入 docker 组。'
  }
  return '当前系统不支持自动拉起 Docker，请手动打开 Docker Desktop。'
}

export function describeLaunchFailure(cause, plan) {
  const code = String(cause?.code || '')
  if (code === 'ENOENT') return `启动失败：找不到 ${plan.target}（路径可能已被移动或删除）`
  if (code === 'EACCES' || code === 'EPERM') {
    return `启动失败：没有权限执行 ${plan.target}（可能被安全软件拦截，或需要管理员权限）`
  }
  const detail = firstLine(cause?.stderr || cause?.message || cause)
  return detail ? `启动 ${plan.label} 失败：${detail}` : `启动 ${plan.label} 失败`
}

/** spawn 的 'error' 事件不会自己抛，必须显式接住，否则进程会因为未处理事件直接崩 */
function spawnDetachedSafe(file, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, { detached: true, stdio: 'ignore', windowsHide: false })
    child.once('error', reject)
    child.once('spawn', () => {
      child.unref()
      resolve({ pid: child.pid ?? null })
    })
  })
}

export async function defaultLaunch(plan, { runFile: run = runFile } = {}) {
  if (plan.kind === 'windows-desktop') {
    const info = await spawnDetachedSafe(plan.target, [])
    return { method: 'Docker Desktop.exe', pid: info.pid }
  }
  if (plan.kind === 'macos-open') {
    const info = await spawnDetachedSafe('open', ['-a', plan.target])
    return { method: 'open -a Docker', pid: info.pid }
  }
  // Linux：systemd 优先，老系统退回 SysV；两步都失败才抛出（带最后一条真实错误）
  try {
    await run('systemctl', ['start', plan.target], { timeout: 60000 })
    return { method: 'systemctl', pid: null }
  } catch {
    await run('service', [plan.target, 'start'], { timeout: 60000 })
    return { method: 'service', pid: null }
  }
}

/** 探测引擎是否可用：能拿到 Server 版本才算真的就绪 */
export async function probeDaemon({ runFile: run = runFile } = {}) {
  try {
    const { stdout } = await run('docker', ['version', '--format', '{{.Server.Version}}'], { timeout: 8000 })
    const version = String(stdout || '').trim()
    if (!version) return { ok: false, error: '守护进程没有返回版本号' }
    return { ok: true, version }
  } catch (error) {
    return { ok: false, error: firstLine(error?.stderr || error?.message || error) || '连不上 Docker 守护进程' }
  }
}

/**
 * 当前有没有 Docker Desktop 桌面进程在跑（排除 frontend 子进程）。
 * 为什么要问：桌面版单实例，如果它已经在跑（用户手动开的、或开机自启的），
 * 再 spawn 一个只会唤起旧窗口、然后新进程退出——白折腾一轮，还容易让人以为是工作台拉起来的。
 */
export async function listDesktopProcesses({ platform = process.platform, runPowerShell: ps = runPowerShell } = {}) {
  if (platform !== 'win32') return []
  try {
    const stdout = await ps(
      "Get-CimInstance Win32_Process -Filter \"Name='Docker Desktop.exe'\" | " +
        "Where-Object { $_.ExecutablePath -notlike '*\\frontend\\*' } | " +
        'Select-Object ProcessId, ExecutablePath | ConvertTo-Json -Compress',
      { timeout: 8000 },
    )
    const text = String(stdout || '').trim()
    if (!text) return []
    const parsed = JSON.parse(text)
    const rows = Array.isArray(parsed) ? parsed : [parsed]
    return rows
      .filter((row) => row && row.ProcessId)
      .map((row) => ({ pid: Number(row.ProcessId), path: row.ExecutablePath || '' }))
  } catch {
    return []
  }
}

/** pid 是否还活着（Windows 用 Get-Process，Unix 用 signal 0） */
export async function isPidAlive(pid, { platform = process.platform, runPowerShell: ps = runPowerShell } = {}) {
  if (!pid) return false
  if (platform === 'win32') {
    try {
      const stdout = await ps(
        `if (Get-Process -Id ${Number(pid)} -ErrorAction SilentlyContinue) { 'alive' } else { 'gone' }`,
        { timeout: 6000 },
      )
      return String(stdout || '').includes('alive')
    } catch {
      return false
    }
  }
  try {
    process.kill(Number(pid), 0)
    return true
  } catch {
    return false
  }
}

/**
 * 桌面版自己的版本号（4.95.0 这种），和引擎版本（29.8.2）是两套编号。
 * 读一次就缓存：每次 status 都去问 PowerShell 太贵。
 */
const desktopVersionCache = new Map()
export async function readDesktopVersion(exe, { runPowerShell: ps = runPowerShell } = {}) {
  if (!exe) return null
  if (desktopVersionCache.has(exe)) return desktopVersionCache.get(exe)
  let version = null
  try {
    const escaped = String(exe).replace(/'/g, "''")
    const stdout = await ps(`(Get-Item -LiteralPath '${escaped}' -ErrorAction Stop).VersionInfo.FileVersion`, { timeout: 8000 })
    version = String(stdout || '').trim() || null
  } catch {
    version = null
  }
  desktopVersionCache.set(exe, version)
  return version
}

/**
 * 状态机工厂：phase = stopped | starting | ready | timeout | error
 * origin = workbench（这次工作台拉起的） | external（原本就在跑 / 用户手动拉起）
 */
export function createDockerDaemonManager(options = {}) {
  const platform = options.platform || process.platform
  const env = options.env || process.env
  const exists = options.exists || defaultExists
  const sleep = options.sleep || ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
  const timeoutMs = options.timeoutMs ?? (Number(env.DSM_DOCKER_START_TIMEOUT_MS) || DEFAULT_TIMEOUT_MS)
  const pollMs = options.pollMs ?? (Number(env.DSM_DOCKER_POLL_MS) || DEFAULT_POLL_MS)
  const run = options.runFile || runFile
  const probe = options.probe || (() => probeDaemon({ runFile: run }))
  const launch = options.launch || ((plan) => defaultLaunch(plan, { runFile: run }))
  const listDesktop = options.listDesktop || (() => listDesktopProcesses({ platform }))
  const alive = options.isAlive || ((pid) => isPidAlive(pid, { platform }))
  const desktopVersionOf = options.readDesktopVersion || ((exe) => readDesktopVersion(exe))
  const describe = options.describeLaunchFailure || describeLaunchFailure

  let state = {
    phase: 'stopped',
    origin: null,
    startedAt: null,
    readyAt: null,
    method: null,
    error: null,
    version: null,
    pid: null,
    desktopVersion: null,
    desktopPids: [],
  }
  let waiting = null

  function waitedMs() {
    return state.startedAt ? Date.now() - state.startedAt : null
  }

  function snapshot() {
    return {
      platform,
      ready: state.phase === 'ready',
      phase: state.phase,
      // origin 只描述「这条引擎是不是本次工作台拉起来的」，界面据此措辞，不许抢功
      origin: state.origin,
      method: state.method,
      version: state.version,
      engineVersion: state.version,
      desktopVersion: state.desktopVersion,
      pid: state.pid,
      desktopPids: state.desktopPids,
      error: state.error,
      startedAt: state.startedAt,
      readyAt: state.readyAt,
      waitedMs: waitedMs(),
      timeoutMs,
      desktopPath: platform === 'win32' ? resolveDesktopPath({ env, exists }) : null,
    }
  }

  async function refreshDesktopVersion() {
    if (platform !== 'win32' || state.desktopVersion) return
    const exe = resolveDesktopPath({ env, exists })
    if (!exe) return
    const version = await desktopVersionOf(exe)
    if (version) state = { ...state, desktopVersion: version }
  }

  async function waitUntilReady() {
    const ourPid = state.pid
    let ourPidAlive = Boolean(ourPid)
    try {
      while (state.startedAt && Date.now() - state.startedAt < timeoutMs) {
        await sleep(pollMs)
        if (state.phase !== 'starting') return

        if (ourPid && ourPidAlive) {
          ourPidAlive = await alive(ourPid)
        }

        const result = await probe()
        if (result.ok) {
          state = {
            ...state,
            phase: 'ready',
            // 关键：只有「自己拉起的进程还活着」才算工作台拉起的
            origin: ourPid ? (ourPidAlive ? 'workbench' : 'external') : 'external',
            version: result.version,
            readyAt: Date.now(),
            error: null,
          }
          return
        }

        if (ourPid && !ourPidAlive) {
          // 自己拉起的进程早退，且引擎没起来：别耗满 180 秒，立刻说清楚
          state = {
            ...state,
            phase: 'error',
            error:
              'Docker Desktop 启动后立即退出（进程已不在），引擎也没起来。' +
              '常见原因：需要管理员/UAC 确认、被安全软件拦截、或桌面版正在做首次初始化。' +
              '可以再点一次「一键拉起」，或手动从开始菜单打开 Docker Desktop。',
          }
          return
        }
      }
      state = {
        ...state,
        phase: 'timeout',
        error:
          `已经发起启动，但 ${Math.round(timeoutMs / 1000)} 秒内没就绪。` +
          'Docker Desktop 首次启动、或正在初始化 WSL 后端时会比较慢：可以再点一次「一键拉起」，' +
          '或看系统托盘鲸鱼图标是否还在转圈。',
      }
    } catch (error) {
      state = { ...state, phase: 'error', error: `等待 Docker 就绪时出错：${firstLine(error?.message || error)}` }
    } finally {
      waiting = null
    }
  }

  async function status() {
    const result = await probe()
    if (result.ok) {
      const origin = state.phase === 'ready' && state.origin ? state.origin : 'external'
      state = { ...state, phase: 'ready', origin, version: result.version, readyAt: state.readyAt || Date.now(), error: null }
      await refreshDesktopVersion()
      return snapshot()
    }
    if (state.phase === 'ready') {
      state = { ...state, phase: 'stopped', error: result.error || 'Docker 守护进程已断开' }
      return snapshot()
    }
    if (state.phase === 'stopped' || state.phase === 'timeout' || state.phase === 'error') {
      return { ...snapshot(), error: state.error || result.error || null }
    }
    // 启动中：保留进度，但把探测到的连接错误塞进去，便于界面显示
    return { ...snapshot(), error: result.error || null }
  }

  async function start() {
    const current = await probe()
    const desktopRunning = await listDesktop().catch(() => [])

    if (current.ok) {
      // 已经能连上：除非本进程先前拉起且仍 ready，否则 origin 只能是 external
      const origin = state.phase === 'ready' && state.origin ? state.origin : 'external'
      state = {
        ...state,
        phase: 'ready',
        origin,
        startedAt: null,
        readyAt: Date.now(),
        error: null,
        version: current.version,
        desktopPids: desktopRunning.map((item) => item.pid),
      }
      await refreshDesktopVersion()
      return { ...snapshot(), launched: false, alreadyRunning: true }
    }

    if (waiting) {
      return { ...snapshot(), launched: false, alreadyStarting: true }
    }

    // 桌面版已经在跑（用户手动开的 / 开机自启）：不再 spawn，只等引擎就绪
    if (desktopRunning.length > 0) {
      state = {
        phase: 'starting',
        origin: 'external',
        startedAt: Date.now(),
        readyAt: null,
        method: 'Docker Desktop（已在运行）',
        version: null,
        error: null,
        pid: null,
        desktopVersion: state.desktopVersion,
        desktopPids: desktopRunning.map((item) => item.pid),
      }
      await refreshDesktopVersion()
      waiting = waitUntilReady()
      return { ...snapshot(), launched: false, attachedToExisting: true }
    }

    const plan = resolveLaunchPlan({ platform, env, exists })
    if (!plan) {
      state = { ...state, phase: 'error', error: describeMissingPlan(platform) }
      throw new HttpError(400, describeMissingPlan(platform), { phase: 'error', platform })
    }

    try {
      const info = await launch(plan)
      state = {
        phase: 'starting',
        origin: 'workbench',
        startedAt: Date.now(),
        readyAt: null,
        method: info?.method || plan.label,
        version: null,
        error: null,
        pid: info?.pid ?? null,
        desktopVersion: state.desktopVersion,
        desktopPids: info?.pid ? [info.pid] : [],
      }
    } catch (cause) {
      const message = describe(cause, plan)
      state = { ...state, phase: 'error', origin: null, error: message }
      throw new HttpError(502, message, { phase: 'error', platform })
    }

    await refreshDesktopVersion()
    waiting = waitUntilReady()
    return { ...snapshot(), launched: true }
  }

  /** 仅测试用：清空状态与后台等待器 */
  function reset() {
    state = {
      phase: 'stopped',
      origin: null,
      startedAt: null,
      readyAt: null,
      method: null,
      error: null,
      version: null,
      pid: null,
      desktopVersion: null,
      desktopPids: [],
    }
    waiting = null
  }

  return { status, start, reset, _snapshot: snapshot }
}

/** 路由用的进程级单例 */
export const dockerDaemon = createDockerDaemonManager()

export default dockerDaemon
