/**
 * 新手向 UI 优化端到端验证（无 Playwright，Chrome DevTools Protocol）：
 *  A. 每页一次性提示条 PageHint
 *     - 新 profile（localStorage 为空）进 /projects：提示条出现，文案说清这页干嘛
 *     - 点动作按钮「自动发现」：发现面板打开 + localStorage 记住（不再显示）
 *     - 刷新后提示条不再出现（ dismiss 持久化）
 *     - 换一页（/ports）：该页提示条独立出现；点「知道了」后刷新仍不出现
 *     - 总览页提示条独立出现
 *  B. 骨架屏 Skeleton
 *     - 用 CDP 网络限速拖慢 /api：首屏期间 .skel 占位出现，且表格尚未渲染
 *     - 数据到位后 .skel 消失、表格/空态出现（加载完成）
 *
 * 依赖：8788 测试后端 + 8790 静态服务（反代 /api）+ dist-test 已构建。
 * 用法：node _e2e-hints.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const BASE = 'http://127.0.0.1:8790'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9340
const SHOTS = process.env.DSM_SHOTS || '.shots'
const profile = mkdtempSync(join(tmpdir(), 'cdp-hints-'))

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`)
}

const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars', '--window-size=1440,1200', `--remote-debugging-port=${PORT}`, `--user-data-dir=${profile}`, 'about:blank'], { stdio: 'ignore' })

async function pageWs() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page.webSocketDebuggerUrl
    } catch { /* 等 chrome */ }
    await delay(300)
  }
  throw new Error('chrome 调试端口未就绪')
}

const ws = new WebSocket(await pageWs())
await new Promise((r, j) => { ws.addEventListener('open', r, { once: true }); ws.addEventListener('error', j, { once: true }) })
let msgId = 0
const pending = new Map()
ws.addEventListener('message', (e) => {
  const m = JSON.parse(String(e.data))
  if (m.id && pending.has(m.id)) {
    const p = pending.get(m.id)
    pending.delete(m.id)
    m.error ? p.rej(new Error(m.error.message)) : p.res(m.result)
  }
})
const send = (method, params = {}) => new Promise((res, rej) => { pending.set(++msgId, { res, rej }); ws.send(JSON.stringify({ id: msgId, method, params })) })
const ev = async (expr) => {
  const o = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true })
  if (o.exceptionDetails) throw new Error(o.exceptionDetails.exception?.description || o.exceptionDetails.text)
  return o.result.value
}
const waitFor = async (expr, timeout = 30000, label = expr) => {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline) {
    try { if (await ev(expr)) return true } catch { /* 页面切换中 */ }
    await delay(150)
  }
  throw new Error('等待超时: ' + label)
}

const goto = async (path) => {
  await send('Page.navigate', { url: BASE + path })
  await waitFor(`!!document.querySelector('.page__title')`, 60000, `渲染 ${path}`)
}

try {
  await send('Page.enable')
  await send('Runtime.enable')

  // ============ A1. /projects 首次进入：提示条出现 ============
  await goto('/projects')
  const hintExists = await ev(`!!document.querySelector('.page-hint[data-hint="projects"]')`)
  check('首次进「本地项目」出现一次性提示条', hintExists === true)

  const hintText = await ev(`document.querySelector('.page-hint[data-hint="projects"]')?.textContent || ''`)
  check('提示条说清这页干嘛（登记 + 一键启停）', hintText.includes('一键启停') && hintText.includes('登记'), hintText.slice(0, 50))

  // ============ A2. 点动作按钮「自动发现」：面板打开 + localStorage 记住 ============
  // 防御式点击：组件被变异掉时返回 false 让后续断言失败，而不是抛异常中断整轮
  await ev(`(() => {
    const btn = document.querySelector('.page-hint[data-hint="projects"] .page-hint__action')
    if (!btn) return false
    btn.click()
    return true
  })()`)
  await delay(400)
  const discoveryOpen = await ev(`[...document.querySelectorAll('button')].some((b) => b.textContent.includes('立即扫描'))`)
  check('点提示条动作按钮打开「自动发现」面板', discoveryOpen === true)
  const stored = await ev(`localStorage.getItem('dsm.hint.projects')`)
  check('执行动作即写 localStorage（不再显示）', stored === '1', String(stored))

  // ============ A3. 刷新后提示条不再出现（dismiss 持久化） ============
  await send('Page.reload')
  await waitFor(`!!document.querySelector('.page__title')`, 60000, '刷新后渲染')
  await delay(600)
  const afterReload = await ev(`!!document.querySelector('.page-hint[data-hint="projects"]')`)
  check('刷新后「本地项目」提示条不再出现', afterReload === false)

  // ============ A4. 换页独立：/ports 提示条出现，点「知道了」后刷新仍不出现 ============
  await goto('/ports')
  const portsHint = await ev(`!!document.querySelector('.page-hint[data-hint="ports"]')`)
  check('进「服务端口」出现该页独立提示条', portsHint === true)
  await ev(`(() => {
    const btn = document.querySelector('.page-hint[data-hint="ports"] .page-hint__close')
    if (!btn) return false
    btn.click()
    return true
  })()`)
  await delay(200)
  const portsHintGone = await ev(`!!document.querySelector('.page-hint[data-hint="ports"]')`)
  check('点「知道了」提示条立即消失', portsHintGone === false)
  await send('Page.reload')
  await waitFor(`!!document.querySelector('.page__title')`, 60000, '刷新后渲染')
  await delay(600)
  const portsHintAfter = await ev(`!!document.querySelector('.page-hint[data-hint="ports"]')`)
  const projectsHintStillGone = await ev(`!!document.querySelector('.page-hint[data-hint="projects"]')`)
  check('刷新后「服务端口」提示条仍不出现（持久化）', portsHintAfter === false)
  check('别的页关闭不影响本页（互不串扰）', projectsHintStillGone === false)

  // ============ A5. 总览页提示条独立出现 ============
  await goto('/')
  const dashHint = await ev(`!!document.querySelector('.page-hint[data-hint="dashboard"]')`)
  check('进「总览」出现该页提示条', dashHint === true)
  const dashText = await ev(`document.querySelector('.page-hint[data-hint="dashboard"]')?.textContent || ''`)
  check('总览提示条说清「待处理」入口', dashText.includes('待处理'), dashText.slice(0, 40))

  // ============ B. 骨架屏：拖慢 /api，首屏先出占位、数据到位后消失 ============
  // 只加延迟、不限吞吐（-1 = 不限）：否则 618KB 的前端包会被拖到几分钟，页面根本渲染不出来
  await send('Network.enable')
  await send('Network.emulateNetworkConditions', { offline: false, latency: 2500, downloadThroughput: -1, uploadThroughput: -1 })
  await goto('/ports')
  // 慢网络下首屏数据未回：应看到骨架屏，且表格/空态还没出现
  const skelShown = await ev(`(() => {
    const skels = document.querySelectorAll('.skel').length
    const table = !!document.querySelector('.table') || !!document.querySelector('.empty')
    return { skels, table }
  })()`)
  check('慢网络首屏出现骨架屏占位', skelShown.skels > 0, `skel=${skelShown.skels}`)
  check('数据未回时表格/空态未渲染', skelShown.table === false, `table=${skelShown.table}`)

  // 数据到位：骨架消失，表格或空态出现
  await waitFor(`document.querySelectorAll('.skel').length === 0 && (!!document.querySelector('.table') || !!document.querySelector('.empty'))`, 90000, '端口数据渲染')
  check('数据到位后骨架屏消失、内容出现', true)
  await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 })
  await send('Network.disable')

  // 截图留证
  mkdirSync(SHOTS, { recursive: true })
  await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false })
  const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
  writeFileSync(join(SHOTS, 'hints-skeleton.png'), Buffer.from(shot.data, 'base64'))
} catch (err) {
  console.log('ERROR  ' + err.message)
  try {
    mkdirSync(SHOTS, { recursive: true })
    const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
    writeFileSync(join(SHOTS, 'hints-failed.png'), Buffer.from(shot.data, 'base64'))
  } catch { /* chrome 已死 */ }
  results.push({ name: '脚本异常: ' + err.message, ok: false })
} finally {
  const failed = results.filter((r) => !r.ok)
  console.log(`\n结果：${results.length - failed.length} 通过，${failed.length} 失败（共 ${results.length} 项）`)
  ws.close()
  chrome.kill()
  try { rmSync(profile, { recursive: true, force: true }) } catch { /* 占用 */ }
  process.exit(failed.length === 0 ? 0 : 1)
}
