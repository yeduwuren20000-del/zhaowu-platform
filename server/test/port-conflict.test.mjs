/**
 * 本地端口冲突判定单元测试：
 *   node server/test/port-conflict.test.mjs
 *
 * 覆盖两个真实踩坑：
 *   1. 同一个冲突被报了两遍（内容相同只是名字顺序相反）
 *   2. 父子目录的项目声明同一端口，被误报成"端口冲突"——
 *      实际上那更像是同一个服务被登记了两次，不是真的抢端口
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const DATA_DIR = path.join(os.tmpdir(), `dsm-conflict-${Date.now()}`)
fs.mkdirSync(DATA_DIR, { recursive: true })
process.env.DSM_DATA_DIR = DATA_DIR
process.env.DSM_DISCOVERY_ON_STARTUP = '0'

const { projectsRepo } = await import('../src/store/projectsRepo.js')
const { buildProjectViews } = await import('../src/services/projectService.js')
const { buildMappings } = await import('../src/services/mappingService.js')
const { portScanner } = await import('../src/services/portScanner.js')

/**
 * 挑几个当前没人监听的端口 —— 测试里的端口一律不能写死。
 * 真实踩坑：本机 3001 被另一个 node 服务占着，"无冲突"场景凭空多出一条
 * foreign 冲突，测试红了但产品是对的。用端口扫描器同一份数据挑空闲端口，
 * 口径和产品一致，也不再依赖"测试机此刻干净"。
 */
async function pickFreePorts(count) {
  const index = await portScanner.getPortIndex({ force: true })
  const out = []
  for (let port = 21000; port < 41000 && out.length < count; port += 1) {
    if (!index.has(port)) out.push(port)
  }
  if (out.length < count) throw new Error(`只找到 ${out.length} 个空闲端口，需要 ${count} 个`)
  return out
}

const [PORT_A, PORT_B, PORT_C, PORT_D, PORT_E, PORT_F, PORT_G] = await pickFreePorts(7)

let passed = 0
const failures = []

function check(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failures.push({ name, detail })
    console.log(`  ✗ ${name}`, detail ?? '')
  }
}

async function reset(projects) {
  const existing = await projectsRepo.list()
  for (const item of existing) await projectsRepo.remove(item.id)
  const created = []
  for (const p of projects) created.push(await projectsRepo.create(p))
  return created
}

console.log('【父子目录 + 同端口 → 疑似重复登记，不是真冲突】')
{
  const [parent, child] = await reset([
    { name: 'DevServerManager', dir: 'D:\\workspaces\\DevServerManager', port: 5180, type: 'React + Vite' },
    { name: 'dev-server-manager-web', dir: 'D:\\workspaces\\DevServerManager\\web', port: 5180, type: 'Vite 开发服务器' },
  ])
  const views = await buildProjectViews({ force: false })
  const mapping = await buildMappings({ projectViews: views, servers: [] })

  check('两项目都标记为疑似重复登记', views.every((v) => v.status === 'possible-duplicate'), views.map((v) => `${v.name}:${v.status}`))
  check('不是 conflict 状态', views.every((v) => v.status !== 'conflict'), views.map((v) => v.status))
  check('状态文案不是"端口冲突"', views.every((v) => v.statusText === '疑似重复登记'), views.map((v) => v.statusText))

  check('只产生 1 条冲突（不是每个项目一条）', mapping.conflicts.length === 1, mapping.conflicts)
  const c = mapping.conflicts[0]
  check('冲突类型是 duplicate-registration', c.type === 'duplicate-registration', c)
  check('标记了 duplicateRegistration', c.duplicateRegistration === true, c)
  check('文案点明是父子目录关系', /目录在.*之内/.test(c.message), c.message)
  check('文案点明不是真的冲突', /不是真的端口冲突/.test(c.message), c.message)
  check('文案包含两个项目名', c.message.includes('DevServerManager') && c.message.includes('dev-server-manager-web'), c.message)
}

console.log('\n【文案稳定：不受遍历顺序影响】')
{
  const again = await buildMappings({ projectViews: await buildProjectViews({ force: false }), servers: [] })
  const first = again.conflicts[0]?.message
  // 反转项目顺序重建，文案必须一字不差
  await reset([
    { name: 'dev-server-manager-web', dir: 'D:\\workspaces\\DevServerManager\\web', port: 5180, type: 'Vite 开发服务器' },
    { name: 'DevServerManager', dir: 'D:\\workspaces\\DevServerManager', port: 5180, type: 'React + Vite' },
  ])
  const reversed = await buildMappings({ projectViews: await buildProjectViews({ force: false }), servers: [] })
  check('反转登记顺序后文案不变', reversed.conflicts[0]?.message === first, { before: first, after: reversed.conflicts[0]?.message })
  check('反转后仍然只有 1 条', reversed.conflicts.length === 1, reversed.conflicts.length)
}

console.log('\n【互不相关的目录 + 同端口 → 仍然是真冲突】')
{
  await reset([
    { name: '项目甲', dir: 'D:\\workspaces\\alpha', port: PORT_A },
    { name: '项目乙', dir: 'D:\\workspaces\\beta', port: PORT_A },
  ])
  const views = await buildProjectViews({ force: false })
  const mapping = await buildMappings({ projectViews: views, servers: [] })
  check('状态是 conflict', views.every((v) => v.status === 'conflict'), views.map((v) => v.status))
  check('状态文案是端口冲突', views.every((v) => v.statusText === '端口重复声明'), views.map((v) => v.statusText))
  check('只有 1 条冲突', mapping.conflicts.length === 1, mapping.conflicts)
  check('类型是真冲突 duplicate', mapping.conflicts[0].type === 'duplicate', mapping.conflicts[0])
  check('未标记 duplicateRegistration', mapping.conflicts[0].duplicateRegistration !== true, mapping.conflicts[0])
  // 只验证两个名字都出现，不强求顺序：排序是为了文案稳定，不是为了让甲排在乙前面
  check('文案列出两个项目名', mapping.conflicts[0].message.includes('项目甲') && mapping.conflicts[0].message.includes('项目乙'), mapping.conflicts[0].message)
  check('文案不含父子目录说法', !/目录在/.test(mapping.conflicts[0].message), mapping.conflicts[0].message)
}

console.log('\n【三个项目抢同一端口：仍然只报一条】')
{
  await reset([
    { name: 'A 项目', dir: 'D:\\w\\a', port: PORT_B },
    { name: 'B 项目', dir: 'D:\\w\\b', port: PORT_B },
    { name: 'C 项目', dir: 'D:\\w\\c', port: PORT_B },
  ])
  const mapping = await buildMappings({ projectViews: await buildProjectViews({ force: false }), servers: [] })
  check('3 个项目 → 只有 1 条冲突', mapping.conflicts.length === 1, mapping.conflicts.length)
  check('文案数量正确（3 个）', /3 个项目声明/.test(mapping.conflicts[0].message), mapping.conflicts[0].message)
  check('名字按序排列', /A 项目、B 项目、C 项目/.test(mapping.conflicts[0].message), mapping.conflicts[0].message)
}

console.log('\n【无冲突时不该产生任何条目】')
{
  await reset([
    { name: '项目甲', dir: 'D:\\workspaces\\alpha', port: PORT_C },
    { name: '项目乙', dir: 'D:\\workspaces\\beta', port: PORT_D },
  ])
  const views = await buildProjectViews({ force: false })
  const mapping = await buildMappings({ projectViews: views, servers: [] })
  check('无冲突条目', mapping.conflicts.length === 0, mapping.conflicts)
  check('状态正常', views.every((v) => v.status !== 'conflict' && v.status !== 'possible-duplicate'), views.map((v) => v.status))
}

console.log('\n【目录完全相同 ≠ 重复登记，仍是真冲突】')
{
  // 同一份代码、同一个端口起两个实例 —— 这是真实的端口抢占，必须如实报出来。
  // （events-e2e 也锁着这个行为：新状态别把它吞掉。）
  await reset([
    { name: '实例 A', dir: 'D:\\workspaces\\same', port: PORT_E },
    { name: '实例 B', dir: 'D:\\workspaces\\same', port: PORT_E },
  ])
  const views = await buildProjectViews({ force: false })
  const mapping = await buildMappings({ projectViews: views, servers: [] })
  check('目录相同仍判为 conflict', views.every((v) => v.status === 'conflict'), views.map((v) => `${v.name}:${v.status}`))
  check('状态文案是端口重复声明', views.every((v) => v.statusText === '端口重复声明'), views.map((v) => v.statusText))
  check('冲突类型是真冲突', mapping.conflicts[0]?.type === 'duplicate', mapping.conflicts[0])
  check('不标记为重复登记', mapping.conflicts[0]?.duplicateRegistration !== true, mapping.conflicts[0])
}

console.log('\n【目录大小写与斜杠差异不应误判成父子】')
{
  // D:\Workspaces\app 与 d:/workspaces/app 是同一个目录（Windows 不区分大小写）
  await reset([
    { name: '父项目', dir: 'D:\\Workspaces\\app', port: PORT_F },
    { name: '子项目', dir: 'd:/workspaces/app/web', port: PORT_F },
  ])
  const mapping = await buildMappings({ projectViews: await buildProjectViews({ force: false }), servers: [] })
  check('大小写/斜杠不同仍识别为父子', mapping.conflicts[0]?.type === 'duplicate-registration', mapping.conflicts[0])
}

console.log('\n【非父子但前缀相同不应误判】')
{
  // \workspaces\app 与 \workspaces\application 不是父子关系
  await reset([
    { name: '项目 app', dir: 'D:\\workspaces\\app', port: PORT_G },
    { name: '项目 application', dir: 'D:\\workspaces\\application', port: PORT_G },
  ])
  const mapping = await buildMappings({ projectViews: await buildProjectViews({ force: false }), servers: [] })
  check('application 不是 app 的子目录', mapping.conflicts[0]?.type === 'duplicate', mapping.conflicts[0])
}

const existing = await projectsRepo.list()
for (const item of existing) await projectsRepo.remove(item.id)
fs.rmSync(DATA_DIR, { recursive: true, force: true })

console.log(`\n结果：通过 ${passed} 项，失败 ${failures.length} 项`)
if (failures.length > 0) {
  console.log(JSON.stringify(failures.slice(0, 12), null, 2))
  process.exitCode = 1
}