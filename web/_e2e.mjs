/**
 * 端到端交互验证（无 Playwright，直接用 Chrome DevTools Protocol）：
 *  - 通过 DOM 事件真的去操作下拉框与输入框（React 受控组件要用原生 setter + input/change）
 *  - 断言「凭据按网盘分开存」这件核心行为：填 A 网盘 -> 切 B 网盘应为空 -> 切回 A 应还原
 *  - 断言 localStorage 里两个槽位都在
 *  - 注入一条历史后断言「最近解析」卡片能渲染
 * 最后顺带出两张全页截图。
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = 'http://127.0.0.1:8790'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9333
const SHOTS = process.env.DSM_SHOTS || '.shots'
const profile = mkdtempSync(join(tmpdir(), 'cdp-pans-'))

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok, detail })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`)
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--hide-scrollbars',
    '--window-size=1440,1100',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
)

async function pageWsUrl() {
  for (let i = 0; i < 60; i += 1) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/list`)
      const list = await res.json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page.webSocketDebuggerUrl
    } catch {
      /* chrome 还没起来 */
    }
    await sleep(300)
  }
  throw new Error('Chrome 调试端口没起来')
}

const wsUrl = await pageWsUrl()
const ws = new WebSocket(wsUrl)
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve, { once: true })
  ws.addEventListener('error', reject, { once: true })
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

function send(method, params = {}) {
  const id = ++msgId
  return new Promise((resolve, reject) => {
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}

async function evalJS(expression) {
  const out = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (out.exceptionDetails) {
    throw new Error(out.exceptionDetails.exception?.description || out.exceptionDetails.text)
  }
  return out.result.value
}

async function waitFor(expression, timeout = 20000, label = expression) {
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

const INJECT = `(() => {
  window.__set = (el, value) => {
    if (!el) return false
    const proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype
    Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value)
    el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }))
    return true
  }
  window.__field = (part) => {
    const label = [...document.querySelectorAll('.field__label')].find((n) => n.textContent.includes(part))
    return label ? label.parentElement.querySelector('input, select, textarea') : null
  }
  window.__val = (part) => {
    const el = window.__field(part)
    return el ? el.value : null
  }
  return true
})()`

async function open(path = '/pans') {
  await send('Page.navigate', { url: BASE + path })
  await sleep(900)
  await waitFor(`!!document.querySelector('.page__title')`, 20000, '页面渲染完成')
  await evalJS(INJECT)
}

await send('Page.enable')
await send('Runtime.enable')

// ---- 0. 干净起点 ----
await open()
await evalJS(`localStorage.clear(); true`)
await open()

const title = await evalJS(`document.querySelector('.page__title').textContent`)
check('页面加载', title === '网盘直链', title)

// 网盘列表是挂载后异步拉的：先等它到位再数 option，否则首轮必挂（竞态）
await waitFor(`document.querySelectorAll('select.select option').length >= 9`, 20000, '网盘列表加载')
const optCount = await evalJS(`document.querySelectorAll('select.select option').length`)
check('网盘下拉已从后端取到列表', optCount === 9, `option 数=${optCount}（含「自动识别」应为 9）`)

// ---- 1. 选百度，填它自己的 cookie ----
await evalJS(`window.__set(document.querySelector('select.select'), '百度网盘')`)
await sleep(250)
const credOpened = await evalJS(`!!window.__field('Cookie')`)
check('选「需登录」网盘后凭据区自动展开', credOpened === true)

await evalJS(`window.__set(window.__field('Cookie'), 'BDUSS=baidu-cookie')`)
await sleep(150)
check('百度槽位写入生效', (await evalJS(`window.__val('Cookie')`)) === 'BDUSS=baidu-cookie')

// ---- 2. 切到天翼：必须不带着百度的 cookie ----
await evalJS(`window.__set(document.querySelector('select.select'), '天翼云盘')`)
await sleep(250)
const cookieWhileTianyi = await evalJS(`window.__val('Cookie')`)
check('切到天翼后 Cookie 为空（不串网盘）', cookieWhileTianyi === '', `实际=${JSON.stringify(cookieWhileTianyi)}`)

await evalJS(`window.__set(window.__field('Cookie'), 'SESSION=ty-cookie')`)
await sleep(150)

// ---- 3. 切回百度：应还原原来那份 ----
await evalJS(`window.__set(document.querySelector('select.select'), '百度网盘')`)
await sleep(250)
const cookieBack = await evalJS(`window.__val('Cookie')`)
check('切回百度后 Cookie 还原', cookieBack === 'BDUSS=baidu-cookie', `实际=${JSON.stringify(cookieBack)}`)

const tokenLeak = await evalJS(`window.__val('Token')`)
check('Token 槽位没有被 Cookie 污染', tokenLeak === '', `实际=${JSON.stringify(tokenLeak)}`)

// ---- 4. 两家的凭据都应该落盘 ----
const stored = await evalJS(`localStorage.getItem('dsm.pan.credentials.v2')`)
const parsed = stored ? JSON.parse(stored) : null
check(
  'localStorage 里两家各占一个槽位',
  Boolean(parsed && parsed['百度网盘'] && parsed['天翼云盘']),
  stored ? Object.keys(parsed).join(' / ') : '空',
)
check(
  '落盘内容正确',
  parsed?.['百度网盘']?.cookie === 'BDUSS=baidu-cookie' && parsed?.['天翼云盘']?.cookie === 'SESSION=ty-cookie',
)

// ---- 5. 「已存凭据」徽标 ----
const badge = await evalJS(`document.querySelector('.pan-cred-saved')?.textContent || ''`)
check('显示「已存本网盘凭据」徽标', badge.includes('已存') && badge.includes('百度网盘'), badge.trim())

// ---- 6. 底部清单里的「本机凭据」列 ----
await evalJS(`(() => {
  const btn = [...document.querySelectorAll('.card__toggle')].find((n) => n.textContent.includes('支持的网盘'))
  btn.click(); return true
})()`)
await sleep(350)
const configured = await evalJS(`document.querySelectorAll('.pan-cred-cell__ok').length`)
check('底部清单标记 2 家已配置', configured === 2, `计数=${configured}`)

// ---- 截图：带凭据状态 ----
mkdirSync(SHOTS, { recursive: true })
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1100, deviceScaleFactor: 1, mobile: false })
let shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
writeFileSync(join(SHOTS, 'pans-cred.png'), Buffer.from(shot.data, 'base64'))

// ---- 7. 注入一条历史，验证「最近解析」能渲染 ----
await evalJS(`localStorage.setItem('dsm.pan.history.v1', JSON.stringify([{
  url: 'https://pan.quark.cn/s/deadbeef', pan: '夸克网盘', title: '示例分享：项目资料', count: 12, pwd: '', at: Date.now() - 3600000
}])); true`)
await open()
const histRows = await evalJS(`document.querySelectorAll('.pan-hist__row').length`)
check('「最近解析」渲染出 1 条', histRows === 1, `行数=${histRows}`)
const histMeta = await evalJS(`document.querySelector('.pan-hist__meta')?.textContent || ''`)
check('历史条目展示了网盘/项数/时间', /夸克网盘/.test(histMeta) && /12 项/.test(histMeta) && /小时前/.test(histMeta), histMeta.trim())

// 点「重新解析」应当真的发起请求并给出可读错误（假分享 ID）
await evalJS(`(() => {
  const btn = [...document.querySelectorAll('button')].find((n) => n.textContent.includes('重新解析'))
  btn.click(); return true
})()`)
await waitFor(`!!document.querySelector('.pan-err__title') || !!document.querySelector('.notice--error')`, 30000, '错误提示出现')
const errTitle = await evalJS(`document.querySelector('.pan-err__title')?.textContent || document.querySelector('.notice--error')?.textContent || ''`)
check('失败时给出「人话」解释', Boolean(errTitle) && errTitle.length > 4, String(errTitle).slice(0, 40))
check('夸克报错指向游客态而不是让新手去填 Cookie', errTitle.includes('游客'), String(errTitle))

// 点「开启游客态」-> 重试 -> 应走到更深一层的业务错误（分享不存在），证明游客路径真的通
const guestBtnFound = await evalJS(`(() => {
  const b = [...document.querySelectorAll('button')].find((n) => n.textContent.includes('开启游客态'))
  if (!b) return false
  b.click(); return true
})()`)
check('出现「开启游客态」快捷按钮', guestBtnFound === true)
await sleep(250)
const guestOn = await evalJS(
  `[...document.querySelectorAll('span.switch')].find((n) => n.textContent.includes('游客态'))?.classList.contains('is-on')`,
)
check('游客态开关已被点亮', guestOn === true)
await evalJS(`(() => {
  const b = [...document.querySelectorAll('button')].find((n) => n.textContent.trim() === '重试')
  b.click(); return true
})()`)
await waitFor(`(document.querySelector('.pan-err__title')?.textContent || '').includes('不存在')`, 90000, '游客态走到「分享不存在」')
check('游客态路径走通（到达业务错误「分享不存在」而非登录墙）', true)

shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
writeFileSync(join(SHOTS, 'pans-history.png'), Buffer.from(shot.data, 'base64'))

// ---- 汇总 ----
const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
ws.close()
chrome.kill()
try {
  rmSync(profile, { recursive: true, force: true })
} catch {
  /* 文件占用，忽略 */
}
process.exit(failed.length === 0 ? 0 : 1)
