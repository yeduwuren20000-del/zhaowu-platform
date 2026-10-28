/**
 * 资源归集单元测试（纯函数，不连服务器）：
 *   node server/test/project-resource.test.mjs
 *
 * 覆盖：端口自动关联、显式关联优先、拒绝按名称/跨机路径乱猜、没采集不出现、
 *       系统指标不计入合计、不同项目不串、停止容器不计入、汇总。
 */
import { aggregateProjectResources, linkServerToGroup, groupPorts, LINK_BASIS, AUTO_BASIS } from '../src/services/projectResource.js'

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

function group(overrides = {}) {
  return {
    id: 'dir:d:/projects/demo',
    name: 'demo',
    projectDir: 'D:\\projects\\demo',
    registeredProjectId: 'prj_1',
    services: [],
    project: null,
    ...overrides,
  }
}

function server(overrides = {}) {
  return {
    id: 'srv_1',
    name: '主服务器',
    host: '10.0.0.1',
    apps: [],
    ssh: { ok: true, at: '2026-10-08T10:00:00.000Z' },
    metrics: null,
    docker: null,
    ...overrides,
  }
}

function container(overrides = {}) {
  return {
    name: 'demo-web',
    image: 'nginx:latest',
    state: 'running',
    health: 'healthy',
    composeProject: '',
    composeService: '',
    ports: [],
    cpuPercent: null,
    memoryUsedBytes: null,
    memoryPercent: null,
    ...overrides,
  }
}

console.log('\n[1] 项目组端口集合（升序）')
check(
  '主端口 + 子服务端口 + 监听中的新子服务',
  JSON.stringify(
    groupPorts(
      group({
        project: { port: 5173, services: [{ port: 8000 }] },
        services: [{ live: true, port: 6006 }, { live: false, port: 9999 }],
      }),
    ),
  ) === JSON.stringify([5173, 6006, 8000]),
  groupPorts(group({ project: { port: 5173, services: [{ port: 8000 }] }, services: [{ live: true, port: 6006 }, { live: false, port: 9999 }] })),
)
check('未监听的已停止服务不计入端口', !groupPorts(group({ project: { port: 5173 }, services: [{ live: false, port: 9999 }] })).includes(9999))
check('没有端口时是空数组', groupPorts(group()).length === 0)

console.log('\n[2] 按端口自动关联容器')
{
  const srv = server({
    docker: { containers: [container({ name: 'web-1', ports: [{ published: 5173, internal: 80 }], cpuPercent: 12.5, memoryUsedBytes: 104857600 })] },
  })
  const { containers } = linkServerToGroup(group({ project: { port: 5173 } }), srv)
  check('端口命中被关联', containers.length === 1, containers)
  check('依据是"端口一致"', containers[0]?.basis === AUTO_BASIS.port, containers[0]?.basis)
  check('标记为自动关联', containers[0]?.auto === true)
  check('容器 CPU/内存原样带出', containers[0]?.cpuPercent === 12.5 && containers[0]?.memoryUsedBytes === 104857600)
}

console.log('\n[3] 按端口自动关联服务器 APP')
{
  const srv = server({ apps: [{ id: 'app_1', name: 'Demo API', port: 8000, deployPath: '/opt/demo', status: 'running' }] })
  const { servers } = linkServerToGroup(group({ project: { port: 5173, services: [{ port: 8000 }] } }), srv)
  check('子服务端口命中的 APP 被关联', servers[0]?.apps.length === 1, servers)
  check('依据是"端口一致"', servers[0]?.apps[0]?.basis === AUTO_BASIS.port)
}

console.log('\n[4] 拒绝按名称、跨机路径乱猜')
{
  const srv = server({
    apps: [{ id: 'app_1', name: 'demo', port: 9000, deployPath: '/opt/demo', status: 'running' }],
    docker: { containers: [container({ name: 'demo', composeProject: 'demo', ports: [] })] },
  })
  const linked = linkServerToGroup(group({ name: 'demo', projectDir: 'D:\\projects\\demo' }), srv)
  check('名字相同但不自动关联', linked.servers.length === 0 && linked.containers.length === 0, linked)
  check('本地 Windows 目录不与远程 Linux 部署路径比较', linked.servers.length === 0)
}

console.log('\n[5] 显式登记的关联（remoteLinks）')
{
  const srv = server({
    id: 'srv_prod',
    apps: [{ id: 'app_x', name: '线上 API', port: 9000, deployPath: '/opt/demo', status: 'running' }],
    docker: { containers: [container({ name: 'demo-api', ports: [] })] },
  })
  const g = group({ project: { port: 5173, remoteLinks: [{ serverId: 'srv_prod', appId: 'app_x', containerName: 'demo-api', note: '线上同源' }] } })
  const linked = linkServerToGroup(g, srv)
  check('显式关联的 APP 被带上', linked.servers[0]?.apps.some((item) => item.appId === 'app_x'), linked.servers[0]?.apps)
  check('显式关联的容器被带上', linked.containers.some((item) => item.name === 'demo-api'), linked.containers)
  check('显式关联的依据标为"手工登记"', linked.containers[0]?.basis === LINK_BASIS.explicit, linked.containers[0]?.basis)
  check('显式关联不算自动', linked.containers[0]?.auto === false)

  const onlyServer = group({ project: { port: 5173, remoteLinks: [{ serverId: 'srv_prod' }] } })
  check('只登记 serverId 时该机整体关联', linkServerToGroup(onlyServer, srv).servers.length === 1)

  const wrongServer = group({ project: { port: 5173, remoteLinks: [{ serverId: 'srv_other' }] } })
  check('登记到别的机器不会误关联', linkServerToGroup(wrongServer, srv).servers.length === 0)
}

console.log('\n[6] 没采集过的服务器 / 容器绝不出现（不虚构）')
{
  const result = aggregateProjectResources({
    groups: [group({ project: { port: 5173 } })],
    servers: [
      server({ id: 'srv_off', name: '离线机', ssh: { ok: false }, metrics: null, docker: null }),
      server({ id: 'srv_nodocker', name: '没 Docker 的机', metrics: { cpuUsagePercent: 10, memory: { totalBytes: 1, usedBytes: 1, usedPercent: 50 }, disk: [], at: 'x' }, docker: { containers: [] } }),
    ],
  })
  check('离线机不出现在资源列表', result.items[0].servers.every((item) => item.serverId !== 'srv_off'), result.items[0].servers)
  check('没有容器的机器不贡献容器合计', result.items[0].totals.containerCount === 0 && result.items[0].totals.hasData === false, result.items[0].totals)
  check('CPU 合计为 0 而不是估算值', result.items[0].totals.cpuPercent === 0, result.items[0].totals)
}

console.log('\n[7] 系统指标不算到项目头上')
{
  const srv = server({
    metrics: {
      at: '2026-10-08T10:00:00.000Z',
      cpuUsagePercent: 33.3,
      cpuCores: 8,
      memory: { totalBytes: 16777216, usedBytes: 8388608, usedPercent: 50 },
      disk: [{ mount: '/', totalBytes: 100, usedBytes: 50, usedPercent: 50 }],
      load: { one: 1.2, five: 1, fifteen: 0.9 },
    },
    docker: { containers: [container({ name: 'demo', ports: [{ published: 5173 }], cpuPercent: 5, memoryUsedBytes: 1024 })] },
  })
  const result = aggregateProjectResources({ groups: [group({ project: { port: 5173 } })], servers: [srv] })
  const item = result.items[0]
  check('容器 CPU 计入合计', item.totals.cpuPercent === 5, item.totals)
  check('合计口径标明"仅容器"', item.totals.scope === 'containers-only')
  check('整机 CPU 不混进合计（5 而不是 38.3）', item.totals.cpuPercent === 5)
  check('系统指标单列且标注整机', item.servers[0].system?.scope === 'system' && /整机/.test(item.servers[0].system.note))
  check('系统内存仍能看到（用于参照）', item.servers[0].system.memoryUsedBytes === 8388608)
  check('合计口径有中文说明', /不计入/.test(item.totals.note), item.totals.note)
}

console.log('\n[8] 不同项目之间不串')
{
  const srv = server({
    // 有 metrics 才会被纳入"采集过"的服务器（没采集的不参与归集）
    metrics: { at: 'x', memory: {}, disk: [], cpuUsagePercent: 1 },
    apps: [
      { id: 'a1', name: 'A', port: 5173, deployPath: '/opt/a', status: 'running' },
      { id: 'b1', name: 'B', port: 8000, deployPath: '/opt/b', status: 'running' },
    ],
  })
  const result = aggregateProjectResources({
    groups: [
      group({ id: 'dir:a', name: 'a', projectDir: 'D:\\a', project: { port: 5173 } }),
      group({ id: 'dir:b', name: 'b', projectDir: 'D:\\b', project: { port: 8000 } }),
    ],
    servers: [srv],
  })
  check('项目 A 只拿到 A 的 APP', result.items[0].servers[0]?.apps.map((item) => item.appName).join(',') === 'A', result.items[0].servers[0]?.apps)
  check('项目 B 只拿到 B 的 APP', result.items[1].servers[0]?.apps.map((item) => item.appName).join(',') === 'B', result.items[1].servers[0]?.apps)
}

console.log('\n[9] 停止的容器不计入合计')
{
  const srv = server({ docker: { containers: [container({ name: 'demo', state: 'exited', ports: [{ published: 5173 }], cpuPercent: 99 })] } })
  const result = aggregateProjectResources({ groups: [group({ project: { port: 5173 } })], servers: [srv] })
  check('停止容器不计入运行数', result.items[0].totals.runningContainerCount === 0, result.items[0].totals)
  check('停止容器的 CPU 不进合计', result.items[0].totals.cpuPercent === 0, result.items[0].totals)
}

console.log('\n[10] 未关联的服务器作为背景列出（并说明原因）')
{
  const srv = server({ id: 'srv_x', name: '别的机', host: '10.0.0.9', metrics: { cpuUsagePercent: 5, memory: {}, disk: [], at: 'x' }, docker: { containers: [] } })
  const result = aggregateProjectResources({ groups: [group({ name: 'demo', project: { port: 5173 } })], servers: [srv] })
  check('未关联机进 unlinkedServers', result.items[0].unlinkedServers.length === 1, result.items[0].unlinkedServers)
  check('给出未关联原因', /端口没对上/.test(result.items[0].unlinkedServers[0]?.reason || ''), result.items[0].unlinkedServers[0])
}

console.log('\n[11] 汇总')
{
  const result = aggregateProjectResources({
    groups: [group({ id: 'g1', name: 'demo', project: { port: 5173 } }), group({ id: 'g2', name: 'other', project: { port: 9000 } })],
    servers: [
      server({ id: 's1', metrics: { memory: {}, disk: [], at: 'x' }, docker: { containers: [container({ name: 'x', ports: [{ published: 5173 }], cpuPercent: 2, memoryUsedBytes: 100 })] } }),
      server({ id: 's2', metrics: { memory: {}, disk: [], at: 'x' }, docker: { containers: [container({ name: 'y', ports: [{ published: 9000 }], cpuPercent: 3, memoryUsedBytes: 200 })] } }),
    ],
  })
  check('汇总统计有容器的组数', result.summary.withContainers === 2, result.summary)
  check('汇总容器数', result.summary.containers === 2, result.summary)
  check('汇总 CPU = 2 + 3', result.summary.cpuPercent === 5, result.summary)
  check('汇总内存 = 100 + 200', result.summary.memoryUsedBytes === 300, result.summary)
  check('汇总记录采集到的服务器数', result.summary.collectedServers === 2 && result.summary.totalServers === 2, result.summary)
}

console.log(`\n结果：通过 ${passed} 项，失败 ${failures.length} 项`)
if (failures.length > 0) {
  console.log(JSON.stringify(failures, null, 2))
  process.exitCode = 1
}
