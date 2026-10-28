/**
 * 项目 ↔ 远程服务器显式关联的端到端测试（第七阶段）：
 *   node server/test/project-link-e2e.test.mjs
 *
 * 覆盖：登记关联 -> 归集生效 -> 取消关联 -> 归集撤销；
 *       校验失败（项目/服务器不存在）返回 404；重复登记幂等；
 *       关联只接受指向已有记录的 ID 引用（sanitizeRemoteLinks）。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DATA_DIR = path.join(os.tmpdir(), `dsm-link-e2e-${Date.now()}`)
fs.mkdirSync(DATA_DIR, { recursive: true })
process.env.DSM_DATA_DIR = DATA_DIR
process.env.DSM_DISCOVERY_ON_STARTUP = '0'

const { projectsRepo } = await import('../src/store/projectsRepo.js')
const { serversRepo } = await import('../src/store/serversRepo.js')
const { setProjectRemoteLink, getProjectGroups } = await import('../src/services/localDiscoveryService.js')
const { sanitizeProjectInput, sanitizeRemoteLinks } = await import('../src/utils/validation.js')

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
  console.log('\n[1] 准备项目与服务器')
  const project = await projectsRepo.create({
    name: '本地 Demo',
    type: 'Node',
    dir: 'D:\\projects\\demo',
    startCommand: 'npm run dev',
    stopCommand: '',
    port: 5173,
    url: 'http://localhost:5173',
    remark: '',
  })
  const server = await serversRepo.create({
    name: '线上机',
    host: '10.0.0.9',
    sshPort: 22,
    username: 'ops',
    authType: 'password',
    passwordEnv: 'DSM_TEST_PASSWORD',
    connectTimeout: 5000,
    logPaths: [],
    apps: [],
  })
  check('项目与服务器已创建', Boolean(project.id) && Boolean(server.id))
  check('初始没有 remoteLinks', (project.remoteLinks || []).length === 0, project.remoteLinks)

  console.log('\n[2] 登记显式关联')
  const linked = await setProjectRemoteLink({ projectId: project.id, serverId: server.id, note: '同一套代码' })
  check('登记成功且 changed=true', linked.changed === true, linked)
  check('remoteLinks 记录一条', linked.links.length === 1, linked.links)
  check('记录里含 serverId 与备注', linked.links[0].serverId === server.id && linked.links[0].note === '同一套代码', linked.links[0])

  console.log('\n[3] 重复登记幂等')
  const again = await setProjectRemoteLink({ projectId: project.id, serverId: server.id, note: '同一套代码' })
  check('重复登记不重复写入', again.changed === false && again.links.length === 1, again)

  console.log('\n[4] 归集生效（即使端口没对上）')
  await serversRepo.setSshMonitor(server.id, {
    ssh: { ok: true, at: '2026-10-08T10:00:00.000Z', latencyMs: 12, error: null },
    metrics: {
      at: '2026-10-08T10:00:00.000Z',
      cpuUsagePercent: 41.5,
      cpuCores: 4,
      memory: { totalBytes: 16777216, usedBytes: 6710886, availableBytes: 10066329, usedPercent: 40 },
      disk: [{ mount: '/', totalBytes: 1000, usedBytes: 500, usedPercent: 50 }],
      ports: [],
    },
    listeningPorts: [],
    portAudit: null,
    docker: null,
  })
  // 造一个分组：端口与服务器 APP 完全对不上，只能靠显式关联
  const groupsView = await getProjectGroups()
  const group = groupsView.groups.find((item) => item.projectDir?.toLowerCase() === 'd:\\projects\\demo') || groupsView.groups[0]
  check('找到项目分组', Boolean(group), groupsView.groups.map((item) => item.name))
  const resource = group?.resources
  check('分组带上 resources', Boolean(resource), group && Object.keys(group))
  check('通过显式关联命中该服务器', resource?.servers?.some((item) => item.serverId === server.id) === true, resource?.servers)
  check('整机指标可见但标记为 system', resource?.servers?.[0]?.system?.scope === 'system' && resource.servers[0].system.cpuUsagePercent === 41.5, resource?.servers?.[0]?.system)
  check('项目合计不含整机指标（无容器则为 0）', resource?.totals?.cpuPercent === 0 && resource.totals.hasData === false, resource?.totals)

  console.log('\n[5] 取消关联')
  const unlinked = await setProjectRemoteLink({ projectId: project.id, serverId: server.id, remove: true })
  check('取消成功', unlinked.changed === true && unlinked.links.length === 0, unlinked)
  const afterGroups = await getProjectGroups()
  const groupAfter = afterGroups.groups.find((item) => item.projectDir?.toLowerCase() === 'd:\\projects\\demo') || afterGroups.groups[0]
  check('取消后不再关联该服务器', groupAfter?.resources?.servers?.some((item) => item.serverId === server.id) === false, groupAfter?.resources?.servers)
  check('该机回到"未关联"并给出原因', groupAfter?.resources?.unlinkedServers?.some((item) => item.serverId === server.id) === true, groupAfter?.resources?.unlinkedServers)

  console.log('\n[6] 指向具体 APP / 容器')
  const app = await serversRepo.addApp(server.id, { name: '线上 API', port: 9000, deployPath: '/opt/demo', url: '', status: 'running', remark: '' })
  await setProjectRemoteLink({ projectId: project.id, serverId: server.id, appId: app.id })
  const appLinks = (await projectsRepo.get(project.id)).remoteLinks
  check('可以登记到具体 APP', appLinks.some((link) => link.appId === app.id), appLinks)
  await setProjectRemoteLink({ projectId: project.id, serverId: server.id, appId: app.id, remove: true })
  check('按 APP 取消生效', (await projectsRepo.get(project.id)).remoteLinks.filter((link) => link.appId === app.id).length === 0)

  console.log('\n[7] 校验失败返回 notFound')
  let notFoundProject = null
  try {
    await setProjectRemoteLink({ projectId: 'prj_not_exist', serverId: server.id })
  } catch (error) {
    notFoundProject = error.status ?? error.statusCode
  }
  check('项目不存在时报 404', notFoundProject === 404, notFoundProject)
  let notFoundServer = null
  try {
    await setProjectRemoteLink({ projectId: project.id, serverId: 'srv_not_exist' })
  } catch (error) {
    notFoundServer = error.status ?? error.statusCode
  }
  check('服务器不存在时报 404', notFoundServer === 404, notFoundServer)

  console.log('\n[8] sanitizeRemoteLinks 只接受 ID 引用')
  const cleaned = sanitizeRemoteLinks([
    { serverId: 'srv_1', appId: 'app_1', containerName: 'web', note: 'ok' },
    { serverId: '' }, // 没有 serverId -> 丢弃
    { appId: 'app_2' }, // 只有 appId -> 丢弃
    'not-an-object',
  ])
  check('只保留有 serverId 的项', cleaned.length === 1 && cleaned[0].serverId === 'srv_1', cleaned)
  check('补齐 createdAt', typeof cleaned[0].createdAt === 'string' && cleaned[0].createdAt.length > 0, cleaned[0])
  check('长字段被截断', sanitizeRemoteLinks([{ serverId: 's', note: 'x'.repeat(500) }])[0].note.length <= 200)
  const viaInput = sanitizeProjectInput({ name: 'x', remoteLinks: [{ serverId: 'srv_9' }] })
  check('项目表单也能透传 remoteLinks', Array.isArray(viaInput.remoteLinks) && viaInput.remoteLinks[0].serverId === 'srv_9', viaInput.remoteLinks)
} finally {
  fs.rmSync(DATA_DIR, { recursive: true, force: true })
}

console.log(`\n结果：通过 ${passed} 项，失败 ${failures.length} 项`)
if (failures.length > 0) {
  console.log(JSON.stringify(failures, null, 2))
  process.exitCode = 1
}
