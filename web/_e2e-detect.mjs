/**
 * 「识别目录」端到端验证（无 Playwright，Chrome DevTools Protocol 驱动真实页面）：
 *  - 打开「本地项目」→ 新增项目弹窗 → 填一个真实的临时项目目录 → 点「识别目录」
 *  - 断言空白字段被填入（名称/类型/启动命令/端口/地址），并给出说明与来源
 *  - 断言「只填空字段」：先手填启动命令，再识别 → 应提示跳过且不覆盖
 *  - 断言候选命令 chips 可点击换启动命令（连端口一起换）
 *  - 断言坏目录给人话错误
 * 依赖：8790 静态服务（反代 /api 到 8788 测试后端）+ dist-test 已构建
 * 用法: node _e2e-detect.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, rmSync, writeFileSync, mkdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = 'http://127.0.0.1:8790'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9337
const SHOTS = process.env.DSM_SHOTS || '.shots'

// 一个真实的临时 Vite 项目：两条可启动脚本，端口都写在命令里
const FIXTURE = mkdtempSync(join(tmpdir(), 'dsm-detect-'))
writeFileSync(
  join(FIXTURE, 'package.json'),
  JSON.stringify(
    {
      name: 'e2e-demo-web',
      scripts: { dev: 'vite --port 5199', start: 'vite preview --port 4199', build: 'vite build' },
      devDependencies: { vite: '^5.0.0' },
    },
    null,
    2,
  ),
)
writeFileSync(join(FIXTURE, 'vite.config.ts'), 'export default {}\n')
const BAD_DIR = join(FIXTURE, 'no-such-subdir')

const profile = mkdtempSync(join(tmpdir(), 'cdp-detect-'))
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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
  window.__clickText = (text, exact) => {
    const b = [...document.querySelectorAll('button')].find((n) => (exact ? n.textContent.trim() === text : n.textContent.includes(text)))
    if (!b) return false
    b.click(); return true
  }
  return true
})()`

await send('Page.enable')
await send('Runtime.enable')
await send('Page.navigate', { url: BASE + '/projects' })
await waitFor(`!!document.querySelector('.page__title')`, 30000, '本地项目页渲染')
await evalJS(INJECT)
check('页面加载', (await evalJS(`document.querySelector('.page__title').textContent`)) === '本地项目')

// ---- 1. 打开新增项目弹窗 ----
check('点头「新增项目」打开弹窗', (await evalJS(`window.__clickText('新增项目', true)`)) === true)
await waitFor(`!!document.querySelector('.modal') && !!window.__field('项目目录')`, 10000, '弹窗打开')

// ---- 2. 填目录 → 识别 ----
await evalJS(`window.__set(window.__field('项目目录'), ${JSON.stringify(FIXTURE)})`)
await sleep(200)
check('点「识别目录」', (await evalJS(`window.__clickText('识别目录')`)) === true)
await waitFor(`!!document.querySelector('.pdet__result')`, 30000, '识别结果出现')

check('名称取自 package.json', (await evalJS(`window.__val('项目名称')`)) === 'e2e-demo-web', await evalJS(`window.__val('项目名称')`))
check('类型识别为前端', (await evalJS(`window.__val('项目类型')`)) === '前端', await evalJS(`window.__val('项目类型')`))
check('启动命令取 dev 脚本', (await evalJS(`window.__val('启动命令')`)) === 'npm run dev', await evalJS(`window.__val('启动命令')`))
check('端口从脚本文本读出', (await evalJS(`window.__val('端口')`)) === '5199', await evalJS(`window.__val('端口')`))
check('访问地址按端口生成', (await evalJS(`window.__val('访问地址')`)) === 'http://localhost:5199', await evalJS(`window.__val('访问地址')`))

const okMsg = await evalJS(`document.querySelector('.pdet__msg--ok')?.textContent || ''`)
check('结果区说明填了哪些空', okMsg.includes('已填入') && okMsg.includes('项目名称'), okMsg.trim())

const allMsgs = await evalJS(`[...document.querySelectorAll('.pdet__msg')].map((n) => n.textContent).join(' || ')`)
check('列出读到的项目文件', allMsgs.includes('package.json'), allMsgs.slice(0, 80))
check('说明脚本来源', allMsgs.includes('dev') && allMsgs.includes('package.json'), allMsgs.slice(0, 120))
check('提醒端口可能不准', allMsgs.includes('端口') && allMsgs.includes('实际以启动后'), allMsgs.slice(0, 160))

// ---- 3. 只填空字段：先手填启动命令，再识别应跳过 ----
await evalJS(`window.__set(window.__field('启动命令'), 'echo custom-cmd')`)
await sleep(150)
await evalJS(`window.__clickText('识别目录')`)
await waitFor(`(document.querySelector('.pdet__result')?.textContent || '').includes('已跳过')`, 30000, '出现已跳过提示')
check('已手填的字段不被覆盖', (await evalJS(`window.__val('启动命令')`)) === 'echo custom-cmd', await evalJS(`window.__val('启动命令')`))
const skipMsg = await evalJS(`[...document.querySelectorAll('.pdet__msg')].map((n) => n.textContent).find((t) => t.includes('已跳过')) || ''`)
check('跳过提示点名字段', skipMsg.includes('启动命令'), skipMsg.trim())

// ---- 4. 候选命令 chips：换一条启动命令（连端口一起换） ----
const chipCount = await evalJS(`document.querySelectorAll('.pdet__chip').length`)
check('给出多条候选启动命令', chipCount >= 2, `chips=${chipCount}`)
await evalJS(`(() => {
  const chip = [...document.querySelectorAll('.pdet__chip')].find((n) => n.textContent.trim() === 'npm run start')
  if (chip) chip.click(); return Boolean(chip)
})()`)
await sleep(250)
check('点 chip 后启动命令切换', (await evalJS(`window.__val('启动命令')`)) === 'npm run start', await evalJS(`window.__val('启动命令')`))
check('点 chip 后端口一起换', (await evalJS(`window.__val('端口')`)) === '4199', await evalJS(`window.__val('端口')`))
check('点 chip 后访问地址一起换', (await evalJS(`window.__val('访问地址')`)) === 'http://localhost:4199', await evalJS(`window.__val('访问地址')`))

// 手动改过端口后，再换命令不该覆盖人的意图
await evalJS(`window.__set(window.__field('端口'), '8080')`)
await sleep(150)
check('手动改端口时自动地址跟着换', (await evalJS(`window.__val('访问地址')`)) === 'http://localhost:8080', await evalJS(`window.__val('访问地址')`))
await evalJS(`(() => {
  const chip = [...document.querySelectorAll('.pdet__chip')].find((n) => n.textContent.trim() === 'npm run dev')
  if (chip) chip.click(); return Boolean(chip)
})()`)
await sleep(250)
check('手动改过的端口不被 chip 覆盖', (await evalJS(`window.__val('端口')`)) === '8080', await evalJS(`window.__val('端口')`))

// ---- 5. 坏目录：人话错误 ----
await evalJS(`window.__set(window.__field('项目目录'), ${JSON.stringify(BAD_DIR)})`)
await sleep(150)
await evalJS(`window.__clickText('识别目录')`)
await waitFor(`[...document.querySelectorAll('.pdet__msg--warn')].some((n) => n.textContent.includes('目录不存在'))`, 30000, '坏目录错误出现')
const badMsg = await evalJS(`[...document.querySelectorAll('.pdet__msg--warn')].map((n) => n.textContent).find((t) => t.includes('目录不存在')) || ''`)
check('坏目录给出可读错误', badMsg.includes('目录不存在') && badMsg.length > 8, badMsg.trim())

// ---- 截图 ----
mkdirSync(SHOTS, { recursive: true })
await send('Emulation.setDeviceMetricsOverride', { width: 1440, height: 1200, deviceScaleFactor: 1, mobile: false })
const shot = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true })
writeFileSync(join(SHOTS, 'project-detect.png'), Buffer.from(shot.data, 'base64'))

const failed = results.filter((r) => !r.ok)
console.log(`\n${results.length - failed.length}/${results.length} 通过`)
ws.close()
chrome.kill()
try {
  rmSync(FIXTURE, { recursive: true, force: true })
  rmSync(profile, { recursive: true, force: true })
} catch {
  /* 文件占用，忽略 */
}
process.exit(failed.length === 0 ? 0 : 1)
