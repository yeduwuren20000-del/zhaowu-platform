/**
 * SSH 监控端到端测试：对着「假 Linux 服务器」跑完整链路。
 *   node server/test/ssh-e2e.test.mjs
 *
 * 覆盖：
 *   - 密码认证连接（密码只从环境变量读取，不落 JSON）
 *   - 采集 metrics 并核对 CPU/内存/磁盘/负载/端口
 *   - 端口三类状态（正常 / 记录未监听 / 监听未登记）
 *   - Docker 只读采集：容器、镜像、健康状态、端口映射、CPU/内存
 *   - 容器与 APP 的三类核对（已登记且运行 / 已登记但停止 / 容器存在但未登记）
 *   - 没装 Docker 与无权限访问 Docker 两种情况
 *   - SFTP 读取白名单日志尾部
 *   - 非白名单路径被拒绝
 *   - 只执行固定的两条只读脚本（无任意命令通道）
 *   - 连接被拒 / 连接超时的错误处理
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DATA_DIR = path.join(os.tmpdir(), `dsm-ssh-e2e-${Date.now()}`)
process.env.DSM_DATA_DIR = DATA_DIR
process.env.DSM_FIXTURE_PASSWORD = 'fixture-pass'

const { startFixtureSshServer, FIXTURE_LOG_PATH } = await import('./ssh-fixture-server.mjs')
const { NO_DOCKER_STDOUT, PERMISSION_DENIED_STDOUT } = await import('./fixtures/docker-output.mjs')
const { serversRepo } = await import('../src/store/serversRepo.js')
const { monitorServer, readServerLog, limiterStats } = await import('../src/services/serverMonitor.js')
const { listServerViews } = await import('../src/services/serverService.js')
const { buildMappings } = await import('../src/services/mappingService.js')

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

function approx(actual, expected, tolerance = 0.2) {
  return typeof actual === 'number' && Math.abs(actual - expected) <= tolerance
}

// 用独立端口，避免与手工联调用的假服务器（默认 2299）冲突
const FIXTURE_PORT = Number(process.env.DSM_E2E_PORT || 2311)
const fixture = await startFixtureSshServer({ port: FIXTURE_PORT, username: 'root', password: 'fixture-pass' })

try {
  console.log('\n[1] 建立服务器记录（密码只走环境变量）')
  const server = await serversRepo.create({
    name: 'Fake Linux',
    host: '127.0.0.1',
    os: 'Ubuntu 22.04',
    sshPort: FIXTURE_PORT,
    user: 'root',
    username: 'root',
    authType: 'password',
    passwordEnv: 'DSM_FIXTURE_PASSWORD',
    connectTimeout: 5000,
    monitorEnabled: true,
    logPaths: [FIXTURE_LOG_PATH],
    remark: '端到端测试用的假服务器',
  })
  await serversRepo.addApp(server.id, { name: 'Nginx', port: 80, deployPath: '/etc/nginx', status: 'running' })
  await serversRepo.addApp(server.id, { name: 'MySQL', port: 3306, deployPath: '/var/lib/mysql', status: 'running' })
  await serversRepo.addApp(server.id, { name: 'Dify Web', port: 8080, deployPath: '/opt/dify', status: 'running' })
  await serversRepo.addApp(server.id, { name: 'Redis', port: 6379, deployPath: '/var/lib/redis', status: 'stopped' })
  await serversRepo.addApp(server.id, { name: 'Ollama', port: 11434, deployPath: '/opt/ollama', status: 'stopped' })
  await serversRepo.addApp(server.id, { name: 'Legacy Web', port: 8888, deployPath: '/srv/legacy', status: 'running' })
  check('记录创建成功', Boolean(server.id))

  console.log('\n[2] SSH 采集')
  const result = await monitorServer(server.id, { force: true })
  check('连接与采集成功', result.server.ssh?.ok === true, result.server.ssh)
  check('SSH 延迟有值', Number.isFinite(result.server.ssh?.latencyMs), result.server.ssh?.latencyMs)
  check('登录用户回传', result.metrics?.loginUser === 'root', result.metrics?.loginUser)
  check('hostname', result.metrics?.hostname === 'prod-web-01', result.metrics?.hostname)
  check('操作系统', result.metrics?.os === 'Ubuntu 22.04.4 LTS', result.metrics?.os)
  check('内核与架构', result.metrics?.kernel === 'Linux 5.15.0-105-generic' && result.metrics?.arch === 'x86_64')
  check('uptime ≈ 5 天', Math.round((result.metrics?.uptimeSec || 0) / 86400) === 5, result.metrics?.uptimeSec)
  check('CPU 核数 8', result.metrics?.cpuCores === 8, result.metrics?.cpuCores)
  check('CPU 使用率 ≈ 49.4%', approx(result.metrics?.cpuUsagePercent, 49.4), result.metrics?.cpuUsagePercent)
  check('load average', JSON.stringify(result.metrics?.load) === JSON.stringify({ one: 0.42, five: 0.58, fifteen: 0.61 }), result.metrics?.load)
  check('内存 ≈ 15.6GB / 占用 37.8%', result.metrics?.memory?.totalBytes === 16702988288 && approx(result.metrics?.memory?.usedPercent, 37.8), result.metrics?.memory)
  check('磁盘包含 / 与 /data', result.metrics?.disk?.length === 3 && result.metrics.disk.some((item) => item.mount === '/data'), result.metrics?.disk?.map((item) => item.mount))
  check('真实监听端口 6 个', result.metrics?.ports?.length === 6, result.metrics?.ports?.length)

  console.log('\n[3] 端口三类状态')
  const audit = result.audit || { summary: {}, items: [] }
  check('正常 3 个（80/3306/8080）', audit.summary.ok === 3, audit.summary)
  check('记录存在但未监听 3 个（6379/11434/8888）', audit.summary.recordedNotListening === 3, audit.summary)
  check('监听但未登记 3 个（22/53/9100）', audit.summary.listeningNotRecorded === 3, audit.summary)
  const unregistered = audit.items.filter((item) => item.state === 'listeningNotRecorded').map((item) => item.port).sort((a, b) => a - b)
  check('未登记端口为 22/53/9100', JSON.stringify(unregistered) === JSON.stringify([22, 53, 9100]), unregistered)
  check('Nginx 判定为正常', audit.items.find((item) => item.appName === 'Nginx')?.state === 'ok')
  check('Redis 判定为未监听', audit.items.find((item) => item.appName === 'Redis')?.state === 'recordedNotListening')

  console.log('\n[4] 服务器视图（首页/服务器页用到的字段）')
  const view = (await listServerViews()).find((item) => item.id === server.id)
  check('监控模式为 ssh 且在线', view.monitor.mode === 'ssh' && view.monitor.online === true, view.monitor)
  check('资源摘要包含 CPU/内存/磁盘', view.resources.cpuUsagePercent === 49.4 && approx(view.resources.memory.usedPercent, 37.8) && view.resources.disk.usePercent === 20, view.resources)
  check('端口核对摘要', view.auditSummary.ok === 3 && view.auditSummary.listeningNotRecorded === 3, view.auditSummary)
  check('最近检测时间存在', Boolean(view.monitoredAt))

  console.log('\n[5] 白名单日志读取（SFTP）')
  const log = await readServerLog(server.id, FIXTURE_LOG_PATH, { lines: 50 })
  check('返回 50 行', log.lines.length === 50, log.lines.length)
  check('最后一行是第 500 条', log.lines[log.lines.length - 1].includes('#500'), log.lines[log.lines.length - 1])
  check('文件大小正确', log.size === Buffer.byteLength((await import('./fixtures/ssh-output.mjs')).SAMPLE_LOG), log.size)
  check('默认路径取白名单第一项', (await readServerLog(server.id, null, { lines: 5 })).path === FIXTURE_LOG_PATH)

  console.log('\n[6] Docker 只读采集')
  const docker = result.docker || {}
  check('识别为已安装 Docker', docker.installed === true, docker.installed)
  check('守护进程可用', docker.daemonOk === true, docker.daemonOk)
  check('Docker 版本', docker.version === '27.3.1', docker.version)
  check('容器 7 个', docker.containers?.length === 7, docker.containers?.length)
  check('镜像 7 个', docker.images?.length === 7, docker.images?.length)
  check('汇总：运行 5 / 退出 1 / 重启中 1 / 异常 1', docker.summary?.running === 5 && docker.summary?.exited === 1 && docker.summary?.restarting === 1 && docker.summary?.unhealthy === 1, docker.summary)
  check('汇总：CPU 合计 50.2%', docker.summary?.cpuPercentTotal === 50.2, docker.summary?.cpuPercentTotal)
  const webContainer = docker.containers?.find((item) => item.name === 'dify-web')
  check('容器健康状态 healthy', webContainer?.health === 'healthy', webContainer?.health)
  check('容器端口映射 8080->3000', webContainer?.ports?.some((port) => port.hostPort === 8080 && port.containerPort === 3000))
  check('容器 CPU 来自 docker stats', webContainer?.cpuPercent === 1.25, webContainer?.cpuPercent)
  check('容器内存 512MiB', webContainer?.memoryUsedBytes === 512 * 1024 * 1024, webContainer?.memoryUsedBytes)
  check('容器运行时长来自 StartedAt', Number.isFinite(webContainer?.uptimeSec) && webContainer.uptimeSec > 86400, webContainer?.uptimeSec)
  const ollamaContainer = docker.containers?.find((item) => item.name === 'ollama')
  check('异常容器与重启次数', ollamaContainer?.health === 'unhealthy' && ollamaContainer?.restartCount === 3, { health: ollamaContainer?.health, restart: ollamaContainer?.restartCount })
  const legacyContainer = docker.containers?.find((item) => item.name === 'legacy-web')
  check('已退出容器保留端口', legacyContainer?.state === 'exited' && legacyContainer?.ports?.[0]?.hostPort === 8888, legacyContainer?.ports)

  console.log('\n[7] 容器与 APP 三类核对')
  const containerAudit = docker.audit || { summary: {}, items: [] }
  check('已登记且运行 4 个', containerAudit.summary.ok === 4, containerAudit.summary)
  check('已登记但未运行 2 个（Legacy Web 已退出 + Nginx 非容器）', containerAudit.summary.recordedStopped === 2, containerAudit.summary)
  check('容器存在但未登记 2 个（dify-api / watchtower）', containerAudit.summary.containerNotRecorded === 2, containerAudit.summary)
  check('Dify Web 关联到 dify-web 容器', containerAudit.items.find((item) => item.appName === 'Dify Web')?.container?.name === 'dify-web')
  check('Legacy Web 归入已登记但停止', containerAudit.items.find((item) => item.appName === 'Legacy Web')?.state === 'recordedStopped')

  console.log('\n[8] 服务器视图与端口来源')
  const dockerView = (await listServerViews()).find((item) => item.id === server.id)
  check('视图包含 Docker 摘要', dockerView.dockerSummary?.running === 5, dockerView.dockerSummary)
  check('视图包含容器核对摘要', dockerView.dockerInfo?.audit?.containerNotRecorded === 2, dockerView.dockerInfo?.audit)
  check('视图标注容器端口来源', dockerView.dockerPorts?.['8080']?.containerName === 'dify-web', dockerView.dockerPorts?.['8080'])
  const mappings = await buildMappings()
  const port8080 = mappings.rows.find((row) => row.serverId === server.id && row.port === 8080)
  const port3306 = mappings.rows.find((row) => row.serverId === server.id && row.port === 3306)
  check('端口映射标记 Docker 来源', port8080?.source === 'docker' && port3306?.source === 'docker', { web: port8080?.source, mysql: port3306?.source })
  check('端口映射带容器名', /dify-web/.test(port8080?.sourceDetail || ''), port8080?.sourceDetail)
  check('端口统计里有 Docker 计数', mappings.stats.docker >= 4, mappings.stats.docker)

  console.log('\n[9] 安全边界')
  let blocked = null
  try {
    await readServerLog(server.id, '/etc/shadow', { lines: 10 })
  } catch (error) {
    blocked = error
  }
  check('非白名单路径被拒绝（403）', blocked?.status === 403, blocked?.message)
  check('只执行了两条固定脚本（系统指标 + Docker）', fixture.commands.length === 2, fixture.commands.length)
  check(
    '执行的命令都是白名单脚本',
    fixture.commands.every((command) => command.includes('@@S:hostname') || command.includes('@@D:docker')),
    fixture.commands.map((command) => command.slice(0, 40)),
  )
  check('没有命令被假服务器拒绝', fixture.rejectCommands.length === 0, fixture.rejectCommands)

  const raw = fs.readFileSync(path.join(DATA_DIR, 'servers.json'), 'utf8')
  check('JSON 里没有明文密码', !raw.includes('fixture-pass'))
  check('JSON 里只记录 passwordEnv', raw.includes('DSM_FIXTURE_PASSWORD'))
  check('JSON 里没有私钥正文', !raw.includes('BEGIN OPENSSH PRIVATE KEY') && !raw.includes('PRIVATE KEY'))

  console.log('\n[10] 错误处理与并发')
  const refused = await serversRepo.create({
    name: 'Closed port',
    host: '127.0.0.1',
    sshPort: FIXTURE_PORT + 1,
    username: 'root',
    authType: 'password',
    passwordEnv: 'DSM_FIXTURE_PASSWORD',
    connectTimeout: 3000,
    monitorEnabled: true,
  })
  const refusedResult = await monitorServer(refused.id, { force: true })
  check('端口未开放 -> 采集失败', refusedResult.server.ssh?.ok === false)
  check('错误码为 REFUSED', refusedResult.server.ssh?.code === 'REFUSED', refusedResult.server.ssh?.code)
  check('错误信息可读', /拒绝|refused/i.test(refusedResult.server.ssh?.error || ''), refusedResult.server.ssh?.error)

  const timeoutServer = await serversRepo.create({
    name: 'Blackhole',
    host: '10.255.255.1',
    sshPort: 22,
    username: 'root',
    authType: 'password',
    passwordEnv: 'DSM_FIXTURE_PASSWORD',
    connectTimeout: 2500,
    monitorEnabled: true,
  })
  const startedAt = Date.now()
  const timeoutResult = await monitorServer(timeoutServer.id, { force: true })
  const elapsed = Date.now() - startedAt
  check('连接超时被捕获', timeoutResult.server.ssh?.ok === false && ['TIMEOUT', 'UNREACHABLE'].includes(timeoutResult.server.ssh?.code), timeoutResult.server.ssh?.code)
  check('超时时间受 connectTimeout 约束（< 8 秒）', elapsed < 8000, elapsed)

  check('并发上限已配置', limiterStats().limit >= 1, limiterStats())

  const authFail = await serversRepo.create({
    name: 'Wrong password',
    host: '127.0.0.1',
    sshPort: FIXTURE_PORT,
    username: 'root',
    authType: 'password',
    passwordEnv: 'DSM_WRONG_PASSWORD',
    connectTimeout: 3000,
    monitorEnabled: true,
  })
  process.env.DSM_WRONG_PASSWORD = 'not-the-password'
  const authResult = await monitorServer(authFail.id, { force: true })
  check('认证失败给出明确提示', authResult.server.ssh?.ok === false && authResult.server.ssh?.code === 'AUTH_FAILED', authResult.server.ssh?.code)

  console.log('\n[11] 没装 Docker 的机器')
  const noDockerFixture = await startFixtureSshServer({ port: 2297, username: 'root', password: 'fixture-pass', dockerStdout: NO_DOCKER_STDOUT })
  try {
    const bare = await serversRepo.create({
      name: 'No Docker host',
      host: '127.0.0.1',
      sshPort: 2297,
      username: 'root',
      authType: 'password',
      passwordEnv: 'DSM_FIXTURE_PASSWORD',
      connectTimeout: 5000,
      monitorEnabled: true,
    })
    const bareResult = await monitorServer(bare.id, { force: true })
    check('系统指标仍然采集成功', bareResult.server.ssh?.ok === true)
    check('installed=false', bareResult.docker?.installed === false, bareResult.docker?.installed)
    check('容器列表为空', bareResult.docker?.containers?.length === 0, bareResult.docker?.containers?.length)
    check('提示"没有 docker 命令"', /没有 docker 命令/.test(bareResult.docker?.error || ''), bareResult.docker?.error)
  } finally {
    await noDockerFixture.close()
  }

  console.log('\n[12] Docker 无权限访问')
  const deniedFixture = await startFixtureSshServer({ port: 2296, username: 'root', password: 'fixture-pass', dockerStdout: PERMISSION_DENIED_STDOUT })
  try {
    const deniedServer = await serversRepo.create({
      name: 'Docker denied host',
      host: '127.0.0.1',
      sshPort: 2296,
      username: 'root',
      authType: 'password',
      passwordEnv: 'DSM_FIXTURE_PASSWORD',
      connectTimeout: 5000,
      monitorEnabled: true,
    })
    const deniedResult = await monitorServer(deniedServer.id, { force: true })
    check('SSH 采集本身成功', deniedResult.server.ssh?.ok === true)
    check('installed=true 但 daemonOk=false', deniedResult.docker?.installed === true && deniedResult.docker?.daemonOk === false, deniedResult.docker?.daemonOk)
    check('给出 docker 组提示', /docker 组/.test(deniedResult.docker?.error || ''), deniedResult.docker?.error)
  } finally {
    await deniedFixture.close()
  }
} finally {
  await fixture.close()
  fs.rmSync(DATA_DIR, { recursive: true, force: true })
}

console.log(`\n结果：通过 ${passed} 项，失败 ${failures.length} 项`)
if (failures.length > 0) {
  console.log(JSON.stringify(failures, null, 2))
  process.exitCode = 1
}
