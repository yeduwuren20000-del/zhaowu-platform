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
const { spawn } = require('node:child_process')

const ROOT = path.resolve(__dirname, '..')
const SERVER_DIR = path.join(ROOT, 'server')
const DIST_INDEX = path.join(ROOT, 'web', 'dist', 'index.html')
const SERVER_LOG = path.join(ROOT, 'data', 'logs', 'electron-server.log')
const API_PORT = Number(process.env.DSM_PORT || 8787)
const URL = `http://127.0.0.1:${API_PORT}`
const APP_ID = 'DevServerManager'
const BG = '#0c0e11' // 与首屏 #boot 骨架同色，零白闪

const KILL = process.argv.includes('--kill')

app.setAppUserModelId(APP_ID)

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

/** 以分离进程拉起后端，日志写 data/logs/electron-server.log；父进程退出不影响它 */
function startServer() {
  fs.mkdirSync(path.dirname(SERVER_LOG), { recursive: true })
  const out = fs.openSync(SERVER_LOG, 'a')
  const child = spawn(process.execPath, [path.join(SERVER_DIR, 'src', 'index.js')], {
    cwd: ROOT,
    detached: true,
    windowsHide: true,
    stdio: ['ignore', out, out],
  })
  child.unref()
  fs.closeSync(out)
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
  win.loadURL(URL)
  win.once('ready-to-show', () => win.show())
  win.on('closed', () => {
    if (mainWindow === win) mainWindow = null
  })
  return win
}

async function boot() {
  if (KILL) {
    console.log('正在停止工作台后端…')
    await stopServer()
    console.log('已停止。')
    app.quit()
    return
  }

  if (!fs.existsSync(DIST_INDEX)) {
    dialog.showErrorBox(
      '前端未构建',
      `未检测到前端产物（${DIST_INDEX}）。\n请先运行一次：npm start （会自动构建前端）。`,
    )
    app.quit()
    return
  }

  let started = false
  if (!(await health())) {
    console.log('启动工作台后端…')
    startServer()
    started = true
    if (!(await waitForServer())) {
      dialog.showErrorBox('后端启动失败', `工作台后端未能在预期时间内启动，请查看日志：${SERVER_LOG}`)
      app.quit()
      return
    }
  }
  console.log(`工作台已就绪：${URL}${started ? '（后端为本次启动）' : '（复用在跑的后端）'}`)
  mainWindow = createWindow()
}

// 单实例：避免重复开多个窗口/后端
const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
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
