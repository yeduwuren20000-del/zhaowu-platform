'use strict'

/**
 * Electron 桌面壳：把工作台包成原生窗口，根治「启动白闪」。
 *
 * 为什么能去白闪：
 *   - BrowserWindow 的 `backgroundColor` 设为与首屏 #boot 骨架同色（#0c0e11），
 *     窗口在画出第一帧时就已是深色，而不是浏览器默认的白色；
 *   - `show: false` + `ready-to-show`：先藏窗口，等页面真正画好再显示，
 *     彻底跳过了「白底 → 内容」那一帧闪烁。
 *
 * 后端仍然是一个独立的 Node 进程（与 desktop.mjs 完全一致）：
 *   工作台后端重度依赖 Node 原生能力（PowerShell / SSH / 子进程），
 *   所以不在 Electron 渲染进程里跑后端，而是主进程 spawn 出来，
 *   只让 Electron 当「深色无白闪的窗口壳」。
 *
 * 用法：
 *   electron electron/main.cjs            # 确保后端在跑 + 打开无白闪窗口
 *   electron electron/main.cjs --kill      # 停止后端
 */

const { app, BrowserWindow, dialog } = require('electron')
const fs = require('node:fs')
const path = require('node:path')
const http = require('node:http')
const { spawn, spawnSync } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')
const SERVER_DIR = path.join(ROOT, 'server')
const DIST_INDEX = path.join(ROOT, 'web', 'dist', 'index.html')
const SERVER_LOG = path.join(ROOT, 'data', 'logs', 'electron-server.log')
const BOOT_LOG = path.join(ROOT, 'data', 'logs', 'electron-boot.log')
const API_PORT = Number(process.env.DSM_PORT || 8787)
const URL = `http://127.0.0.1:${API_PORT}`
const APP_ID = 'DevServerManager'
const BG = '#0c0e11' // 与首屏 #boot 骨架同色，零白闪

const KILL = process.argv.includes('--kill')

app.setAppUserModelId(APP_ID)

/** 启动排障日志：Electron 主进程没有终端，所有关键步骤写这里方便本机排查 */
function bootLog(line) {
  try {
    fs.mkdirSync(path.dirname(BOOT_LOG), { recursive: true })
    fs.appendFileSync(BOOT_LOG, `[${new Date().toISOString()}] ${line}\n`)
  } catch {
    /* 日志失败不应阻断启动 */
  }
}

/**
 * 解析真正的 node 可执行文件。
 * ⚠️ 关键坑：Electron 主进程里 `process.execPath` 是 electron 自己，用它去跑后端
 * Node 脚本会先初始化整座 Chromium，启动极慢且不稳，后端常常起不来（表现为闪白/打不开）。
 * 这里优先取 node：① npm 注入的 npm_node_execpath；② PATH 里能跑 `node --version` 的；
 * ③ Windows 按 PATHEXT 在 PATH 目录中找 node(.exe)；④ 实在找不到才回退 electron 自己。
 */
function resolveNode() {
  const isWin = process.platform === 'win32'
  const npmNode = process.env.npm_node_execpath
  if (npmNode && !/electron/i.test(npmNode) && fs.existsSync(npmNode)) {
    return npmNode
  }
  try {
    const probe = spawnSync('node', ['--version'], { timeout: 8000, windowsHide: true })
    if (probe.status === 0) return 'node'
  } catch {
    /* 忽略，继续下面兜底 */
  }
  if (isWin) {
    const exts = (process.env.PATHEXT || '.EXE;.CMD;.BAT').split(';').filter(Boolean)
    for (const dir of (process.env.PATH || '').split(path.delimiter).filter(Boolean)) {
      for (const ext of exts) {
        const candidate = path.join(dir, 'node' + ext)
        if (fs.existsSync(candidate)) return candidate
      }
    }
  }
  return process.execPath
}

const NODE_BIN = resolveNode()
bootLog(`electron boot, NODE_BIN=${NODE_BIN}, execPath=${process.execPath}, gotLock handled later`)

function health() {
  return new Promise((resolve) => {
    const req = http.get(`${URL}/api/health`, { timeout: 2000 }, (res) => {
      res.resume()
      resolve(res.statusCode === 200)
    })
    req.on('error', () => resolve(false))
    req.on('timeout', () => {
      req.destroy()
      resolve(false)
    })
  })
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function waitForServer(timeoutMs = 25000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (await health()) return true
    await sleep(300)
  }
  return false
}

/** 以分离进程拉起后端（真正的 node），日志写 data/logs/electron-server.log；父进程退出不影响它 */
function startServer() {
  fs.mkdirSync(path.dirname(SERVER_LOG), { recursive: true })
  const out = fs.openSync(SERVER_LOG, 'a')
  const child = spawn(NODE_BIN, [path.join(SERVER_DIR, 'src', 'index.js')], {
    cwd: ROOT,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, out],
  })
  child.unref()
  fs.closeSync(out)
  bootLog(`backend spawned via NODE_BIN=${NODE_BIN}, pid=${child.pid}`)
  return child.pid
}

function stopServer() {
  return new Promise((resolve) => {
    if (process.platform !== 'win32') return resolve(false)
    const ps = spawn('powershell.exe', [
      '-NoProfile',
      '-Command',
      `Get-NetTCPConnection -State Listen -LocalPort ${API_PORT} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }`,
    ], { windowsHide: true })
    ps.on('exit', (code) => resolve(code === 0))
    ps.on('error', () => resolve(false))
  })
}

let mainWindow = null

/** 深色连接中提示页：后端没起时覆盖 Chromium 默认浅色错误页，避免闪白 */
const ERROR_HTML =
  'data:text/html;charset=utf-8,' +
  encodeURIComponent(`<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:#0c0e11;color:#7d8590;font-family:-apple-system,"Segoe UI","Microsoft YaHei",sans-serif;display:flex;align-items:center;justify-content:center;flex-direction:column;gap:12px;text-align:center;padding:0 24px}
  .t{color:#e6e9ee;font-size:15px;font-weight:600}
  .h{font-size:12px;line-height:1.6}
  code{color:#9aa4b2;background:#171a1f;padding:2px 6px;border-radius:4px;word-break:break-all}
  .d{width:8px;height:8px;border-radius:50%;background:#4c8dfd;animation:blink 1.1s ease-in-out infinite}
  @keyframes blink{0%,100%{opacity:.3}50%{opacity:1}}
</style></head><body>
  <div class="d"></div>
  <div class="t">正在连接工作台后端…</div>
  <div class="h">后端尚未就绪或启动较慢，正在自动重试。若长时间仍无反应，请查看日志：<br><code>${SERVER_LOG.replace(/\\/g, '/')}</code></div>
</body></html>`)

function createWindow() {
  const win = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 960,
    minHeight: 600,
    backgroundColor: BG, // 第一帧就是深色，无白闪
    show: false, // 等 ready-to-show 再显示，跳过白底那一帧
    title: '开发与服务器管理工作台',
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      // 工作台内嵌打开的应用(iframe)在窗口失焦时也需要保持运行，关掉后台节流
      backgroundThrottling: false,
      spellcheck: false,
    },
  })
  win.setMenuBarVisibility(false)

  const showWhenReady = () => {
    if (!win.isVisible()) win.show()
  }
  // 兜底：极端情况下 ready-to-show 未触发也不让窗口永远不显示
  const fallback = setTimeout(showWhenReady, 20000)

  let retrying = false
  win.once('ready-to-show', () => {
    clearTimeout(fallback)
    showWhenReady()
  })
  // 后端没起 / 连接失败：用深色提示页覆盖 Chromium 默认的浅色错误页（闪白元凶之一），
  // 并每 4s 探测后端，一旦就绪自动切回工作台
  win.webContents.on('did-fail-load', () => {
    if (!retrying) {
      retrying = true
      bootLog('loadURL failed, showing dark retry page')
      win.loadURL(ERROR_HTML)
      const timer = setInterval(async () => {
        if (await health()) {
          clearInterval(timer)
          bootLog('backend became reachable, reloading SPA')
          win.loadURL(URL)
        }
      }, 4000)
      win.on('closed', () => clearInterval(timer))
    }
  })

  win.loadURL(URL)
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })
  return win
}

async function boot() {
  if (KILL) {
    bootLog('kill requested')
    console.log('正在停止工作台后端…')
    await stopServer()
    bootLog('backend stopped')
    console.log('已停止。')
    app.quit()
    return
  }

  if (!fs.existsSync(DIST_INDEX)) {
    bootLog(`dist missing: ${DIST_INDEX}`)
    dialog.showErrorBox(
      '前端未构建',
      `未检测到前端产物（${DIST_INDEX}）。\n请先运行一次：npm start （会自动构建前端）。`,
    )
    app.quit()
    return
  }

  let started = false
  if (!(await health())) {
    bootLog('backend not running, spawning')
    console.log('启动工作台后端…')
    startServer()
    started = true
    if (!(await waitForServer())) {
      bootLog('backend failed to start within timeout')
      dialog.showErrorBox('后端启动失败', `工作台后端未能在预期时间内启动，请查看日志：${SERVER_LOG}`)
      app.quit()
      return
    }
  }
  bootLog(`ready, started=${started}`)
  console.log(`工作台已就绪：${URL}${started ? '（后端为本次启动）' : '（复用在跑的后端）'}`)
  mainWindow = createWindow()
}

// 单实例：避免重复开多个窗口/后端
const gotLock = app.requestSingleInstanceLock()
bootLog(`gotLock=${gotLock}`)
if (!gotLock) {
  bootLog('another instance holds the lock -> quit')
  app.quit()
} else {
  app.whenReady().then(boot)
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore()
      mainWindow.focus()
    }
  })
  // 关闭窗口不杀后端：它可能正在托管你从工作台启动的项目；彻底停止用 --kill
  app.on('window-all-closed', () => app.quit())
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) boot()
  })
}
