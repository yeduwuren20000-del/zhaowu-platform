/**
 * 第一阶段回归测试：本地项目的启动 / 端口检测 / 停止 / 日志 / 删除。
 *   node server/test/project-lifecycle.test.mjs
 *
 * 用真实进程验证：事实来自系统（PID、监听表），不是读数据库里的记录。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(os.tmpdir(), `dsm-lifecycle-${Date.now()}`)
process.env.DSM_DATA_DIR = DATA_DIR
process.env.DSM_DISCOVERY_ON_STARTUP = '0'
// 「端口学习」场景要等满启动校验超时，测试里缩短到 6 秒（生产默认 20 秒）
process.env.DSM_START_VERIFY_TIMEOUT_MS = '6000'

const { projectsRepo } = await import('../src/store/projectsRepo.js')
const { runtimeRepo } = await import('../src/store/runtimeRepo.js')
const { startProject, stopProject, restartProject, openDirectory, deleteProject } = await import('../src/services/processManager.js')
const { buildProjectViews } = await import('../src/services/projectService.js')
const { portScanner } = await import('../src/services/portScanner.js')
const { logRepo } = await import('../src/store/logRepo.js')

const PORT = 5311
const ROOT = path.resolve(here, '..', '..')

let passed = 0
const failures = []

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
  console.log('\n[1] 创建项目记录')
  const project = await projectsRepo.create({
    name: '生命周期测试服务',
    type: 'Node',
    dir: ROOT,
    startCommand: `node server/test/fixture-server.mjs ${PORT}`,
    stopCommand: '',
    port: PORT,
    url: `http://localhost:${PORT}`,
    remark: '自动化测试',
  })
  check('记录已写入', Boolean(project.id))

  const before = (await buildProjectViews({ force: true })).find((item) => item.id === project.id)
  check('启动前状态为已停止', before.status === 'stopped', before.status)
  check('端口未被监听', !(await portScanner.isPortListening(PORT)))

  console.log('\n[2] 启动 + 真实端口/PID 检测')
  const started = await startProject(project)
  check('启动命令执行成功', started.running === true, started)
  check('端口已就绪', started.portReady === true, started.message)
  check('记录了真实 PID', Number.isInteger(started.pid) && started.pid > 0, started.pid)

  const running = (await buildProjectViews({ force: true })).find((item) => item.id === project.id)
  check('视图状态为运行中', running.status === 'running', { status: running.status, conflict: running.conflict })
  check('进程名来自系统', running.processName === 'node', running.processName)
  check('记录了内存占用', running.memory > 0, running.memory)
  check('记录了运行时长', running.uptimeMs >= 0, running.uptimeMs)
  check('跟踪的 PID 是启动器', running.runtime?.pid === started.pid, { runtime: running.runtime?.pid, started: started.pid })

  const owners = await portScanner.getPortOwners(PORT, { force: true })
  check('端口归属来自系统监听表', owners.length > 0 && Number(owners[0].pid) > 0, owners)
  check('视图里的 PID 就是监听进程', running.pid === Number(owners[0].pid), { view: running.pid, listener: owners[0].pid })
  check('监听进程是启动器拉起来的（父进程链包含启动器）', running.pid !== started.pid && running.processName === owners[0].processName, { listener: running.pid, launcher: started.pid })

  console.log('\n[3] 重启')
  const restarted = await restartProject(project)
  check('重启后端口重新就绪', restarted.started.portReady === true, restarted.started.message)
  check('重启换成了新进程', restarted.started.pid !== started.pid, { old: started.pid, new: restarted.started.pid })

  console.log('\n[4] 进程日志')
  const logFile = logRepo.projectFile(project.id)
  check('日志文件已创建', fs.existsSync(logFile))
  const lines = await logRepo.readProjectLog(project.id, 50)
  check('日志里有启动命令与监听输出', lines.some((line) => line.includes('fixture-server.mjs')) && lines.some((line) => /listening/i.test(line)), lines.slice(0, 3))

  console.log('\n[5] 停止 + 端口释放')
  const stopped = await stopProject(project)
  check('端口已释放', stopped.portReleased === true, stopped)
  check('结束了进程树', stopped.killed.length > 0, stopped.killed)
  const afterStop = (await buildProjectViews({ force: true })).find((item) => item.id === project.id)
  check('视图状态回到已停止', afterStop.status === 'stopped', afterStop.status)
  check('运行态记录已清理', afterStop.runtime === null, afterStop.runtime)

  console.log('\n[6] 删除运行中的项目：后端兜底先停再删')
  const again = await startProject(project)
  check('重新启动成功', again.portReady === true, again.message)
  const beforeDelete = (await buildProjectViews({ force: true })).find((item) => item.id === project.id)
  check('删除前项目在运行', beforeDelete.status === 'running', beforeDelete.status)
  const deleted = await deleteProject(project)
  check('删除返回 wasRunning=true', deleted.wasRunning === true)
  check('删除内部走了停止流程（端口已释放）', deleted.stopped?.portReleased === true, deleted.stopped)
  check('项目记录已删除', !(await projectsRepo.list()).some((item) => item.id === project.id))
  const orphanCheck = await portScanner.getPortOwners(PORT, { force: true })
  check('没有孤儿进程占用端口', orphanCheck.length === 0, orphanCheck)

  console.log('\n[7] 打开目录')
  const opened = await openDirectory(ROOT)
  check('打开目录不报错', opened.opened === ROOT, opened)

  console.log('\n[8] 端口自动避让：主端口被外部占用时换空闲端口（env 注入生效）')
  // 占用者优先用真实服务：本机 dify 的 nginx 占着 80；没占就自己起一个占 80 的 fixture
  const CONFLICT_PORT = 80
  let selfOccupier = null
  let occupierPid = null
  const owners80 = await portScanner.getPortOwners(CONFLICT_PORT, { force: true })
  if (owners80.length > 0) {
    occupierPid = owners80[0].pid
    console.log(`  （80 已被真实服务占用：PID ${occupierPid}，直接用它当占用者）`)
  } else {
    selfOccupier = await startProject({
      id: 'occupy-80-temp',
      name: '占位80',
      type: 'Node',
      dir: ROOT,
      startCommand: `node server/test/fixture-server.mjs ${CONFLICT_PORT}`,
      stopCommand: '',
      port: CONFLICT_PORT,
    })
    await sleep(1500)
    const owners = await portScanner.getPortOwners(CONFLICT_PORT, { force: true })
    occupierPid = owners[0]?.pid ?? null
    check('占位服务成功占用 80', Boolean(occupierPid), owners)
  }

  const shiftProject = await projectsRepo.create({
    name: '端口避让测试服务',
    type: 'Node',
    dir: ROOT,
    startCommand: 'node server/test/fixture-port-env.mjs',
    stopCommand: '',
    port: CONFLICT_PORT,
    portEnv: 'PORT',
  })
  const shiftResult = await startProject(shiftProject)
  check('发生避让：actualPort 不是被占的 80', shiftResult.actualPort !== CONFLICT_PORT, shiftResult.actualPort)
  check('避让到 80 之后的端口', shiftResult.actualPort > CONFLICT_PORT, shiftResult.actualPort)
  check('避让后端口真的就绪（env 注入生效）', shiftResult.portReady === true, shiftResult.message)
  check('返回了端口避让警告', typeof shiftResult.portWarning === 'string' && shiftResult.portWarning.includes('已自动改用'), shiftResult.portWarning)
  const shiftRuntime = await runtimeRepo.get(shiftProject.id)
  check('运行态记录的是实际端口', shiftRuntime?.port === shiftResult.actualPort, shiftRuntime)
  const shiftOwners = await portScanner.getPortOwners(shiftResult.actualPort, { force: true })
  check('实际端口上有我们的进程', shiftOwners.length > 0 && shiftOwners.every((o) => o.pid !== occupierPid), shiftOwners)
  const shiftLogs = await logRepo.readProjectLog(shiftProject.id, 50)
  // 项目日志里对应的是 spawnProject 写的「环境变量覆盖」行（env 真的注入了）；
  // 「已自动改用」那句在工作台事件日志里，已由 portWarning 断言覆盖
  check('项目日志记录了环境变量覆盖（避让落地到启动命令）', shiftLogs.some((line) => line.includes('环境变量覆盖') && line.includes('PORT')), shiftLogs.slice(-6))

  // 停止：必须按实际端口校验释放（避让后停错端口会假成功）
  const shiftStop = await stopProject(shiftProject)
  check('停止后实际端口已释放', shiftStop.portReleased === true, shiftStop)
  const stillThere = await portScanner.getPortOwners(shiftResult.actualPort, { force: true })
  check('实际端口上无残留', stillThere.length === 0, stillThere)

  // ---- 端口避让（命令行参数通道）：模拟 vite/next 这类 --port 型 dev server ----
  // 和上面的 portEnv 通道分开测：注入方式不同，落地位置也不同（命令文本 vs 环境变量）
  const argProject = await projectsRepo.create({
    name: '端口参数避让测试服务',
    type: '前端',
    dir: ROOT,
    startCommand: 'node server/test/fixture-port-arg.mjs',
    stopCommand: '',
    port: CONFLICT_PORT,
    portArg: '--port {port}',
  })
  const argResult = await startProject(argProject)
  check('命令行通道也发生避让', argResult.actualPort !== CONFLICT_PORT && argResult.actualPort > CONFLICT_PORT, argResult.actualPort)
  check('命令行通道避让后端口就绪', argResult.portReady === true, argResult.message)
  const argLogs = await logRepo.readProjectLog(argProject.id, 50)
  check(
    '启动命令里带上了新端口参数（真的注入了，不是日志吹的）',
    argLogs.some((line) => line.includes(`--port ${argResult.actualPort}`)),
    argLogs.slice(-6),
  )
  const argStop = await stopProject(argProject)
  check('命令行通道停止后端口释放', argStop.portReleased === true, argStop)
  await projectsRepo.remove(argProject.id)

  // ---- 端口学习：dev server 自己换端口（Vite 顺延）时不能判失败 ----
  // 找一对都空闲的端口：声明 base，fixture 故意监听 base+100
  let base = 5460
  for (let i = 0; i < 40; i += 1) {
    const [baseBusy, driftBusy] = await Promise.all([
      portScanner.isPortListening(base, { force: true }),
      portScanner.isPortListening(base + 100, { force: true }),
    ])
    if (!baseBusy && !driftBusy) break
    base += 1
  }
  const driftProject = await projectsRepo.create({
    name: '端口漂移测试服务',
    type: '前端',
    dir: ROOT,
    startCommand: `node server/test/fixture-port-drift.mjs --port ${base}`,
    stopCommand: '',
    port: base,
  })
  const driftResult = await startProject(driftProject)
  check('端口漂移被认出来（没误判成启动失败）', driftResult.portReady === true, driftResult.message)
  check('实际端口记成漂移后的端口', driftResult.actualPort === base + 100, { actual: driftResult.actualPort, base })
  check('运行态也更新为实际端口', (await runtimeRepo.get(driftProject.id))?.port === base + 100, await runtimeRepo.get(driftProject.id))
  const driftLogs = await logRepo.readProjectLog(driftProject.id, 40)
  check('日志说清了学到的端口', driftLogs.some((line) => line.includes(String(base + 100))), driftLogs.slice(-4))
  const driftStop = await stopProject(driftProject)
  check('漂移端口能正常停止并释放', driftStop.portReleased === true, driftStop)
  await projectsRepo.remove(driftProject.id)

  await projectsRepo.remove(shiftProject.id)
  if (selfOccupier) {
    await stopProject({ id: 'occupy-80-temp', name: '占位80', port: CONFLICT_PORT, stopCommand: '', dir: ROOT })
    await runtimeRepo.clear('occupy-80-temp')
  }
  check('占用者 80 仍在（没被误伤）', (await portScanner.getPortOwners(CONFLICT_PORT, { force: true })).length > 0)
} finally {
  // 兜底：确保测试进程被清理
  try {
    await stopProject({ id: 'cleanup', name: 'cleanup', port: PORT, stopCommand: '', dir: ROOT })
  } catch {
    /* 忽略 */
  }
  await sleep(200)
  fs.rmSync(DATA_DIR, { recursive: true, force: true })
}

console.log(`\n结果：通过 ${passed} 项，失败 ${failures.length} 项`)
if (failures.length > 0) {
  console.log(JSON.stringify(failures, null, 2))
  process.exitCode = 1
}
