/**
 * 启动失败诊断单元测试（纯函数 + 日志 fixture，不启动任何真实进程）：
 *   node server/test/start-diagnosis.test.mjs
 *
 * 覆盖：
 *   - 每条匹配器：依赖缺失 / 脚本不存在 / 端口占用 / Python 异常 / 权限 / 环境变量 / 命令找不到
 *   - 兜底：秒退无线索（exited-silently）/ 在跑但端口未就绪（slow-start）
 *   - 启动成功不诊断（返回 null）
 *   - install 命令按 lockfile 推断
 *   - advice 的 action 形状是前端认得的（copy/navigate）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { diagnoseStartFailure, guessInstallCommand } from '../src/services/startDiagnosis.js'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsm-diag-'))
// PROJECT.dir 指向 TMP：放一个 requirements.txt，让「Python 缺模块」用例能拿到 pip 命令
fs.writeFileSync(path.join(TMP, 'requirements.txt'), 'django\n')

let passed = 0
const failures = []

function check(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failures.push({ name, detail })
    console.log(`  ✗ ${name}${detail !== undefined ? ' -> ' + JSON.stringify(detail) : ''}`)
  }
}

const PROJECT = { id: 'p1', dir: TMP, port: 5199, startCommand: 'npm run dev', name: 'demo' }
const dead = (log) => ({ running: false, portReady: false, log })

console.log('【启动成功不诊断】')
{
  const r = diagnoseStartFailure({ project: PROJECT, verify: { running: true, portReady: true, log: [] } })
  check('running + portReady 返回 null', r === null, r)
}

console.log('【依赖缺失】')
{
  const log = [
    '[launcher] 启动命令：npm run dev',
    '[launcher] 工作目录：D:\\demo',
    '[launcher] 子进程 PID=12345',
    "> demo@1.0.0 dev",
    '> vite',
    '',
    'sh: line 1: vite: command not found',
    'npm ERR! code ELIFECYCLE',
  ]
  const r = diagnoseStartFailure({ project: PROJECT, verify: dead(log) })
  check('原因识别为依赖缺失', r.cause === 'deps-missing', r.cause)
  check('标题说人话', r.title === '依赖还没安装', r.title)
  check('evidence 是命中那一行', r.evidence.includes('command not found'), r.evidence)
  check('日志尾部被带回', r.logTail.length === 4 && r.logTail[0].includes('vite'), r.logTail)
  check('建议带安装命令（可复制）', r.advice[0].action?.kind === 'copy' && r.advice[0].action.value.length > 0, r.advice[0])
  check('摘要说明推断依据', /lockfile|npm|requirements/i.test(r.summary), r.summary)
}

console.log('【依赖缺失：Node ESM 找不到模块】')
{
  const log = ['node:internal/modules/esm/loader:123', "Error: Cannot find module 'D:\\demo\\src\\main.ts'", 'npm ERR! code 1']
  const r = diagnoseStartFailure({ project: PROJECT, verify: dead(log) })
  check('Cannot find module 命中', r.cause === 'deps-missing', r.cause)
}

console.log('【npm 脚本名不存在】')
{
  const log = ['npm ERR! Missing script: "dev"', 'npm ERR! A complete log of this run can be found in:']
  const r = diagnoseStartFailure({ project: PROJECT, verify: dead(log) })
  check('原因识别为脚本缺失', r.cause === 'script-missing', r.cause)
  check('摘要点名了缺失的脚本名', r.summary.includes('dev'), r.summary)
  check('建议跳转到编辑表单', r.advice[0].action?.kind === 'navigate' && r.advice[0].action.state?.edit === 'p1', r.advice[0])
}

console.log('【端口被占用】')
{
  const log = ['vite v5.4.0  dev server running at:', 'Error: listen EADDRINUSE: address already in use :::5199', 'npm ERR! code 1']
  const owners = [{ pid: 8888, processName: 'node.exe' }]
  const r = diagnoseStartFailure({ project: PROJECT, verify: dead(log), portOwners: owners })
  check('原因识别为端口占用', r.cause === 'port-in-use', r.cause)
  check('建议里带占用者 PID 与进程名', r.advice[0].text.includes('8888') && r.advice[0].text.includes('node.exe'), r.advice[0])
  check('建议跳转端口页', r.advice[0].action?.to === '/ports', r.advice[0])
  check('也给了换端口的路', r.advice.some((a) => a.text.includes('换成一个没人用的')), r.advice)
}

console.log('【端口被占用：没有扫到占用者】')
{
  const log = ['Error: listen EADDRINUSE: address already in use :::5199']
  const r = diagnoseStartFailure({ project: PROJECT, verify: dead(log), portOwners: [] })
  check('无占用者时也不崩，仍给端口页入口', r.cause === 'port-in-use' && r.advice[0].action?.to === '/ports', r.advice[0])
}

console.log('【Python 异常】')
{
  const log = [
    'Traceback (most recent call last):',
    '  File "app.py", line 42, in <module>',
    '    raise RuntimeError("port must be int")',
    'RuntimeError: port must be int',
  ]
  const r = diagnoseStartFailure({ project: PROJECT, verify: dead(log) })
  check('原因识别为 Python 异常', r.cause === 'python-error', r.cause)
  check('建议跳转日志页并带上项目', r.advice[0].action?.to === '/logs' && r.advice[0].action.state?.source === 'project:p1', r.advice[0])
}

console.log('【Python 缺模块：归依赖缺失（给安装命令比「看报错」更可执行）】')
{
  const log = [
    'Traceback (most recent call last):',
    '  File "manage.py", line 22, in <module>',
    "ModuleNotFoundError: No module named 'django'",
  ]
  const r = diagnoseStartFailure({ project: PROJECT, verify: dead(log) })
  check('No module named 归为依赖缺失', r.cause === 'deps-missing', r.cause)
  check('建议给 pip 安装命令', r.advice[0].action?.kind === 'copy' && r.advice[0].action.value.includes('pip install'), r.advice[0])
}

console.log('【权限不足】')
{
  const log = ['Error: listen EACCES: permission denied 0.0.0.0:80']
  const r = diagnoseStartFailure({ project: PROJECT, verify: dead(log) })
  check('原因识别为权限', r.cause === 'permission', r.cause)
  check('建议提管理员运行', r.advice[0].text.includes('管理员'), r.advice[0])
}

console.log('【环境变量缺失】')
{
  const log = ['Error: Environment variable DATABASE_URL is not defined']
  const r = diagnoseStartFailure({ project: PROJECT, verify: dead(log) })
  check('原因识别为环境变量', r.cause === 'env-missing', r.cause)
}

console.log('【命令找不到（Windows 中文报错）】')
{
  const log = ["'pnpm' 不是内部或外部命令，也不是可运行的程序或批处理文件。"]
  const r = diagnoseStartFailure({ project: PROJECT, verify: dead(log) })
  check('中文报错命中', r.cause === 'command-not-found', r.cause)
  check('建议含拼写检查', r.advice.some((a) => a.text.includes('拼写')), r.advice)
  check('建议含环境体检入口', r.advice.some((a) => a.action?.to === '/dashboard'), r.advice)
}

console.log('【命令找不到（英文报错）】')
{
  const log = ["'npx' is not recognized as an internal or external command,"]
  const r = diagnoseStartFailure({ project: PROJECT, verify: dead(log) })
  check('英文报错命中', r.cause === 'command-not-found', r.cause)
}

console.log('【秒退但无线索：兜底】')
{
  const log = ['[launcher] 启动命令：./server', '[launcher] 子进程 PID=999', '[launcher] 进程退出：code=1 signal=null']
  const r = diagnoseStartFailure({ project: PROJECT, verify: dead(log) })
  check('兜底原因', r.cause === 'exited-silently', r.cause)
  check('兜底也带日志尾部', r.logTail.length === 3, r.logTail)
  check('兜底建议手动复现（带命令）', r.advice.some((a) => a.action?.kind === 'copy' && a.action.value === 'npm run dev'), r.advice)
  check('兜底 evidence 不瞎编：没有命中就留空或顶一行', r.evidence === null || typeof r.evidence === 'string', r.evidence)
}

console.log('【进程在跑但端口未就绪：slow-start】')
{
  const log = ['[launcher] 子进程 PID=1234', 'ready started server on 0.0.0.0:4000, url: http://localhost:4000']
  const r = diagnoseStartFailure({ project: PROJECT, verify: { running: true, portReady: false, log } })
  check('原因识别为编译中', r.cause === 'slow-start', r.cause)
  check('标题不是「失败」口吻', r.title.includes('还没监听'), r.title)
}

console.log('【install 命令推断】')
{
  const npmDir = path.join(TMP, 'npm-proj')
  fs.mkdirSync(npmDir, { recursive: true })
  fs.writeFileSync(path.join(npmDir, 'package-lock.json'), '{}')
  check('package-lock → npm install', guessInstallCommand(npmDir).command === 'npm install', guessInstallCommand(npmDir))

  const pnpmDir = path.join(TMP, 'pnpm-proj')
  fs.mkdirSync(pnpmDir, { recursive: true })
  fs.writeFileSync(path.join(pnpmDir, 'pnpm-lock.yaml'), '')
  check('pnpm-lock → pnpm install', guessInstallCommand(pnpmDir).command === 'pnpm install', guessInstallCommand(pnpmDir))

  const pyDir = path.join(TMP, 'py-proj')
  fs.mkdirSync(pyDir, { recursive: true })
  fs.writeFileSync(path.join(pyDir, 'requirements.txt'), 'flask')
  check('requirements.txt → pip install -r', guessInstallCommand(pyDir).command === 'pip install -r requirements.txt', guessInstallCommand(pyDir))

  check('空目录给默认值并说明', guessInstallCommand(path.join(TMP, 'not-exist')).command === 'npm install', guessInstallCommand(path.join(TMP, 'not-exist')))
}

console.log('【匹配优先级：具体原因压过笼统原因】')
{
  // 同时含 EADDRINUSE 和 command not found：端口占用更具体，应胜出
  const log = ["'vite' 不是内部或外部命令", 'Error: listen EADDRINUSE: address already in use :::5199']
  const r = diagnoseStartFailure({ project: PROJECT, verify: dead(log) })
  check('EADDRINUSE 压过命令找不到', r.cause === 'port-in-use', r.cause)
}

console.log('')
console.log(`结果：通过 ${passed} 项，失败 ${failures.length} 项`)
if (failures.length > 0) {
  console.log(JSON.stringify(failures, null, 2))
  process.exit(1)
}
fs.rmSync(TMP, { recursive: true, force: true })
