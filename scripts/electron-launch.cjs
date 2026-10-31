'use strict'

/**
 * Electron 桌面壳启动器（防御 ELECTRON_RUN_AS_NODE 退化）。
 *
 * 背景（这是「打不开工作台」的真正元凶）：
 *   某些环境 / 别的 Electron 应用会把 `ELECTRON_RUN_AS_NODE=1` 写进
 *   系统或用户环境变量。只要这个变量「存在」（哪怕是空串），electron 二进制
 *   就会退化成纯 Node 去加载 main.cjs —— 于是 `require('electron')` 拿不到
 *   `app`，main.cjs 第一行 `app.setAppUserModelId` 直接抛
 *   "Cannot read properties of undefined"，窗口永远不出现，且崩在写日志之前，
 *   表现就是「双击没反应 / 打不开」。
 *
 * 这里的唯一职责：在 spawn 真正的 electron 之前，把该变量从子进程环境里彻底删除，
 * 强制 electron 走正常运行时。其余逻辑（拉后端、建窗口、深色无白闪）都在
 * electron/main.cjs 里，本文件不重复实现。
 */

const { spawn } = require('node:child_process')
const path = require('node:path')
const { createRequire } = require('node:module')

const require2 = createRequire(__filename)
const electronPkg = require2.resolve('electron/package.json')
const electronDir = path.dirname(electronPkg)

const exeName =
  process.platform === 'win32'
    ? 'electron.exe'
    : process.platform === 'darwin'
      ? 'Electron.app/Contents/MacOS/Electron'
      : 'electron'
const bin = path.join(electronDir, 'dist', exeName)

const ROOT = path.resolve(__dirname, '..')
const mainCjs = path.join(ROOT, 'electron', 'main.cjs')

const args = [mainCjs, ...process.argv.slice(2)]

// 关键：删除会让 electron 退化成 Node 的变量。
const env = { ...process.env }
const hadRunAsNode = 'ELECTRON_RUN_AS_NODE' in env
delete env.ELECTRON_RUN_AS_NODE

if (hadRunAsNode) {
  // 仅作诊断提示；控制台在 vbs 隐藏模式下看不到，但写进 boot 日志便于排障。
  try {
    const fs = require('node:fs')
    const bootLog = path.join(ROOT, 'data', 'logs', 'electron-boot.log')
    fs.mkdirSync(path.dirname(bootLog), { recursive: true })
    fs.appendFileSync(
      bootLog,
      `[${new Date().toISOString()}] launcher: 检测到 ELECTRON_RUN_AS_NODE，已删除后再启动 electron（否则会退化成 Node 导致打不开）\n`,
    )
  } catch {
    /* 日志失败不阻断 */
  }
}

const child = spawn(bin, args, {
  cwd: ROOT,
  env,
  windowsHide: false,
  stdio: 'inherit',
})
child.on('error', (error) => {
  console.error(`启动 electron 失败：${error.message}`)
  process.exitCode = 1
})
child.on('exit', (code) => process.exit(code ?? 0))
