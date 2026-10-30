import { normalizeLocalResources } from '../src/services/localResourceService.js'

let pass = 0
let failures = 0
function check(name, cond) {
  if (cond) {
    pass += 1
    console.log(`  ✓ ${name}`)
  } else {
    failures += 1
    console.log(`  ✗ ${name}`)
  }
}

console.log('localResource.normalizeLocalResources')

// 模拟 PowerShell ConvertTo-Json -Compress 的输出（数字为 Number，disk 为数组）
const sample = {
  hostname: 'DESKTOP-ABC',
  cpuPercent: 12.3,
  memTotalBytes: 17179869184,
  memFreeBytes: 4294967296,
  memUsedBytes: 12884801888,
  memPercent: 75,
  disks: [
    { drive: 'C:', totalBytes: 512110190592, freeBytes: 102400000000, usedBytes: 409710190592 },
    { drive: 'D:', totalBytes: 1000204886016, freeBytes: 500000000000, usedBytes: 500204886016 },
  ],
}

const out = normalizeLocalResources(sample)

check('返回对象', out && typeof out === 'object')
check('platform 标记 win32', out?.platform === 'win32')
check('hostname 透传', out?.hostname === 'DESKTOP-ABC')
check('cpuPercent 透传', out?.cpuPercent === 12.3)
check('memPercent 透传', out?.memPercent === 75)
check('内存字节透传', out?.memTotalBytes === 17179869184 && out?.memUsedBytes === 12884801888)
check(
  '磁盘聚合 used = 两盘之和',
  out?.diskUsedBytes === 409710190592 + 500204886016,
)
check(
  '磁盘聚合 total = 两盘之和',
  out?.diskTotalBytes === 512110190592 + 1000204886016,
)
check(
  '磁盘占用率 = used/total',
  Math.abs(out?.diskPercent - ((409710190592 + 500204886016) / (512110190592 + 1000204886016)) * 100) < 0.1,
)
check('disks 数组保留', Array.isArray(out?.disks) && out.disks.length === 2)

// 异常输入：拿不到任何资源时返回 null（非 win32 平台 / 空对象 / 解析失败）
check('空对象 → null', normalizeLocalResources({}) === null)
check('null → null', normalizeLocalResources(null) === null)
check('非对象 → null', normalizeLocalResources('garbage') === null)
// 只有磁盘、没有 CPU/内存：仍给出 diskPercent
check(
  '仅磁盘也能算占用率',
  (() => {
    const r = normalizeLocalResources({ disks: [{ drive: 'C:', totalBytes: 100, usedBytes: 40 }] })
    return r && r.diskPercent === 40 && r.cpuPercent === null
  })(),
)

console.log('')
if (failures === 0) {
  console.log(`全部通过：${pass} 项`)
  process.exit(0)
} else {
  console.log(`失败 ${failures} 项 / 共 ${pass + failures} 项`)
  process.exit(1)
}
