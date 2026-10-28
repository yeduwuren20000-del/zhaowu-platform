/**
 * 项目聚合单元测试（纯函数，不依赖系统状态）：
 *   node server/test/grouping.test.mjs
 *
 * 覆盖需求里的全部聚合场景：
 *   同目录多个端口 / 同进程多个端口 / 前后端两个进程 / 不同项目同名 /
 *   无 projectDir 服务 / 系统服务不参与聚合 / 已登记项目与监听状态组合 / 冲突 /
 *   已登记项目下发现新的子服务 / 事实字段不被改写 / 目录归一化
 */
import { buildProjectGroups, normalizeDir, declaredPortsOf, GROUP_STATUS } from '../src/services/projectGrouping.js'

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

let fingerprintSeed = 0
function candidate(overrides = {}) {
  fingerprintSeed += 1
  return {
    fingerprint: `fp${String(fingerprintSeed).padStart(4, '0')}`,
    pid: overrides.pid ?? 1000 + fingerprintSeed,
    port: overrides.port ?? 5000 + fingerprintSeed,
    address: '127.0.0.1',
    processName: 'node.exe',
    exePath: 'E:\\nodejs\\node.exe',
    commandLine: '"E:\\nodejs\\node.exe" app.js',
    startedAt: '2026-10-06T10:00:00.000Z',
    projectDir: null,
    projectDirSource: null,
    projectMarkers: [],
    project: null,
    serviceName: `服务 ${overrides.port ?? 5000 + fingerprintSeed}`,
    type: overrides.type || 'Node 服务',
    category: overrides.category || 'dev-server',
    confidence: 0.8,
    reasons: ['测试'],
    source: 'rule',
    filtered: false,
    filterReason: null,
    devRelevant: true,
    suggestedStartCommand: 'npm run dev',
    suggestedUrl: `http://localhost:${overrides.port ?? 5000 + fingerprintSeed}`,
    aiEligible: false,
    ai: null,
    registrationState: 'unregistered',
    registeredProjectId: null,
    registeredProjectName: null,
    matchedBy: null,
    ...overrides,
  }
}

function project(overrides = {}) {
  return {
    id: overrides.id || `prj_${Math.random().toString(16).slice(2, 8)}`,
    name: overrides.name || 'demo',
    type: overrides.type || 'Node',
    dir: overrides.dir || 'D:\\projects\\demo',
    port: overrides.port ?? null,
    url: overrides.url || '',
    startCommand: 'npm run dev',
    services: overrides.services || [],
    ...overrides,
  }
}

console.log('\n[1] 目录归一化')
check('大小写与分隔符统一', normalizeDir('D:/Projects/Demo/') === normalizeDir('d:\\projects\\demo'), [normalizeDir('D:/Projects/Demo/'), normalizeDir('d:\\projects\\demo')])
check('空值安全', normalizeDir(null) === '' && normalizeDir('') === '')

console.log('\n[2] 同目录多个端口 → 一个项目组')
{
  const dir = 'D:\\projects\\multi'
  const result = buildProjectGroups({
    candidates: [
      candidate({ port: 5173, projectDir: dir }),
      candidate({ port: 5174, projectDir: dir, pid: 2001 }),
      candidate({ port: 8000, projectDir: dir, pid: 2002, processName: 'python.exe', type: 'FastAPI' }),
    ],
  })
  check('只产生 1 个项目组', result.groups.length === 1, result.groups.length)
  const group = result.groups[0]
  check('组里有 3 个子服务', group.services.length === 3, group.services.length)
  check('端口数量统计为 3', group.summary.ports === 3, group.summary)
  check('进程数量统计为 3', group.summary.processes === 3, group.summary)
  check('整体状态为全部运行', group.status === 'all-running', group.status)
  check('组名回退到目录名', group.name === 'multi', group.name)
  check('端口列表升序', JSON.stringify(group.summary.portList) === JSON.stringify([5173, 5174, 8000]), group.summary.portList)
}

console.log('\n[3] 同进程多个端口 → 同一组内两个子服务（同一个 PID）')
{
  const dir = 'D:\\projects\\oneproc'
  const result = buildProjectGroups({
    candidates: [
      candidate({ port: 3000, pid: 4242, projectDir: dir }),
      candidate({ port: 3001, pid: 4242, projectDir: dir }),
    ],
  })
  const group = result.groups[0]
  check('一个组两个子服务', group.services.length === 2)
  check('两个子服务 PID 相同（事实字段保留）', group.services[0].pid === 4242 && group.services[1].pid === 4242, group.services.map((item) => item.pid))
  check('进程数量记为 1', group.summary.processes === 1, group.summary)
  check('端口数量记为 2', group.summary.ports === 2, group.summary)
}

console.log('\n[4] 前后端两个进程 → 一个项目组，技术栈/类型各自保留')
{
  const dir = 'D:\\projects\\fullstack'
  const result = buildProjectGroups({
    candidates: [
      candidate({ port: 5173, pid: 100, projectDir: dir, type: 'Vite 开发服务器', processName: 'node.exe' }),
      candidate({ port: 8000, pid: 200, projectDir: dir, type: 'FastAPI', processName: 'python.exe' }),
    ],
  })
  const group = result.groups[0]
  check('一个项目组', result.groups.length === 1)
  check('两个子服务类型不同', group.services[0].type !== group.services[1].type, group.services.map((item) => item.type))
  check('进程名各自保留', group.services.map((item) => item.processName).join(',') === 'node.exe,python.exe', group.services.map((item) => item.processName))
}

console.log('\n[5] 不同项目同名 → 不合并')
{
  const result = buildProjectGroups({
    candidates: [
      candidate({ port: 4100, projectDir: 'D:\\a\\same-name', project: { root: 'D:\\a\\same-name', markers: ['package.json'], stack: { packageName: 'same-name', kinds: ['node'] } } }),
      candidate({ port: 4200, projectDir: 'D:\\b\\same-name', project: { root: 'D:\\b\\same-name', markers: ['package.json'], stack: { packageName: 'same-name', kinds: ['node'] } } }),
    ],
  })
  check('两个目录 → 两个项目组', result.groups.length === 2, result.groups.map((group) => group.projectDir))
  check('两组名字可能相同但目录不同', new Set(result.groups.map((group) => group.key)).size === 2, result.groups.map((group) => group.key))
  check('组名取自 package.json 名称', result.groups.every((group) => group.name === 'same-name'), result.groups.map((group) => group.name))
}

console.log('\n[6] 无 projectDir 的服务 → 按 PID 分组，不与目录组合并')
{
  const result = buildProjectGroups({
    candidates: [
      candidate({ port: 5000, pid: 700, projectDir: null }),
      candidate({ port: 5001, pid: 700, projectDir: null }),
      candidate({ port: 5002, pid: 701, projectDir: null }),
      candidate({ port: 5173, pid: 702, projectDir: 'D:\\projects\\real' }),
    ],
  })
  check('目录组只有 1 个', result.groups.length === 1, result.groups.length)
  check('无目录服务分成 2 组（按 PID）', result.loose.length === 2, result.loose.map((group) => group.key))
  check('同 PID 的两个端口在同一组', result.loose.some((group) => group.services.length === 2))
  check('无目录组不带 projectDir', result.loose.every((group) => group.projectDir === null))
  check('无目录组不会被算进目录组', result.groups[0].services.length === 1, result.groups[0].services.length)
}

console.log('\n[7] 系统服务不参与聚合')
{
  const result = buildProjectGroups({
    candidates: [
      candidate({ port: 49668, processName: 'svchost.exe', filtered: true, filterReason: 'Windows 系统进程' }),
      candidate({ port: 5173, projectDir: 'D:\\projects\\x' }),
    ],
  })
  check('系统服务进入 system 桶', result.system.length === 1, result.system.length)
  check('系统服务不出现在任何组里', !result.groups.some((group) => group.services.some((service) => service.processName === 'svchost.exe')))
  check('系统服务不产生 loose 组', result.loose.length === 0, result.loose.length)
  check('汇总里区分 systemServices', result.summary.systemServices === 1, result.summary)
}

console.log('\n[8] 已登记项目的整体状态')
{
  const dir = 'D:\\projects\\registered'
  const registered = project({ id: 'prj_reg', name: '已登记项目', dir, port: 5173 })

  const allStopped = buildProjectGroups({ candidates: [], projects: [registered] })
  check('没有监听 → 全部停止', allStopped.groups[0]?.status === 'all-stopped', allStopped.groups[0]?.status)
  check('已登记项目即使没有监听也会出现在列表里', allStopped.groups.length === 1)
  check('未监听的端口标记为仅记录', allStopped.groups[0].services[0].live === false, allStopped.groups[0].services[0])

  const allRunning = buildProjectGroups({ candidates: [candidate({ port: 5173, projectDir: dir })], projects: [registered] })
  check('唯一端口在监听 → 全部运行', allRunning.groups[0].status === 'all-running', allRunning.groups[0].status)
  check('匹配到已登记项目', allRunning.groups[0].registeredProjectId === 'prj_reg')

  const partial = buildProjectGroups({
    candidates: [candidate({ port: 5173, projectDir: dir })],
    projects: [project({ id: 'prj_reg2', name: '前后端项目', dir, port: 5173, services: [{ id: 'svc_1', name: 'API', port: 8000 }] })],
  })
  check('一个在监听 + 一个未监听 → 部分运行', partial.groups[0].status === 'partial-running', { status: partial.groups[0].status, services: partial.groups[0].services.map((item) => [item.port, item.live]) })
  check('未监听的子服务来自项目记录', partial.groups[0].services.find((item) => item.port === 8000)?.live === false)
}

console.log('\n[9] 冲突判定')
{
  const dir = 'D:\\projects\\conflict'
  const samePort = buildProjectGroups({
    candidates: [
      candidate({ port: 3000, pid: 900, address: '127.0.0.1', projectDir: dir }),
      candidate({ port: 3000, pid: 901, address: '0.0.0.0', projectDir: dir }),
    ],
  })
  check('同端口多监听者 → 存在冲突', samePort.groups[0].status === 'conflict', samePort.groups[0].status)
  check('冲突信息可读', /端口 3000/.test(samePort.groups[0].conflicts[0]?.message || ''), samePort.groups[0].conflicts)
  check('冲突状态文案', samePort.groups[0].statusText === GROUP_STATUS.conflict.text, samePort.groups[0].statusText)

  const foreign = buildProjectGroups({
    candidates: [candidate({ port: 8080, pid: 950, projectDir: 'D:\\other\\project', processName: 'java.exe' })],
    projects: [project({ id: 'prj_conf', name: '声明了 8080 的项目', dir: 'D:\\projects\\conflict', port: 8080 })],
  })
  const conflictGroup = foreign.groups.find((group) => group.registeredProjectId === 'prj_conf')
  check('声明的端口被别人占用 → 冲突', conflictGroup?.status === 'conflict', conflictGroup?.status)
  check('冲突指向真实占用者', /java\.exe/.test(conflictGroup?.conflicts?.[0]?.message || ''), conflictGroup?.conflicts)
}

console.log('\n[9.7] 容器端口代理不算外来冲突（Docker Desktop / WSL 场景）')
{
  // 复现现场：Dify(80) / Stirling-PDF(8790) / Uptime Kuma(3001) 三个容器都在跑，
  // 但宿主机端口由 wslrelay.exe 持有、projectDir 推不出来 → 旧逻辑一律报"存在冲突"。
  const containerApp = project({
    id: 'prj_docker',
    name: 'Stirling-PDF',
    dir: 'D:\\projects\\docker-app',
    port: 8790,
    type: 'docker',
    containerName: 'workbench-stirling',
  })
  const viaWsl = buildProjectGroups({
    candidates: [candidate({ port: 8790, pid: 29980, processName: 'wslrelay.exe', projectDir: null, exePath: '' })],
    projects: [containerApp],
  })
  const wslGroup = viaWsl.groups.find((group) => group.registeredProjectId === 'prj_docker')
  check('容器项目 + wslrelay 持端口 → 不报冲突', wslGroup?.conflicts.length === 0, wslGroup?.conflicts)
  check('容器在跑 → 判为运行中', wslGroup?.status === GROUP_STATUS.allRunning.status, wslGroup?.status)

  // 反例一：不是容器部署的项目，端口被容器代理占着就是真冲突（别人的容器抢了你的端口）
  const plainApp = project({ id: 'prj_plain', name: '普通前端', dir: 'D:\\projects\\plain', port: 8790, type: 'Node' })
  const plainCase = buildProjectGroups({
    candidates: [candidate({ port: 8790, pid: 29980, processName: 'wslrelay.exe', projectDir: null })],
    projects: [plainApp],
  })
  const plainGroup = plainCase.groups.find((group) => group.registeredProjectId === 'prj_plain')
  check('非容器项目 + 容器代理持端口 → 仍是冲突', plainGroup?.status === 'conflict', plainGroup?.status)

  // 反例二：容器项目，但占用者是普通进程（别人手起的 java）→ 也得报
  const realClash = buildProjectGroups({
    candidates: [candidate({ port: 8790, pid: 7001, processName: 'java.exe', projectDir: 'D:\\other\\svc' })],
    projects: [containerApp],
  })
  const clashGroup = realClash.groups.find((group) => group.registeredProjectId === 'prj_docker')
  check('容器项目 + 普通进程持端口 → 仍是冲突', clashGroup?.status === 'conflict', clashGroup?.status)
}

console.log('\n[9.8] 畸形目录归一（D://30651//dify//docker 这类手填路径）')
{
  const weird = normalizeDir('D://30651//dify//docker')
  const normal = normalizeDir('D:\\30651\\dify\\docker')
  check('重复分隔符与正斜杠归一一致', weird === normal, { weird, normal })
  check('UNC 路径前导双斜杠保留', normalizeDir('\\\\server\\share\\dir') === '\\\\server\\share\\dir', normalizeDir('\\\\server\\share\\dir'))
  check('尾部反斜杠忽略', normalizeDir('D:\\a\\b\\\\') === normalizeDir('D:\\a\\b'), normalizeDir('D:\\a\\b\\\\'))
}

console.log('\n[9.5] 目录识别不出来时，仍要按端口判定存活（真实踩坑回归）')
{
  // 复现现场：本工作台的 2299/8787 是后台启动的，扫描推断不出项目目录，
  // 于是旧逻辑把它们全判成"已停止"，明明三个端口都在监听。
  const dir = 'D:\\projects\\DevServerManager'
  const registered = project({
    id: 'prj_dsm',
    name: 'DevServerManager',
    dir,
    port: 5180,
    services: [
      { id: 's1', name: 'node.exe :2299', port: 2299 },
      { id: 's2', name: 'node.exe :8787', port: 8787 },
    ],
  })
  const result = buildProjectGroups({
    candidates: [
      // 三个都在监听，但目录识别不出来（projectDir 为空）→ 全部进 loose
      candidate({ port: 2299, pid: 46420, projectDir: '', processName: 'node.exe' }),
      candidate({ port: 5180, pid: 38516, projectDir: `${dir}\\web`, processName: 'node.exe' }),
      candidate({ port: 8787, pid: 35900, projectDir: '', processName: 'node.exe' }),
    ],
    projects: [registered],
  })

  const group = result.groups.find((item) => item.registeredProjectId === 'prj_dsm')
  check('项目分组存在', Boolean(group), result.groups.map((g) => g.id))
  check('端口在监听就应算运行中（3/3）', group?.summary.live === 3, group?.summary)
  check('状态为全部运行', group?.status === 'all-running', group?.status)
  check('不应有 declaredOnly', group?.summary.declaredOnly === 0, group?.summary)
  check('进程数正确', group?.summary.processes === 3, group?.summary)

  // 关键：真实 PID 要带到界面上，而不是空着
  const byPort = new Map(group?.services?.map((s) => [Number(s.port), s]) || [])
  check('2299 带出真实 PID', byPort.get(2299)?.pid === 46420, byPort.get(2299))
  check('8787 带出真实 PID', byPort.get(8787)?.pid === 35900, byPort.get(8787))
  check('来源标明是"项目记录+端口实测"', byPort.get(2299)?.source === 'project-record+live-port', byPort.get(2299)?.source)
  check('带出进程名', byPort.get(8787)?.processName === 'node.exe', byPort.get(8787)?.processName)

  // 真正没监听的端口仍应显示为停止
  const stopped = buildProjectGroups({
    candidates: [candidate({ port: 5180, pid: 1, projectDir: `${dir}\\web`, processName: 'node.exe' })],
    projects: [project({ id: 'prj_dsm2', name: '半运行', dir, port: 5180, services: [{ id: 's1', name: 'x', port: 9999 }] })],
  })
  const g2 = stopped.groups.find((item) => item.registeredProjectId === 'prj_dsm2')
  const off = g2?.services?.find((s) => Number(s.port) === 9999)
  check('确实没监听的端口仍是停止', off?.live === false, off)
  check('停止的端口不带 PID', !off?.pid, off?.pid)
  check('状态为部分运行', g2?.status === 'partial-running', g2?.status)
}

console.log('\n[9.6] 子目录占用不算外来冲突（monorepo 场景）')
{
  const dir = 'D:\\projects\\mono'
  const result = buildProjectGroups({
    // Vite 前端跑在 monorepo 的 web/ 子目录里 —— 那就是项目自己的服务
    candidates: [candidate({ port: 5173, pid: 38516, projectDir: `${dir}\\web`, processName: 'node.exe' })],
    projects: [project({ id: 'prj_mono', name: 'monorepo', dir, port: 5173 })],
  })
  const group = result.groups.find((item) => item.registeredProjectId === 'prj_mono')
  check('子目录占用不算冲突', group?.conflicts.length === 0, group?.conflicts)
  check('状态为全部运行', group?.status === 'all-running', group?.status)
}

console.log('\n[9.7] 属于已登记项目的端口不在 loose 里重复出现')
{
  const dir = 'D:\\projects\\dup'
  const result = buildProjectGroups({
    candidates: [
      candidate({ port: 2299, pid: 111, projectDir: '', processName: 'node.exe' }),
      candidate({ port: 7788, pid: 222, projectDir: '', processName: 'other.exe' }),
    ],
    projects: [project({ id: 'prj_dup', name: '会重复的项目', dir, port: 5173, services: [{ id: 's1', name: 'n', port: 2299 }] })],
  })
  const loosePorts = result.loose.flatMap((group) => group.services.map((s) => Number(s.port)))
  check('已登记端口不再出现在 loose', !loosePorts.includes(2299), loosePorts)
  check('未登记的端口仍留在 loose', loosePorts.includes(7788), loosePorts)
}

console.log('\n[10] 已登记项目下发现新的子服务')
{
  const dir = 'D:\\projects\\growing'
  const registered = project({ id: 'prj_grow', name: '成长中的项目', dir, port: 5173 })
  const result = buildProjectGroups({
    candidates: [
      candidate({ port: 5173, projectDir: dir }),
      candidate({ port: 6006, pid: 1500, projectDir: dir, type: '调试端口' }),
    ],
    projects: [registered],
  })
  const group = result.groups[0]
  const newService = group.services.find((service) => service.port === 6006)
  check('已登记项目的端口不算新子服务', group.services.find((service) => service.port === 5173)?.isNewSubService === false)
  check('同目录新端口标记为新的子服务', newService?.isNewSubService === true, newService)
  check('汇总里给出新子服务数量', group.summary.newSubServices === 1, group.summary)
  check('newSubServices 列表可用', group.newSubServices.length === 1 && group.newSubServices[0].port === 6006)
  check('新端口已登记后状态为全部运行', group.status === 'all-running', { status: group.status, services: group.services.map((item) => [item.port, item.live, item.isNewSubService]) })
}

console.log('\n[11] 事实字段不被聚合改写')
{
  const dir = 'D:\\projects\\facts'
  const original = candidate({
    port: 7331,
    pid: 8888,
    address: '0.0.0.0',
    processName: 'python.exe',
    exePath: 'C:\\Python311\\python.exe',
    commandLine: '"C:\\Python311\\python.exe" -m uvicorn main:app --port 7331',
    startedAt: '2026-10-06T08:00:00.000Z',
    projectDir: dir,
  })
  const snapshot = JSON.parse(JSON.stringify(original))
  const result = buildProjectGroups({ candidates: [original], projects: [project({ dir, port: 7331, id: 'prj_f' })] })
  const service = result.groups[0].services.find((item) => item.live)
  for (const field of ['pid', 'port', 'address', 'processName', 'exePath', 'commandLine', 'startedAt']) {
    check(`事实字段 ${field} 未被改写`, service[field] === snapshot[field], { before: snapshot[field], after: service[field] })
  }
  check('原始候选对象也没有被就地修改', original.pid === snapshot.pid && original.port === snapshot.port && original.isNewSubService === undefined)
  check('候选对象被保留在子服务里（便于溯源）', service.candidate === original)
}

console.log('\n[12] 已登记项目的端口集合')
{
  const ports = declaredPortsOf({ port: 5173, services: [{ port: 8000 }, { port: 8080 }, {}] })
  check('主端口 + 子服务端口', ports.has(5173) && ports.has(8000) && ports.has(8080) && ports.size === 3, [...ports])
  check('没有端口时返回空集合', declaredPortsOf({}).size === 0)
}

console.log(`\n结果：通过 ${passed} 项，失败 ${failures.length} 项`)
if (failures.length > 0) {
  console.log(JSON.stringify(failures.slice(0, 12), null, 2))
  process.exitCode = 1
}
