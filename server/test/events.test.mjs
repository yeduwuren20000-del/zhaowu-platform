/**
 * 第六阶段：服务生命周期事件单测。
 *   node server/test/events.test.mjs
 *
 * 覆盖：
 *   - buildEvent 的字段白名单、长度上限、默认级别与消息、未知类型拒绝
 *   - eventStore 的追加 / 过滤 / 类型计数 / 上限裁剪 / 清空保留状态指纹
 *   - 首次观察只建基线，指纹一致不产生事件（不是每秒快照）
 *   - started / stopped / crashed / recovered / port_conflict / port_changed 全部状态转移
 *   - 子服务与项目分别记录，PID 变化不算一次状态变化
 *   - 启停动作直接记录后，下一次观察不会重复记同一条
 *   - 自动发现：首次扫描汇总、增量逐条、超出上限合并
 *   - SSH 在线/离线、Docker 容器集合变化、服务器 APP 端口核对结果变化
 *   - 记录失败或输入残缺都不抛错（事件是旁路能力）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DATA_DIR = path.join(os.tmpdir(), `dsm-events-${Date.now()}`)
process.env.DSM_DATA_DIR = DATA_DIR

const { eventStore } = await import('../src/store/eventStore.js')
const {
  buildEvent,
  clearEvents,
  EVENT_TYPES,
  EVENT_TYPE_LIST,
  listEvents,
  markProjectState,
  observeDiscoveryScan,
  observeMappingConflicts,
  observeProjectStates,
  observeServerMonitor,
  recordProjectAction,
  recentActivity,
} = await import('../src/services/eventService.js')
const { FILES, EVENT_MAX_ITEMS } = await import('../src/config.js')

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

/** 每个场景用独立项目 id，避免状态指纹互相干扰 */
let seq = 0
const nextId = () => `evt-test-${(seq += 1)}`

function view({ id, name = '测试项目', status = 'stopped', port = null, pid = null, processName = '', services = [], conflict = null }) {
  return {
    id,
    name,
    status,
    port,
    processName,
    live: port ? { port, pid, processName, address: `127.0.0.1:${port}` } : null,
    conflict,
    services,
  }
}

/** 观察一次并返回本次新增的事件（同时返回观察后的状态指纹） */
async function observe(id, facts) {
  const emitted = await observeProjectStates([view({ id, ...facts })])
  return { emitted, state: await eventStore.getState(`project:${id}`) }
}

async function eventsOf(id) {
  return eventStore.list({ projectId: id })
}

try {
  console.log('\n[1] buildEvent：白名单、上限与默认值')
  check('未知类型被拒绝', buildEvent({ type: 'not_a_real_type' }) === null)
  const minimal = buildEvent({ type: EVENT_TYPES.STARTED, projectId: 'p1', port: 3000, pid: 4321, note: '不该进事件' })
  check('生成的事件带 id 与时间', minimal.id.startsWith('evt_') && !Number.isNaN(Date.parse(minimal.at)), minimal)
  check('白名单外的字段不会进入事件', minimal.note === undefined, minimal)
  check('级别按类型取默认值', minimal.level === 'success', minimal.level)
  check('缺消息时用中文标签兜底', minimal.message === '开始运行', minimal.message)
  check('缺来源时记为 observe', minimal.source === 'observe', minimal.source)
  check('端口与 PID 原样保留', minimal.port === 3000 && minimal.pid === 4321, minimal)
  check('非法端口被丢弃', buildEvent({ type: EVENT_TYPES.STARTED, port: 70000 }).port === null)
  check('非法 PID 被丢弃', buildEvent({ type: EVENT_TYPES.STARTED, pid: -3 }).pid === null)
  check('白名单外的级别退回默认值', buildEvent({ type: EVENT_TYPES.STOPPED, level: 'verbose' }).level === 'info')
  const longName = '超'.repeat(200)
  check('超长字段被截断', buildEvent({ type: EVENT_TYPES.STARTED, projectName: longName }).projectName.length === 120)
  check('超长消息被截断到 400', buildEvent({ type: EVENT_TYPES.STARTED, message: '啊'.repeat(900) }).message.length === 400)
  check('空字符串字段不落库', buildEvent({ type: EVENT_TYPES.STARTED, detail: '' }).detail === undefined)
  check('全部类型都有中文标签', EVENT_TYPE_LIST.every((type) => Boolean(buildEvent({ type, projectId: 'p-tag' }))))

  console.log('\n[2] 首次观察只建基线，不回放当前状态')
  const baseId = nextId()
  const first = await observe(baseId, { status: 'running', port: 5100, pid: 1001, processName: 'node' })
  check('第一次观察不产生事件', first.emitted.length === 0, first.emitted)
  check('状态指纹已建立', first.state?.status === 'running' && first.state?.port === 5100, first.state)
  const second = await observe(baseId, { status: 'running', port: 5100, pid: 2002, processName: 'node' })
  check('事实一致时不重复记录', second.emitted.length === 0, second.emitted)
  check('PID 变化不算一次状态变化', (await eventsOf(baseId)).length === 0)

  console.log('\n[3] 状态转移表')
  const startId = nextId()
  await observe(startId, { status: 'stopped' })
  const started = await observe(startId, { status: 'running', port: 5101, pid: 11, processName: 'node' })
  check('停止 -> 运行记为 started', started.emitted[0]?.type === 'started', started.emitted)
  check('消息含端口与 PID', /5101/.test(started.emitted[0]?.message || '') && /11/.test(started.emitted[0]?.message || ''), started.emitted[0]?.message)
  const changed = await observe(startId, { status: 'running', port: 5199, pid: 11, processName: 'node' })
  check('端口变化记为 port_changed', changed.emitted[0]?.type === 'port_changed', changed.emitted)
  const crashed = await observe(startId, { status: 'stopped' })
  check('运行中消失记为 crashed（不是 stopped）', crashed.emitted[0]?.type === 'crashed', crashed.emitted)
  check('异常退出级别为 error', crashed.emitted[0]?.level === 'error', crashed.emitted[0]?.level)
  const recovered = await observe(startId, { status: 'running', port: 5101, pid: 22 })
  check('异常后再次运行记为 recovered', recovered.emitted[0]?.type === 'recovered', recovered.emitted)
  check('恢复消息说明上一次异常', /恢复运行/.test(recovered.emitted[0]?.message || ''), recovered.emitted[0]?.message)

  const conflicId = nextId()
  await observe(conflicId, { status: 'stopped' })
  const conflicted = await observe(conflicId, {
    status: 'conflict',
    port: 5102,
    conflict: { type: 'foreign', message: '端口 5102 被 PID 999(node) 占用' },
  })
  check('端口被占用记为 port_conflict', conflicted.emitted[0]?.type === 'port_conflict', conflicted.emitted)
  check('冲突级别为 warn', conflicted.emitted[0]?.level === 'warn', conflicted.emitted[0]?.level)
  const conflictGone = await observe(conflicId, { status: 'running', port: 5102, pid: 888 })
  check('冲突解除后运行记为 recovered', conflictGone.emitted[0]?.type === 'recovered', conflictGone.emitted)

  const slowId = nextId()
  await observe(slowId, { status: 'stopped' })
  const starting = await observe(slowId, { status: 'starting', pid: 77 })
  check('编译中（starting）不单独记一条', starting.emitted.length === 0, starting.emitted)
  const afterStarting = await observe(slowId, { status: 'running', port: 5103, pid: 77 })
  check('真的监听后才记 started', afterStarting.emitted[0]?.type === 'started', afterStarting.emitted)
  const dyingId = nextId()
  await observe(dyingId, { status: 'stopped' })
  await observe(dyingId, { status: 'starting', pid: 78 })
  const killedStarting = await observe(dyingId, { status: 'stopped' })
  check('启动中进程消失记为 crashed（级别 warn）', killedStarting.emitted[0]?.level === 'warn' && killedStarting.emitted[0]?.type === 'crashed', killedStarting.emitted)

  console.log('\n[4] 子服务单独成条')
  const groupId = nextId()
  const service = { id: 'svc-1', name: 'API', port: 8000 }
  const groupFirst = await observeProjectStates([view({ id: groupId, name: '全栈应用', status: 'stopped', services: [service] })])
  check('首次观察项目与子服务都只建基线', groupFirst.length === 0, groupFirst)
  const groupSecond = await observeProjectStates([
    view({ id: groupId, name: '全栈应用', status: 'running', port: 5173, pid: 500, services: [{ ...service, live: true, livePid: 600, liveProcessName: 'python' }] }),
  ])
  check('主端口与子服务各记一条', groupSecond.length === 2, groupSecond.map((item) => item.type))
  check('子服务事件带 serviceId', groupSecond.every((item) => item.serviceId === undefined || item.serviceId === 'svc-1'), groupSecond)
  const apiEvent = groupSecond.find((item) => item.serviceId === 'svc-1')
  check('子服务事件标明子服务名', apiEvent?.serviceName === 'API' && /子服务/.test(apiEvent?.message || ''), apiEvent)
  check('子服务事实字段保留 PID 与进程名', apiEvent?.pid === 600 && apiEvent?.processName === 'python', apiEvent)
  const groupThird = await observeProjectStates([
    view({ id: groupId, name: '全栈应用', status: 'running', port: 5173, pid: 500, services: [{ ...service, live: false }] }),
  ])
  check('子服务停止单独记一条', groupThird.length === 1 && groupThird[0].serviceId === 'svc-1', groupThird)

  console.log('\n[5] 启停动作直接记录，观察不再重复')
  const actionId = nextId()
  const actionEvent = await recordProjectAction(
    { id: actionId, name: '动作项目' },
    {
      type: EVENT_TYPES.STARTED,
      message: '项目「动作项目」启动成功：端口 5104 已监听（PID 700）',
      facts: { port: 5104, pid: 700 },
      state: { status: 'running', port: 5104, pid: 700 },
    },
  )
  check('动作事件来源标为 action', actionEvent?.source === 'action', actionEvent)
  check('动作事件级别为 success', actionEvent?.level === 'success', actionEvent)
  const afterAction = await observe(actionId, { status: 'running', port: 5104, pid: 700, processName: 'node' })
  check('下一次观察不再重复记同一次启动', afterAction.emitted.length === 0, afterAction.emitted)
  await markProjectState({ id: actionId }, { status: 'stopped', port: null, pid: null })
  const stopEvent = await recordProjectAction(
    { id: actionId, name: '动作项目' },
    {
      type: EVENT_TYPES.STOPPED,
      message: '项目「动作项目」已停止',
      facts: { port: 5104, pid: 700 },
      state: { status: 'stopped', port: null, pid: null },
    },
  )
  check('用户主动停止记为 stopped', stopEvent?.type === 'stopped', stopEvent)
  check('主动停止不是 crashed', stopEvent?.level === 'info', stopEvent?.level)
  const afterStop = await observe(actionId, { status: 'stopped' })
  check('停止后观察不再补记异常退出', afterStop.emitted.length === 0, afterStop.emitted)
  check('动作项目共两条事件', (await eventsOf(actionId)).length === 2)

  console.log('\n[6] 自动发现扫描')
  const candidate = (port, name) => ({
    fingerprint: `fp-${port}`,
    port,
    pid: 900 + port - 5200,
    processName: name,
    serviceName: name,
    address: '127.0.0.1',
  })
  const scan1 = { at: new Date().toISOString(), candidates: [candidate(5201, 'node.exe'), candidate(5202, 'python.exe')], firstSeen: [candidate(5201, 'node.exe'), candidate(5202, 'python.exe')] }
  const firstScanEvents = await observeDiscoveryScan(scan1, { firstScan: true })
  check('首次扫描只记一条汇总', firstScanEvents.length === 1, firstScanEvents.map((item) => item.message))
  check('汇总事件列出端口', /5201/.test(firstScanEvents[0]?.message || ''), firstScanEvents[0]?.message)
  const scan2 = { at: new Date().toISOString(), candidates: [candidate(5203, 'java.exe')], firstSeen: [candidate(5203, 'java.exe')] }
  const incremental = await observeDiscoveryScan(scan2, { firstScan: false })
  check('后续扫描逐个新服务记一条', incremental.length === 1 && incremental[0].type === 'new_service_found', incremental)
  check('未登记服务消息含进程名', /java\.exe/.test(incremental[0]?.message || ''), incremental[0]?.message)
  const many = Array.from({ length: 20 }, (_, index) => candidate(5210 + index, 'node.exe'))
  const overflow = await observeDiscoveryScan({ at: new Date().toISOString(), candidates: many, firstSeen: many }, { firstScan: false })
  check('单次扫描逐条数量有上限', overflow.length === 13, overflow.length)
  check('超出的部分合并成一条汇总', /另有 8 个/.test(overflow.at(-1)?.message || ''), overflow.at(-1)?.message)
  const noNew = await observeDiscoveryScan({ at: new Date().toISOString(), candidates: [], firstSeen: [] }, { firstScan: false })
  check('没有新发现时不记录', noNew.length === 0, noNew)
  const sameDir = await observeDiscoveryScan(
    {
      at: new Date().toISOString(),
      candidates: [{ ...candidate(5240, 'node.exe'), sameDirectoryProjectId: 'proj-1', sameDirectoryProjectName: '同目录项目', projectDir: 'D:\\demo' }],
      firstSeen: [{ fingerprint: 'fp-5240', port: 5240, serviceName: 'node.exe' }],
    },
    { firstScan: false },
  )
  check('同目录新端口关联到已有项目', sameDir[0]?.projectId === 'proj-1' && /子服务/.test(sameDir[0]?.message || ''), sameDir[0])
  check('残缺扫描结果不抛错', (await observeDiscoveryScan(null)).length === 0)

  console.log('\n[7] 服务器：SSH / Docker / APP 端口')
  const dockerContainers = (names) =>
    names.map((item) => ({ id: `id-${item.name}`, name: item.name, state: item.state, health: item.health || 'none' }))
  const serverBase = (overrides = {}) => ({
    id: 'srv-1',
    name: '生产机',
    host: '10.0.0.8',
    sshPort: 22,
    apps: [{ id: 'app-1', name: 'Nginx', port: 80 }],
    ssh: { at: new Date().toISOString(), ok: true, code: null, error: null },
    docker: { at: new Date().toISOString(), installed: true, daemonOk: true, summary: { total: 2, running: 2 }, containers: dockerContainers([{ name: 'web', state: 'running' }, { name: 'db', state: 'running' }]) },
    portAudit: { items: [{ appId: 'app-1', state: 'ok', listen: { pid: 400, process: 'nginx' } }] },
    ...overrides,
  })
  const srvFirst = await observeServerMonitor(serverBase())
  check('首次服务器观察只建基线', srvFirst.length === 0, srvFirst.map((item) => item.type))
  const srvSame = await observeServerMonitor(serverBase())
  check('事实一致不再记录', srvSame.length === 0, srvSame)
  const sshDown = await observeServerMonitor(
    serverBase({ ssh: { at: new Date().toISOString(), ok: false, code: 'TIMEOUT', error: '连接超时' } }),
  )
  check('SSH 失败记为 ssh_offline', sshDown.some((item) => item.type === 'ssh_offline' && item.level === 'error'), sshDown)
  check('离线消息带错误码', sshDown.find((item) => item.type === 'ssh_offline')?.code === 'TIMEOUT')
  const sshUp = await observeServerMonitor(serverBase())
  const onlineEvent = sshUp.find((item) => item.type === 'ssh_online')
  check('SSH 恢复记为 ssh_online', Boolean(onlineEvent), sshUp)
  check('恢复消息说明此前离线', /此前/.test(onlineEvent?.message || ''), onlineEvent?.message)

  const dockerChanged = await observeServerMonitor(
    serverBase({
      docker: {
        at: new Date().toISOString(),
        installed: true,
        daemonOk: true,
        summary: { total: 3, running: 1 },
        containers: dockerContainers([{ name: 'web', state: 'running' }, { name: 'db', state: 'exited' }, { name: 'cache', state: 'running' }]),
      },
    }),
  )
  const dockerEvent = dockerChanged.find((item) => item.type === 'docker_changed')
  check('容器集合变化记为 docker_changed', Boolean(dockerEvent), dockerChanged.map((item) => item.type))
  check('明细里同时给出新增与状态变化', /新增 cache/.test(dockerEvent?.detail || '') && /db: running → exited/.test(dockerEvent?.detail || ''), dockerEvent?.detail)
  check('Docker 事件带 serverId', dockerEvent?.serverId === 'srv-1', dockerEvent)
  const dockerQuiet = await observeServerMonitor(
    serverBase({
      docker: {
        at: new Date().toISOString(),
        installed: true,
        daemonOk: true,
        summary: { total: 3, running: 1 },
        containers: dockerContainers([{ name: 'web', state: 'running' }, { name: 'db', state: 'exited' }, { name: 'cache', state: 'running' }]),
      },
    }),
  )
  check('同样的容器状态不再重复记录', !dockerQuiet.some((item) => item.type === 'docker_changed'), dockerQuiet.map((item) => item.type))
  const appGone = await observeServerMonitor(serverBase({ portAudit: { items: [{ appId: 'app-1', state: 'recordedNotListening' }] } }))
  check('远程 APP 停止监听单独记一条', appGone.some((item) => item.type === 'stopped' && item.serverId === 'srv-1'), appGone)
  const noSshResult = await observeServerMonitor({ id: 'srv-2', name: '未采集', ssh: null, docker: null, apps: [] })
  check('没有采集结果的服务器不产生事件', noSshResult.length === 0, noSshResult)

  console.log('\n[8] 服务器侧端口冲突')
  const conflictRow = { scope: 'server', port: 8080, owner: '10.0.0.8:8080', serverId: 'srv-1', serverName: '生产机', type: 'duplicate', message: '10.0.0.8:8080 上端口 8080 被多个应用声明：A、B' }
  const conflictFirst = await observeMappingConflicts([conflictRow])
  check('新出现的端口冲突立刻记一条', conflictFirst[0]?.type === 'port_conflict' && conflictFirst[0]?.serverId === 'srv-1', conflictFirst)
  check('冲突事件级别为 warn', conflictFirst[0]?.level === 'warn', conflictFirst[0])
  const conflictRepeat = await observeMappingConflicts([conflictRow])
  check('同一个冲突不会重复刷屏', conflictRepeat.length === 0, conflictRepeat)
  const conflictChanged = await observeMappingConflicts([{ ...conflictRow, message: '10.0.0.8:8080 上端口 8080 被多个应用声明：A、B、C' }])
  check('冲突内容变化记为 port_changed', conflictChanged[0]?.type === 'port_changed', conflictChanged)
  const conflictResolved = await observeMappingConflicts([])
  check('冲突消失不产生事件', conflictResolved.length === 0, conflictResolved)
  const conflictAgain = await observeMappingConflicts([conflictRow])
  check('再次冲突能重新记出', conflictAgain[0]?.type === 'port_conflict', conflictAgain)
  check('本地冲突由项目视图覆盖，这里不重复记', (await observeMappingConflicts([{ scope: 'local', port: 1, owner: 'x' }])).length === 0)

  console.log('\n[9] 查询：过滤 / 计数 / 最新活动')
  const all = await listEvents({ limit: 500 })
  check('返回按时间倒序', all.items[0]?.id !== undefined && Date.parse(all.items[0].at) >= Date.parse(all.items.at(-1).at), all.items.slice(0, 2))
  check('total 与文件条数一致', all.total === (await eventStore.read()).items.length, all.total)
  check('类型选项覆盖全部类型', all.typeOptions.length === EVENT_TYPE_LIST.length)
  const portEvents = await listEvents({ type: 'port_conflict,port_changed', limit: 500 })
  check('支持多类型过滤', portEvents.items.length > 0 && portEvents.items.every((item) => ['port_conflict', 'port_changed'].includes(item.type)), portEvents.items.map((item) => item.type))
  const serverEvents = await listEvents({ serverId: 'srv-1', limit: 500 })
  check('支持按服务器过滤', serverEvents.items.length > 0 && serverEvents.items.every((item) => item.serverId === 'srv-1'))
  const projectEvents = await listEvents({ projectId: startId, limit: 500 })
  check('支持按项目过滤', projectEvents.items.length > 0 && projectEvents.items.every((item) => item.projectId === startId))
  check('类型计数与列表一致', Object.values(all.typeCounts).reduce((sum, value) => sum + value, 0) >= all.items.length, all.typeCounts)
  check('limit 生效', (await listEvents({ limit: 3 })).items.length === 3)
  check('最近活动取最新若干条', (await recentActivity(5)).length === 5)

  console.log('\n[10] 落盘与上限裁剪')
  const raw = await eventStore.read()
  check('events.json 结构为 version/items/states', raw.version === 1 && Array.isArray(raw.items) && typeof raw.states === 'object')
  check('状态指纹按主体存', Object.keys(raw.states).some((key) => key.startsWith('project:')) && Object.keys(raw.states).some((key) => key.startsWith('server:')))
  check('事件文件已落盘', fs.existsSync(FILES.events))
  check('事件里不含任何凭据字段', !/(password|privateKey|token)/i.test(JSON.stringify(raw)))
  const before = raw.items.length
  for (let index = 0; index < EVENT_MAX_ITEMS + 10; index += 1) {
    await eventStore.commit({ event: buildEvent({ type: EVENT_TYPES.STARTED, projectId: 'prune-test', message: `第 ${index} 条` }) })
  }
  const pruned = await eventStore.read()
  check('超出上限时丢弃最旧的', pruned.items.length === EVENT_MAX_ITEMS && pruned.items.at(-1).message === `第 ${EVENT_MAX_ITEMS + 9} 条`, { before, after: pruned.items.length })
  const cleared = await clearEvents()
  check('清空返回删除条数', cleared?.removed > 0, cleared)
  check('清空后状态指纹保留', Object.keys((await eventStore.read()).states).length > 0)
  const afterClear = await observe(baseId, { status: 'running', port: 5100, pid: 1001 })
  check('清空后重复观察不会把现状重放一遍', afterClear.emitted.length === 0, afterClear.emitted)

  console.log('\n[11] 事件是旁路能力：残缺输入不影响主流程')
  check('空视图列表安全', (await observeProjectStates([])).length === 0)
  check('非数组输入安全（失败被吞掉，只返回空）', ((await observeProjectStates(null)) || []).length === 0)
  check('残缺项目安全', (await observeProjectStates([{ id: 'x' }])).length === 0)
  check('残缺服务器安全', (await observeServerMonitor({})).length === 0)
  check('未知类型的动作不记录', (await recordProjectAction({ id: 'x', name: 'x' }, { type: 'not_a_real_type', message: 'x' })) === null)
  check('没有状态指纹的动作也能记录', Boolean(await recordProjectAction({ id: 'act-only', name: '只记录' }, { type: EVENT_TYPES.STOPPED, message: '已停止' })))
} finally {
  fs.rmSync(DATA_DIR, { recursive: true, force: true })
}

console.log(`\n结果：通过 ${passed} 项，失败 ${failures.length} 项`)
if (failures.length > 0) {
  console.log(JSON.stringify(failures, null, 2))
  process.exitCode = 1
}
