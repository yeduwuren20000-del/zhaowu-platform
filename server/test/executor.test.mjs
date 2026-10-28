/**
 * 本地命令执行器测试（真实进程 + 真实日志文件）：
 *   node server/test/executor.test.mjs
 *
 * 覆盖：捕获 stdout/stderr、中文编码、非零退出码、参数引号、超时杀树、
 *       ENOENT 翻译、detached 服务日志捕获（Windows 关键坑）、killTree、toArgv、错误描述。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { run, runQuiet, spawnService, killTree, normalizeError, describeError, toArgv, isWindows } from '../src/utils/executor.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsm-executor-'))

let passed = 0
const failures = []
const children = []

function check(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failures.push({ name, detail })
    console.log(`  ✗ ${name}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`)
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

try {
  console.log('\n[1] 捕获 stdout / stderr / 退出码')
  const r1 = await run(`node -e "console.log('hello'); console.error('boom'); process.exit(0)"`)
  check('成功：ok=true，code=0', r1.ok === true && r1.code === 0, r1)
  check('捕获到 stdout', r1.stdout.includes('hello'), r1.stdout)
  check('捕获到 stderr', r1.stderr.includes('boom'), r1.stderr)
  check('有 PID 与耗时', Number.isInteger(r1.pid) && r1.durationMs >= 0)

  console.log('\n[2] 中文输出不被乱码')
  const r2 = await run(`node -e "console.log('你好，工作台')"`)
  check('中文 stdout 完整保留', r2.stdout.includes('你好，工作台'), JSON.stringify(r2.stdout))

  console.log('\n[3] 非零退出码')
  const r3 = await run(`node -e "process.exit(7)"`)
  check('ok=false 且 code=7', r3.ok === false && r3.code === 7, r3)

  console.log('\n[4] 参数含空格（shell=false 精确传递，不被 shell 拆开）')
  const r4 = await run('node', { shell: false, args: ['-e', 'console.log(JSON.stringify(process.argv.slice(1)))', 'hello world', 'arg two'] })
  const argv4 = JSON.parse(r4.stdout.trim())
  check('含空格的参数是一个整体（不拆开）', Array.isArray(argv4) && argv4.length === 2 && argv4[0] === 'hello world' && argv4[1] === 'arg two', r4.stdout)

  console.log('\n[5] 超时杀进程树')
  const r5 = await run(`node -e "setInterval(() => {}, 1000)"`, { timeout: 700 })
  check('标记 timedOut', r5.timedOut === true, r5)
  check('给出中文超时错误', r5.error?.code === 'ETIMEDOUT' && /超时|超过/.test(r5.error.message), r5.error)

  console.log('\n[6] ENOENT 翻译（shell 报"命令不存在"也要识别）')
  const r6 = await run('definitely-not-a-real-command-xyz', { shell: true })
  check('失败且 error 存在', r6.ok === false && r6.error != null, r6)
  check('识别为 ENOENT（命令未找到）', r6.error?.code === 'ENOENT', r6.error)
  check('describeError 给出中文提示', /找不到|不存在/.test(describeError(r6.error)), describeError(r6.error))

  console.log('\n[7] detached 服务：日志捕获 + 存活 + killTree')
  const logFile = path.join(TMP, 'svc.log')
  const started = await spawnService(`node "${path.join(here, 'fixture-server.mjs')}" 5491`, { logFile, note: '测试' })
  check('spawnService 成功返回 PID', started.ok === true && Number.isInteger(started.pid), started)
  await sleep(1200)

  // 服务端口起来了，说明命令真的在跑
  let listening = false
  try {
    const resp = await fetch('http://127.0.0.1:5491/')
    listening = resp.ok
  } catch {
    listening = false
  }
  check('服务真的在监听', listening)

  const logText = fs.readFileSync(logFile, 'utf8')
  check('日志里有子进程真实输出（listening）', /listening/.test(logText), logText.split('\n').slice(0, 6))
  check('日志里有启动头与 PID', /\$ node/.test(logText) && /子进程 PID=/.test(logText), logText.split('\n').slice(0, 5))

  const killed = await killTree(started.pid)
  check('killTree 成功', killed.killed === true, killed)
  await sleep(600)
  let stillListening = true
  try {
    await fetch('http://127.0.0.1:5491/')
  } catch {
    stillListening = false
  }
  check('进程树已被真正结束', stillListening === false)

  console.log('\n[8] spawnService 缺命令')
  const r8 = await spawnService('')
  check('缺命令返回错误', r8.ok === false && r8.error?.code === 'NO_COMMAND', r8)

  console.log('\n[9] toArgv / 参数解析')
  check('拆分空白', JSON.stringify(toArgv('node -v')) === JSON.stringify(['node', '-v']))
  check('保留引号内空格', JSON.stringify(toArgv('echo "a b" c')) === JSON.stringify(['echo', 'a b', 'c']), toArgv('echo "a b" c'))
  check('数组原样返回', JSON.stringify(toArgv(['a', 'b'])) === JSON.stringify(['a', 'b']))

  console.log('\n[10] 错误描述')
  const e1 = Object.assign(new Error('spawn bash ENOENT'), { code: 'ENOENT' })
  check('ENOENT -> 中文提示', /找不到|不存在/.test(describeError(e1)), describeError(e1))
  check('未知错误不抛', typeof describeError(null) === 'string')
  check('normalizeError 保留 code', normalizeError(e1).code === 'ENOENT')

  console.log(`\n平台：${isWindows() ? 'Windows' : '其它'}（detached 日志捕获路径${isWindows() ? '' : '在非 Windows 上仍适用'}）`)
} finally {
  for (const child of children) {
    try {
      child.kill()
    } catch {
      /* 忽略 */
    }
  }
  try {
    fs.rmSync(TMP, { recursive: true, force: true })
  } catch {
    /* 忽略 */
  }
}

console.log(`\n结果：通过 ${passed} 项，失败 ${failures.length} 项`)
if (failures.length > 0) {
  console.log(JSON.stringify(failures, null, 2))
  process.exitCode = 1
}
