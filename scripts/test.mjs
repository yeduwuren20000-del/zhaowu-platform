/**
 * 全量测试入口：按文件名顺序跑 server/test/*.test.mjs，汇总断言数。
 *
 *   npm test                 # 全部
 *   npm test -- events       # 只跑文件名含 events 的
 *
 * 零依赖、跨平台；任何一份失败都以退出码 1 结束（CI 用同一条命令）。
 */
import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { ROOT, log } from './lib/run.mjs'

const TEST_DIR = path.join(ROOT, 'server', 'test')
const filter = process.argv[2]

const files = fs
  .readdirSync(TEST_DIR)
  .filter((name) => name.endsWith('.test.mjs'))
  .filter((name) => !filter || name.includes(filter))
  .sort()

if (files.length === 0) {
  log('sys', `没有找到测试文件（目录：${TEST_DIR}）`)
  process.exit(1)
}

/** 每个测试脚本自己会打印「结果：通过 N 项，失败 M 项」，这里顺带汇总 */
function runOne(file) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [path.join(TEST_DIR, file)], {
      stdio: ['ignore', 'pipe', 'inherit'],
      cwd: ROOT,
    })
    let passed = 0
    let failed = 0
    let tail = ''
    child.stdout.on('data', (chunk) => {
      const text = chunk.toString()
      process.stdout.write(text)
      tail = (tail + text).slice(-4000)
      const match = /结果：通过 (\d+) 项，失败 (\d+) 项/.exec(tail)
      if (match) {
        passed = Number(match[1])
        failed = Number(match[2])
        tail = ''
      }
    })
    child.on('exit', (code) => resolve({ file, code, passed, failed }))
  })
}

const results = []
for (const file of files) {
  log('sys', `▶ ${file}`)
  results.push(await runOne(file))
}

const totalPassed = results.reduce((sum, item) => sum + item.passed, 0)
const totalFailed = results.reduce((sum, item) => sum + item.failed, 0)
const broken = results.filter((item) => item.code !== 0)

console.log('')
log('sys', '──────── 测试汇总 ────────')
for (const item of results) {
  const mark = item.code === 0 && item.failed === 0 ? '✓' : '✗'
  log('sys', `${mark} ${item.file.padEnd(30)} 通过 ${item.passed} 项，失败 ${item.failed} 项`)
}
log('sys', `合计：通过 ${totalPassed} 项，失败 ${totalFailed} 项，脚本 ${results.length - broken.length}/${results.length} 正常退出`)

process.exitCode = broken.length > 0 || totalFailed > 0 ? 1 : 0
