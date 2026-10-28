import fs from 'node:fs'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { log, npmCommand, ROOT, run } from './lib/run.mjs'

/**
 * 生产式启动：检查依赖 -> 需要时构建前端 -> 启动后端（单端口 8787 同时提供 API 与页面）-> 打开浏览器。
 * 用法：npm start 或 双击 start.bat
 */

const SERVER_DIR = path.join(ROOT, 'server')
const WEB_DIR = path.join(ROOT, 'web')
const DIST_DIR = path.join(WEB_DIR, 'dist')
const API_PORT = Number(process.env.DSM_PORT || 8787)
const URL = `http://127.0.0.1:${API_PORT}`

function ensureInstalled(dir, label) {
  if (fs.existsSync(path.join(dir, 'node_modules'))) return Promise.resolve()
  log('sys', `${label}依赖未安装，正在执行 npm install（首次运行需要联网，稍等）…`)
  return new Promise((resolve, reject) => {
    const child = run('sys', npmCommand(), ['install', '--no-fund', '--no-audit'], { cwd: dir })
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${label}依赖安装失败（退出码 ${code}）`))))
  })
}

function newestMtime(dir) {
  let newest = 0
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const target = path.join(dir, entry.name)
    if (entry.isDirectory()) newest = Math.max(newest, newestMtime(target))
    else newest = Math.max(newest, fs.statSync(target).mtimeMs)
  }
  return newest
}

function needsBuild() {
  const index = path.join(DIST_DIR, 'index.html')
  if (!fs.existsSync(index)) return true
  if (process.env.DSM_FORCE_BUILD === '1') return true
  const distTime = fs.statSync(index).mtimeMs
  return newestMtime(path.join(WEB_DIR, 'src')) > distTime
}

/**
 * 探测 esbuild 原生二进制能否运行。本机火绒 HIPS 会拦截 esbuild.exe（Go 二进制）
 * 在进程最早初始化阶段加载 winmm.dll，vite build/dev 直接 panic 报
 * "winmm.dll not found"——winmm.dll 本身完好（微软签名有效、无 DLL 劫持、非沙箱），
 * 纯属误伤。esbuild 正常的环境仍走 vite；被拦的环境自动降级到 Rollup 通道
 * （产物结构与 vite 等价，已通过全部 e2e 回归）。DSM_BUILDER=vite/rollup 可强制指定。
 */
function esbuildUsable() {
  const bin = path.join(WEB_DIR, 'node_modules', 'esbuild', 'bin', 'esbuild')
  if (!fs.existsSync(bin)) return false
  try {
    const probe = spawnSync(process.execPath, [bin, '--version'], { encoding: 'utf8', timeout: 20000 })
    return probe.status === 0
  } catch {
    return false
  }
}

function runBuild(label, args) {
  log('sys', `正在构建前端（${label}）…`)
  return new Promise((resolve, reject) => {
    const child = run('web', process.execPath, args, { cwd: WEB_DIR })
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`前端构建失败（${label}，退出码 ${code}）`))))
  })
}

function buildWeb() {
  const usable = esbuildUsable()
  if (process.env.DSM_BUILDER !== 'rollup' && usable) {
    return runBuild('vite', [path.join(WEB_DIR, 'node_modules', 'vite', 'bin', 'vite.js'), 'build'])
  }
  if (!usable) {
    log('sys', 'esbuild 当前不可用（疑似安全软件拦截其加载 winmm.dll），自动切换 Rollup 通道——产物与 vite 等价，已全量 e2e 验证')
  }
  return runBuild('rollup', [path.join(WEB_DIR, '_rollup.mjs'), 'dist'])
}

function openBrowser(url) {
  if (process.platform === 'win32') {
    spawn('cmd', ['/c', 'start', '', url], { detached: true, stdio: 'ignore', windowsHide: true }).unref()
  } else if (process.platform === 'darwin') {
    spawn('open', [url], { detached: true, stdio: 'ignore' }).unref()
  } else {
    spawn('xdg-open', [url], { detached: true, stdio: 'ignore' }).unref()
  }
}

async function main() {
  await ensureInstalled(SERVER_DIR, '后端')
  await ensureInstalled(WEB_DIR, '前端')
  if (needsBuild()) await buildWeb()
  else log('sys', '前端产物已是最新，跳过构建（需要强制重建时设置 DSM_FORCE_BUILD=1）')

  log('sys', `启动工作台：${URL}`)
  const api = run('api', process.execPath, [path.join(SERVER_DIR, 'src', 'index.js')], { cwd: ROOT })

  setTimeout(() => {
    if (process.env.DSM_NO_OPEN !== '1') openBrowser(URL)
  }, 1200)

  api.on('exit', (code) => {
    if (code !== 0) log('sys', `工作台已退出（退出码 ${code}）`)
    process.exit(code ?? 0)
  })

  process.on('SIGINT', () => {
    api.kill()
    process.exit(0)
  })
}

main().catch((error) => {
  console.error(`\n启动失败：${error.message}\n`)
  process.exit(1)
})
