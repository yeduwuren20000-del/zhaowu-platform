/**
 * 自动发现端到端测试：在真实系统上扫描、登记、忽略、恢复，并验证安全边界。
 *   node server/test/discovery-e2e.test.mjs
 *
 * 覆盖：
 *   - 真实监听端口 + 真实 PID/进程名（事实字段来自系统）
 *   - 项目元数据探测（有限深度、白名单）与"绝不执行目标项目脚本"
 *   - 已登记项目自动匹配，不重复创建
 *   - 忽略 -> 记录指纹 -> 不再提示 -> 可恢复
 *   - 新服务提醒与"知道了"
 *   - AI 辅助识别：只能提供建议，事实字段不可被改写
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const DATA_DIR = path.join(os.tmpdir(), `dsm-discovery-e2e-${Date.now()}`)
fs.mkdirSync(DATA_DIR, { recursive: true })
process.env.DSM_DATA_DIR = DATA_DIR
process.env.DSM_DISCOVERY_ON_STARTUP = '0'

const { scanLocalServices, registerCandidate, ignoreCandidates, restoreCandidates, acknowledgeCandidates, getDiscoveryState } = await import('../src/services/localDiscoveryService.js')
const { projectsRepo } = await import('../src/store/projectsRepo.js')
const { discoveryRepo } = await import('../src/store/discoveryRepo.js')
const { getProcessTable } = await import('../src/services/processInspector.js')

const PORT_A = 5231 // 有项目标记（含"恶意"脚本，用于验证不被执行）
const PORT_B = 5232 // 无项目标记（用于 AI 辅助识别路径）

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
const children = []

async function waitForPort(port, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/`)
      if (response.ok) return true
    } catch {
      /* 还没起来 */
    }
    if (Date.now() > deadline) return false
    await sleep(250)
  }
}

// ---------- 准备两个被发现的"服务" ----------
const projectDir = path.join(DATA_DIR, 'malicious-app')
fs.mkdirSync(path.join(projectDir, 'src'), { recursive: true })
fs.writeFileSync(
  path.join(projectDir, 'package.json'),
  JSON.stringify(
    {
      name: 'malicious-app',
      scripts: { dev: 'vite', preinstall: 'node -e "require(\'fs\').writeFileSync(\'pwned.txt\',\'pwned\')"', postinstall: 'echo pwned > pwned.txt' },
      devDependencies: { vite: '^5.0.0' },
    },
    null,
    2,
  ),
  'utf8',
)
fs.writeFileSync(path.join(projectDir, 'src', 'index.js'), 'console.log("hello")\n', 'utf8')
fs.copyFileSync(path.join(here, 'fixture-server.mjs'), path.join(projectDir, 'fixture-server.mjs'))

const bareDir = path.join(DATA_DIR, 'bare-service')
fs.mkdirSync(bareDir, { recursive: true })
fs.copyFileSync(path.join(here, 'fixture-server.mjs'), path.join(bareDir, 'fixture-server.mjs'))

function startFixture(scriptPath, port, cwd) {
  const child = spawn(process.execPath, [scriptPath, String(port)], { cwd, stdio: 'ignore', windowsHide: true })
  children.push(child)
  return child
}

try {
  const childA = startFixture(path.join(projectDir, 'fixture-server.mjs'), PORT_A, projectDir)
  const childB = startFixture(path.join(bareDir, 'fixture-server.mjs'), PORT_B, bareDir)
  check('两个被测服务已启动', (await waitForPort(PORT_A)) && (await waitForPort(PORT_B)))

  console.log('\n[1] 扫描：事实字段来自系统')
  const processTableBefore = (await getProcessTable({ force: true })).size
  const scan = await scanLocalServices({ includeAi: false })
  const candidateA = scan.recommended.find((item) => item.port === PORT_A) || scan.candidates.find((item) => item.port === PORT_A)
  const candidateB = scan.recommended.find((item) => item.port === PORT_B) || scan.candidates.find((item) => item.port === PORT_B)

  check('扫描到监听端口', scan.summary.listeningCount > 0, scan.summary)
  check('发现被测服务 A（5231）', Boolean(candidateA), scan.candidates.filter((item) => item.port === PORT_A).length)
  check('发现被测服务 B（5232）', Boolean(candidateB))
  check('PID 与真实进程一致', candidateA?.pid === childA.pid, { expected: childA.pid, actual: candidateA?.pid })
  check('进程名来自系统', candidateA?.processName === 'node.exe' || candidateA?.processName === 'node', candidateA?.processName)
  check('监听地址来自系统', '127.0.0.1' === candidateA?.address, candidateA?.address)
  check('命令行来自系统', String(candidateA?.commandLine || '').includes('fixture-server.mjs'), candidateA?.commandLine?.slice(0, 80))
  check('启动时间来自系统', Boolean(candidateA?.startedAt), candidateA?.startedAt)
  check('识别为 Vite（项目里有 vite 依赖）', candidateA?.type === 'Vite 开发服务器', candidateA?.type)
  check('识别来源为规则层', candidateA?.source === 'rule', candidateA?.source)
  check('置信度在 0-1 之间', candidateA?.confidence > 0 && candidateA?.confidence <= 1, candidateA?.confidence)
  check('推断出项目目录', candidateA?.projectDir === projectDir, { expected: projectDir, actual: candidateA?.projectDir })
  check('给出建议启动命令', candidateA?.suggestedStartCommand === 'npm run dev', candidateA?.suggestedStartCommand)
  check('给出访问地址', candidateA?.suggestedUrl === `http://localhost:${PORT_A}`, candidateA?.suggestedUrl)
  check('未登记状态', candidateA?.registrationState === 'unregistered', candidateA?.registrationState)
  check('无项目标记的进程标记为可交给 AI', candidateB?.aiEligible === true, { type: candidateB?.type, confidence: candidateB?.confidence })

  console.log('\n[1.5] 落盘瘦身：已过滤服务只留最小字段（candidates 必须保留完整信息）')
  {
    const saved = await discoveryRepo.getLastScan()
    const savedFiltered = saved?.filtered || []
    const savedCandidates = saved?.candidates || []
    check('过滤段已落盘', savedFiltered.length > 0, savedFiltered.length)
    // 这四个字段对"已过滤"服务无用（用户不会登记它们，前端只读 summary.filtered 数字）
    const heavy = ['chain', 'commandLine', 'exePath', 'reasons', 'startedAt', 'project']
    check(
      '过滤段不再存父进程链/命令行等重字段',
      savedFiltered.every((item) => heavy.every((key) => item[key] === undefined)),
      savedFiltered.find((item) => heavy.some((key) => item[key] !== undefined)),
    )
    check('过滤段保留解释原因', savedFiltered.every((item) => typeof item.filterReason === 'string' && item.filterReason.length > 0), savedFiltered[0])
    check('过滤段保留指纹（忽略/恢复功能依赖）', savedFiltered.every((item) => typeof item.fingerprint === 'string' && item.fingerprint), savedFiltered[0]?.fingerprint)
    // candidates 是登记的依据，项目目录推断要靠父进程链，不能瘦身
    check(
      '候选段仍保留完整信息（含父进程链）',
      savedCandidates.length === 0 || savedCandidates.every((item) => Array.isArray(item.chain) || typeof item.projectDir === 'string'),
      savedCandidates[0] && Object.keys(savedCandidates[0]),
    )
    const sizeKb = Math.round(fs.statSync(path.join(DATA_DIR, 'discovery.json')).size / 1024)
    check('discovery.json 体积保持在合理范围（< 120KB）', sizeKb < 120, `${sizeKb} KB`)
  }

  console.log('\n[2] 安全边界：不执行目标项目脚本')
  check('package.json 里的 preinstall 没有被执行', !fs.existsSync(path.join(projectDir, 'pwned.txt')))
  check('没有生成 node_modules', !fs.existsSync(path.join(projectDir, 'node_modules')))
  const processTableAfter = (await getProcessTable({ force: true })).size
  // 系统进程数会有正常波动，这里只要求"没有明显增多的进程"，真正的保证是上面的 pwned.txt / node_modules 断言
  check('扫描没有额外拉起进程', processTableAfter <= processTableBefore + 3, { before: processTableBefore, after: processTableAfter })
  check('脚本名只被读取、不被运行', candidateA?.project?.stack?.scripts?.includes('preinstall') && candidateA?.project?.stack?.scripts?.includes('dev'), candidateA?.project?.stack?.scripts)

  console.log('\n[3] 登记：事实字段取自扫描结果')
  const registered = await registerCandidate({ fingerprint: candidateA.fingerprint, overrides: { name: '恶意脚本测试项目' } })
  check('登记成功', Boolean(registered.project?.id))
  check('端口来自扫描结果', registered.project.port === PORT_A, registered.project.port)
  check('目录来自扫描结果', registered.project.dir === projectDir, registered.project.dir)
  check('启动命令来自规则建议', registered.project.startCommand === 'npm run dev', registered.project.startCommand)
  check('备注标注了自动发现来源', /自动发现/.test(registered.project.remark || ''), registered.project.remark)

  const projects = await projectsRepo.list()
  check('项目已写入 projects.json', projects.some((item) => item.id === registered.project.id))

  console.log('\n[4] 重复扫描不重复创建')
  const rescan = await scanLocalServices({ includeAi: false })
  const againA = rescan.candidates.find((item) => item.port === PORT_A)
  check('候选人标记为已登记', againA?.registrationState === 'registered', againA?.registrationState)
  check('匹配方式为端口', againA?.matchedBy === '端口', againA?.matchedBy)
  check('不再出现在待登记列表', !rescan.recommended.some((item) => item.port === PORT_A))
  check('项目没有重复创建', (await projectsRepo.list()).filter((item) => item.port === PORT_A).length === 1)

  console.log('\n[5] 忽略与恢复')
  await ignoreCandidates({ fingerprints: [candidateB.fingerprint], note: '测试忽略' })
  const ignoredList = await discoveryRepo.listIgnored()
  check('忽略记录写入指纹', ignoredList.some((item) => item.fingerprint === candidateB.fingerprint))
  const scanIgnored = await scanLocalServices({ includeAi: false })
  const ignoredB = scanIgnored.candidates.find((item) => item.port === PORT_B)
  check('被忽略的服务不再出现在待登记列表', !scanIgnored.recommended.some((item) => item.port === PORT_B))
  check('被忽略的服务仍可查询到状态', ignoredB?.registrationState === 'ignored', ignoredB?.registrationState)

  await restoreCandidates({ fingerprints: [candidateB.fingerprint] })
  const scanRestored = await scanLocalServices({ includeAi: false })
  check('恢复后重新出现在待登记列表', scanRestored.recommended.some((item) => item.port === PORT_B))

  console.log('\n[6] 新服务提醒与"知道了"')
  const stateBefore = await getDiscoveryState()
  check('有未确认的新服务', stateBefore.newCount > 0, stateBefore.newCount)
  const allNew = (await discoveryRepo.getLastScan())?.newCandidates?.map((item) => item.fingerprint) || []
  await acknowledgeCandidates({ fingerprints: allNew })
  const stateAfter = await getDiscoveryState()
  check('"知道了"之后提醒清零', stateAfter.newCount === 0, stateAfter.newCount)

  console.log('\n[7] AI 辅助识别：只给建议，不改事实')
  process.env.DSM_AI_API_KEY = 'test-key'
  process.env.DSM_AI_MODEL = 'fake-model'
  const aiInputs = []
  const maliciousAi = async ({ input }) => {
    aiInputs.push(input)
    return JSON.stringify({
      serviceName: 'AI 建议的服务名',
      type: 'AI 建议的类型',
      stack: ['node'],
      purpose: '测试用途',
      suggestedStartCommand: 'node fixture-server.mjs 5232',
      confidence: 0.66,
      reasoning: '看命令行像自定义 Node 服务',
      // 下面这些是"越权"字段，必须被丢弃
      pid: 1,
      port: 1,
      projectDir: 'C:\\fake-project',
      commandLine: 'rm -rf /',
      fingerprint: 'hacked',
    })
  }
  const aiScan = await scanLocalServices({ includeAi: true, aiClient: maliciousAi })
  const aiCandidate = aiScan.candidates.find((item) => item.port === PORT_B)
  const inputForB = aiInputs.find((input) => input?.listener?.port === PORT_B)
  check('AI 确实被调用', aiScan.summary.aiApplied > 0, aiScan.summary)
  check('AI 输入只含已采集元数据', Boolean(inputForB?.process?.name) && inputForB?.listener?.port === PORT_B, inputForB?.listener)
  check('AI 输入里没有“事实之外的秘密”', inputForB && !('password' in inputForB) && !JSON.stringify(inputForB).includes('rm -rf'), Object.keys(inputForB || {}))
  check('AI 建议名称已记录', aiCandidate?.ai?.serviceName === 'AI 建议的服务名', aiCandidate?.ai?.serviceName)
  check('识别来源标注为 rule+ai', aiCandidate?.source === 'rule+ai', aiCandidate?.source)
  check('事实字段 pid 未被 AI 改写', aiCandidate?.pid === childB.pid, { expected: childB.pid, actual: aiCandidate?.pid })
  check('事实字段 port 未被 AI 改写', aiCandidate?.port === PORT_B, aiCandidate?.port)
  check('事实字段 commandLine 未被 AI 改写', !String(aiCandidate?.commandLine).includes('rm -rf'), aiCandidate?.commandLine?.slice(0, 60))
  check('事实字段 projectDir 未被 AI 改写', aiCandidate?.projectDir === null, aiCandidate?.projectDir)
  check('AI 不能自己登记项目', !(await projectsRepo.list()).some((item) => item.port === PORT_B))
  check('AI 结果已缓存，便于复用', Boolean((await discoveryRepo.getAiCache(candidateB.fingerprint))?.ai))
  delete process.env.DSM_AI_API_KEY
  delete process.env.DSM_AI_MODEL

  console.log('\n[8] 持久化格式')
  const raw = fs.readFileSync(path.join(DATA_DIR, 'discovery.json'), 'utf8')
  const parsed = JSON.parse(raw)
  check('扫描结果落盘', raw.includes('lastScan'))
  check('忽略列表按指纹存储', parsed.ignored.every((item) => typeof item.fingerprint === 'string' && item.fingerprint.length === 16))
  check('忽略条目里没有事实字段', parsed.ignored.every((item) => item.pid === undefined && item.port === undefined))
  check('候选里保留了事实字段（供登记用）', parsed.lastScan.candidates.every((item) => 'pid' in item && 'port' in item))
  check('新服务提醒列表被持久化', Array.isArray(parsed.lastScan.newCandidates))
} finally {
  for (const child of children) {
    try {
      child.kill()
    } catch {
      /* 忽略 */
    }
  }
  await sleep(300)
  fs.rmSync(DATA_DIR, { recursive: true, force: true })
}

console.log(`\n结果：通过 ${passed} 项，失败 ${failures.length} 项`)
if (failures.length > 0) {
  console.log(JSON.stringify(failures, null, 2))
  process.exitCode = 1
}
