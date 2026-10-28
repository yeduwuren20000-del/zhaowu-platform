/**
 * 项目聚合端到端测试（真实进程 + 真实监听表）：
 *   node server/test/grouping-e2e.test.mjs
 *
 * 覆盖：
 *   - 同目录两个进程、同进程两个端口、前后端两个进程 -> 聚合成一个项目组
 *   - 不同目录 -> 不同项目组；无项目标记目录 -> 独立（loose）分组
 *   - 登记整个项目组 -> 只创建一个项目，其余服务成为子服务
 *   - 已登记项目下出现新的同目录端口 -> 标记为"发现新的子服务" -> 关联为子服务
 *   - 事实字段（PID/端口/命令行）在聚合与关联后保持不变
 *   - 忽略新的子服务后不再出现在待登记列表
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(os.tmpdir(), `dsm-grouping-e2e-${Date.now()}`)
fs.mkdirSync(DATA_DIR, { recursive: true })
process.env.DSM_DATA_DIR = DATA_DIR
process.env.DSM_DISCOVERY_ON_STARTUP = '0'

const { scanLocalServices, getProjectGroups, registerGroup, registerGroups, associateCandidate, ignoreCandidates } = await import('../src/services/localDiscoveryService.js')
const { projectsRepo } = await import('../src/store/projectsRepo.js')

const MAIN_DIR = path.join(DATA_DIR, 'fullstack-app')
const OTHER_DIR = path.join(DATA_DIR, 'other-app')
const BARE_DIR = path.join(DATA_DIR, 'bare-service')
const BATCH_A_DIR = path.join(DATA_DIR, 'batch-alpha')
const BATCH_B_DIR = path.join(DATA_DIR, 'batch-beta')

const P_FRONT_A = 5431
const P_FRONT_B = 5432
const P_API = 5433
const P_OTHER = 5434
const P_BARE = 5435
const P_NEW = 5436
const P_BATCH_A = 5437
const P_BATCH_B = 5438
const P_BATCH_B2 = 5439

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

async function waitForPorts(ports, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    let all = true
    for (const port of ports) {
      try {
        const response = await fetch(`http://127.0.0.1:${port}/`)
        if (!response.ok) all = false
      } catch {
        all = false
      }
    }
    if (all) return true
    if (Date.now() > deadline) return false
    await sleep(250)
  }
}

function startFixture(scriptPath, ports, cwd) {
  const child = spawn(process.execPath, [scriptPath, ...ports.map(String)], { cwd, stdio: 'ignore', windowsHide: true })
  children.push(child)
  return child
}

// ---- 准备目录：主项目（有 package.json）+ 另一个项目 + 无标记目录 ----
fs.mkdirSync(path.join(MAIN_DIR, 'server'), { recursive: true })
fs.writeFileSync(
  path.join(MAIN_DIR, 'package.json'),
  JSON.stringify({ name: 'fullstack-app', scripts: { dev: 'vite' }, devDependencies: { vite: '^5.0.0', react: '^18.0.0' } }, null, 2),
  'utf8',
)
fs.copyFileSync(path.join(here, 'fixture-server.mjs'), path.join(MAIN_DIR, 'fixture-server.mjs'))
fs.mkdirSync(OTHER_DIR, { recursive: true })
fs.writeFileSync(path.join(OTHER_DIR, 'pyproject.toml'), '[project]\nname = "other-app"\ndependencies = ["fastapi"]\n', 'utf8')
fs.copyFileSync(path.join(here, 'fixture-server.mjs'), path.join(OTHER_DIR, 'fixture-server.mjs'))
fs.mkdirSync(BARE_DIR, { recursive: true })
fs.copyFileSync(path.join(here, 'fixture-server.mjs'), path.join(BARE_DIR, 'fixture-server.mjs'))
fs.mkdirSync(BATCH_A_DIR, { recursive: true })
fs.writeFileSync(path.join(BATCH_A_DIR, 'package.json'), JSON.stringify({ name: 'batch-alpha' }, null, 2), 'utf8')
fs.copyFileSync(path.join(here, 'fixture-server.mjs'), path.join(BATCH_A_DIR, 'fixture-server.mjs'))
fs.mkdirSync(BATCH_B_DIR, { recursive: true })
fs.writeFileSync(path.join(BATCH_B_DIR, 'package.json'), JSON.stringify({ name: 'batch-beta' }, null, 2), 'utf8')
fs.copyFileSync(path.join(here, 'fixture-server.mjs'), path.join(BATCH_B_DIR, 'fixture-server.mjs'))

try {
  // 主目录：一个进程监听两个端口（前端 + 调试端口），另一个进程是后端
  const frontChild = startFixture(path.join(MAIN_DIR, 'fixture-server.mjs'), [P_FRONT_A, P_FRONT_B], MAIN_DIR)
  const apiChild = startFixture(path.join(MAIN_DIR, 'fixture-server.mjs'), [P_API], path.join(MAIN_DIR, 'server'))
  const otherChild = startFixture(path.join(OTHER_DIR, 'fixture-server.mjs'), [P_OTHER], OTHER_DIR)
  const bareChild = startFixture(path.join(BARE_DIR, 'fixture-server.mjs'), [P_BARE], BARE_DIR)
  check('四个被测服务已启动', await waitForPorts([P_FRONT_A, P_FRONT_B, P_API, P_OTHER, P_BARE]))

  console.log('\n[1] 按目录聚合')
  const scan = await scanLocalServices({ includeAi: false })
  const groups = scan.groups
  const mainGroup = groups.find((group) => group.projectDir && group.projectDir.toLowerCase() === MAIN_DIR.toLowerCase())
  const otherGroup = groups.find((group) => group.projectDir && group.projectDir.toLowerCase() === OTHER_DIR.toLowerCase())

  check('生成了主项目组', Boolean(mainGroup), groups.map((group) => group.projectDir))
  check('主要组包含 3 个监听端口', mainGroup?.summary.ports === 3, mainGroup?.summary)
  check('主要组包含 2 个进程', mainGroup?.summary.processes === 2, mainGroup?.summary)
  check('同进程的两个端口在同一个组里', mainGroup?.services.filter((service) => service.pid === frontChild.pid).length === 2, mainGroup?.services.map((service) => [service.port, service.pid]))
  check('前后端进程都在同一个组里', mainGroup?.services.some((service) => service.pid === apiChild.pid))
  check('另一个目录自成一组', Boolean(otherGroup) && otherGroup.summary.ports === 1, otherGroup?.summary)
  check('两个项目组不互相合并', mainGroup?.id !== otherGroup?.id)
  check('组名取自 package.json', mainGroup?.name === 'fullstack-app', mainGroup?.name)
  check('技术栈识别出 node/vite', (mainGroup?.stack?.kinds || []).includes('node') && (mainGroup?.stack?.dependencies || []).includes('vite'), mainGroup?.stack)
  check('整体状态为全部运行', mainGroup?.status === 'all-running', mainGroup?.status)

  const loosePorts = (scan.looseGroups || []).flatMap((group) => group.summary.portList)
  check('无项目标记的服务进入独立分组', loosePorts.includes(P_BARE), loosePorts)
  check('独立分组不与目录组合并', !mainGroup?.services.some((service) => service.port === P_BARE))
  check('系统服务被排除在聚合之外', (scan.systemServices || []).every((item) => item.filtered))

  console.log('\n[2] 事实字段在聚合后保持不变')
  const frontService = mainGroup.services.find((service) => service.port === P_FRONT_A)
  const rawCandidate = scan.candidates.find((item) => item.port === P_FRONT_A)
  check('PID 与真实进程一致', frontService?.pid === frontChild.pid, { group: frontService?.pid, real: frontChild.pid })
  check('端口未被改写', frontService?.port === P_FRONT_A)
  check('命令行来自系统采集', frontService?.commandLine === rawCandidate?.commandLine, { grouped: frontService?.commandLine?.slice(0, 60), raw: rawCandidate?.commandLine?.slice(0, 60) })
  check('exe 路径未被改写', frontService?.exePath === rawCandidate?.exePath)

  console.log('\n[3] 登记整个项目组：只创建一个项目')
  const registered = await registerGroup({ groupId: mainGroup.id })
  check('创建了项目', Boolean(registered.project?.id))
  check('主端口取组内最小端口', registered.project.port === P_FRONT_A, registered.project.port)
  check('项目目录来自扫描结果', registered.project.dir.toLowerCase() === MAIN_DIR.toLowerCase(), registered.project.dir)
  check('同目录其它服务成为子服务', registered.project.services.length === 2, registered.project.services.length)
  check('子服务保留真实端口', registered.project.services.map((service) => service.port).sort().join(',') === [P_FRONT_B, P_API].sort().join(','), registered.project.services.map((service) => service.port))
  check('子服务保留 PID', registered.project.services.every((service) => Number.isInteger(service.pid)), registered.project.services.map((service) => service.pid))
  check('子服务保留命令行', registered.project.services.every((service) => typeof service.commandLine === 'string' && service.commandLine.length > 0))
  check('projects.json 里只有 1 个该项目目录的项目', (await projectsRepo.list()).filter((item) => item.dir && item.dir.toLowerCase() === MAIN_DIR.toLowerCase()).length === 1, (await projectsRepo.list()).map((item) => item.dir))

  const afterRegister = await getProjectGroups()
  const mainAfter = afterRegister.groups.find((group) => group.projectDir?.toLowerCase() === MAIN_DIR.toLowerCase())
  check('重新分组后显示为已登记项目组', mainAfter?.registrationState === 'registered', mainAfter?.registrationState)
  check('已登记端口不再算新子服务', mainAfter?.summary.newSubServices === 0, mainAfter?.summary)

  console.log('\n[4] 已登记项目下发现新的同目录端口')
  const newChild = startFixture(path.join(MAIN_DIR, 'fixture-server.mjs'), [P_NEW], MAIN_DIR)
  check('新服务已启动', await waitForPorts([P_NEW]))

  const secondScan = await scanLocalServices({ includeAi: false })
  const mainSecond = secondScan.groups.find((group) => group.projectDir?.toLowerCase() === MAIN_DIR.toLowerCase())
  const newService = mainSecond?.services.find((service) => service.port === P_NEW)
  check('新端口出现在已登记项目组里', Boolean(newService), mainSecond?.summary)
  check('被标记为"发现新的子服务"', newService?.isNewSubService === true, newService)
  check('没有创建第二个项目', (await projectsRepo.list()).filter((item) => item.dir && item.dir.toLowerCase() === MAIN_DIR.toLowerCase()).length === 1, (await projectsRepo.list()).map((item) => item.dir))
  check('整体状态仍为全部运行（新端口在跑，只是没登记）', mainSecond?.status === 'all-running', { status: mainSecond?.status, services: mainSecond?.services.map((service) => [service.port, service.live, service.isNewSubService]) })
  check('新子服务 PID 与真实进程一致', newService?.pid === newChild.pid, { grouped: newService?.pid, real: newChild.pid })

  console.log('\n[5] 关联新子服务')
  const associated = await associateCandidate({ fingerprint: newService.fingerprint, projectId: registered.project.id })
  check('关联成功', associated.alreadyAssociated === false && Boolean(associated.service?.id))
  check('子服务数量变为 3', associated.project.services.length === 3, associated.project.services.length)
  check('关联记录里保留了事实字段', associated.service.port === P_NEW && associated.service.pid === newChild.pid)
  check('关联后项目仍然只有一个该项目目录的项目', (await projectsRepo.list()).filter((item) => item.dir && item.dir.toLowerCase() === MAIN_DIR.toLowerCase()).length === 1)

  const afterAssociate = await getProjectGroups()
  const mainAssociated = afterAssociate.groups.find((group) => group.projectDir?.toLowerCase() === MAIN_DIR.toLowerCase())
  check('关联后不再显示"发现新的子服务"', mainAssociated?.summary.newSubServices === 0, mainAssociated?.summary)
  check('关联后状态回到全部运行', mainAssociated?.status === 'all-running', mainAssociated?.status)

  console.log('\n[6] 忽略新的子服务')
  const thirdChild = startFixture(path.join(MAIN_DIR, 'fixture-server.mjs'), [P_NEW + 10], MAIN_DIR)
  check('再来一个同目录服务', await waitForPorts([P_NEW + 10]))
  const thirdScan = await scanLocalServices({ includeAi: false })
  const mainThird = thirdScan.groups.find((group) => group.projectDir?.toLowerCase() === MAIN_DIR.toLowerCase())
  const thirdService = mainThird?.services.find((service) => service.port === P_NEW + 10)
  check('再次出现新子服务', thirdService?.isNewSubService === true, thirdService?.port)
  await ignoreCandidates({ fingerprints: [thirdService.fingerprint], note: '测试忽略新子服务' })
  const fourthScan = await scanLocalServices({ includeAi: false })
  const mainFourth = fourthScan.groups.find((group) => group.projectDir?.toLowerCase() === MAIN_DIR.toLowerCase())
  check('被忽略后不再算"新的子服务"', mainFourth?.summary.newSubServices === 0, mainFourth?.summary)
  const stillListed = mainFourth?.services.some((service) => service.port === P_NEW + 10)
  check('被忽略的服务仍可查询到（状态为已忽略）', stillListed, mainFourth?.services.map((service) => [service.port, service.ignored]))
  check('第三个服务不影响项目数量', (await projectsRepo.list()).filter((item) => item.dir && item.dir.toLowerCase() === MAIN_DIR.toLowerCase()).length === 1)
  void thirdChild
  void otherChild
  void bareChild

  console.log('\n[7] 一键批量登记多个项目组')
  // 两个独立目录、各有一个监听服务
  const batchA = startFixture(path.join(BATCH_A_DIR, 'fixture-server.mjs'), [P_BATCH_A], BATCH_A_DIR)
  const batchB = startFixture(path.join(BATCH_B_DIR, 'fixture-server.mjs'), [P_BATCH_B, P_BATCH_B2], BATCH_B_DIR)
  check('批量测试的两个服务已启动', await waitForPorts([P_BATCH_A, P_BATCH_B, P_BATCH_B2]))

  const batchScan = await scanLocalServices({ includeAi: false })
  const groupA = batchScan.groups.find((group) => group.projectDir?.toLowerCase() === BATCH_A_DIR.toLowerCase())
  const groupB = batchScan.groups.find((group) => group.projectDir?.toLowerCase() === BATCH_B_DIR.toLowerCase())
  check('识别出两个待登记项目组', Boolean(groupA) && Boolean(groupB) && groupA.registrationState === 'unregistered' && groupB.registrationState === 'unregistered')
  check('组 B 同进程两个端口', groupB?.summary.processes === 1 && groupB?.summary.ports === 2, groupB?.summary)

  const projectsBefore = (await projectsRepo.list()).length
  const batch = await registerGroups({ groupIds: [groupA.id, groupB.id] })
  check('批量登记成功 2 组', batch.created === 2 && batch.failed === 0 && batch.skipped === 0, batch)
  check('新增 2 个项目', (await projectsRepo.list()).length === projectsBefore + 2, { before: projectsBefore, after: (await projectsRepo.list()).length })
  check('组 A 项目目录正确', (await projectsRepo.list()).some((item) => item.dir?.toLowerCase() === BATCH_A_DIR.toLowerCase()))
  check('组 B 项目目录正确', (await projectsRepo.list()).some((item) => item.dir?.toLowerCase() === BATCH_B_DIR.toLowerCase()))
  check('组 B 的同进程第二个端口成为子服务', (await projectsRepo.list()).filter((item) => item.dir?.toLowerCase() === BATCH_B_DIR.toLowerCase())[0]?.services?.length === 1, (await projectsRepo.list()).filter((item) => item.dir?.toLowerCase() === BATCH_B_DIR.toLowerCase())[0]?.services)

  // 幂等 / 跳过已登记
  const again = await registerGroups({ groupIds: [groupA.id, groupB.id] })
  check('再次批量登记会跳过已登记的组', again.created === 0 && again.skipped === 2 && again.failed === 0, again)
  check('不会重复建项目', (await projectsRepo.list()).length === projectsBefore + 2)

  // 事实字段在批量路径下不被改写
  const rawB = batchScan.candidates.find((item) => item.port === P_BATCH_B)
  const projB = (await projectsRepo.list()).find((item) => item.dir?.toLowerCase() === BATCH_B_DIR.toLowerCase())
  check('批量登记后主端口 PID 与系统一致', Number(projB.port) === P_BATCH_B && Number(rawB.pid) === Number(batchB.pid), { projPort: projB.port, rawPid: rawB?.pid, childPid: batchB.pid })
  const subB = projB.services?.[0]
  check('批量登记的子服务保留事实字段', subB && subB.port === P_BATCH_B2 && subB.pid === batchB.pid && typeof subB.commandLine === 'string' && subB.commandLine.length > 0, subB)

  // 结果里带了组名，便于前端提示
  check('批量结果带组名与项目 ID', batch.results.every((item) => item.ok && item.name && item.projectId), batch.results)
} finally {
  for (const child of children) {
    try {
      child.kill()
    } catch {
      /* 忽略 */
    }
  }
  await sleep(300)
  fs.rmSync(DATA_DIR, { recursive: true, force: true })
}

console.log(`\n结果：通过 ${passed} 项，失败 ${failures.length} 项`)
if (failures.length > 0) {
  console.log(JSON.stringify(failures, null, 2))
  process.exitCode = 1
}
