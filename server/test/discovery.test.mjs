/**
 * 自动发现单元测试（不联网、不依赖真实系统状态）：
 *   node server/test/discovery.test.mjs
 *
 * 覆盖：
 *   - projectDetector：有限深度、白名单文件、体积上限、不可信目录（node_modules/AppData）拒绝、**不执行任何脚本**
 *   - serviceClassifier：常见服务的规则识别、系统进程/保留端口/编辑器/装机软件过滤、指纹稳定性
 *   - aiIdentifier：AI 只能填建议字段，事实字段（PID/端口/路径/命令行）不可被改写；未配置时不调用
 *   - processInspector：命令行解析、路径候选、父进程 cd 提示、exe 目录推断
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const ROOT = path.join(os.tmpdir(), `dsm-discovery-unit-${Date.now()}`)

const { detectProject, findProjectRoot, probeDirectory, isPlausibleProjectRoot, summarizePackageJson, summarizeCompose } = await import('../src/services/projectDetector.js')
const { classifyService, buildFingerprint, SYSTEM_PROCESSES, NON_DEV_HINTS } = await import('../src/services/serviceClassifier.js')
const { mergeAiSuggestion, identifyService, identifyCandidates, buildAiInput, aiConfig, FACT_FIELDS } = await import('../src/services/aiIdentifier.js')
const { tokenizeCommandLine, extractPathCandidates, extractCdHints, inferDirsFromExe, inferCandidateDirs, getProcessTable, buildParentChain } = await import('../src/services/processInspector.js')

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

function write(relative, content) {
  const file = path.join(ROOT, relative)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, content, 'utf8')
  return file
}

// ---------- 准备测试用的项目目录树 ----------
write('my-app/package.json', JSON.stringify({ name: 'my-app', version: '1.0.0', private: true, scripts: { dev: 'vite', build: 'vite build', test: 'vitest' }, devDependencies: { vite: '^5.0.0', react: '^18.0.0', vitest: '^1.0.0' } }, null, 2))
write('my-app/vite.config.js', 'export default { server: { port: 5173 } }\n')
write('my-app/src/index.js', 'console.log(1)\n')
write('my-app/secret-notes.txt', '不该被读取\n')
write('my-app/node_modules/some-lib/package.json', JSON.stringify({ name: 'some-lib' }))

write('py-app/pyproject.toml', '[project]\nname = "py-app"\ndependencies = ["fastapi", "uvicorn"]\n')
write('py-app/main.py', 'print("hi")\n')

write('deep/a/b/c/d/e/f/g/package.json', JSON.stringify({ name: 'too-deep' }))
write('compose-app/docker-compose.yml', 'services:\n  web:\n    image: nginx\n    ports:\n      - "8080:80"\n  db:\n    image: mysql\n')
write('fake-app/package.json', JSON.stringify({ name: 'fake-app' }))
write('AppData/Local/some-tool/package.json', JSON.stringify({ name: 'tool-inside-appdata' }))
write('malicious/package.json', JSON.stringify({ name: 'malicious', scripts: { preinstall: 'node -e "require(\'fs\').writeFileSync(\'pwned.txt\',\'x\')"', postinstall: 'echo pwned > pwned.txt' } }))
write('big/package.json', `{"name":"big","padding":"${'x'.repeat(5000)}"}`)

const tempRoot = ROOT

try {
  console.log('\n[1] 项目元数据探测')
  const myApp = detectProject([{ dir: path.join(ROOT, 'my-app', 'src'), source: 'test', confidence: 0.9 }])
  check('从子目录向上找到项目根', myApp.root === path.join(ROOT, 'my-app'), myApp.root)
  check('识别到 package.json 与 vite.config.js', myApp.markers.includes('package.json') && myApp.markers.includes('vite.config.js'), myApp.markers)
  check('解析出项目名', myApp.stack.packageName === 'my-app', myApp.stack?.packageName)
  check('解析出 scripts 名称（不执行）', JSON.stringify(myApp.stack.scripts) === JSON.stringify(['dev', 'build', 'test']), myApp.stack.scripts)
  check('解析出关键依赖', myApp.stack.dependencies.includes('vite') && myApp.stack.dependencies.includes('react'), myApp.stack.dependencies)
  check('可判定为 Node 项目', myApp.stack.kinds.includes('node'), myApp.stack.kinds)

  const probed = probeDirectory(path.join(ROOT, 'my-app'))
  check('只读白名单文件', !probed.markers.includes('secret-notes.txt') && !probed.files['secret-notes.txt'], Object.keys(probed.files))
  check('不递归 node_modules', !probed.markers.some((marker) => marker.includes('node_modules')), probed.markers)

  const pyApp = detectProject([{ dir: path.join(ROOT, 'py-app'), source: 'test', confidence: 0.9 }])
  check('识别 Python 项目', pyApp.stack.kinds.includes('python') && pyApp.stack.python?.hints?.includes('fastapi'), pyApp.stack?.python)

  const compose = detectProject([{ dir: path.join(ROOT, 'compose-app'), source: 'test', confidence: 0.9 }])
  check('识别 docker-compose 及其服务与端口', compose.stack.compose?.services?.includes('web') && compose.stack.compose?.publishedPorts?.includes(8080), compose.stack?.compose)
  check('docker-compose 项目同样有 Dockerfile 判定字段', compose.hasDockerfile === false, compose.hasDockerfile)

  console.log('\n[2] 有限深度与不可信目录')
  const tooDeep = findProjectRoot(path.join(ROOT, 'deep', 'a', 'b', 'c'), { maxUp: 3 })
  check('超过 maxUp 深度不误判', tooDeep === null, tooDeep?.root)
  const deepEnough = findProjectRoot(path.join(ROOT, 'deep', 'a', 'b', 'c', 'd', 'e', 'f', 'g'), { maxUp: 6 })
  check('在允许深度内可以找到', deepEnough?.root.endsWith('too-deep') || deepEnough?.root.endsWith('g'), deepEnough?.root)

  check('node_modules 不视为项目根', isPlausibleProjectRoot(path.join(ROOT, 'my-app', 'node_modules', 'some-lib')) === false)
  check('AppData 下不视为项目根', isPlausibleProjectRoot('C:\\Users\\x\\AppData\\Local\\app') === false)
  const inNodeModules = detectProject([{ dir: path.join(ROOT, 'my-app', 'node_modules', 'some-lib'), source: 'test', confidence: 0.9 }])
  check('node_modules 里的 package.json 不作为项目根（继续向上找到真正项目）', inNodeModules.root === path.join(ROOT, 'my-app'), inNodeModules.root)
  const inAppData = detectProject([{ dir: path.join(ROOT, 'AppData', 'Local', 'some-tool'), source: 'test', confidence: 0.9 }])
  check('AppData 下的 package.json 不被当成项目', inAppData.root === null, inAppData.root)

  console.log('\n[3] 只读保证：不执行任何脚本')
  const malicious = detectProject([{ dir: path.join(ROOT, 'malicious'), source: 'test', confidence: 0.9 }])
  check('能读出 scripts 名称', malicious.stack.scripts.includes('preinstall') && malicious.stack.scripts.includes('postinstall'), malicious.stack.scripts)
  check('package.json 里的脚本没有被执行（没有 pwned.txt）', !fs.existsSync(path.join(ROOT, 'malicious', 'pwned.txt')))
  check('node_modules 没有被创建', !fs.existsSync(path.join(ROOT, 'malicious', 'node_modules')))

  const bigProbed = probeDirectory(path.join(ROOT, 'big'), { maxBytes: 1024 })
  check('超过体积上限的文件被跳过', bigProbed.files['package.json']?.skipped === '文件过大，已跳过', bigProbed.files['package.json'])

  console.log('\n[4] package.json / compose 摘要')
  const summary = summarizePackageJson('{"name":"x","scripts":{"dev":"vite"},"dependencies":{"express":"^4"}}')
  check('摘要解析脚本与依赖', summary.scripts.includes('dev') && summary.dependencies.interesting.includes('express') && summary.dependencies.total === 1, summary)
  check('坏 JSON 不抛错', summarizePackageJson('{ not json').parseError !== undefined)
  check('compose 摘要', summarizeCompose('services:\n  api:\n    build: .\n  db:\n    image: redis\n').services.length === 2)

  console.log('\n[5] 服务分类规则')
  const cases = [
    { name: 'Vite 开发服务器', ctx: { port: 5173, processName: 'node.exe', commandLine: '"node" "D:\\proj\\node_modules\\vite\\bin\\vite.js"', project: { root: 'D:\\proj', markers: ['package.json', 'vite.config.js'], stack: { kinds: ['node'], scripts: ['dev'], dependencies: ['vite'] } } }, expect: { type: 'Vite 开发服务器', category: 'dev-server', filtered: false, start: 'npm run dev' } },
    { name: 'Next.js', ctx: { port: 3000, processName: 'node.exe', commandLine: 'node next dev', project: { root: 'D:\\next-app', markers: ['package.json', 'next.config.js'], stack: { kinds: ['node'], scripts: ['dev'], dependencies: ['next'] } } }, expect: { type: 'Next.js', filtered: false } },
    { name: 'Express', ctx: { port: 4000, processName: 'node.exe', commandLine: 'node app.js', project: { root: 'D:\\api', markers: ['package.json'], stack: { kinds: ['node'], scripts: ['start'], dependencies: ['express'] } } }, expect: { type: 'Node 服务（Express）', filtered: false, start: 'npm run start' } },
    { name: 'FastAPI', ctx: { port: 8000, processName: 'python.exe', commandLine: 'python -m uvicorn main:app --port 8000', project: null }, expect: { type: 'FastAPI', category: 'dev-server', filtered: false } },
    { name: 'Flask', ctx: { port: 5000, processName: 'python.exe', commandLine: 'python app.py', project: { root: 'D:\\flask', markers: ['requirements.txt'], stack: { kinds: ['python'], scripts: [], dependencies: [] } }, }, expect: { type: 'Python 服务', filtered: false } },
    { name: 'Django（manage.py）', ctx: { port: 8000, processName: 'python.exe', commandLine: 'python manage.py runserver 8000', project: null }, expect: { type: 'Django', filtered: false, start: 'python manage.py runserver 8000' } },
    { name: 'Spring Boot', ctx: { port: 8080, processName: 'java.exe', commandLine: 'java -jar target\\app.jar --spring.profiles.active=dev', project: { root: 'D:\\spring', markers: ['pom.xml'], stack: { kinds: ['jvm'], scripts: [], dependencies: [] } } }, expect: { type: 'Spring Boot', filtered: false, start: 'mvn spring-boot:run' } },
    { name: 'MySQL', ctx: { port: 3306, processName: 'mysqld.exe', commandLine: '', project: null }, expect: { type: 'MySQL / MariaDB', category: 'database', filtered: false, url: null } },
    { name: 'Redis', ctx: { port: 6379, processName: 'redis-server.exe', commandLine: '', project: null }, expect: { type: 'Redis', category: 'database', filtered: false } },
    { name: 'PostgreSQL', ctx: { port: 5432, processName: 'postgres.exe', commandLine: '', project: null }, expect: { type: 'PostgreSQL', category: 'database', filtered: false } },
    { name: 'MongoDB', ctx: { port: 27017, processName: 'mongod.exe', commandLine: '', project: null }, expect: { type: 'MongoDB', category: 'database', filtered: false } },
    { name: 'Ollama', ctx: { port: 11434, processName: 'ollama.exe', commandLine: '', project: null }, expect: { type: 'Ollama', category: 'ai-service', filtered: false } },
    { name: 'Nginx', ctx: { port: 80, processName: 'nginx.exe', commandLine: '', project: null }, expect: { type: 'Nginx', category: 'web-server', filtered: false } },
    { name: 'Docker 端口代理', ctx: { port: 8080, processName: 'com.docker.backend.exe', commandLine: '', project: null }, expect: { type: 'Docker 容器端口（宿主机代理）', category: 'container', filtered: false } },
    { name: '进程名 docker-proxy', ctx: { port: 5432, processName: 'docker-proxy.exe', commandLine: '', project: null }, expect: { category: 'container', filtered: false } },
    { name: '系统进程 svchost', ctx: { port: 49668, processName: 'svchost.exe', commandLine: '', project: null }, expect: { filtered: true, reason: '系统进程' } },
    { name: '系统进程 lsass', ctx: { port: 49670, processName: 'lsass.exe', commandLine: '', project: null }, expect: { filtered: true } },
    { name: '动态 RPC 端口 + 非开发进程', ctx: { port: 58226, processName: 'Code.exe', commandLine: '', project: null }, expect: { filtered: true } },
    { name: '系统保留端口 445', ctx: { port: 445, processName: 'unknown-thing.exe', commandLine: '', project: null }, expect: { filtered: true, reason: '保留端口' } },
    { name: '装机软件（QQ）', ctx: { port: 50006, processName: 'QQLiveService.exe', commandLine: '', project: null }, expect: { filtered: true, reason: '非开发' } },
    { name: '代理工具 mihomo', ctx: { port: 7890, processName: 'mihomo.exe', commandLine: '', project: null }, expect: { filtered: true } },
    { name: '编辑器 VS Code', ctx: { port: 60943, processName: 'Code.exe', commandLine: 'Code.exe --type=utility', project: null }, expect: { filtered: true, reason: '编辑器' } },
    { name: '未知常驻程序（svr 后缀）', ctx: { port: 5283, processName: 'SomeToolSvr.exe', commandLine: '', project: null }, expect: { filtered: true, reason: '常驻' } },
    { name: '已知装机软件名（android 模拟器服务）', ctx: { port: 5283, processName: 'AndrowsSvr.exe', commandLine: '', project: null }, expect: { filtered: true } },
    { name: '未知监听服务', ctx: { port: 45678, processName: 'weird-thing.exe', commandLine: '', project: null }, expect: { filtered: false, type: '未知监听服务' } },
  ]

  for (const item of cases) {
    const result = classifyService({ chain: [], address: '0.0.0.0', ...item.ctx })
    let ok = true
    let detail = {}
    if (item.expect.type && result.type !== item.expect.type) ok = false
    if (item.expect.category && result.category !== item.expect.category) ok = false
    if (item.expect.filtered !== undefined && result.filtered !== item.expect.filtered) ok = false
    if (item.expect.start && result.suggestedStartCommand !== item.expect.start) ok = false
    if (item.expect.url === null && result.suggestedUrl !== null) ok = false
    if (item.expect.reason && !String(result.filterReason || '').includes(item.expect.reason)) ok = false
    if (!ok) detail = { type: result.type, category: result.category, filtered: result.filtered, reason: result.filterReason, start: result.suggestedStartCommand, url: result.suggestedUrl }
    check(`规则：${item.name}`, ok, ok ? undefined : detail)
  }

  const vite = classifyService({ port: 5173, processName: 'node.exe', commandLine: 'vite', project: { root: 'D:\\p', markers: ['package.json', 'vite.config.js'], stack: { kinds: ['node'], scripts: ['dev'], dependencies: ['vite'] } }, chain: [], address: '127.0.0.1' })
  const unknown = classifyService({ port: 45678, processName: 'weird.exe', commandLine: '', project: null, chain: [], address: '0.0.0.0' })
  check('证据充分时置信度更高', vite.confidence > unknown.confidence, { vite: vite.confidence, unknown: unknown.confidence })
  check('证据充分时不需要 AI', vite.aiEligible === false, vite.aiEligible)
  check('识别不出时标记为可交给 AI', unknown.aiEligible === true, unknown.aiEligible)
  check('可执行文件类型也返回 http 访问地址', vite.suggestedUrl === 'http://localhost:5173', vite.suggestedUrl)

  console.log('\n[6] 指纹稳定性')
  const fp1 = buildFingerprint({ processName: 'node.exe', exePath: 'E:\\node.exe', projectDir: 'D:\\app', port: 5173 })
  const fp2 = buildFingerprint({ processName: 'node.exe', exePath: 'E:\\node.exe', projectDir: 'D:\\app', port: 5173 })
  const fp3 = buildFingerprint({ processName: 'node.exe', exePath: 'E:\\node.exe', projectDir: 'D:\\app', port: 3000 })
  check('同样输入得到同样指纹（与 PID 无关）', fp1 === fp2)
  check('端口不同则指纹不同', fp1 !== fp3)
  check('指纹长度固定', fp1.length === 16, fp1.length)

  console.log('\n[7] AI 建议合并不改写事实字段')
  const candidate = {
    fingerprint: 'abc1234567890def',
    pid: 1234,
    port: 5173,
    address: '127.0.0.1',
    processName: 'node.exe',
    exePath: 'E:\\node.exe',
    commandLine: '"E:\\node.exe" vite',
    projectDir: 'D:\\real-project',
    projectMarkers: ['package.json', 'vite.config.js'],
    project: { root: 'D:\\real-project', markers: ['package.json', 'vite.config.js'], stack: { kinds: ['node'], scripts: ['dev'], dependencies: ['vite'] } },
    serviceName: 'node.exe :5173',
    type: 'Node 进程',
    confidence: 0.5,
  }
  const maliciousReply = {
    serviceName: '我的前端项目',
    type: 'Vite + React',
    stack: ['vite', 'react'],
    purpose: '本地开发服务器',
    suggestedStartCommand: 'npm run dev',
    confidence: 0.88,
    reasoning: '命令行里出现 vite',
    pid: 9999,
    port: 1,
    projectDir: 'C:\\fake',
    commandLine: 'rm -rf /',
    exePath: 'C:\\evil.exe',
    processName: 'evil',
    fingerprint: 'hacked',
  }
  const merged = mergeAiSuggestion(candidate, maliciousReply, { model: 'test-model' })
  const after = merged.candidate
  check('名称被 AI 建议覆盖（建议字段生效）', after.ai.serviceName === '我的前端项目', after.ai?.serviceName)
  check('建议启动命令生效', after.ai.suggestedStartCommand === 'npm run dev')
  check('置信度被规范化到 0-1', after.ai.confidence === 0.88)
  for (const field of ['pid', 'port', 'address', 'processName', 'exePath', 'commandLine', 'projectDir', 'fingerprint']) {
    check(`事实字段 ${field} 未被改写`, after[field] === candidate[field], { before: candidate[field], after: after[field] })
  }
  check('记录被拒绝的事实字段', merged.rejectedFields.includes('pid') && merged.rejectedFields.includes('projectDir'), merged.rejectedFields)
  check('只应用白名单建议字段', merged.appliedFields.every((field) => ['serviceName', 'type', 'stack', 'purpose', 'suggestedStartCommand', 'confidence', 'reasoning'].includes(field)), merged.appliedFields)

  console.log('\n[8] AI 调用行为')
  const config = aiConfig()
  check('未配置时 available=false', config.available === false, config.reason)
  const notConfigured = await identifyService(candidate, { config })
  check('未配置时不发起调用', notConfigured.available === false && notConfigured.error === null)

  let called = 0
  const fakeConfig = { ...config, available: true, model: 'fake-model', maxPerScan: 2, concurrency: 2 }
  const fakeClient = async ({ input }) => {
    called += 1
    check('发给模型的是采集到的元数据', input.listener.port === 5173 && input.process.name === 'node.exe' && input.project.dir === 'D:\\real-project', input)
    return '```json\n{"serviceName":"AI 名称","type":"AI 类型","confidence":0.77,"pid":1,"port":2}\n```'
  }
  const identified = await identifyService(candidate, { client: fakeClient, config: fakeConfig })
  check('能从 ```json 包裹中解析', identified.result?.serviceName === 'AI 名称', identified.result)
  check('调用一次', called === 1, called)
  check('合并后事实字段仍未被改写', identified.merged.candidate.port === 5173 && identified.merged.candidate.pid === 1234)

  const batch = await identifyCandidates([candidate, { ...candidate, fingerprint: 'f2' }, { ...candidate, fingerprint: 'f3' }], { client: fakeClient, config: fakeConfig })
  check('批量识别受 maxPerScan 限制', batch.used === 2 && batch.skipped === 1, { used: batch.used, skipped: batch.skipped })
  check('批量结果按指纹索引', batch.results.has(candidate.fingerprint))

  console.log('\n[9] 进程命令行解析')
  const tokens = tokenizeCommandLine('"E:\\node.exe" "D:\\my app\\server.js" --port 3000')
  check('引号内空格保留', tokens[1] === 'D:\\my app\\server.js', tokens)
  const dirCandidate = path.join(ROOT, 'my-app')
  const paths = extractPathCandidates(`"E:\\node.exe" "${path.join(dirCandidate, 'src', 'index.js')}" --config "${path.join(dirCandidate, 'vite.config.js')}"`)
  check('提取存在的绝对路径文件', paths.some((item) => item.file?.endsWith('index.js')), paths)
  check('相对路径不猜', extractPathCandidates('node server/src/index.js').length === 0)
  const exeDirs = inferDirsFromExe('D:\\proj\\node_modules\\vite\\bin\\vite.js')
  check('从 node_modules 推断项目根', exeDirs[0].dir === 'D:\\proj', exeDirs)
  const venvDirs = inferDirsFromExe('D:\\proj\\.venv\\Scripts\\python.exe')
  check('从 .venv 推断项目根', venvDirs[0].dir === 'D:\\proj', venvDirs)
  const appDir = path.join(ROOT, 'my-app')
  const cdChain = [
    { pid: 100, name: 'node.exe', commandLine: `node src/index.js` },
    { pid: 200, name: 'cmd.exe', commandLine: `cmd.exe /d /s /c "cd /d ${appDir} && npm run dev"` },
    { pid: 300, name: 'explorer.exe', commandLine: '' },
  ]
  const hints = extractCdHints(cdChain, cdChain[0])
  check('解析父进程 cd 提示（并用命令行相对路径验证）', hints.length === 1 && hints[0].dir === appDir, hints)
  check('不存在的目录不会被当成 cd 提示', extractCdHints([{ pid: 1, name: 'node' }, { name: 'cmd.exe', commandLine: 'cmd /c "cd /d Z:\\not-exist-xyz && npm run dev"' }], { commandLine: 'node main.js' }).length === 0)
  check('只看直接父进程（祖父级的 cd 不算）', extractCdHints([{ pid: 1 }, { pid: 2, name: 'node.exe' }, { name: 'pwsh.exe', commandLine: `Set-Location ${appDir}` }], { pid: 1, commandLine: 'node src/index.js' }).length === 0)
  check('无法验证的 cd 提示被丢弃', extractCdHints([{ pid: 1, commandLine: '"E:\\node.exe" E:\\Temp\\somewhere\\app.mjs' }, { name: 'pwsh.exe', commandLine: `Set-Location ${appDir}` }], { pid: 1, commandLine: '"E:\\node.exe" E:\\Temp\\somewhere\\app.mjs' }).length === 0)
  const inferred = inferCandidateDirs({ commandLine: `node "${path.join(dirCandidate, 'src', 'index.js')}"`, exePath: '' }, [])
  check('候选目录去重且带来源（取文件所在目录）', inferred.length === 1 && inferred[0].dir === path.join(dirCandidate, 'src'), inferred)
  check('候选项可继续向上解析到项目根', detectProject(inferred).root === dirCandidate, detectProject(inferred).root)
  const table = await getProcessTable({ force: true })
  check('进程表可用（至少取到自身进程）', table.size > 0 && table.has(process.pid), table.size)
  const chain = buildParentChain(process.pid, table)
  check('父进程链包含自身', chain[0].pid === process.pid, chain.slice(0, 2))
} finally {
  fs.rmSync(ROOT, { recursive: true, force: true })
}

console.log(`\n结果：通过 ${passed} 项，失败 ${failures.length} 项`)
if (failures.length > 0) {
  console.log(JSON.stringify(failures.slice(0, 12), null, 2))
  process.exitCode = 1
}
