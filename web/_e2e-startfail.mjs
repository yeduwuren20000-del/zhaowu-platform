/**
 * 「启动失败诊断」端到端验证（无 Playwright，Chrome DevTools Protocol 驱动真实页面）：
 *  - 场景 A：启动命令根本不存在（fake command）→ 横幅说「启动命令执行不了」+ 给出去处
 *  - 场景 B：npm run 一个没装的 bin → 横幅说「依赖还没安装」+ 给安装命令
 *  - 场景 C：真实能起来的服务 → 不出现横幅，且能正常停止
 *  - 断言横幅结构：标题 / 证据行 / 建议动作（跳转+复制）/ 日志尾部展开
 * 依赖：8790 静态服务（反代 /api 到 8788 测试后端，数据目录为空）+ dist-test 已构建
 * 用法: node _e2e-startfail.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = 'http://127.0.0.1:8790'
const API = 'http://127.0.0.1:8788/api'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9338
const SHOTS = process.env.DSM_SHOTS || '.shots'

// 三个场景共用一个目录：里面放一个 package.json（dev 脚本指向未安装的 vite）
// 和一个真实可运行的 server.js（用于「成功即清横幅」场景）
const FIXTURE = mkdtempSync(join(tmpdir(), 'dsm-startfail-'))
writeFileSync(
  join(FIXTURE, 'package.json'),
  JSON.stringify({ name: 'e2e-startfail-demo', scripts: { dev: 'vite --port 18872' } }, null, 2),
)
writeFileSync(
  join(FIXTURE, 'server.js'),
  "require('http').createServer((q, s) => s.end('ok')).listen(18873)\n",
)

// 每轮唯一后缀：重名卡片会让「点的卡片」和「查的卡片」不是同一张（列表排序会变），
// 这是上一轮 e2e 误报的根因；开场再清掉历史残留，保证端口不重复声明。
const RUN = Date.now().toString(36)
const SCENARIOS = [
  {
    key: 'cmd',
    name: `诊断-命令找不到-${RUN}`,
    startCommand: 'dsm-no-such-cmd-xyz --serve',
    port: 18871,
    expectCause: 'command-not-found',
    expectTitle: '启动命令执行不了',
  },
  {
    key: 'deps',
    name: `诊断-依赖缺失-${RUN}`,
    startCommand: 'npm run dev',
    port: 18872,
    expectCause: 'deps-missing',
    expectTitle: '依赖还没安装',
  },
  {
    key: 'ok',
    name: `诊断-成功清横幅-${RUN}`,
    startCommand: 'node server.js',
    port: 18873,
    expectCause: null,
    expectTitle: null,
  },
]
const SCENARIO_PREFIX = '诊断-'
const NAME_A = SCENARIOS[0].name
const NAME_B = SCENARIOS[1].name
const NAME_C = SCENARIOS[2].name

const profile = mkdtempSync(join(tmpdir(), 'cdp-startfail-'))
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// ---- 预置：清掉历史场景项目（上一轮异常退出会留残留），再建本轮三个 ----
async function cleanupScenarioProjects() {
  const res = await fetch(`${API}/projects?force=1`)
  const body = await res.json().catch(() => ({}))
  const list = body?.data || []
  const stale = list.filter((p) => String(p.name || '').startsWith(SCENARIO_PREFIX))
  for (const p of stale) {
    // 先停再删：删除路由不会结束进程，运行中的项目直接删会留下占着端口的孤儿进程
    if (p.status === 'running' || p.status === 'starting') {
      await fetch(`${API}/projects/${p.id}/stop`, { method: 'POST' }).catch(() => {})
    }
    await fetch(`${API}/projects/${p.id}`, { method: 'DELETE' }).catch(() => {})
  }
  if (stale.length > 0) console.log(`[setup] 清理历史场景项目 ${stale.length} 个`)
  return stale.length
}

async function createProjects() {
  for (const s of SCENARIOS) {
    const res = await fetch(`${API}/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        name: s.name,
        type: 'Node',
        dir: FIXTURE,
        startCommand: s.startCommand,
        port: s.port,
        url: `http://localhost:${s.port}`,
        remark: 'e2e 启动失败诊断场景',
      }),
    })
    const body = await res.json().catch(() => ({}))
    if (!res.ok || body?.ok === false) throw new Error(`创建项目失败: ${JSON.stringify(body).slice(0, 200)}`)
    s.id = body.data?.id || body.data?.project?.id
    if (!s.id) throw new Error(`创建项目响应里没有 id: ${JSON.stringify(body).slice(0, 200)}`)
  }
}

const chrome = spawn(
  CHROME,
  ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--window-size=1440,1200', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'],
  { stdio: 'ignore' },
)

async function pageWsUrl() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page.webSocketDebuggerUrl
    } catch {
      /* chrome 还没起来 */
    }
    await sleep(300)
  }
  throw new Error('Chrome 调试端口没起来')
}

const ws = new WebSocket(await pageWsUrl())
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', reject, { once: true })
})
// 控制台错误 / 未捕获异常收集：静默 JS 报错是 e2e 最难查的一类问题（try 外声明，catch 里也要用）
const consoleErrors = []
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(String(event.data))
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
    consoleErrors.push((msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200))
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(String(msg.params?.exceptionDetails?.exception?.description || msg.params?.exceptionDetails?.text || '').slice(0, 200))
  }
})
let msgId = 0
const pending = new Map()
ws.addEventListener('message', (event) => {
  const msg = JSON.parse(String(event.data))
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id)
    pending.delete(msg.id)
    if (msg.error) reject(new Error(`${msg.error.code} ${msg.error.message}`))
    else resolve(msg.result)
  }
})
const send = (method, params = {}) =>
  new Promise((resolve, reject) => {
    pending.set(++msgId, { resolve, reject })
    ws.send(JSON.stringify({ id: msgId, method, params }))
  })
async function evalJS(expression) {
  const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (out.exceptionDetails) throw new Error(out.exceptionDetails.exception?.description || out.exceptionDetails.text)
  return out.result.value
}
async function waitFor(expression, timeout = 30000, label = expression) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try {
      if (await evalJS(expression)) return true
    } catch {
      /* 页面可能正在跳转 */
    }
    await sleep(150)
  }
  throw new Error(`等待超时: ${label}`)
}

/** 找到某个项目卡片（按名称文本匹配） */
const cardOf = (name) => `(() => {
  const rows = [...document.querySelectorAll('.project-row')]
  return rows.find((n) => n.textContent.includes(${JSON.stringify(name)})) || null
})()`
/** 在某张卡片里点「启动」 */
const clickStart = (name) => `(() => {
  const rows = [...document.querySelectorAll('.project-row')]
  const row = rows.find((n) => n.textContent.includes(${JSON.stringify(name)}))
  if (!row) return 'no-card'
  const btn = [...row.querySelectorAll('button')].find((n) => n.textContent.trim() === '启动')
  if (!btn) return 'no-button'
  btn.click(); return 'clicked'
})()`
/** 某张卡片里是否出现了失败横幅 */
const hasBanner = (name) => `!!${cardOf(name)}?.querySelector('.pfail')`

try {
  await cleanupScenarioProjects()
  await createProjects()
  console.log(`[setup] 已创建 ${SCENARIOS.length} 个场景项目：${SCENARIOS.map((s) => `${s.name}(${s.id?.slice(0, 8)})`).join(' / ')}`)

  await send('Page.enable')
  await send('Runtime.enable')
  await send('Page.navigate', { url: BASE + '/projects' })
  await waitFor(`!!document.querySelector('.page__title')`, 30000, '本地项目页渲染')
  await waitFor(`document.querySelectorAll('.project-row').length >= 3`, 15000, '三个项目卡片都渲染出来')

  // ---- 场景 A：命令不存在 ----
  check('A：点启动', (await evalJS(clickStart(NAME_A))) === 'clicked')
  await waitFor(hasBanner(NAME_A), 45000, '场景 A 横幅出现')
  const titleA = await evalJS(`${cardOf(NAME_A)}.querySelector('.pfail__title')?.textContent || ''`)
  check('A：标题是人话（不是原始报错）', titleA.includes('启动命令执行不了'), titleA)
  const evidenceA = await evalJS(`${cardOf(NAME_A)}.querySelector('.pfail__evidence code')?.textContent || ''`)
  check('A：证据行来自日志真实内容', evidenceA.includes('dsm-no-such-cmd-xyz'), evidenceA)
  const summaryA = await evalJS(`${cardOf(NAME_A)}.querySelector('.pfail__summary')?.textContent || ''`)
  check('A：摘要解释原因', summaryA.includes('拼写') || summaryA.includes('没装'), summaryA)
  const adviceCountA = await evalJS(`${cardOf(NAME_A)}.querySelectorAll('.pfail__advice li').length`)
  check('A：给出多条建议', adviceCountA >= 2, `advice=${adviceCountA}`)
  const navBtnsA = await evalJS(`${cardOf(NAME_A)}.querySelectorAll('.pfail__advice button').length`)
  check('A：建议带可点动作（跳转/复制）', navBtnsA >= 2, `buttons=${navBtnsA}`)

  // 日志尾部默认折叠，点开后有内容
  const logToggleA = await evalJS(`(() => {
    const row = ${cardOf(NAME_A)}
    const t = row.querySelector('.pfail__log-toggle')
    if (!t) return 'no-toggle'
    t.click(); return 'clicked'
  })()`)
  check('A：日志尾部可展开', logToggleA === 'clicked')
  await sleep(200)
  const logBodyA = await evalJS(`${cardOf(NAME_A)}.querySelector('.pfail__log-body')?.textContent || ''`)
  check('A：展开后看到原始日志', logBodyA.includes('launcher') || logBodyA.includes('命令'), logBodyA.slice(0, 80))

  // 复制反馈属于场景 B（依赖缺失才给安装命令）；command-not-found 的建议全是跳转，没有复制按钮
  await evalJS(`(() => {
    const row = ${cardOf(NAME_A)}
    const btn = [...row.querySelectorAll('.pfail__advice button')].find((n) => n.textContent.includes('去处理'))
    if (btn) btn.click(); return Boolean(btn)
  })()`)
  await waitFor(`!!document.querySelector('.modal')`, 8000, '跳转后弹出编辑表单')
  check('A：建议动作能跳到编辑表单', (await evalJS(`!!document.querySelector('.modal')`)) === true)
  await evalJS(`(() => { const b = [...document.querySelectorAll('.modal button')].find((n) => n.textContent.trim() === '取消'); if (b) b.click(); return Boolean(b) })()`)
  await sleep(200)

  // ---- 场景 B：依赖缺失（npm run 未安装的 bin） ----
  check('B：点启动', (await evalJS(clickStart(NAME_B))) === 'clicked')
  await waitFor(hasBanner(NAME_B), 60000, '场景 B 横幅出现（npm 退出需要一两秒）')
  const titleB = await evalJS(`${cardOf(NAME_B)}.querySelector('.pfail__title')?.textContent || ''`)
  check('B：标题是「依赖还没安装」', titleB.includes('依赖还没安装'), titleB)
  const evidenceB = await evalJS(`${cardOf(NAME_B)}.querySelector('.pfail__evidence code')?.textContent || ''`)
  check('B：证据行命中 bin 找不到', /command not found|不是内部或外部命令|is not recognized/i.test(evidenceB), evidenceB)
  const copyBtnB = await evalJS(`(() => {
    const row = ${cardOf(NAME_B)}
    const btn = [...row.querySelectorAll('.pfail__advice button')].find((n) => n.textContent.includes('复制'))
    return btn ? btn.textContent.trim() : ''
  })()`)
  check('B：提供安装命令复制按钮', copyBtnB.includes('复制'), copyBtnB)
  // 复制有点击反馈（成功或失败都算，不能没反应）
  await evalJS(`(() => {
    const row = ${cardOf(NAME_B)}
    const btn = [...row.querySelectorAll('.pfail__advice button')].find((n) => n.textContent.includes('复制'))
    if (btn) btn.click(); return Boolean(btn)
  })()`)
  await sleep(400)
  const copiedB = await evalJS(`${cardOf(NAME_B)}.querySelector('.pfail__copied')?.textContent || ''`)
  check('B：复制按钮有点击反馈', copiedB.length > 0, copiedB)

  // ---- 场景 C：真实能跑的服务 → 无横幅，且可停止 ----
  check('C：点启动', (await evalJS(clickStart(NAME_C))) === 'clicked')
  await waitFor(`${cardOf(NAME_C)}?.textContent.includes('运行中')`, 60000, '场景 C 进入运行中')
  check('C：启动成功不出现失败横幅', (await evalJS(hasBanner(NAME_C))) === false)

  // 运行中项目的删除确认框：必须警告端口占用，并给「先停止，再删除」的稳妥路径
  await evalJS(`(() => {
    const rows = [...document.querySelectorAll('.project-row')]
    const row = rows.find((n) => n.textContent.includes(${JSON.stringify(NAME_C)}))
    const more = row && row.querySelector('.icon-button')
    if (more) more.click(); return Boolean(more)
  })()`)
  await waitFor(`[...document.querySelectorAll('.menu__item')].some((n) => n.textContent.includes('删除项目'))`, 5000, '更多菜单展开')
  await evalJS(`(() => {
    const item = [...document.querySelectorAll('.menu__item')].find((n) => n.textContent.includes('删除项目'))
    if (item) item.click(); return Boolean(item)
  })()`)
  await waitFor(`!!document.querySelector('.modal')`, 5000, '删除确认框弹出')
  const delMsg = await evalJS(`document.querySelector('.modal')?.textContent || ''`)
  check('C：删除运行中项目的确认框警告端口占用', delMsg.includes('端口') && delMsg.includes('冲突'), delMsg.slice(0, 90))
  const hasStopThenDelete = await evalJS(`[...document.querySelectorAll('.modal button')].some((n) => n.textContent.includes('先停止'))`)
  check('C：提供「先停止，再删除」按钮', hasStopThenDelete === true)
  await evalJS(`(() => { const b = [...document.querySelectorAll('.modal button')].find((n) => n.textContent.trim() === '取消'); if (b) b.click(); return Boolean(b) })()`)
  await sleep(200)
  // 等「停止」按钮存在且可用：action 执行期间按钮是 disabled，对禁用按钮 click() 是静默无效。
  // 注意 /api/projects?force=1 在本机要 12s 左右（全端口扫描），action 的 reload 很慢，等待给宽
  await waitFor(
    `(() => {
      const row = ${cardOf(NAME_C)}
      if (!row) return false
      const btn = [...row.querySelectorAll('button')].find((n) => n.textContent.trim() === '停止')
      return Boolean(btn) && !btn.disabled
    })()`,
    45000,
    '场景 C 停止按钮可用',
  )
  const stopC = await evalJS(`(() => {
    const rows = [...document.querySelectorAll('.project-row')]
    const row = rows.find((n) => n.textContent.includes(${JSON.stringify(NAME_C)}))
    if (!row) return 'no-card'
    const btn = [...row.querySelectorAll('button')].find((n) => n.textContent.trim() === '停止')
    if (!btn) return 'no-button'
    if (btn.disabled) return 'disabled'
    btn.click(); return 'clicked'
  })()`)
  check('C：可以停止', stopC === 'clicked', stopC)
  await waitFor(`${cardOf(NAME_C)}?.textContent.includes('已停止')`, 45000, '场景 C 已停止')

  // ---- 截图：失败横幅全貌 ----
  mkdirSync(SHOTS, { recursive: true })
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false })
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  writeFileSync(join(SHOTS, 'start-failure.png'), Buffer.from(shot.data, 'base64'))

  const failed = results.filter((r) => !r.ok)
  if (consoleErrors.length > 0) {
    console.log(`\n[浏览器控制台错误 ${consoleErrors.length} 条]`)
    consoleErrors.slice(0, 5).forEach((e) => console.log(`  ! ${e}`))
  }
  console.log(`\n${results.length - failed.length}/${results.length} 通过`)
  await cleanupScenarioProjects()
  ws.close()
  chrome.kill()
  try {
    rmSync(FIXTURE, { recursive: true, force: true })
    rmSync(profile, { recursive: true, force: true })
  } catch {
    /* 文件占用，忽略 */
  }
  process.exit(failed.length === 0 ? 0 : 1)
} catch (error) {
  console.error(`\n[e2e 中断] ${error.message}`)
  // 失败现场转储：页面上有几张卡片、哪张有横幅、toast 在说什么——下次不用猜
  try {
    const dump = await evalJS(`JSON.stringify({
      rows: [...document.querySelectorAll('.project-row')].map((n) => ({
        name: (n.querySelector('.project-row__name') || {}).textContent || '(无名)',
        hasBanner: Boolean(n.querySelector('.pfail')),
        status: (n.querySelector('.status-word') || {}).textContent || '',
      })),
      pfailTotal: document.querySelectorAll('.pfail').length,
      toasts: [...document.querySelectorAll('.toast, .toasts > *')].map((n) => n.textContent.trim().slice(0, 80)),
    })`)
    console.log(`[页面状态] ${dump}`)
  } catch {
    /* 页面可能已经不可用 */
  }
  if (consoleErrors.length > 0) {
    console.log(`[浏览器控制台错误 ${consoleErrors.length} 条]`)
    consoleErrors.slice(0, 5).forEach((e) => console.log(`  ! ${e}`))
  }
  try {
    mkdirSync(SHOTS, { recursive: true })
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
    writeFileSync(join(SHOTS, 'start-failure-error.png'), Buffer.from(shot.data, 'base64'))
  } catch {
    /* 截图失败不影响主错误 */
  }
  const failed = results.filter((r) => !r.ok)
  console.log(`${results.length - failed.length}/${results.length} 通过（中断前）`)
  await cleanupScenarioProjects().catch(() => {})
  ws.close()
  chrome.kill()
  process.exit(1)
}
