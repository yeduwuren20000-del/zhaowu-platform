import fs from 'node:fs'
import path from 'node:path'
import { log, npmCommand, onExit, ROOT, run } from './lib/run.mjs'

/**
 * 开发模式：同时启动后端 API（8787）与 Vite 开发服务器（5180，带热更新与 /api 代理）。
 * 用法：npm run dev 或 dev.bat
 */

const SERVER_DIR = path.join(ROOT, 'server')
const WEB_DIR = path.join(ROOT, 'web')

function ensureInstalled(dir, label) {
  const marker = path.join(dir, 'node_modules')
  if (fs.existsSync(marker)) return null
  log('sys', `${label} 依赖未安装，正在执行 npm install …`)
  return new Promise((resolve, reject) => {
    const child = run('sys', npmCommand(), ['install', '--no-fund', '--no-audit'], { cwd: dir })
    child.on('exit', (code) => (code === 0 ? resolve() : reject(new Error(`${label} 依赖安装失败（退出码 ${code}）`))))
  })
}

async function main() {
  await ensureInstalled(SERVER_DIR, '后端')
  await ensureInstalled(WEB_DIR, '前端')

  log('sys', '启动后端 API：http://127.0.0.1:8787')
  const api = run('api', process.execPath, [path.join(SERVER_DIR, 'src', 'index.js')], { cwd: ROOT })

  log('sys', '启动前端开发服务器：http://localhost:5180')
  const web = run('web', npmCommand(), ['run', 'dev'], { cwd: WEB_DIR })

  log('sys', '开发地址 http://localhost:5180 （API 代理到 8787，Ctrl+C 退出）')

  const shutdown = () => {
    for (const child of [api, web]) {
      if (child && !child.killed) child.kill()
    }
    process.exit(0)
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)

  onExit(api, (code) => {
    if (code !== 0) log('sys', `后端退出（退出码 ${code}），同时停止前端`)
    shutdown()
  })
  onExit(web, (code) => {
    if (code !== 0) log('sys', `前端退出（退出码 ${code}），同时停止后端`)
    shutdown()
  })
}

main().catch((error) => {
  console.error(`\n启动失败：${error.message}\n`)
  process.exit(1)
})
