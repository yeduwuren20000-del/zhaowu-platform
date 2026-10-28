/**
 * 第六阶段：事件时间线端到端测试（真实 API 进程 + 真实本地服务进程 + 假 SSH 服务器）。
 *   node server/test/events-e2e.test.mjs
 *
 * 覆盖：
 *   - 新建项目后首次刷新只建基线，不把现状重放成"刚刚启动"
 *   - 启动 -> started（来源 action，带真实端口与 PID），页面反复刷新不会重复记录
 *   - 外部杀掉进程 -> 下一次刷新记 crashed；用户主动停止 -> stopped 而不是 crashed
 *   - 两个项目声明同一端口 -> 未运行的一方记 port_conflict
 *   - SSH 采集：首次建基线；连不上记 ssh_offline；恢复记 ssh_online；Docker 可用性变化记 docker_changed
 *   - 服务器 APP 端口改到真实监听的端口 -> started（远程开始监听）
 *   - 同一服务器两个 APP 声明同一端口 -> port_conflict（带 serverId）
 *   - /api/events 的过滤 / 类型计数 / 首页 timeline / 清空后不重放
 *   - 自动发现扫描产生的事件类型只有 new_service_found
 */
import { execSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, '..', '..')
const DATA_DIR = path.join(os.tmpdir(), `dsm-events-e2e-${Date.now()}`)
const API_PORT = Number(process.env.DSM_E2E_API_PORT || 8899)
const BASE = `http://127.0.0.1:${API_PORT}/api`

process.env.DSM_DATA_DIR = DATA_DIR
process.env.DSM_PORT = String(API_PORT)
process.env.DSM_DISCOVERY_ON_STARTUP = '0'
process.env.DSM_FIXTURE_PASSWORD = 'events-fixture-pass'

const { startFixtureSshServer } = await import('./ssh-fixture-server.mjs')
const { NO_DOCKER_STDOUT } = await import('./fixtures/docker-output.mjs')

const PROJECT_PORT = 5511
const SSH_PORT = 2322

let passed = 0
const failures = []
let api = null
let sshFixture = null

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

async function apiRequest(method, urlPath, body) {
  const response = await fetch(`${BASE}${urlPath}`, {
    method,
    headers: body ? { 'content-type': 'application/json' } : undefined,
    body: body ? JSON.stringify(body) : undefined,
  })
  const payload = await response.json().catch(() => null)
  if (!response.ok || payload?.ok !== true) {
    throw new Error(`${method} ${urlPath} 失败：${payload?.error?.message || response.status}`)
  }
  return payload.data
}

const listEvents = (query = '') => apiRequest('GET', `/events${query}`)
const eventsFor = async (query) => (await listEvents(query)).items

async function waitFor(check, timeoutMs = 15000, intervalMs = 300) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      if (await check()) return true
    } catch {
      /* 还没就绪 */
    }
    if (Date.now() > deadline) return false
    await sleep(intervalMs)
  }
}

function killTree(pid) {
  if (!pid) return
  try {
    if (process.platform === 'win32') execSync(`taskkill /F /T /PID ${pid}`, { stdio: 'ignore' })
    else process.kill(Number(pid), 'SIGKILL')
  } catch {
    /* 进程可能已经退出 */
  }
}

try {
  console.log('\n[1] 启动后端并新建项目')
  api = spawn(process.execPath, [path.join(ROOT, 'server', 'src', 'index.js')], { cwd: ROOT, stdio: 'ignore', windowsHide: true })
  check('后端 API 已就绪', await waitFor(async () => (await fetch(`${BASE}/health`)).ok), '等待 /api/health 超时')

  const projectA = await apiRequest('POST', '/projects', {
    name: '事件E2E-主服务',
    type: 'Node',
    dir: ROOT,
    startCommand: `node server/test/fixture-server.mjs ${PROJECT_PORT}`,
    port: PROJECT_PORT,
    url: `http://localhost:${PROJECT_PORT}`,
    remark: '第六阶段端到端',
  })
  const viewsAfterCreate = await apiRequest('GET', '/projects?force=1')
  check('项目已登记', viewsAfterCreate.some((item) => item.id === projectA.id), viewsAfterCreate.length)
  check('首次刷新只建基线（没有事件）', (await eventsFor(`?projectId=${projectA.id}`)).length === 0, await eventsFor(`?projectId=${projectA.id}`))

  console.log('\n[2] 启动 -> started')
  const start = await apiRequest('POST', `/projects/${projectA.id}/start`)
  check('端口已就绪', start.result.portReady === true, start.result.message)
  const startedEvents = await eventsFor(`?projectId=${projectA.id}`)
  check('启动记了一条 started', startedEvents.length === 1 && startedEvents[0].type === 'started', startedEvents)
  check('事件带真实端口与 PID', startedEvents[0]?.port === PROJECT_PORT && startedEvents[0]?.pid === start.result.pid, startedEvents[0])
  check('事件来源为 action、级别为 success', startedEvents[0]?.source === 'action' && startedEvents[0]?.level === 'success', startedEvents[0])
  check('事件带项目名与时间', startedEvents[0]?.projectName === '事件E2E-主服务' && !Number.isNaN(Date.parse(startedEvents[0]?.at)))
  await apiRequest('GET', '/projects?force=1')
  await apiRequest('GET', '/projects?force=1')
  check('反复刷新页面不会重复记录同一次启动', (await eventsFor(`?projectId=${projectA.id}`)).length === 1)

  console.log('\n[3] 外部杀掉进程 -> crashed')
  const runningView = (await apiRequest('GET', '/projects?force=1')).find((item) => item.id === projectA.id)
  check('监听进程 PID 与运行进程都来自系统', Boolean(runningView.live?.pid) && Boolean(runningView.runtime?.pid), runningView)
  killTree(runningView.runtime.pid)
  check('端口确实被释放', await waitFor(async () => {
    const view = (await apiRequest('GET', '/projects?force=1')).find((item) => item.id === projectA.id)
    return view.live === null
  }), '端口仍在监听')
  const crashEvents = await eventsFor(`?projectId=${projectA.id}`)
  check('刷新后记为 crashed（而不是 stopped）', crashEvents[0]?.type === 'crashed', crashEvents[0])
  check('异常退出级别为 error 且消息可解释', crashEvents[0]?.level === 'error' && /异常退出/.test(crashEvents[0]?.message || ''), crashEvents[0]?.message)
  check('crashed 只记一次', crashEvents.length === 2, crashEvents.map((item) => item.type))

  console.log('\n[4] 重新启动 + 用户主动停止 -> stopped')
  const restart = await apiRequest('POST', `/projects/${projectA.id}/start`)
  check('重新启动成功', restart.result.portReady === true, restart.result.message)
  const afterRestart = await eventsFor(`?projectId=${projectA.id}&type=started,crashed,recovered`)
  check('重新启动记为 started', afterRestart[0]?.type === 'started', afterRestart[0])
  const stop = await apiRequest('POST', `/projects/${projectA.id}/stop`)
  check('端口已释放', stop.result.portReleased === true, stop.result)
  const stoppedEvents = await eventsFor(`?projectId=${projectA.id}&type=stopped`)
  check('主动停止记为 stopped', stoppedEvents.length === 1 && stoppedEvents[0].level === 'info', stoppedEvents)
  await apiRequest('GET', '/projects?force=1')
  check('停止后不会被补记成异常退出', (await eventsFor(`?projectId=${projectA.id}&type=crashed`)).length === 1)

  console.log('\n[5] 两个项目声明同一端口 -> port_conflict')
  const projectB = await apiRequest('POST', '/projects', {
    name: '事件E2E-重复端口',
    type: 'Node',
    dir: ROOT,
    startCommand: `node server/test/fixture-server.mjs ${PROJECT_PORT}`,
    port: PROJECT_PORT,
  })
  await apiRequest('GET', '/projects?force=1')
  check('新项目首次观察没有事件', (await eventsFor(`?projectId=${projectB.id}`)).length === 0)
  await apiRequest('POST', `/projects/${projectA.id}/start`)
  const conflictView = await waitFor(async () => {
    const view = (await apiRequest('GET', '/projects?force=1')).find((item) => item.id === projectB.id)
    return view.status === 'conflict' ? view : null
  })
  check('未运行的一方状态为端口冲突', Boolean(conflictView), projectB.id)
  const conflictEvents = await eventsFor(`?projectId=${projectB.id}&type=port_conflict`)
  check('冲突记了一条 port_conflict', conflictEvents.length === 1 && conflictEvents[0].level === 'warn', conflictEvents)
  check('冲突消息说明端口与占用者', new RegExp(String(PROJECT_PORT)).test(conflictEvents[0]?.message || ''), conflictEvents[0]?.message)
  await apiRequest('GET', '/projects?force=1')
  check('同一个冲突不会每次刷新都记一遍', (await eventsFor(`?projectId=${projectB.id}&type=port_conflict`)).length === 1)
  const aEvents = (await eventsFor(`?projectId=${projectA.id}`)).map((item) => item.type)
  check('正在运行的一方不会因重复声明被记成异常', aEvents.filter((type) => type === 'crashed').length === 1, aEvents)
  await apiRequest('POST', `/projects/${projectA.id}/stop`)

  console.log('\n[6] 服务器：SSH / Docker / APP 端口')
  sshFixture = await startFixtureSshServer({ port: SSH_PORT, password: 'events-fixture-pass' })
  const server = await apiRequest('POST', '/servers', {
    name: '事件E2E-服务器',
    host: '127.0.0.1',
    sshPort: SSH_PORT,
    username: 'root',
    authType: 'password',
    passwordEnv: 'DSM_FIXTURE_PASSWORD',
    connectTimeout: 6000,
    monitorEnabled: true,
    logPaths: [],
  })
  await apiRequest('POST', `/servers/${server.id}/apps`, { name: 'Nginx', port: 80, status: 'running' })
  const placeholderApp = await apiRequest('POST', `/servers/${server.id}/apps`, { name: '占位应用', port: 5999, status: 'stopped' })
  await apiRequest('POST', `/servers/${server.id}/apps`, { name: '冲突A', port: 9001, status: 'running' })
  await apiRequest('POST', `/servers/${server.id}/apps`, { name: '冲突B', port: 9001, status: 'running' })
  const firstMonitor = await apiRequest('POST', `/servers/${server.id}/probe-ssh`, { force: true })
  check('SSH 采集成功', firstMonitor.server.ssh?.ok === true, firstMonitor.error)
  check('首次采集只建基线', (await eventsFor(`?serverId=${server.id}`)).length === 0, await eventsFor(`?serverId=${server.id}`))
  const portsView = await apiRequest('GET', '/ports?force=1')
  const serverConflictEvents = await eventsFor(`?serverId=${server.id}&type=port_conflict`)
  check('端口映射页里发现了同端口重复声明', portsView.conflicts.some((item) => item.scope === 'server' && item.port === 9001), portsView.conflicts)
  check('服务器侧冲突记了一条且带 serverId', serverConflictEvents.length === 1 && serverConflictEvents[0].serverId === server.id, serverConflictEvents)
  check('服务器名出现在冲突消息里', /事件E2E-服务器/.test(serverConflictEvents[0]?.message || ''), serverConflictEvents[0]?.message)

  await apiRequest('PUT', `/servers/${server.id}/apps/${placeholderApp.id}`, { port: 80, status: 'running' })
  await apiRequest('POST', `/servers/${server.id}/probe-ssh`, { force: true })
  const appEvents = await eventsFor(`?serverId=${server.id}&type=started`)
  check('APP 端口改到真实监听的端口后记为开始监听', appEvents.length === 1 && /远程/.test(appEvents[0].message || ''), appEvents)
  check('该 APP 事件保留了端口事实', appEvents[0]?.port === 80 && appEvents[0]?.serviceName === '占位应用', appEvents[0])
  await apiRequest('POST', `/servers/${server.id}/probe-ssh`, { force: true })
  check('同样的采集结果不再重复记录', (await eventsFor(`?serverId=${server.id}&type=started`)).length === 1)

  console.log('\n[7] SSH 断开与 Docker 变化')
  await sshFixture.close()
  sshFixture = null
  await apiRequest('POST', `/servers/${server.id}/probe-ssh`, { force: true }).catch(() => {})
  const offlineEvents = await eventsFor(`?serverId=${server.id}&type=ssh_offline`)
  check('连不上时记 ssh_offline', offlineEvents.length === 1 && offlineEvents[0].level === 'error', offlineEvents)
  check('离线事件说明了原因', /失败/.test(offlineEvents[0]?.message || ''), offlineEvents[0]?.message)
  check('SSH 失败时不把远程 APP 误判为停止', (await eventsFor(`?serverId=${server.id}&type=stopped`)).length === 0, await eventsFor(`?serverId=${server.id}&type=stopped`))
  sshFixture = await startFixtureSshServer({ port: SSH_PORT, password: 'events-fixture-pass', dockerStdout: NO_DOCKER_STDOUT })
  await apiRequest('POST', `/servers/${server.id}/probe-ssh`, { force: true })
  const onlineEvents = await eventsFor(`?serverId=${server.id}&type=ssh_online`)
  check('恢复连接记为 ssh_online', onlineEvents.length === 1, onlineEvents)
  check('恢复消息说明此前离线', /此前/.test(onlineEvents[0]?.message || ''), onlineEvents[0]?.message)
  const dockerEvents = await eventsFor(`?serverId=${server.id}&type=docker_changed`)
  check('Docker 由可用变为未安装 -> docker_changed', dockerEvents.length === 1, dockerEvents)
  check('Docker 事件明细说明未安装', /没有安装 Docker/.test(dockerEvents[0]?.detail || ''), dockerEvents[0]?.detail)
  const serversFile = fs.readFileSync(path.join(DATA_DIR, 'servers.json'), 'utf8')
  check('服务器文件里没有明文凭据', !serversFile.includes('events-fixture-pass') && !/"password":\s*"[^"]+"/.test(serversFile))

  console.log('\n[8] 查询接口与首页时间线')
  const dashboard = await apiRequest('GET', '/dashboard')
  const allEvents = await listEvents('?limit=500')
  check('返回最新在前的列表', allEvents.items.length > 0 && Date.parse(allEvents.items[0].at) >= Date.parse(allEvents.items.at(-1).at), allEvents.items.slice(0, 2))
  check('每条事件都有类型与消息', allEvents.items.every((item) => item.type && item.message && item.id && item.at))
  check('类型计数覆盖返回的事件', Object.entries(allEvents.typeCounts).every(([type, count]) => count >= allEvents.items.filter((item) => item.type === type).length), allEvents.typeCounts)
  const mixed = await listEvents('?type=started,ssh_offline&limit=500')
  check('支持多类型过滤', mixed.items.length > 0 && mixed.items.every((item) => ['started', 'ssh_offline'].includes(item.type)), mixed.items.map((item) => item.type))
  const types = await apiRequest('GET', '/events/types')
  check('类型字典带中文标签', types.length === 10 && types.every((item) => item.value && item.label), types)
  check('首页带最近活动时间线', Array.isArray(dashboard.timeline) && dashboard.timeline.length > 0, dashboard.timeline)
  check('首页时间线最新在前', dashboard.timeline[0]?.at >= dashboard.timeline.at(-1)?.at)
  check('首页时间线是全部事件的一部分', allEvents.items.some((item) => item.id === dashboard.timeline[0].id))

  console.log('\n[9] 清空时间线后不把现状重放一遍')
  const removed = await apiRequest('DELETE', '/events')
  check('清空返回删除条数', removed.removed > 0, removed)
  check('清空后列表为空', (await listEvents()).items.length === 0)
  await apiRequest('GET', '/projects?force=1')
  await apiRequest('GET', '/ports?force=1')
  await apiRequest('POST', `/servers/${server.id}/probe-ssh`, { force: true })
  await apiRequest('GET', '/dashboard')
  check('重复观察当前状态没有产生事件', (await listEvents()).items.length === 0, (await listEvents()).items)
  const startAgain = await apiRequest('POST', `/projects/${projectB.id}/start`)
  check('清空后新的启停仍然会记录', startAgain.result.portReady === true || startAgain.result.running === true, startAgain.result)
  const afterClear = await eventsFor(`?projectId=${projectB.id}`)
  check('新记录的是这次启动', afterClear.some((item) => item.type === 'started'), afterClear)

  console.log('\n[10] 自动发现扫描只产生新服务事件')
  const beforeScan = await listEvents('?limit=500')
  const scan = await apiRequest('POST', '/discovery/scan', {})
  check('扫描完成', Boolean(scan.at) && Boolean(scan.summary), scan?.summary)
  const afterScan = await listEvents('?limit=500')
  const added = afterScan.items.filter((item) => !beforeScan.items.some((existing) => existing.id === item.id))
  check('扫描新增的事件类型只有 new_service_found', added.every((item) => item.type === 'new_service_found'), added.map((item) => item.type))
  check('扫描新增的事件来源标为 discovery', added.every((item) => item.source === 'discovery'), added.map((item) => item.source))
} finally {
  console.log('\n[清理] 结束所有测试进程')
  try {
    if (api) {
      const projects = await apiRequest('GET', '/projects').catch(() => [])
      for (const item of projects) await apiRequest('POST', `/projects/${item.id}/stop`).catch(() => {})
    }
  } catch {
    /* 忽略 */
  }
  await sleep(300)
  if (api) api.kill()
  if (sshFixture) await sshFixture.close().catch(() => {})
  await sleep(200)
  fs.rmSync(DATA_DIR, { recursive: true, force: true })
}

console.log(`\n结果：通过 ${passed} 项，失败 ${failures.length} 项`)
if (failures.length > 0) {
  console.log(JSON.stringify(failures, null, 2))
  process.exitCode = 1
}
