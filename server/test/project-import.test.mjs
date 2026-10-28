/**
 * 「填个前端地址就能拉起」的识别层测试。
 *   node server/test/project-import.test.mjs
 *
 * 覆盖三件事：
 *   1) 地址解析（不能把 D:\app 当网址）；
 *   2) 端口推断（scripts --port > 配置文件 > .env > 框架默认）；
 *   3) 真起一个 dev server，只给地址不填目录 —— 能不能反查出目录与端口。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'

const DATA_DIR = path.join(os.tmpdir(), `dsm-import-${Date.now()}`)
process.env.DSM_DATA_DIR = DATA_DIR
process.env.DSM_DISCOVERY_ON_STARTUP = '0'

const { parseFrontendUrl, looksLikeUrl, detectDeclaredPorts, portShiftHint, inspectProjectSource } = await import(
  '../src/services/projectImport.js'
)
const { projectsRepo } = await import('../src/store/projectsRepo.js')

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

// ---- 准备一个假的 vite 项目 ----
const PROJ = path.join(os.tmpdir(), `dsm-vite-app-${Date.now()}`)
fs.mkdirSync(path.join(PROJ, 'src'), { recursive: true })
fs.writeFileSync(
  path.join(PROJ, 'package.json'),
  JSON.stringify(
    {
      name: 'demo-vite-app',
      private: true,
      scripts: { dev: 'vite', build: 'vite build', preview: 'vite preview --port 4173' },
      devDependencies: { vite: '^5.0.0' },
    },
    null,
    2,
  ),
)
fs.writeFileSync(path.join(PROJ, 'vite.config.ts'), "export default defineConfig({ server: { port: 5301, host: true } })\n")
fs.writeFileSync(path.join(PROJ, '.env.local'), 'VITE_API=/api\nPORT=5302\n')
// 子包：模拟 monorepo 里"反查落到 server/ 子目录"的真实情况
const SUB = path.join(PROJ, 'server')
fs.mkdirSync(SUB, { recursive: true })
fs.writeFileSync(
  path.join(SUB, 'package.json'),
  JSON.stringify({ name: 'demo-server', private: true, scripts: { start: 'node server.mjs' } }, null, 2),
)
fs.writeFileSync(
  path.join(SUB, 'server.mjs'),
  `import http from 'node:http'
const port = Number(process.env.PORT) || 5399
http.createServer((req, res) => { res.writeHead(200); res.end('ok') }).listen(port, '127.0.0.1', () => console.log('up ' + port))
`,
)

let child = null

try {
  console.log('\n[1] 地址解析')
  check('http 地址能解析出端口', parseFrontendUrl('http://localhost:5173/')?.port === 5173)
  check('省略协议也能解析', parseFrontendUrl('localhost:3000/app')?.port === 3000)
  check('https 默认 443', parseFrontendUrl('https://localhost')?.port === 443)
  check('Windows 路径不当网址', parseFrontendUrl('D:\\projects\\app') === null)
  check('looksLikeUrl 区分路径与地址', looksLikeUrl('D:\\app') === false && looksLikeUrl('127.0.0.1:8080') === true)

  console.log('\n[2] 端口推断')
  const ports = detectDeclaredPorts(PROJ)
  check('识别到端口候选', ports.length >= 2, ports.map((item) => `${item.port}<-${item.source}`))
  check('配置文件端口优先于框架默认', ports[0]?.port === 5301, ports[0])
  check(
    'package.json 脚本里的 --port 也是候选',
    ports.some((item) => item.port === 4173 && item.source.includes('preview')),
    ports,
  )
  check('.env 里的 PORT 被读到', ports.some((item) => item.port === 5302), ports)
  check('空目录不报错', detectDeclaredPorts(path.join(PROJ, 'src')).length === 0)

  console.log('\n[3] 端口覆盖方式')
  check('vite 走命令行参数', portShiftHint({ command: 'npm run dev', deps: { vite: '^5' } })?.portArg === '--port {port}')
  check('CRA 只能走环境变量', portShiftHint({ command: 'npm start', deps: { 'react-scripts': '^5' } })?.portEnv === 'PORT')
  check('非服务型命令不硬加参数', portShiftHint({ command: 'node build.js', deps: { vite: '^5' } }) === null)

  console.log('\n[4] 只给目录')
  const byDir = await inspectProjectSource({ dir: PROJ })
  check('返回成功', byDir.ok === true, byDir.error)
  check('目录归一化为绝对路径', byDir.fields?.dir === path.resolve(PROJ), byDir.fields?.dir)
  check('启动命令来自 scripts.dev', byDir.fields?.startCommand === 'npm run dev', byDir.fields?.startCommand)
  check('端口取配置文件里的 5301', byDir.fields?.port === 5301, byDir.fields?.port)
  check('访问地址跟着端口生成', byDir.fields?.url === 'http://localhost:5301', byDir.fields?.url)
  check('记录了端口参数形态', Boolean(byDir.fields?.portArg), byDir.fields?.portArg)
  check('未登记时没有 knownProject', byDir.knownProject === null)
  check('候选命令带端口覆盖方式', (byDir.candidates?.startCommand || []).some((item) => item.portArg), byDir.candidates)

  console.log('\n[5] 只给地址（真起一个服务）')
  const livePort = 5401
  child = spawn(process.execPath, [path.join(SUB, 'server.mjs')], {
    cwd: SUB,
    env: { ...process.env, PORT: String(livePort) },
    stdio: 'ignore',
    windowsHide: true,
  })
  // 等端口真的监听起来（最多 10 秒）
  for (let i = 0; i < 20; i += 1) {
    await sleep(500)
    try {
      await fetch(`http://127.0.0.1:${livePort}/`, { signal: AbortSignal.timeout(800) })
      break
    } catch {
      /* 还没起来，继续等 */
    }
  }

  const byUrl = await inspectProjectSource({ url: `http://localhost:${livePort}/` })
  check('地址识别成功', byUrl.ok === true, byUrl.error)
  check('看到端口在监听', byUrl.live?.listening === true, byUrl.live)
  check('从监听进程反查到项目目录', byUrl.fields?.dir === path.resolve(SUB), byUrl.fields?.dir)
  check('端口用地址里的实际端口', byUrl.fields?.port === livePort, byUrl.fields?.port)
  check(
    '说明里讲清了反查依据',
    (byUrl.notes || []).some((note) => note.includes('反查到目录')),
    byUrl.notes,
  )

  console.log('\n[6] 地址填进目录框也能用')
  const swapped = await inspectProjectSource({ dir: `http://localhost:${livePort}` })
  check('目录框里的地址被当成地址处理', swapped.fields?.port === livePort, swapped.fields?.port)

  console.log('\n[7] 记住过就以记住的目录为准')
  // 外层整个仓库已登记：反查到 server/ 子目录时应回落，而不是凭空多一个项目
  const registered = await projectsRepo.create({
    name: 'demo-vite-app',
    type: '前端',
    dir: PROJ,
    startCommand: 'npm run dev',
    port: 5301,
    url: 'http://localhost:5301',
  })
  const remembered = await inspectProjectSource({ url: `http://localhost:${livePort}` })
  check('目录回落到已登记的外层项目', remembered.fields?.dir === path.resolve(PROJ), remembered.fields?.dir)
  check('认出这是已登记项目', remembered.knownProject?.name === 'demo-vite-app', remembered.knownProject)
  check('按记住的启动命令给建议', remembered.fields?.startCommand === 'npm run dev', remembered.fields?.startCommand)
  check(
    '说明里提到已记住',
    (remembered.notes || []).some((note) => note.includes('已登记项目「demo-vite-app」')),
    remembered.notes,
  )
  await projectsRepo.remove(registered.id)

  console.log('\n[8] 端口空闲：自动匹配它（不用先手动启动）')
  const { portScanner } = await import('../src/services/portScanner.js')
  const idlePort = 5490
  check('测试前提：该端口确实空闲', (await portScanner.isPortListening(idlePort, { force: true })) === false)
  const byIdle = await inspectProjectSource({ url: `http://localhost:${idlePort}/` })
  check('识别不再走进死路', byIdle.ok === true, byIdle.error)
  check('标记为空闲', byIdle.portPlan?.status === 'free', byIdle.portPlan)
  check('匹配到的端口就是填的那个', byIdle.portPlan?.port === idlePort, byIdle.portPlan)
  check('字段用匹配到的端口', byIdle.fields?.port === idlePort, byIdle.fields?.port)
  check('地址也用匹配到的端口', byIdle.fields?.url === `http://localhost:${idlePort}`, byIdle.fields?.url)

  console.log('\n[9] 端口被陌生进程占：自动顺延到空闲端口')
  // 一个"命令行里没有项目目录线索"的服务：没法反查，只能靠端口匹配
  const BLOCK = path.join(os.tmpdir(), `dsm-blocker-${Date.now()}`)
  fs.mkdirSync(BLOCK, { recursive: true })
  fs.copyFileSync(path.join(SUB, 'server.mjs'), path.join(BLOCK, 'server.mjs'))
  const blockerPort = 5500
  const blocker = spawn(process.execPath, [path.join(BLOCK, 'server.mjs')], {
    cwd: BLOCK,
    env: { ...process.env, PORT: String(blockerPort) },
    stdio: 'ignore',
    windowsHide: true,
  })
  for (let i = 0; i < 20; i += 1) {
    await sleep(500)
    try {
      await fetch(`http://127.0.0.1:${blockerPort}/`, { signal: AbortSignal.timeout(800) })
      break
    } catch {
      /* 还没起来，继续等 */
    }
  }
  const blocked = await inspectProjectSource({ url: `http://localhost:${blockerPort}/` })
  check('被占时仍识别成功', blocked.ok === true, blocked.error)
  check('标记为顺延', blocked.portPlan?.status === 'shifted', blocked.portPlan)
  check('顺延端口不是被占的那个', Number(blocked.portPlan?.port) !== blockerPort, blocked.portPlan)
  check(
    '顺延端口确实空闲',
    (await portScanner.isPortListening(blocked.portPlan?.port, { force: true })) === false,
    blocked.portPlan?.port,
  )
  check('说清是谁占了', Number(blocked.portPlan?.owner?.pid) > 0, blocked.portPlan?.owner)
  check('字段用顺延后的端口', Number(blocked.fields?.port) === Number(blocked.portPlan?.port), blocked.fields?.port)
  check('地址用顺延后的端口', blocked.fields?.url === `http://localhost:${blocked.portPlan?.port}`, blocked.fields?.url)

  console.log('\n[10] 被占 + 给了目录：配置端口优先，顺延端口不盖它')
  const blockedWithDir = await inspectProjectSource({ url: `http://localhost:${blockerPort}/`, dir: PROJ })
  check('端口按项目配置来（5301）', blockedWithDir.fields?.port === 5301, blockedWithDir.fields?.port)
  check('目录仍然识别到', blockedWithDir.fields?.dir === path.resolve(PROJ), blockedWithDir.fields?.dir)
  check(
    '说明里解释了为什么不用顺延端口',
    (blockedWithDir.notes || []).some((note) => note.includes('按配置的来')),
    blockedWithDir.notes,
  )
  try {
    blocker.kill('SIGTERM')
  } catch {
    /* 已退出 */
  }
  await sleep(300)
} finally {
  if (child) {
    try {
      child.kill('SIGTERM')
    } catch {
      /* 已退出 */
    }
  }
  await sleep(300)
  for (const dir of [PROJ, DATA_DIR]) {
    try {
      fs.rmSync(dir, { recursive: true, force: true })
    } catch {
      /* 清理失败不影响结论 */
    }
  }
}

// 必须和 scripts/test.mjs 的正则一致（结果：通过 N 项，失败 M 项），
// 否则汇总页会显示"通过 0 项"——测试全过但数字是假的。
console.log(`\n结果：通过 ${passed} 项，失败 ${failures.length} 项`)
if (failures.length > 0) {
  for (const item of failures) console.log(`  FAIL: ${item.name} -> ${JSON.stringify(item.detail)}`)
  process.exit(1)
}
