import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import { spawn } from 'node:child_process'
import { ROOT } from './lib/run.mjs'

/**
 * 桌面端封装：优先用 Electron 拉起工作台（无白闪），没装 Electron 时退回系统浏览器的 app 模式。
 *
 *   node scripts/desktop.mjs            # 确保后端在跑 + 打开无白闪窗口（Electron）或独立应用窗口
 *   node scripts/desktop.mjs --kill      # 顺带停掉后端再退出
 *
 * 后端仍然是一个独立的 Node 进程：工作台后端只监听 127.0.0.1、且重度依赖 Node 原生能力
 * （PowerShell、SSH、子进程），所以不在 Electron 渲染进程里跑后端，而是主进程把它 spawn 出来，
 * 只让 Electron 当「深色无白闪的窗口壳」。详见 electron/main.cjs。
 *
 * 退回浏览器 app 模式时（未装 Electron）使用独立 user-data-dir（data/.desktop-profile）：
 * 不污染你日常浏览器，也不被它的扩展/登录态干扰。
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

  // 装了 Electron 就优先用它拉起（无白闪）；没装才退回下面的浏览器 app 模式
  const electronMain = path.join(ROOT, 'electron', 'main.cjs')
  const hasElectron = fs.existsSync(path.join(ROOT, 'node_modules', 'electron'))
  if (hasElectron && fs.existsSync(electronMain)) {
    const args = ['run', 'electron', '--', ...(kill ? ['--kill'] : [])]
    const npmBin = process.platform === 'win32' ? 'npm.cmd' : 'npm'
    const child = spawn(npmBin, args, { cwd: ROOT, stdio: 'inherit', windowsHide: false })
    child.on('exit', (code) => process.exit(code ?? 0))
    return
  }

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
