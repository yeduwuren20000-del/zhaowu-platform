#!/usr/bin/env node
/**
 * 把 pan.py 的「源头仓库」同步进 tools/panlink（工作台内嵌副本）。
 *
 *   node scripts/sync-panlink.mjs <源目录>          # 同步
 *   node scripts/sync-panlink.mjs <源目录> --check  # 只比对，不写文件（有漂移退出 1）
 *   DSM_PAN_SRC=<源目录> node scripts/sync-panlink.mjs
 *
 * 为什么要这个脚本：tools/panlink 是**副本**，源头那份在另一处维护。
 * 上一版就吃过亏——工作台里是 8 家网盘，源头已经 10 家，界面上的「支持 8 家」
 * 和实际能力长期不一致，而且没人发现。手工 cp 也会漏（新增的模块忘了拷，
 * 表现为「解析时报 ImportError」）。所以同步这件事必须是**一条命令 + 有清单**。
 *
 * 只覆盖 pan.py 与 pans/*.py：工作台不需要源头的 tests/ 与文档
 * （它们跟随源头跑，拷进来只会让两份测试各自漂移）。
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, '..')
const TARGET = path.join(ROOT, 'tools', 'panlink')
const MANIFEST = path.join(TARGET, 'SYNC.json')

const args = process.argv.slice(2)
const checkOnly = args.includes('--check')
const source = args.find((item) => !item.startsWith('-')) || process.env.DSM_PAN_SRC

if (!source) {
  console.error('用法：node scripts/sync-panlink.mjs <源目录> [--check]')
  console.error('  源目录即 pan.py 所在目录（应包含 pan.py 与 pans/base.py）')
  process.exit(2)
}

const SRC = path.resolve(source)
const srcPan = path.join(SRC, 'pan.py')
const srcPans = path.join(SRC, 'pans')

function fail(message, code = 1) {
  console.error(`✗ ${message}`)
  process.exit(code)
}

if (!fs.existsSync(srcPan)) fail(`源目录里没有 pan.py：${srcPan}`)
if (!fs.existsSync(path.join(srcPans, 'base.py'))) fail(`源目录里没有 pans/base.py：${srcPans}`)

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 16)

/** 收集要同步的文件：pan.py + pans/*.py（不递归，pans 是平铺模块目录） */
function collect(dir, prefix = '') {
  const out = new Map()
  for (const name of fs.readdirSync(dir)) {
    if (!name.endsWith('.py')) continue
    const full = path.join(dir, name)
    if (!fs.statSync(full).isFile()) continue
    out.set(prefix + name, full)
  }
  return out
}

const wanted = new Map([['pan.py', srcPan], ...collect(srcPans, 'pans/')])
// 清单里只记相对路径：绝对路径会把开发机的目录结构带进仓库
const relSource = path.relative(ROOT, SRC)
const sourceLabel = !relSource || relSource.startsWith('..') || path.isAbsolute(relSource) ? '<外部源目录>' : relSource
const manifest = { source: sourceLabel, syncedAt: new Date().toISOString(), files: {} }
let copied = 0
let same = 0
const drift = []

for (const [rel, from] of wanted) {
  const to = path.join(TARGET, rel)
  const srcBuf = fs.readFileSync(from)
  const hash = sha(srcBuf)
  const exists = fs.existsSync(to)
  const previous = exists ? sha(fs.readFileSync(to)) : null
  manifest.files[rel] = hash

  if (previous === hash) {
    same += 1
    continue
  }
  drift.push({ rel, previous, next: hash })
  if (checkOnly) continue
  fs.mkdirSync(path.dirname(to), { recursive: true })
  fs.writeFileSync(to, srcBuf)
  copied += 1
}

// 源头已删除、副本还留着的模块：不清理会变成幽灵 provider（永远不被 import，
// 但有人改错地方时排查会先看它，浪费半天）
const stale = []
const targetPansDir = path.join(TARGET, 'pans')
if (fs.existsSync(targetPansDir)) {
  for (const name of fs.readdirSync(targetPansDir)) {
    if (!name.endsWith('.py')) continue
    if (wanted.has(`pans/${name}`)) continue
    stale.push(`pans/${name}`)
    if (!checkOnly) fs.rmSync(path.join(targetPansDir, name), { force: true })
  }
}
for (const dir of [TARGET, targetPansDir]) {
  const cache = path.join(dir, '__pycache__')
  if (!checkOnly && fs.existsSync(cache)) fs.rmSync(cache, { recursive: true, force: true })
}

if (checkOnly) {
  if (drift.length === 0 && stale.length === 0) {
    console.log(`✓ 无漂移：${wanted.size} 个文件与源目录一致（${SRC}）`)
    process.exit(0)
  }
  console.log(`✗ 有漂移：${drift.length} 个文件内容不同，${stale.length} 个多余文件`)
  for (const item of drift) console.log(`   ~ ${item.rel}  ${item.previous || '(缺失)'} -> ${item.next}`)
  for (const item of stale) console.log(`   - ${item}（源目录已无此模块）`)
  process.exit(1)
}

manifest.stale = stale
fs.writeFileSync(MANIFEST, `${JSON.stringify(manifest, null, 2)}\n`)

console.log(`源目录：${SRC}`)
console.log(`目标：  ${TARGET}`)
console.log(`写入 ${copied} 个 / 未变 ${same} 个 / 清理多余 ${stale.length} 个`)
if (copied > 0) {
  for (const item of drift) console.log(`   + ${item.rel}`)
}
for (const item of stale) console.log(`   - ${item}`)
console.log(`清单：${path.relative(ROOT, MANIFEST)}（含每个文件的内容指纹，便于事后比对）`)
console.log('\n提示：同步后请跑一次 `npm test -- pans`，它会验证副本仍满足工作台用到的 CLI 契约。')
