/**
 * Docker 守护进程「一键拉起」测试。
 *   node server/test/docker-daemon.test.mjs
 *
 * 全量用注入替身：**不真的去启动 Docker Desktop**（那会弹 UAC、动用户环境），
 * 只验证「决策逻辑 / 状态机 / 归属判定 / 错误话术 / 并发去重」这些真正会出错的地方。
 * 最后一组打真实 HTTP，确认路由接线与返回结构（GET /daemon 是只读探测，安全）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import {
  createDockerDaemonManager,
  desktopCandidates,
  resolveDesktopPath,
  resolveLaunchPlan,
  probeDaemon,
  firstLine,
} from '../src/services/dockerDaemonService.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, '..', '..')
const DATA_DIR = path.join(os.tmpdir(), `dsm-docker-daemon-${Date.now()}`)
const API_PORT = Number(process.env.DSM_DOCKER_DAEMON_TEST_PORT || 8917)
const BASE = `http://127.0.0.1:${API_PORT}/api`

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

/** 造一个「按顺序返回不同结果」的探针 */
function probeSequence(steps) {
  let index = 0
  return async () => {
    const step = steps[Math.min(index, steps.length - 1)]
    if (steps.length > 1) index += 1
    return typeof step === 'function' ? step() : step
  }
}

function makeManager(overrides = {}) {
  const launched = []
  const manager = createDockerDaemonManager({
    platform: 'win32',
    env: { ProgramFiles: 'C:\\Program Files' },
    exists: () => true,
    sleep: (ms) => sleep(ms),
    timeoutMs: 400,
    pollMs: 10,
    // 默认：没有桌面版进程在跑、自己拉起的 pid 活着、桌面版版本可读
    listDesktop: async () => [],
    isAlive: async () => true,
    readDesktopVersion: async () => '4.95.0.242831',
    launch: async (plan) => {
      launched.push(plan)
      return { method: plan.label, pid: 4242 }
    },
    ...overrides,
  })
  return { manager, launched }
}

/** 等到 manager 离开 starting（最多 2s），避免测试自己卷超时 */
async function waitSettled(manager, limitMs = 2000) {
  const deadline = Date.now() + limitMs
  for (;;) {
    const snapshot = manager._snapshot()
    if (snapshot.phase !== 'starting') return snapshot
    if (Date.now() > deadline) return snapshot
    await sleep(20)
  }
}

// ---------------------------------------------------------------- [1] 路径解析
console.log('\n[1] Docker Desktop 路径解析')
const withOverride = desktopCandidates({ ProgramFiles: 'C:\\Program Files', DSM_DOCKER_DESKTOP: 'D:\\Apps\\Docker Desktop.exe' })
check('DSM_DOCKER_DESKTOP 覆盖排在首位', withOverride[0] === 'D:\\Apps\\Docker Desktop.exe', withOverride)
check('覆盖值不会重复出现', withOverride.filter((item) => item === 'D:\\Apps\\Docker Desktop.exe').length === 1)
check(
  '包含 ProgramFiles 下的默认相对路径',
  withOverride.some((item) => item.endsWith('Docker\\Docker Desktop.exe') && item.startsWith('C:\\Program Files')),
  withOverride,
)
check('始终包含兜底绝对路径', withOverride.includes('C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe'))

const resolvedOverride = resolveDesktopPath({
  env: { ProgramFiles: 'C:\\Program Files', DSM_DOCKER_DESKTOP: 'E:\\Portable\\Docker Desktop.exe' },
  exists: (candidate) =>
    candidate === 'E:\\Portable\\Docker Desktop.exe' || candidate === 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe',
})
check('按顺序取第一个真实存在的路径', resolvedOverride === 'E:\\Portable\\Docker Desktop.exe', resolvedOverride)

const resolvedNone = resolveDesktopPath({ env: { ProgramFiles: 'C:\\Program Files' }, exists: () => false })
check('一个都不存在时返回 null', resolvedNone === null, resolvedNone)

// ---------------------------------------------------------------- [2] 平台策略
console.log('\n[2] 各平台该拉什么')
const winPlan = resolveLaunchPlan({ platform: 'win32', env: { ProgramFiles: 'C:\\Program Files' }, exists: () => true })
check('Windows → 拉起 Docker Desktop.exe', winPlan?.kind === 'windows-desktop' && /Docker Desktop\.exe$/i.test(winPlan.target), winPlan)

const winMissing = resolveLaunchPlan({ platform: 'win32', env: { ProgramFiles: 'C:\\Program Files' }, exists: () => false })
check('Windows 找不到安装 → null（交给上层给可执行提示）', winMissing === null, winMissing)

const macPlan = resolveLaunchPlan({ platform: 'darwin', exists: () => false })
check('macOS → open -a Docker', macPlan?.kind === 'macos-open' && macPlan.target === 'Docker', macPlan)

const linuxPlan = resolveLaunchPlan({ platform: 'linux', exists: () => false })
check('Linux → 启动 docker 服务', linuxPlan?.kind === 'linux-service' && linuxPlan.target === 'docker', linuxPlan)

const otherPlan = resolveLaunchPlan({ platform: 'freebsd', exists: () => false })
check('未知平台 → null', otherPlan === null, otherPlan)

// ---------------------------------------------------------------- [3] 已在运行
console.log('\n[3] 引擎已在运行时：幂等、不重复拉起、不抢功')
{
  const { manager, launched } = makeManager({ probe: async () => ({ ok: true, version: '29.8.2' }) })
  const result = await manager.start()
  check('返回 alreadyRunning', result.alreadyRunning === true, result)
  check('launched=false', result.launched === false, result)
  check('ready=true 且带引擎版本号', result.ready === true && result.version === '29.8.2', result)
  check('origin=external（不是这次拉起的就不能说是）', result.origin === 'external', result.origin)
  check('没有真的去拉起进程', launched.length === 0, launched)

  const again = await manager.start()
  check('再点一次仍然幂等', again.alreadyRunning === true && launched.length === 0, again)
}

// ---------------------------------------------------------------- [4] 拉起→就绪
console.log('\n[4] 下拉起 → 启动中 → 就绪（状态机）')
{
  const { manager, launched } = makeManager({
    probe: probeSequence([
      { ok: false, error: 'open //./pipe/dockerDesktopLinuxEngine: 找不到文件' },
      { ok: false, error: 'open //./pipe/dockerDesktopLinuxEngine: 找不到文件' },
      { ok: true, version: '29.8.2' },
    ]),
  })
  const started = await manager.start()
  check('首次 start 返回 launched=true', started.launched === true, started)
  check('立刻返回时 phase=starting（不阻塞 HTTP）', started.phase === 'starting', started)
  check('记录了启动方式', started.method === 'Docker Desktop', started)
  check('记下了自己拉起的 pid', started.pid === 4242, started.pid)
  check('start 阶段 origin=workbench', started.origin === 'workbench', started.origin)
  check('真的调用了一次 launch', launched.length === 1 && launched[0].kind === 'windows-desktop', launched)

  const settled = await waitSettled(manager)
  check('后台等待器把状态推到 ready', settled.phase === 'ready', settled)
  check('ready 后带引擎版本', settled.version === '29.8.2', settled)
  check('readyAt 被记录', typeof settled.readyAt === 'number', settled)
  check('进程还活着 → origin 保持 workbench', settled.origin === 'workbench', settled.origin)
  check('同时给出桌面版版本（双编号）', settled.desktopVersion === '4.95.0.242831', settled.desktopVersion)
}

// ---------------------------------------------------------------- [5] 并发去重
console.log('\n[5] 连点按钮：只拉起一次')
{
  const { manager, launched } = makeManager({
    probe: async () => ({ ok: false, error: '引擎未启动' }),
    timeoutMs: 3000,
  })
  const first = await manager.start()
  const second = await manager.start()
  check('第一次 launched=true', first.launched === true, first)
  check('第二次 alreadyStarting=true', second.alreadyStarting === true, second)
  check('第二次 launched=false', second.launched === false, second)
  check('launch 只被调用一次', launched.length === 1, launched)
  manager.reset()
}

// ---------------------------------------------------------------- [6] 找不到入口
console.log('\n[6] 找不到 Docker Desktop：给的是下一步，不是「未知错误」')
{
  const { manager, launched } = makeManager({ exists: () => false, probe: async () => ({ ok: false }) })
  let caught = null
  try {
    await manager.start()
  } catch (error) {
    caught = error
  }
  check('抛了错误而不是静默失败', caught !== null)
  check('HTTP 状态码 400', caught?.status === 400, caught?.status)
  check('提示里给出 DSM_DOCKER_DESKTOP 这条路', /DSM_DOCKER_DESKTOP/.test(caught?.message || ''), caught?.message)
  check('没有去拉起任何进程', launched.length === 0, launched)
  check('状态机落到 error', manager._snapshot().phase === 'error', manager._snapshot())
}

// ---------------------------------------------------------------- [7] 拉起失败
console.log('\n[7] 拉起动作本身失败（权限被拦 / 路径没了）')
{
  const denied = makeManager({
    probe: async () => ({ ok: false }),
    launch: async () => {
      const error = new Error('spawn EACCES')
      error.code = 'EACCES'
      throw error
    },
  })
  let deniedError = null
  try {
    await denied.manager.start()
  } catch (error) {
    deniedError = error
  }
  check('权限问题 → 502', deniedError?.status === 502, deniedError?.status)
  check('说明是权限/安全软件，而不是「失败」两个字', /权限|安全软件/.test(deniedError?.message || ''), deniedError?.message)

  const missing = makeManager({
    probe: async () => ({ ok: false }),
    launch: async () => {
      const error = new Error('spawn ENOENT')
      error.code = 'ENOENT'
      throw error
    },
  })
  let missingError = null
  try {
    await missing.manager.start()
  } catch (error) {
    missingError = error
  }
  check('路径不存在 → 明确说路径可能被移动', /找不到|移动/.test(missingError?.message || ''), missingError?.message)
}

// ---------------------------------------------------------------- [8] 超时
console.log('\n[8] 超时：不假装成功')
{
  const { manager } = makeManager({
    probe: async () => ({ ok: false, error: '引擎未启动' }),
    timeoutMs: 60,
    pollMs: 10,
  })
  await manager.start()
  const settled = await waitSettled(manager)
  check('超时后 phase=timeout', settled.phase === 'timeout', settled)
  check('文案里带秒数，告诉用户等了多久', /秒内没就绪/.test(settled.error || ''), settled.error)
  check('ready 仍为 false', settled.ready === false, settled)
  manager.reset()
}

// ---------------------------------------------------------------- [9] 引擎掉线
console.log('\n[9] 本来是 ready，引擎被关掉 → 回落 stopped')
{
  let healthy = true
  const { manager } = makeManager({
    probe: async () => (healthy ? { ok: true, version: '29.8.2' } : { ok: false, error: 'pipe 不存在' }),
  })
  const readySnapshot = await manager.status()
  check('先到 ready', readySnapshot.phase === 'ready', readySnapshot)
  healthy = false
  const dropped = await manager.status()
  check('掉线后 phase=stopped', dropped.phase === 'stopped', dropped)
  check('ready=false', dropped.ready === false, dropped)
  check('保留了真实原因', /pipe/.test(dropped.error || ''), dropped.error)
}

// ---------------------------------------------------------------- [10] 探针与小工具
console.log('\n[10] 探针 / 文案小工具')
{
  const ok = await probeDaemon({ runFile: async () => ({ stdout: '29.8.2\n', stderr: '' }) })
  check('拿到版本号即 ok', ok.ok === true && ok.version === '29.8.2', ok)

  const empty = await probeDaemon({ runFile: async () => ({ stdout: '   ', stderr: '' }) })
  check('空版本号不算就绪', empty.ok === false, empty)

  const failed = await probeDaemon({
    runFile: async () => {
      const error = new Error('command failed')
      error.stderr = 'failed to connect to the docker API at npipe:////./pipe/dockerDesktopLinuxEngine\n第二行细节'
      throw error
    },
  })
  check('失败时只取第一行，不糊一屏', failed.ok === false && !/第二行/.test(failed.error), failed)
  check('firstLine 去空行取首行', firstLine('\n\n  abc  \n def') === 'abc', firstLine('\n\n  abc  \n def'))
}

// ---------------------------------------------------------------- [11] 不抢功（真实踩过的坑）
console.log('\n[11] 抢功回归：自己拉起的进程早退，引擎是别人弄起来的 → origin 必须 external')
{
  // 场景复现：spawn 成功 → 进程几秒后退出 → 用户手动开桌面版 → 引擎就绪
  // 旧实现会报「已为你拉起」，实际功劳是用户的。
  let aliveCalls = 0
  const { manager, launched } = makeManager({
    probe: probeSequence([
      { ok: false, error: '引擎未启动' },
      { ok: false, error: '引擎未启动' },
      { ok: true, version: '29.8.2' },
    ]),
    isAlive: async () => {
      aliveCalls += 1
      return aliveCalls <= 1 // 第一轮还在，第二轮就没了
    },
    timeoutMs: 3000,
  })

  const started = await manager.start()
  check('确实发起了拉起', started.launched === true && launched.length === 1, started)
  check('发起时归属是 workbench', started.origin === 'workbench', started.origin)

  const settled = await waitSettled(manager)
  check('最终仍能到 ready', settled.phase === 'ready', settled)
  check('但 origin 改成 external（不是我拉起的）', settled.origin === 'external', settled.origin)
  check('pid 仍保留，便于排查', settled.pid === 4242, settled.pid)
}

// ---------------------------------------------------------------- [12] 桌面版已在跑
console.log('\n[12] 桌面版已经在跑（用户手动开的）：不再 spawn，只等引擎')
{
  const { manager, launched } = makeManager({
    probe: probeSequence([{ ok: false, error: '引擎还在初始化' }, { ok: true, version: '29.8.2' }]),
    listDesktop: async () => [{ pid: 24948, path: 'C:\\Program Files\\Docker\\Docker\\Docker Desktop.exe' }],
    timeoutMs: 3000,
  })
  const started = await manager.start()
  check('不再拉起第二个进程', launched.length === 0, launched)
  check('返回 attachedToExisting', started.attachedToExisting === true, started)
  check('launched=false', started.launched === false, started)
  check('origin=external', started.origin === 'external', started.origin)
  check('记下已有桌面进程 pid', Array.isArray(started.desktopPids) && started.desktopPids[0] === 24948, started.desktopPids)

  const settled = await waitSettled(manager)
  check('等到了就绪', settled.phase === 'ready', settled)
  check('就绪后归属仍是 external', settled.origin === 'external', settled.origin)
}

// ---------------------------------------------------------------- [13] 早退快速失败
console.log('\n[13] 自己拉起的进程立即退出且引擎没起：快速失败，不干等 180 秒')
{
  let aliveCalls = 0
  const { manager } = makeManager({
    probe: async () => ({ ok: false, error: '引擎未启动' }),
    isAlive: async () => {
      aliveCalls += 1
      return aliveCalls <= 1
    },
    timeoutMs: 5000,
    pollMs: 10,
  })
  const began = Date.now()
  await manager.start()
  const settled = await waitSettled(manager)
  const elapsed = Date.now() - began
  check('落到 error 而不是等到 timeout', settled.phase === 'error', settled.phase)
  check('文案点出「启动后立即退出」', /立即退出/.test(settled.error || ''), settled.error)
  check('给出了下一步（再点一次 / 手动打开）', /再点一次|手动/.test(settled.error || ''), settled.error)
  check('明显快于 timeoutMs（5000ms）', elapsed < 3000, elapsed)
}

// ---------------------------------------------------------------- [14] 真实路由
console.log('\n[14] 真实 HTTP：路由接线与返回结构')
{
  fs.mkdirSync(DATA_DIR, { recursive: true })
  const api = spawn(process.execPath, [path.join(ROOT, 'server', 'src', 'index.js')], {
    cwd: ROOT,
    env: { ...process.env, DSM_DATA_DIR: DATA_DIR, DSM_PORT: String(API_PORT), DSM_DISCOVERY_ON_STARTUP: '0' },
    stdio: 'ignore',
  })
  let up = false
  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await fetch(`${BASE}/health`)
      if (response.ok) {
        up = true
        break
      }
    } catch {
      /* 还没起来 */
    }
    await sleep(300)
  }
  check('测试实例起来了', up)

  if (up) {
    const daemonRes = await fetch(`${BASE}/docker/daemon`)
    const daemonPayload = await daemonRes.json().catch(() => null)
    check('GET /api/docker/daemon 返回 200', daemonRes.status === 200, daemonRes.status)
    check('带 ok 包装', daemonPayload?.ok === true, daemonPayload)
    const info = daemonPayload?.data
    check('phase 是已知状态之一', ['stopped', 'starting', 'ready', 'timeout', 'error'].includes(info?.phase), info?.phase)
    check('ready 是布尔', typeof info?.ready === 'boolean', info?.ready)
    check('timeoutMs 是正数', typeof info?.timeoutMs === 'number' && info.timeoutMs > 0, info?.timeoutMs)
    check('platform 有值', typeof info?.platform === 'string' && info.platform.length > 0, info?.platform)
    check('有 origin 字段（缺了就没法判断归属）', Object.prototype.hasOwnProperty.call(info || {}, 'origin'), Object.keys(info || {}))
    check('只读探测没有把 Docker 拉起来（phase 未被改写成 starting）', info?.phase !== 'starting', info?.phase)
  }

  api.kill()
  await sleep(200)
}

// ---------------------------------------------------------------- 收尾
console.log('\n[15] 测试产物清理')
try {
  fs.rmSync(DATA_DIR, { recursive: true, force: true })
  check('临时数据目录已删除', !fs.existsSync(DATA_DIR), DATA_DIR)
} catch (error) {
  check('临时数据目录已删除', false, String(error?.message || error))
}

console.log(`\n结果：通过 ${passed} 项，失败 ${failures.length} 项`)
if (failures.length > 0) {
  for (const item of failures) console.log(`  ✗ ${item.name} -> ${JSON.stringify(item.detail)}`)
  process.exit(1)
}
