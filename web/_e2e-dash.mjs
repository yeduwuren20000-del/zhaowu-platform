/**
 * 总览页「环境体检」端到端验证。
 * 两种模式：
 *   默认        依赖齐全 → 断言收成一行「全部就绪」、明细 6 行、可重新检测
 *   --expect-bad 后端 PATH 被裁剪（缺 Python）→ 断言红色横幅、标「缺失」、给出可复制命令
 * 用法: node _e2e-dash.mjs [--expect-bad]
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'

const EXPECT_BAD = process.argv.includes('--expect-bad')
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = EXPECT_BAD ? 9335 : 9336
const BASE = process.env.SERVE_BASE || 'http://127.0.0.1:8790'
const SHOTS = process.env.DSM_SHOTS || '.shots'
const profile = mkdtempSync(join(tmpdir(), 'cdp-dash-'))

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

await send('Page.enable')
await send('Runtime.enable')
await send('Page.navigate', { url: BASE + '/' })
await waitFor(`!!document.querySelector('.page__title')`, 30000, '总览渲染')
// 体检是独立请求，等它出结果（loading 文案消失且出现计数）
await waitFor(`!!document.querySelector('.pf__count') && !document.querySelector('.pf__loading')`, 40000, '体检结果返回')

const countText = await ev(`document.querySelector('.pf__count').textContent`)
check('体检卡已渲染并给出就绪计数', /\d+\/\d+/.test(countText), countText)

const collapsedText = await ev(`document.querySelector('.pf__collapsed')?.textContent || ''`)

if (!EXPECT_BAD) {
  check('依赖齐全时默认折叠成一行', collapsedText.includes('全部就绪'), collapsedText || '(未折叠)')
  check('就绪计数为 6/6', countText.trim() === '6/6 就绪', countText)
  // 环境没缺口时，「待处理」里不该出现环境项（演示项目的目录缺失是另一码事，与此无关）
  const envTodosOk = await ev(`[...document.querySelectorAll('.todo__text')].filter((n) => n.textContent.includes('没就绪')).length`)
  check('环境齐全时待处理清单不含环境缺失项', envTodosOk === 0, `环境条目=${envTodosOk}`)
} else {
  check('缺失必需项时出现红色横幅', (await ev(`!!document.querySelector('.pf__banner')`)) === true)
  const bannerText = await ev(`document.querySelector('.pf__banner')?.textContent || ''`)
  check('横幅说明影响（而不是只报错）', bannerText.includes('必需组件没就绪'), bannerText.trim().slice(0, 40))
  check('缺失项被标为「缺失」', (await ev(`[...document.querySelectorAll('.pf__state.is-bad')].length`)) >= 1)

  // ---- 环境体检必须汇入总览「待处理」：缺 Python 时这里就要有一条，并说清影响 ----
  const todoTexts = await ev(`[...document.querySelectorAll('.todo__text')].map((n) => n.textContent)`)
  const pythonTodo = todoTexts.find((t) => t.includes('Python'))
  check('待处理清单出现「Python 没就绪」', Boolean(pythonTodo), JSON.stringify(todoTexts))
  check('该条说明影响的功能（网盘直链）', Boolean(pythonTodo && pythonTodo.includes('网盘直链')), pythonTodo)
  check('PowerShell 缺失也各占一条', todoTexts.filter((t) => t.includes('PowerShell')).length === 1, JSON.stringify(todoTexts))
  check('环境条目排在待处理最前面', (todoTexts[0] || '').includes('没就绪'), todoTexts[0])

  // 状态条「待处理」计数要把环境缺失算进去（本后端缺 2 个必需项）
  const pendingValue = await ev(`(() => {
    const btn = [...document.querySelectorAll('.status-strip__item')].find((n) => n.textContent.includes('待处理'))
    return btn ? btn.querySelector('.status-strip__value').textContent : ''
  })()`)
  check('状态条「待处理」计入环境缺失', Number(pendingValue) >= 2, `值=${pendingValue}`)

  // 点环境条目应滚到体检卡（不跳路由），证明「去处理」指向能解决问题的地方
  const beforePath = await ev(`location.pathname + location.search`)
  await ev(`(() => {
    const todo = [...document.querySelectorAll('.todo')].find((n) => n.textContent.includes('没就绪'))
    if (todo) todo.click(); return Boolean(todo)
  })()`)
  await new Promise((r) => setTimeout(r, 400))
  const afterPath = await ev(`location.pathname + location.search`)
  check('点待处理条目不发生页面跳转', beforePath === afterPath, `${beforePath} -> ${afterPath}`)
}

// 展开明细
await ev(`(() => {
  const b = [...document.querySelectorAll('.card__toggle')].find((n) => n.textContent.includes('查看明细') || n.textContent.includes('收起'))
  if (b && b.getAttribute('aria-expanded') === 'false') b.click()
  return true
})()`)
await delay(300)

const rows = await ev(`document.querySelectorAll('.pf__row').length`)
check('明细列出全部检查项', rows === 6, `行数=${rows}`)

const labels = await ev(`[...document.querySelectorAll('.pf__name')].map((n) => n.textContent.trim()).join(' | ')`)
check('六项检查内容正确', /Node\.js/.test(labels) && /Python/.test(labels) && /PowerShell/.test(labels) && /Git/.test(labels) && /Docker/.test(labels) && /数据目录可写/.test(labels), labels)

if (EXPECT_BAD) {
  const cmdBtns = await ev(`document.querySelectorAll('.pf__cmd').length`)
  check('缺失项给出可复制的安装命令', cmdBtns >= 1, `命令按钮=${cmdBtns}`)
  const pythonRow = await ev(`(() => {
    const row = [...document.querySelectorAll('.pf__row')].find((n) => n.textContent.includes('Python'))
    return row ? row.textContent : ''
  })()`)
  check('Python 行说明了影响（网盘直链）', pythonRow.includes('网盘直链'), pythonRow.replace(/\s+/g, ' ').slice(0, 60))
}

// 重新检测按钮
await ev(`(() => {
  const b = [...document.querySelectorAll('button')].find((n) => n.textContent.includes('重新检测'))
  b.click(); return true
})()`)
await delay(1200)
await waitFor(`!document.querySelector('.pf__loading')`, 40000, '重新检测完成')
check('「重新检测」可重跑且不报错', (await ev(`!!document.querySelector('.pf__count')`)) === true)

mkdirSync(SHOTS, { recursive: true })
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false })
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
const name = EXPECT_BAD ? 'dash-preflight-bad.png' : 'dash-preflight-ok.png'
writeFileSync(join(SHOTS, name), Buffer.from(shot.data, 'base64'))

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
ws.close()
chrome.kill()
try { rmSync(profile, { recursive: true, force: true }) } catch { /* 占用 */ }
process.exit(failed.length === 0 ? 0 : 1)
