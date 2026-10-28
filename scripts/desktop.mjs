import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { ROOT } from './lib/run.mjs'

/**
 * 桌面端封装（Windows）：用系统自带的 Edge / Chrome 以「应用窗口模式」拉起工作台。
 *
 *   node scripts/desktop.mjs            # 确保后端在跑 + 打开独立应用窗口
 *   node scripts/desktop.mjs --kill      # 顺带停掉后端再退出
 *
 * 为什么用浏览器 app 模式而不是 Electron：
 *   - 工作台后端本来就只监听 127.0.0.1、且依赖大量 Node 能力（PowerShell、SSH、子进程），
 *     Electron 还要再嵌一个 Chromium + 打包，体积和复杂度都上一个台阶；
 *   - app 模式给的是**没有地址栏、没有标签、独立进程、独立任务栏图标**的窗口，
 *     观感和普通桌面程序一致，且零额外依赖（用系统已装的浏览器）。
 *
 * 独立 user-data-dir（data/.desktop-profile）：不污染你日常浏览器，也不被它的扩展/登录态干扰。
 */

const SERVER_DIR = path.join(ROOT, 'server')
const DIST_INDEX = path.join(ROOT, 'web', 'dist', 'index.html')
const PROFILE_DIR = path.join(ROOT, 'data', '.desktop-profile')
const SERVER_LOG = path.join(ROOT, 'data', 'logs', 'desktop-server.log')
const API_PORT = Number(process.env.DSM_PORT || 8787)
const URL = `http://127.0.0.1:${API_PORT}`

const BROWSERS = [
  'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe',
  'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe',
  'C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe',
]

function findBrowser() {
  return BROWSERS.find((candidate) => fs.existsSync(candidate)) || null
}

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

/** 以分离进程拉起后端，日志写 data/logs/desktop-server.log；父进程退出不影响它 */
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
    const child = spawn('powershell.exe', ['-NoProfile', '-Command', `Get-NetTCPConnection -State Listen -LocalPort ${API_PORT} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique | ForEach-Object { Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue }`], { windowsHide: true })
    child.on('exit', (code) => resolve(code === 0))
    child.on('error', () => resolve(false))
  })
}

function openAppWindow(browser) {
  fs.mkdirSync(PROFILE_DIR, { recursive: true })
  const args = [
    `--app=${URL}`,
    `--user-data-dir=${PROFILE_DIR}`,
    '--class=DevServerManager',
    '--no-first-run',
    '--no-default-browser-check',
    '--disable-features=Translate',
    '--window-size=1440,900',
  ]
  const child = spawn(browser, args, { detached: true, stdio: 'ignore', windowsHide: false })
  child.unref()
  return child.pid
}

async function main() {
  const kill = process.argv.includes('--kill')

  if (kill) {
    console.log('正在停止工作台后端…')
    await stopServer()
    console.log('已停止。')
    return
  }

  if (!fs.existsSync(DIST_INDEX)) {
    console.log('未检测到前端产物，请先运行一次：npm start （会自动构建）')
    process.exitCode = 1
    return
  }

  let started = false
  if (!(await health())) {
    console.log('启动工作台后端…')
    startServer()
    started = true
    if (!(await waitForServer())) {
      console.log(`后端未能启动，请查看日志：${SERVER_LOG}`)
      process.exitCode = 1
      return
    }
  }
  console.log(`工作台已就绪：${URL}${started ? '（后端为本次启动）' : '（复用在跑的后端）'}`)

  const browser = findBrowser()
  if (!browser) {
    console.log('未找到 Edge 或 Chrome，已用系统默认浏览器打开普通标签页。')
    spawn(process.platform === 'win32' ? 'cmd' : 'open', process.platform === 'win32' ? ['/c', 'start', '', URL] : [URL], { detached: true, stdio: 'ignore' }).unref()
    return
  }

  console.log(`以应用窗口模式打开：${path.basename(browser)}`)
  openAppWindow(browser)
  console.log('提示：关闭该窗口不会停止后端（它可能正在托管你启动的项目）。')
  console.log('      要彻底停止：npm run desktop -- --kill')
}

main().catch((error) => {
  console.error(`桌面端启动失败：${error.message}`)
  process.exitCode = 1
})
