/**
 * 「错误不再甩技术消息」端到端验证（CDP Fetch 域拦截，真页面真 React）：
 *  - 场景 A：/api/ports 返 500 → 页面显示「服务端出错了」+ 重试按钮 + 折叠详情；
 *            点重试（放行请求）→ 错误条消失，页面恢复
 *  - 场景 B：/api/ports 断网（ERR_FAILED）→ 页面显示「连不上工作台服务」+ start.bat 线索；
 *            恢复后刷新 → 正常
 * 依赖：8790 静态服务（反代 /api 到 8788）+ dist-test 已构建
 * 用法: node _e2e-errors.mjs
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const BASE = 'http://127.0.0.1:8790'
const CHROME = 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9339
const SHOTS = process.env.DSM_SHOTS || '.shots'

const profile = mkdtempSync(join(tmpdir(), 'cdp-errors-'))
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

// ---- 拦截状态：场景 A 是 http500，场景 B 是 offline；intercept=false 即放行（重试恢复）----
let mode = 'http500'
let intercept = true
const consoleErrors = []
let msgId = 0
const pending = new Map()

ws.addEventListener('message', (event) => {
  const msg = JSON.parse(String(event.data))

  if (msg.method === 'Fetch.requestPaused') {
    const { requestId, request } = msg.params
    if (!/\/api\/ports/.test(request.url)) {
      // 其他接口（/api/projects 等）一律放行，不干扰页面其他部分
      ws.send(JSON.stringify({ id: ++msgId, method: 'Fetch.continueRequest', params: { requestId } }))
      return
    }
    if (!intercept) {
      ws.send(JSON.stringify({ id: ++msgId, method: 'Fetch.continueRequest', params: { requestId } }))
      return
    }
    if (mode === 'http500') {
      const body = Buffer.from(JSON.stringify({ ok: false, error: { message: '模拟服务端崩溃：数据库连接断了' } })).toString('base64')
      ws.send(
        JSON.stringify({
          id: ++msgId,
          method: 'Fetch.fulfillRequest',
          params: {
            requestId,
            responseCode: 500,
            responseHeaders: [
              { name: 'Content-Type', value: 'application/json' },
              { name: 'Access-Control-Allow-Origin', value: '*' },
            ],
            body,
          },
        }),
      )
    } else {
      ws.send(JSON.stringify({ id: ++msgId, method: 'Fetch.failRequest', params: { requestId, errorReason: 'Failed' } }))
    }
    return
  }

  if (msg.method === 'Runtime.consoleAPICalled' && msg.params?.type === 'error') {
    consoleErrors.push((msg.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 200))
  }
  if (msg.method === 'Runtime.exceptionThrown') {
    consoleErrors.push(String(msg.params?.exceptionDetails?.exception?.description || msg.params?.exceptionDetails?.text || '').slice(0, 200))
  }

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
async function waitFor(expression, timeout = 45000, label = expression) {
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
const shot = async (name) => {
  try {
    const out = await send('Page.captureScreenshot', { format: 'png', captureBeyondViewport: false })
    mkdirSync(SHOTS, { recursive: true })
    writeFileSync(join(SHOTS, name), Buffer.from(out.data, 'base64'))
  } catch {
    /* 截图失败不影响断言 */
  }
}

try {
  await send('Page.enable')
  await send('Runtime.enable')
  await send('Fetch.enable', { patterns: [{ urlPattern: '*api/ports*', requestStage: 'Request' }] })

  // ============ 场景 A：HTTP 500 → 友好文案 + 重试恢复 ============
  mode = 'http500'
  intercept = true
  await send('Page.navigate', { url: BASE + '/ports' })
  await waitFor(`!!document.querySelector('.page__title')`, 30000, '服务端口页渲染')
  await waitFor(`!!document.querySelector('.err')`, 45000, '错误条出现')

  const titleA = await evalJS(`document.querySelector('.err__title')?.textContent || ''`)
  check('A：500 → 标题是「服务端出错了」', titleA.includes('服务端出错'), titleA)
  const hintA = await evalJS(`document.querySelector('.err__hint')?.textContent || ''`)
  check('A：提示指了下一步（重试/日志）', hintA.includes('重试') || hintA.includes('日志'), hintA.slice(0, 60))
  const retryA = await evalJS(`(() => {
    const b = document.querySelector('.err__actions button')
    return b ? b.textContent.trim() : ''
  })()`)
  check('A：有重试按钮（过去只能刷新整个页面）', retryA.length > 0, retryA)
  const detailA = await evalJS(`!!document.querySelector('.err__detail')`)
  check('A：技术原文进折叠详情（不外露给新手）', detailA === true)
  const rawA = await evalJS(`document.querySelector('.err__detail code')?.textContent || ''`)
  check('A：折叠详情里有服务端原始消息', rawA.includes('数据库连接断了'), rawA.slice(0, 60))
  const noTechMsg = await evalJS(`!document.body.innerText.includes('HTTP 500')`)
  check('A：页面不再直接甩 HTTP 500 术语', noTechMsg === true)
  await shot('err-500.png')

  // 放行后续请求 → 点重试 → 错误条消失
  intercept = false
  const clicked = await evalJS(`(() => {
    const b = document.querySelector('.err__actions button')
    if (!b || b.disabled) return false
    b.click(); return true
  })()`)
  check('A：重试按钮可点', clicked === true)
  await waitFor(`!document.querySelector('.err')`, 30000, '重试后错误条消失')
  check('A：重试后页面恢复（错误条消失）', true)
  await shot('err-recovered.png')

  // ============ 场景 B：断网 → 「连不上工作台服务」 ============
  mode = 'offline'
  intercept = true
  await send('Page.reload')
  await waitFor(`!!document.querySelector('.err')`, 45000, '断网错误条出现')
  const titleB = await evalJS(`document.querySelector('.err__title')?.textContent || ''`)
  check('B：断网 → 标题是「连不上工作台服务」', titleB.includes('连不上工作台服务'), titleB)
  const hintB = await evalJS(`document.querySelector('.err__hint')?.textContent || ''`)
  check('B：提示点名 start.bat（最常见的根因）', hintB.includes('start.bat'), hintB.slice(0, 60))
  await shot('err-offline.png')

  // 恢复网络 → 再点重试 → 正常
  intercept = false
  await evalJS(`(() => {
    const b = document.querySelector('.err__actions button')
    if (b) b.click()
  })()`)
  await waitFor(`!document.querySelector('.err')`, 30000, '断网恢复后错误条消失')
  check('B：恢复后错误条消失', true)

  // ============ 收尾：干净页面无错误条 ============
  check('收尾：页面不再有错误条', (await evalJS(`!document.querySelector('.err')`)) === true)
} catch (error) {
  check(`运行异常：${error.message}`, false)
} finally {
  // 浏览器静默报错收集：ErrorNotice 自己渲染出错也会体现在这里
  if (consoleErrors.length > 0) {
    console.log(`\n[浏览器报错 ${consoleErrors.length} 条]`)
    consoleErrors.slice(0, 5).forEach((e) => console.log('  ', e))
  }
  check('无浏览器未捕获报错', consoleErrors.length === 0, `${consoleErrors.length} 条`)
  try {
    await send('Fetch.disable')
  } catch {
    /* 浏览器可能已关 */
  }
  ws.close()
  chrome.kill()
}

const passed = results.filter((r) => r.ok).length
const failed = results.length - passed
console.log(`\n结果：${passed} 项通过，${failed} 项失败`)
process.exit(failed > 0 ? 1 : 0)
