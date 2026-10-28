/**
 * 资源历史趋势测试（第七阶段·第三轮）：
 *   node server/test/resource-history.test.mjs
 *
 * 死守三条口径：
 *   1. 只记真实采样，绝不插值 —— 空档必须如实返回；
 *   2. 采集失败时 setSshMonitor 会保留上一次的 metrics，
 *      所以失败路径绝不能记点（否则趋势图出现"假稳定"）；
 *   3. 告警有冷却，持续高负载不会每轮刷一条。
 * 另测并发写不丢点（第二轮 lost-update 教训的复用）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DATA_DIR = path.join(os.tmpdir(), `dsm-rests-${Date.now()}`)
fs.mkdirSync(DATA_DIR, { recursive: true })
process.env.DSM_DATA_DIR = DATA_DIR
process.env.DSM_AUTO_MONITOR_ON_STARTUP = '0'

const { resourceStore } = await import('../src/store/resourceStore.js')
const { extractSample, detectSpikes, recordSample, buildSeries, getHistory, parseWindow, RESOURCE_HISTORY_LIMITS } = await import('../src/services/resourceHistory.js')
const { RESOURCE_MIN_GAP_MS } = await import('../src/config.js')
const { serversRepo } = await import('../src/store/serversRepo.js')
const { monitorServer } = await import('../src/services/serverMonitor.js')

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

const iso = (offsetMs = 0) => new Date(Date.now() + offsetMs).toISOString()

try {
  console.log('\n[1] parseWindow')
  check('1h = 3600000', parseWindow('1h') === 3600000)
  check('30m / 24h / 7d', parseWindow('30m') === 1800000 && parseWindow('24h') === 86400000 && parseWindow('7d') === 604800000)
  check('裸毫秒数字', parseWindow('60000') === 60000)
  check('非法值返回 null（不限窗口）', parseWindow('abc') === null && parseWindow('') === null && parseWindow(null) === null)
  check('超大值被拒绝', parseWindow('99999d') === null)

  console.log('\n[2] extractSample：采不到就是 null，不是 0')
  {
    const server = {
      id: 's1',
      metrics: {
        collectedAt: iso(0),
        cpuUsagePercent: 49.4,
        memory: { usedBytes: 8388608, totalBytes: 16777216, usedPercent: 50 },
        load: { one: 1.25, five: 1, fifteen: 0.9 },
        disk: [{ mount: '/data', usePercent: 10 }, { mount: '/', usePercent: 72.5 }],
      },
      docker: { summary: { cpuPercentTotal: 6.3, memoryUsedBytes: 1024, running: 4 } },
    }
    const sample = extractSample(server, { source: 'auto' })
    check('CPU 被取出', sample.cpuPercent === 49.4, sample)
    check('内存三元组齐全', sample.memoryUsedBytes === 8388608 && sample.memoryTotalBytes === 16777216 && sample.memoryUsedPercent === 50)
    check('load1 被取出', sample.load1 === 1.25)
    check('根分区使用率优先取 "/"（不是第一个）', sample.diskUsedPercent === 72.5, sample.diskUsedPercent)
    check('容器汇总被取出', sample.containerCpuPercent === 6.3 && sample.containerCount === 4)
    check('来源标记为 auto', sample.source === 'auto')

    const empty = extractSample({ id: 's2' })
    check('什么都没采到时返回 null', empty === null)

    const noDocker = extractSample({ id: 's3', metrics: { cpuUsagePercent: 10, memory: {}, disk: [] } })
    check('没采 Docker 时容器字段是 null 而不是 0', noDocker.containerCpuPercent === null && noDocker.containerCount === null, noDocker)
    check('没有磁盘时 diskUsedPercent 是 null', noDocker.diskUsedPercent === null)
  }

  console.log('\n[3] detectSpikes：阈值 + 冷却 + 缺值不判定')
  {
    const base = { cpuPercent: 95, memoryUsedPercent: 50, containerCount: 1 }
    const spikes = detectSpikes('s1', '机器一', base, { now: 1000000 })
    check('CPU 超阈值触发告警', spikes.length === 1 && spikes[0].metric === 'cpu', spikes)
    check('告警带机器名与阈值', spikes[0].serverName === '机器一' && spikes[0].threshold === RESOURCE_HISTORY_LIMITS.spikeCpuPercent)
    check('消息可读', /CPU 使用率 95%/.test(spikes[0].message), spikes[0].message)

    check('未超阈值不告警', detectSpikes('s1', 'x', { cpuPercent: 10, memoryUsedPercent: 10 }, { now: 1 }).length === 0)
    check('内存超阈值单独告警', detectSpikes('s1', 'x', { cpuPercent: 1, memoryUsedPercent: 99 }, { now: 1 })[0]?.metric === 'memory')
    check('采不到值（null）绝不判定', detectSpikes('s1', 'x', { cpuPercent: null, memoryUsedPercent: null }, { now: 1 }).length === 0)

    const cooldown = RESOURCE_HISTORY_LIMITS.spikeCooldownMs
    check(
      '冷却期内不重复告警',
      detectSpikes('s1', 'x', base, { now: 10 * cooldown, lastSpikeTimes: { cpu: 10 * cooldown - 1000 } }).length === 0,
    )
    check('冷却结束后可以再告警', detectSpikes('s1', 'x', base, { now: 10 * cooldown, lastSpikeTimes: { cpu: 0 } }).length === 1)
    check('CPU 告警不影响内存告警的冷却判断', detectSpikes('s1', 'x', { cpuPercent: 99, memoryUsedPercent: 99 }, { now: 5000, lastSpikeTimes: { cpu: 4900 } }).map((i) => i.metric).join(',') === 'memory')
  }

  console.log('\n[4] recordSample：去抖、无数据跳过、失败隔离')
  {
    const server = {
      id: 'srv_deb',
      name: '去抖机',
      metrics: { collectedAt: iso(0), cpuUsagePercent: 30, memory: { usedBytes: 1, totalBytes: 2, usedPercent: 50 }, disk: [], load: null },
      docker: null,
    }
    const first = await recordSample(server, { source: 'manual' })
    check('首次采集被记录', first.recorded === true, first)

    const second = await recordSample(server, { source: 'manual' })
    check('间隔太短被跳过（手动连点不刷爆历史）', second.recorded === false && second.reason === 'too-soon', second)
    check('跳过时给出最小间隔', second.minGapMs === RESOURCE_MIN_GAP_MS, second)

    const none = await recordSample({ id: 'srv_empty', name: '没数据' })
    check('没采到指标时不记录', none.recorded === false && none.reason === 'no-metrics', none)

    const allNull = await recordSample({ id: 'srv_null', name: '全空', metrics: { cpuUsagePercent: null, memory: {}, disk: [] }, docker: null })
    check('全是 null 时不记录（避免噪声点）', allNull.recorded === false && allNull.reason === 'no-usable-values', allNull)

    const noId = await recordSample({})
    check('缺 serverId 时安全返回', noId.recorded === false && noId.reason === 'no-server')

    // 只有容器数据（没有系统指标）也应该记录
    const dockerOnly = await recordSample({ id: 'srv_dk', name: '只有容器', metrics: null, docker: { summary: { running: 3, cpuPercentTotal: 1.2, memoryUsedBytes: 500 } } })
    check('只有容器汇总时也能记录', dockerOnly.recorded === true, dockerOnly)
  }

  console.log('\n[5] 关键回归：采集失败时不得写入历史点（真实链路，不看源码）')
  {
    // 第一次成功采集：记 1 个点
    const server = {
      id: 'srv_fail',
      name: '会失败的机器',
      metrics: { collectedAt: iso(0), cpuUsagePercent: 20, memory: { usedBytes: 1, totalBytes: 2, usedPercent: 50 }, disk: [] },
      docker: null,
    }
    await recordSample(server, { source: 'auto' })
    check('成功采集记 1 个点', (await resourceStore.samplesFor('srv_fail')).length === 1)

    // 真实链路：建一台必然连不上的服务器，走 monitorServer 的失败分支。
    // setSshMonitor 在失败时会保留上一次的 metrics —— 若失败路径也记历史，
    // 趋势图就会出现"旧值反复出现"的假稳定，这里断言点数不变。
    const dead = await serversRepo.create({
      name: '连不上的机器',
      host: '127.0.0.1',
      sshPort: 2298,
      username: 'nobody',
      authType: 'password',
      passwordEnv: 'DSM_NO_SUCH_ENV_FOR_HISTORY_TEST',
      connectTimeout: 1200,
      logPaths: [],
      apps: [],
    })
    const before = (await resourceStore.samplesFor(dead.id)).length
    const failed = await monitorServer(dead.id, { force: true, includeDocker: true, source: 'auto' })
    const after = (await resourceStore.samplesFor(dead.id)).length

    check('这次采集确实失败了', Boolean(failed.error), failed.error)
    check('失败采集没有新增历史点', before === 0 && after === 0, { before, after })
    check('失败信息被如实记录（不静默吞掉）', Boolean((await serversRepo.get(dead.id)).ssh?.error), (await serversRepo.get(dead.id)).ssh)

    // 对照：成功链路确实会记点（用已有假 SSH 主机不现实，这里用直接调用证明不是"永远不记"）
    const ok = await recordSample({ id: dead.id, name: dead.name, metrics: { collectedAt: iso(0), cpuUsagePercent: 33, memory: { usedBytes: 1, totalBytes: 2, usedPercent: 40 }, disk: [] }, docker: null }, { source: 'auto' })
    check('显式成功记录仍能写入（说明上面是真的没记而不是写入失败）', ok.recorded === true && (await resourceStore.samplesFor(dead.id)).length === 1)
  }

  console.log('\n[6] buildSeries：空档如实返回，不插值')
  {
    const samples = [
      { at: iso(-6 * 60000), cpuPercent: 10 },
      { at: iso(-5 * 60000), cpuPercent: 20 },
      { at: iso(-4 * 60000), cpuPercent: 30 },
      { at: iso(-60 * 60000), cpuPercent: 40 }, // 往前 1 小时的大空档
      { at: iso(-59 * 60000), cpuPercent: 50 },
    ].sort((a, b) => Date.parse(a.at) - Date.parse(b.at))

    const series = buildSeries(samples, { now: Date.now() })
    check('点数正确', series.count === 5, series.count)
    check('识别出 1 处断档', series.gaps.length === 1, series.gaps)
    check('断档给出起止与时长', series.gaps[0]?.ms > 50 * 60000, series.gaps[0])
    check('断档两端点被记录', Boolean(series.gaps[0]?.from && series.gaps[0]?.to))
    check('统计量正确', series.stats.cpuPercent.min === 10 && series.stats.cpuPercent.max === 50 && series.stats.cpuPercent.samples === 5, series.stats.cpuPercent)
    check('均值 = 30', series.stats.cpuPercent.avg === 30, series.stats.cpuPercent.avg)
    // 排序后是 -60m(40) -59m(50) -6m(10) -5m(20) -4m(30)，最后一个点是 30
    check('最后一个点作为 last', series.stats.cpuPercent.last === 30, series.stats.cpuPercent.last)
    check('没有任何点的指标统计为 null', series.stats.load1 === null && series.stats.diskUsedPercent === null)
    check('空数组安全', buildSeries([], { now: Date.now() }).count === 0 && buildSeries(null).gaps.length === 0)
    check('单点不算断档', buildSeries([{ at: iso(0), cpuPercent: 1 }]).gaps.length === 0)

    const stale = buildSeries([{ at: iso(-3 * 3600000), cpuPercent: 5 }], { now: Date.now() })
    check('最后一个点太旧 -> stale=true（数据不新鲜）', stale.stale === true, stale.stale)
    const fresh = buildSeries([{ at: iso(-30000), cpuPercent: 5 }], { now: Date.now() })
    check('刚采过 -> stale=false', fresh.stale === false, fresh.stale)
  }

  console.log('\n[7] resourceStore：环形裁剪与字段白名单')
  {
    const capacity = (await resourceStore.stats()).capacityPerServer
    let lastAt = null
    for (let i = 0; i < capacity + 40; i += 1) {
      lastAt = iso(i * 1000)
      await resourceStore.addSample('srv_ring', { at: lastAt, cpuPercent: 10 + (i % 50), evil: '不该进库', nested: { x: 1 } })
    }
    const list = await resourceStore.samplesFor('srv_ring')
    check('超出容量后只保留最近 N 个', list.length === capacity, { length: list.length, capacity })
    check('淘汰的是最旧的、保留的是最新写入的', list[list.length - 1].at === lastAt, { tail: list[list.length - 1].at, lastAt })
    check('列表按时间正序', list.every((item, index) => index === 0 || Date.parse(item.at) >= Date.parse(list[index - 1].at)))
    check('白名单外的字段没进库', !('evil' in list[0]) && !('nested' in list[0]), Object.keys(list[0]))

    const windowed = await resourceStore.samplesFor('srv_ring', { windowMs: 600000 })
    check('按窗口过滤只留近期', windowed.every((item) => Date.parse(item.at) >= Date.now() - 600000))
    const limited = await resourceStore.samplesFor('srv_ring', { limit: 5 })
    check('limit 取最近的 N 个', limited.length === 5 && limited[0].at <= limited[4].at, limited.map((i) => i.at))

    const last = await resourceStore.lastSample('srv_ring')
    check('lastSample 返回最新点', last.at === list[list.length - 1].at)
    check('未知机器 lastSample 为 null', (await resourceStore.lastSample('nope')) === null)

    const cleared = await resourceStore.clear('srv_ring')
    check('按机器清空', cleared.removed === capacity && (await resourceStore.samplesFor('srv_ring')).length === 0, cleared)
  }

  console.log('\n[8] 尖峰记录与查询')
  {
    await resourceStore.addSpike({ serverId: 'srv_sp', serverName: '告警机', metric: 'cpu', value: 96, threshold: 85, message: 'CPU 96%' })
    await resourceStore.addSpike({ serverId: 'srv_sp', serverName: '告警机', metric: 'memory', value: 97, threshold: 90, message: '内存 97%' })
    await resourceStore.addSpike({ serverId: 'srv_other', serverName: '别的', metric: 'cpu', value: 99, threshold: 85, message: 'x' })

    const mine = await resourceStore.spikes({ serverId: 'srv_sp' })
    check('按机器过滤告警', mine.length === 2, mine.length)
    check('最新的排在前面', mine[0].metric === 'memory' && mine[1].metric === 'cpu', mine.map((i) => i.metric))
    check('limit 生效', (await resourceStore.spikes({ limit: 1 })).length === 1)
    check('lastSpikeAt 能读到时间', (await resourceStore.lastSpikeAt('srv_sp', 'cpu')) > 0)
    check('未知指标 lastSpikeAt 为 0', (await resourceStore.lastSpikeAt('srv_sp', 'disk')) === 0)
    check('告警字段被裁剪到合理长度', (await resourceStore.addSpike({ serverId: 'x', message: '长'.repeat(500) })).message.length <= 300)
  }

  console.log('\n[9] 并发写不丢点（第二轮 lost-update 教训的复用）')
  {
    const ids = Array.from({ length: 12 }, (_, i) => `srv_c${i}`)
    await Promise.all(ids.map((id, i) => resourceStore.addSample(id, { at: iso(i), cpuPercent: 10 + i })))
    const stats = await resourceStore.stats()
    const stored = ids.filter((id) => stats.servers.some((entry) => entry.serverId === id && entry.samples === 1)).length
    check('12 台机器并行采样各自都有 1 个点', stored === 12, { stored, servers: stats.servers.length })

    // 同一台机器并行写：不能互相覆盖
    await Promise.all(Array.from({ length: 20 }, (_, i) => resourceStore.addSample('srv_same', { at: iso(1000 + i), cpuPercent: i })))
    const same = await resourceStore.samplesFor('srv_same')
    check('同一台并行 20 次写入共 20 个点', same.length === 20, same.length)
  }

  console.log('\n[10] getHistory 组合查询')
  {
    const server = {
      id: 'srv_hist',
      name: '历史机',
      metrics: { collectedAt: iso(0), cpuUsagePercent: 91, memory: { usedBytes: 1, totalBytes: 2, usedPercent: 95 }, disk: [{ mount: '/', usePercent: 60 }] },
      docker: { summary: { running: 2, cpuPercentTotal: 4 } },
    }
    const recorded = await recordSample(server, { source: 'auto' })
    check('高负载采样被记录', recorded.recorded === true)
    check('同时产生尖峰告警', recorded.spikes.length === 2, recorded.spikes.map((s) => s.metric))

    const history = await getHistory('srv_hist', { windowMs: null })
    check('历史带采样点', history.samples.length === 1, history.samples.length)
    check('历史带序列摘要', history.series.count === 1 && history.series.stats.cpuPercent.last === 91)
    check('历史带告警', history.spikes.length === 2, history.spikes.length)
    check('空档字段存在', Array.isArray(history.series.gaps) && typeof history.series.stale === 'boolean')

    const empty = await getHistory('never-seen', {})
    check('没历史时返回空且不报错', empty.samples.length === 0 && empty.series.count === 0 && empty.spikes.length === 0)
  }

  console.log('\n[11] 记录失败绝不影响主流程（旁路语义）')
  {
    // 传入会让 structuredClone / 写盘出问题的畸形输入也不能抛
    const weird = await recordSample({ id: 'srv_weird', name: '怪', metrics: { cpuUsagePercent: Number.NaN, memory: { usedPercent: Infinity }, disk: null }, docker: undefined })
    check('NaN/Infinity 输入不抛异常', typeof weird === 'object', weird)
    const stored = await resourceStore.samplesFor('srv_weird')
    check('非法数值被清洗掉（不写 NaN 进库）', stored.every((item) => !Number.isNaN(item.cpuPercent) && item.cpuPercent !== null || item.cpuPercent === null), stored)

    const circular = { id: 'srv_circ', name: '循环引用', metrics: { cpuUsagePercent: 5, memory: { usedPercent: 5 }, disk: [] } }
    circular.metrics.self = circular
    const safe = await recordSample(circular)
    check('畸形对象不导致抛错', safe && typeof safe === 'object')
  }

  console.log('\n[12] 清空与统计')
  {
    const stats = await resourceStore.stats()
    check('stats 报告每台机器的点数与容量', Array.isArray(stats.servers) && stats.capacityPerServer > 0 && typeof stats.spikes === 'number', stats.servers.length)
    const all = await resourceStore.clear()
    check('全清返回移除数', all.removed > 0, all)
    const after = await resourceStore.stats()
    check('清空后无残留', after.servers.length === 0 && after.spikes === 0, after)
  }
} finally {
  fs.rmSync(DATA_DIR, { recursive: true, force: true })
}

console.log(`\n结果：通过 ${passed} 项，失败 ${failures.length} 项`)
if (failures.length > 0) {
  console.log(JSON.stringify(failures, null, 2))
  process.exitCode = 1
}
