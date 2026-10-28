/**
 * SSH 自动刷新调度器测试（第七阶段·第二轮）：
 *   node server/test/auto-monitor.test.mjs
 *
 * 核心验证点：
 *   1. 目标筛选：关闭监控的机器不采、熔断中的机器不采、退避到期后恢复采集；
 *   2. 熔断退避：连续失败才退避，退避时长指数增长并封顶，成功后清零；
 *   3. 设置持久化：间隔被钳制到合法区间，非法值回退默认；
 *   4. **日志不被刷爆**：反复失败的机器进入熔断后不再产生新的采集失败记录；
 *   5. 一轮没结束不会重入。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DATA_DIR = path.join(os.tmpdir(), `dsm-automon-${Date.now()}`)
fs.mkdirSync(DATA_DIR, { recursive: true })
process.env.DSM_DATA_DIR = DATA_DIR
process.env.DSM_AUTO_MONITOR_ON_STARTUP = '0'

const { monitorRepo, backoffMsFor, isCircuitOpen, MIN_INTERVAL_MS, MAX_INTERVAL_MS, DEFAULT_INTERVAL_MS, FAILURE_THRESHOLD } = await import('../src/store/monitorRepo.js')
const { selectTargets, runRound, startAutoMonitor, stopAutoMonitor, setAutoMonitorInterval, autoMonitorStatus } = await import('../src/services/autoMonitor.js')
const { serversRepo } = await import('../src/store/serversRepo.js')
const { logRepo } = await import('../src/store/logRepo.js')

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

try {
  console.log('\n[1] 熔断退避时长')
  check('未达阈值不退避', backoffMsFor(1) === 0 && backoffMsFor(FAILURE_THRESHOLD) === 0)
  check('刚过阈值退避 1 分钟', backoffMsFor(FAILURE_THRESHOLD + 1) === 60000, backoffMsFor(FAILURE_THRESHOLD + 1))
  check('再失败翻倍', backoffMsFor(FAILURE_THRESHOLD + 2) === 120000 && backoffMsFor(FAILURE_THRESHOLD + 3) === 240000)
  check('封顶 30 分钟', backoffMsFor(50) === 1800000, backoffMsFor(50))

  console.log('\n[2] isCircuitOpen')
  const now = Date.now()
  check('无记录 -> 未熔断', isCircuitOpen(null, now) === false)
  check('retryAfter 为空 -> 未熔断', isCircuitOpen({ failures: 0, retryAfter: null }, now) === false)
  check('未来时间 -> 熔断中', isCircuitOpen({ retryAfter: new Date(now + 5000).toISOString() }, now) === true)
  check('已过期 -> 恢复可采', isCircuitOpen({ retryAfter: new Date(now - 1000).toISOString() }, now) === false)

  console.log('\n[3] 目标筛选')
  {
    const servers = [
      { id: 'ok1', name: '正常机', monitorEnabled: true },
      { id: 'off', name: '已关监控', monitorEnabled: false },
      { id: 'held', name: '熔断中', monitorEnabled: true },
      { id: 'recovered', name: '退避已过', monitorEnabled: true },
    ]
    const health = {
      held: { failures: 5, retryAfter: new Date(Date.now() + 60000).toISOString() },
      recovered: { failures: 5, retryAfter: new Date(Date.now() - 1000).toISOString() },
    }
    const { eligible, onHold } = selectTargets(servers, health)
    check('关闭监控的不采集', !eligible.some((item) => item.id === 'off'), eligible.map((i) => i.id))
    check('熔断中的不采集', !eligible.some((item) => item.id === 'held'))
    check('熔断中的被单独列出（带原因）', onHold.some((item) => item.serverId === 'held' && item.failures === 5), onHold)
    check('退避到期的恢复采集', eligible.some((item) => item.id === 'recovered'), eligible.map((i) => i.id))
    check('正常机始终采集', eligible.some((item) => item.id === 'ok1'))
    check('空输入安全', selectTargets(null, null).eligible.length === 0)
  }

  console.log('\n[4] 设置持久化与钳制')
  {
    const set1 = await monitorRepo.updateSettings({ intervalMs: 1 })
    check('过小间隔被抬到下限', set1.intervalMs === MIN_INTERVAL_MS, set1)
    const set2 = await monitorRepo.updateSettings({ intervalMs: 99999999 })
    check('过大间隔被压到上限', set2.intervalMs === MAX_INTERVAL_MS, set2)
    const set3 = await monitorRepo.updateSettings({ intervalMs: 'abc' })
    check('非法间隔回退默认', set3.intervalMs === DEFAULT_INTERVAL_MS, set3)
    const set4 = await monitorRepo.updateSettings({ enabled: true, intervalMs: 300000 })
    check('开关与间隔可同时更新', set4.enabled === true && set4.intervalMs === 300000)
    const read = await monitorRepo.read()
    check('设置已落盘', read.settings.enabled === true && read.settings.intervalMs === 300000, read.settings)
    await monitorRepo.updateSettings({ evil: 'x' })
    const afterEvil = await monitorRepo.read()
    check('未知字段不会污染设置', !('evil' in afterEvil.settings), afterEvil.settings)
  }

  console.log('\n[5] 采集结果记录')
  {
    await monitorRepo.recordOutcome('srv_a', { ok: false, error: '连接超时' })
    let h = (await monitorRepo.read()).health.srv_a
    check('首次失败计数 1', h.failures === 1, h)
    check('未达阈值不进入退避', h.retryAfter === null)
    await monitorRepo.recordOutcome('srv_a', { ok: false, error: '连接超时' })
    await monitorRepo.recordOutcome('srv_a', { ok: false, error: '连接超时' })
    h = (await monitorRepo.read()).health.srv_a
    check('第三次失败开始退避', h.failures === 3 && Boolean(h.retryAfter), h)
    check('退避原因被记录', /超时/.test(h.lastError || ''), h.lastError)
    await monitorRepo.recordOutcome('srv_a', { ok: true })
    h = (await monitorRepo.read()).health.srv_a
    check('成功后计数清零', h.failures === 0 && h.retryAfter === null, h)
    check('成功时间被记录', Boolean(h.lastOkAt))
    await monitorRepo.clearFailure('srv_a')
    check('clearFailure 幂等', (await monitorRepo.read()).health.srv_a.failures === 0)
    await monitorRepo.forgetServer('srv_a')
    check('forgetServer 删除记录', (await monitorRepo.read()).health.srv_a === undefined)
  }

  console.log('\n[6] 真实一轮：反复失败的机器会被熔断，不再刷日志')
  {
    // 一台必然连不上的机器（本地无监听端口 + 短超时）
    const bad = await serversRepo.create({
      name: '必然失败机',
      host: '127.0.0.1',
      sshPort: 2298,
      username: 'nobody',
      authType: 'password',
      passwordEnv: 'DSM_NO_SUCH_ENV_XYZ',
      connectTimeout: 1200,
      logPaths: [],
      apps: [],
    })
    // 仓储首次读取会播种示例数据：把除 bad 以外的机器全部关掉监控，保证作用域精确
    for (const item of await serversRepo.list()) {
      if (item.id !== bad.id) await serversRepo.update(item.id, { monitorEnabled: false })
    }
    await serversRepo.update(bad.id, { monitorEnabled: true })

    const round1 = await runRound({ reason: 'test' })
    check('第一轮只采集作用域内 1 台', round1.probed === 1, round1)
    check('第一轮记录为失败', round1.failed === 1 && round1.ok === 0, round1)
    const logsAfter1 = (await logRepo.tail(500)).filter((l) => l.source === bad.name).length
    check('失败产生了日志记录', logsAfter1 >= 1, logsAfter1)

    // 连续失败到进入退避
    await monitorRepo.recordOutcome(bad.id, { ok: false, error: 'again' })
    await monitorRepo.recordOutcome(bad.id, { ok: false, error: 'again' })
    const healthNow = (await monitorRepo.read()).health[bad.id]
    check('已达退避条件', Boolean(healthNow.retryAfter), healthNow)

    const logsBefore = (await logRepo.tail(500)).filter((l) => l.source === bad.name).length
    const round2 = await runRound({ reason: 'test' })
    const logsAfter2 = (await logRepo.tail(500)).filter((l) => l.source === bad.name).length
    check('熔断中本轮不再采集', round2.probed === 0, round2)
    check('熔断中不再新增失败日志（日志不被刷爆）', logsAfter2 === logsBefore, { before: logsBefore, after: logsAfter2 })
    check('摘要里体现被熔断的台数', round2.onHold === 1, round2)

    // 退避到期后应恢复采集
    await monitorRepo.setHealth(bad.id, { failures: 3, retryAfter: new Date(Date.now() - 1).toISOString(), lastError: 'again' })
    const round3 = await runRound({ reason: 'test' })
    check('退避到期后重新尝试采集', round3.probed === 1, round3)

    // resetCircuit 立即重试
    await monitorRepo.setHealth(bad.id, { failures: 4, retryAfter: new Date(Date.now() + 600000).toISOString(), lastError: 'again' })
    check('退避中不再采集', (await runRound({ reason: 'test' })).probed === 0)
    await monitorRepo.resetCircuit(bad.id)
    check('resetCircuit 后可立即重试', (await runRound({ reason: 'test' })).probed === 1)

    // 关闭监控后完全不采
    await serversRepo.update(bad.id, { monitorEnabled: false })
    const round4 = await runRound({ reason: 'test' })
    check('关闭监控的机器不参与自动采集', round4.probed === 0, round4)
  }

  console.log('\n[7] 启停与间隔调整')
  {
    const started = await startAutoMonitor({ intervalMs: 60000 })
    check('start 返回 running=true', started.running === true && started.intervalMs === 60000, started)
    let status = await autoMonitorStatus()
    check('状态里 running 为真', status.running === true)
    check('状态暴露间隔与上下限', status.settings.intervalMs === 60000 && status.limits.minIntervalMs === MIN_INTERVAL_MS)

    const changed = await setAutoMonitorInterval(12345)
    check('间隔被钳到下限', changed.intervalMs === MIN_INTERVAL_MS, changed)
    check('运行中会重新排期', changed.rearmed === true)

    const stopped = await stopAutoMonitor()
    check('stop 返回 running=false', stopped.running === false)
    status = await autoMonitorStatus()
    check('停止后状态同步', status.running === false)
    const persisted = await monitorRepo.read()
    check('停止后设置里 enabled=false', persisted.settings.enabled === false)

    const badInterval = await setAutoMonitorInterval(-5)
    check('非法间隔不会崩溃且回退默认', badInterval.intervalMs === DEFAULT_INTERVAL_MS, badInterval)
  }

  console.log('\n[8] 一轮未结束不重入')
  {
    const [a, b] = await Promise.all([runRound({ reason: 'concurrent-a' }), runRound({ reason: 'concurrent-b' })])
    const skipped = [a, b].filter((item) => item.skipped === 'busy')
    check('并发调用时第二个被跳过', skipped.length <= 1 && [a, b].every((item) => item !== undefined), { a, b })
  }

  console.log('\n[9] 无服务器时安全')
  {
    const all = await serversRepo.list()
    for (const item of all) await serversRepo.remove(item.id)
    const round = await runRound({ reason: 'empty' })
    check('没有任何服务器时返回 0 且不报错', round.probed === 0 && round.error === undefined, round)
    check('空轮也写入 lastRun 摘要', Boolean(round.at) && round.onHold === 0, round)
  }
  console.log('\n[10] 并发更新不丢计数（回归：mutate 只串行化写盘，不串行化读-改-写）')
  {
    // 不同机器并行失败：每台都必须记到 1，不能被后写入者覆盖
    const ids = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8']
    await Promise.all(ids.map((id) => monitorRepo.recordOutcome(id, { ok: false, error: 'boom' })))
    const snap = await monitorRepo.read()
    const counted = ids.filter((id) => (snap.health[id]?.failures || 0) === 1).length
    check('8 台机器并行失败各自都记到 1 次', counted === 8, { counted, health: ids.map((id) => snap.health[id]?.failures) })

    // 同一台机器并行失败：计数必须精确等于调用次数
    await Promise.all(Array.from({ length: 12 }, () => monitorRepo.recordOutcome('same', { ok: false, error: 'boom' })))
    const snap2 = await monitorRepo.read()
    check('同一台并行 12 次失败计数为 12', snap2.health.same?.failures === 12, snap2.health.same)
    check('达到阈值后确实进入退避', Boolean(snap2.health.same?.retryAfter), snap2.health.same)

    // 混合读写：并行成功与失败也不能互相吞掉
    await monitorRepo.recordOutcome('mix', { ok: false, error: 'e' })
    await Promise.all([monitorRepo.recordOutcome('mix', { ok: true }), monitorRepo.recordOutcome('mix', { ok: false, error: 'e' })])
    const snap3 = await monitorRepo.read()
    check('成功/失败交错后计数仍是合法值（0 或 1）', [0, 1].includes(snap3.health.mix?.failures), snap3.health.mix)

    // 并行写设置也不能互相覆盖出非法值
    await Promise.all([monitorRepo.updateSettings({ intervalMs: 60000 }), monitorRepo.updateSettings({ intervalMs: 300000 })])
    const snap4 = await monitorRepo.read()
    check('并行改间隔后仍是两个合法值之一', [60000, 300000].includes(snap4.settings.intervalMs), snap4.settings)
  }
} finally {
  await stopAutoMonitor().catch(() => {})
  fs.rmSync(DATA_DIR, { recursive: true, force: true })
}

console.log(`\n结果：通过 ${passed} 项，失败 ${failures.length} 项`)
if (failures.length > 0) {
  console.log(JSON.stringify(failures, null, 2))
  process.exitCode = 1
}
