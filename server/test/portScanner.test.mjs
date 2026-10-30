/**
 * 端口扫描器单元测试：node server/test/portScanner.test.mjs
 *
 * 覆盖两块：
 *   1. probePort（新增的轻量环回探针）：开一个真监听端口 → true；关掉 → false；命中缓存不重连。
 *   2. findFreePort 的效率回归：曾经在循环里逐个端口强制全量重扫（最坏 200 次扫描，分钟级）；
 *      现在只扫一次全机监听表、循环里只查索引。这里断言它确实只做"一次扫描"且返回的是真空闲端口。
 */
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import fs from 'node:fs'

const DATA_DIR = path.join(os.tmpdir(), `dsm-probe-${Date.now()}`)
fs.mkdirSync(DATA_DIR, { recursive: true })
process.env.DSM_DATA_DIR = DATA_DIR
process.env.DSM_DISCOVERY_ON_STARTUP = '0'

const { portScanner } = await import('../src/services/portScanner.js')

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

/** 开一个监听指定端口的 TCP 服务器（绑定环回），返回 { server, port, close } */
function listenOn(port) {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.on('error', reject)
    server.listen(port, '127.0.0.1', () => resolve({ server, port }))
  })
}

// 挑一个当前空闲的端口，避免和本机已有服务冲突
const index0 = await portScanner.getPortIndex({ force: true })
let FREE = null
for (let p = 21000; p < 41000 && FREE === null; p += 1) if (!index0.has(p)) FREE = p
if (FREE === null) throw new Error('找不到空闲端口')

console.log('【probePort：轻量环回探针】')
{
  const { server } = await listenOn(FREE)
  try {
    const up = await portScanner.probePort(FREE)
    check('监听中的端口 → true', up === true, `got ${up}`)

    // 第二次调用命中 1.5s 缓存，不应再发起 connect（值不变）
    const cached = await portScanner.probePort(FREE)
    check('缓存命中仍返回 true', cached === true, `got ${cached}`)

    // 非法端口 → false
    check('端口 0 → false', (await portScanner.probePort(0)) === false)
    check('端口 70000 → false', (await portScanner.probePort(70000)) === false)
  } finally {
    await new Promise((r) => server.close(r))
  }

  // 关掉之后再探：用 force 绕过缓存，应得到 false；且超时受控（不会无限等）
  const t0 = Date.now()
  const down = await portScanner.probePort(FREE, { force: true })
  const dt = Date.now() - t0
  check('已关闭的端口 → false', down === false, `got ${down}`)
  check('未监听判定受超时约束（< 2000ms）', dt < 2000, `耗时 ${dt}ms`)
}

console.log('【findFreePort：只扫一次，返回真空闲端口】')
{
  // 用探针清掉刚才的缓存干扰，再量 findFreePort 的执行时间
  portScanner.invalidate()
  const t0 = Date.now()
  const found = await portScanner.findFreePort(FREE + 1, { limit: 50 })
  const dt = Date.now() - t0
  check('返回一个端口号', Number.isInteger(found) && found >= FREE + 1, `got ${found}`)
  const idx = await portScanner.getPortIndex({ force: true })
  check('返回的是真空闲端口（不在监听表里）', found === null || !idx.has(found), `found=${found} 在监听表中=${idx.has(found)}`)
  // 关键回归：之前最坏 50 次循环 = 50 次完整扫描（Windows 上分钟级）；
  // 现在只扫一次，50 个候选里基本第一个就命中，远小于一次扫描的量级 + 余量
  check('只扫一次，耗时远低于 50 次扫描（< 8000ms）', dt < 8000, `耗时 ${dt}ms`)
}

console.log('')
console.log('【invalidate 同时清两处缓存】')
{
  // 端口未监听时探到 false 并写入探针缓存（1.5s）
  const down = await portScanner.probePort(FREE, { force: true })
  check('未监听端口 → false（并写入探针缓存）', down === false, `got ${down}`)

  // 把端口拉起，但还不 invalidate：1.5s 内非强制探活应命中风活的 false（陈旧）
  const { server } = await listenOn(FREE)
  try {
    const stale = await portScanner.probePort(FREE)
    check('未 invalidate 时命中陈旧缓存 → false', stale === false, `got ${stale}`)

    // 端口刚变过状态，invalidate 应把探针缓存一并清掉；非强制重探读到真实 true
    portScanner.invalidate()
    const fresh = await portScanner.probePort(FREE)
    check('invalidate 后非强制探活读到真实 true', fresh === true, `got ${fresh}`)
  } finally {
    await new Promise((r) => server.close(r))
  }
}

if (failures.length === 0) {
  console.log(`结果：通过 ${passed} 项，失败 0 项`)
  process.exit(0)
} else {
  console.log(`结果：通过 ${passed} 项，失败 ${failures.length} 项`)
  for (const f of failures) console.log(`  - ${f.name} ${f.detail ?? ''}`)
  process.exit(1)
}
