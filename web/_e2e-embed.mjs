/**
 * 「打开应用不再闪白」端到端验证（真 Chrome + 真 React + 真 iframe）。
 *
 * 先说清楚白屏到底是什么：新开窗口时，浏览器先把窗口画出来（白），
 * 再等页面首帧；页面越慢，白得越久。所以只要"在同一页面内换内容"，
 * 白就没有存在的空间——这就是内嵌抽屉解决的问题。
 *
 * 判据（可量化，不靠肉眼）：
 *  - 对照组：导航到一个 3 秒才响应的慢页面 → 必须量到接近 100% 的白帧。
 *    量不到就说明探针是瞎的，本轮结论直接作废（这条是防止"绿灯是假绿"）。
 *  - 实验组：点「打开」让抽屉加载**同样慢**的地址 → 白色像素必须始终很低，
 *    且加载中露出的是深色遮罩，不是白色。
 *  - 结构性：抽屉出现、iframe 指向正确地址、Esc 能关、没开新窗口。
 *
 * 用法: node _e2e-embed.mjs
 * 依赖: 8787 已在跑（后端托管 web/dist）；脚本自己起一个延迟响应的慢服务
 */
import { spawn } from 'node:child_process'
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import http from 'node:http'

const BASE = process.env.DSM_BASE || 'http://127.0.0.1:8787'
const CHROME = process.env.DSM_CHROME || 'C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe'
const PORT = 9343
const SLOW_PORT = 9413
const SLOW_MS = 3000
const SHOTS = process.env.DSM_SHOTS || '.shots'

mkdirSync(SHOTS, { recursive: true })
const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`)
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// 慢页面：3 秒后才吐出内容，模拟"应用启动中 / 页面很大"的真实情况
const slowServer = http.createServer((req, res) => {
  setTimeout(() => {
    res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' })
    res.end('<html><body style="background:#fff;font:16px sans-serif">slow app</body></html>')
  }, SLOW_MS)
})
await new Promise((r) => slowServer.listen(SLOW_PORT, '127.0.0.1', r))
const SLOW_URL = `http://127.0.0.1:${SLOW_PORT}/slow`
// 独立的空目录：给临时项目一个自己的分组位置
const slowDir = mkdtempSync(join(tmpdir(), 'e2e-embed-app-'))

const profile = mkdtempSync(join(tmpdir(), 'cdp-embed-'))
const chrome = spawn(
  CHROME,
  [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--no-proxy-server',
    '--hide-scrollbars',
    '--window-size=1440,1000',
    `--remote-debugging-port=${PORT}`,
    `--user-data-dir=${profile}`,
    'about:blank',
  ],
  { stdio: 'ignore' },
)

async function wsUrl() {
  for (let i = 0; i < 80; i += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl)
      if (page) return page.webSocketDebuggerUrl
    } catch {
      /* 未就绪 */
    }
    await sleep(200)
  }
  throw new Error('Chrome 调试端口没起来')
}

let msgId = 0
const pending = new Map()
let socket

function send(method, params = {}) {
  const id = ++msgId
  socket.send(JSON.stringify({ id, method, params }))
  return new Promise((resolve, reject) => pending.set(id, { resolve, reject }))
}

async function evaluate(expression) {
  const res = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })
  if (res.exceptionDetails) throw new Error(res.exceptionDetails.exception?.description || 'evaluate 失败')
  return res.result?.value
}

/** 截图后统计"接近白色"的像素占比（缩到 320x200 再数，够用且快） */
async function whiteRatio(saveAs = null) {
  const shot = await send('Page.captureScreenshot', { format: 'png' })
  if (saveAs) writeFileSync(join(SHOTS, saveAs), Buffer.from(shot.data, 'base64'))
  return evaluate(`(async () => {
    const img = new Image()
    img.src = 'data:image/png;base64,${shot.data}'
    await img.decode()
    const c = document.createElement('canvas')
    c.width = 320; c.height = 200
    const ctx = c.getContext('2d')
    ctx.drawImage(img, 0, 0, 320, 200)
    const d = ctx.getImageData(0, 0, 320, 200).data
    // 判"刺眼的亮"用亮度而不是纯白：浏览器错误页是 r≈221 的浅灰，
    // 只数 >235 会把它当成"不白"，正是这种阈值放水会让验证假绿。
    let bright = 0
    for (let i = 0; i < d.length; i += 4) {
      const lum = d[i] * 0.299 + d[i+1] * 0.587 + d[i+2] * 0.114
      if (lum > 200) bright++
    }
    return bright / (320 * 200)
  })()`)
}

async function main() {
  socket = new WebSocket(await wsUrl())
  await new Promise((r) => (socket.onopen = r))
  socket.onmessage = (event) => {
    const msg = JSON.parse(event.data)
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id)
      pending.delete(msg.id)
      if (msg.error) reject(new Error(msg.error.message))
      else resolve(msg.result)
    }
  }
  await send('Runtime.enable')
  await send('Page.enable')

  await send('Page.navigate', { url: `${BASE}/projects` })
  await sleep(3200)
  check('工作台页面已加载', Boolean(await evaluate('document.title')), await evaluate('document.title'))

  // ---------- 对照组：证明探针能看见白 ----------
  send('Page.navigate', { url: SLOW_URL })
  const legacy = []
  for (let i = 0; i < 8; i += 1) {
    legacy.push(await whiteRatio())
    await sleep(100)
  }
  const legacyMax = Math.max(...legacy)
  check(
    '对照：慢页面加载确实产生白屏',
    legacyMax > 0.8,
    `最亮帧占比 ${(legacyMax * 100).toFixed(0)}%`,
  )

  // 回到工作台
  await send('Page.navigate', { url: `${BASE}/projects` })
  await sleep(3200)

  // ---------- 实验组 A：应用正在跑，抽屉里加载它 ----------
  // 用那个慢服务当"真应用"：它 3 秒才响应，正好覆盖最容易被看成白屏的加载期。
  // 直接调前端已有的 openUrl 入口不可行（被 useEmbed 包住），所以通过界面点开真实项目，
  // 再断言抽屉结构与"亮帧"——真实项目的地址快慢由环境决定，但判据不受影响。
  let appeared = false
  for (let i = 0; i < 40; i += 1) {
    appeared = await evaluate(`document.querySelectorAll('.project-row').length > 0`)
    if (appeared) break
    await sleep(250)
  }
  check('项目行已渲染', appeared, `行数 ${await evaluate(`document.querySelectorAll('.project-row').length`)}`)

  const clicked = await evaluate(`(() => {
    const el = document.querySelector('.project-row__url')
    if (!el) return 'no-target'
    el.click()
    return 'clicked'
  })()`)
  check('找到并点击了「打开」入口', clicked === 'clicked', clicked)

  const ratios = []
  const seen = { shell: false, notice: false }
  for (let i = 0; i < 20; i += 1) {
    ratios.push(await whiteRatio(i === 0 ? 'embed-first-frame.png' : null))
    const state = await evaluate(`({
      shell: !!document.querySelector('.embed-shell'),
      notice: !!document.querySelector('.embed-notice'),
    })`)
    if (state.shell) seen.shell = true
    if (state.notice) seen.notice = true
    await sleep(50)
  }
  const maxBright = Math.max(...ratios)
  check('抽屉出现时没有刺眼的亮帧（亮度>200 占比 < 25%）', maxBright < 0.25, `最亮帧占比 ${(maxBright * 100).toFixed(1)}%`)
  check('抽屉真的出现了', seen.shell)

  const detail = await evaluate(`(() => {
    const head = document.querySelector('.embed-head__title')
    const url = document.querySelector('.embed-head__url')
    const body = document.querySelector('.embed-body')
    return {
      headText: head ? head.innerText.replace(/\\s+/g, ' ').trim() : '',
      url: url ? url.innerText.trim() : '',
      bodyBg: body ? getComputedStyle(body).backgroundColor : '',
      notice: !!document.querySelector('.embed-notice'),
      noticeText: document.querySelector('.embed-notice') ? document.querySelector('.embed-notice').innerText.replace(/\\s+/g, ' ').trim() : '',
    }
  })()`)

  check('抽屉标题显示应用名', Boolean(detail.headText), detail.headText)
  check('抽屉里给出了地址', /^https?:\/\//.test(detail.url || ''), detail.url)

  const bg = (detail.bodyBg || '').match(/rgba?\((\d+), (\d+), (\d+)/)
  check(
    '抽屉主体是深色底（白屏的物理前提被移除）',
    Boolean(bg) && Number(bg[1]) < 80 && Number(bg[2]) < 80 && Number(bg[3]) < 80,
    detail.bodyBg,
  )

  // 该项目的端口此刻没在监听（工作台自身不在被管理的项目里跑），
  // 所以这里应当看到"服务未运行"的提示，而**不是**浏览器的浅灰错误页。
  check('端口不通时给出可操作提示，而不是错误页', detail.notice, detail.noticeText.slice(0, 60))
  check('端口不通时不渲染 iframe（掐掉浅灰错误页的来源）', !(await evaluate(`!!document.querySelector('.embed-frame')`)))

  await send('Page.captureScreenshot', { format: 'png' }).then((r) =>
    writeFileSync(join(SHOTS, 'embed-drawer-down.png'), Buffer.from(r.data, 'base64')),
  )

  // ---------- 关闭 ----------
  await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
  await sleep(300)
  check('Esc 能关掉抽屉', await evaluate(`!document.querySelector('.embed-shell')`))

  // ---------- 实验组 B：把慢服务登记进工作台，验证"应用在跑"的完整链路 ----------
  const created = await fetch(`${BASE}/api/projects`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      name: '__e2e_embed_probe__',
      // 单独目录：和工作台自己的目录分开，否则会被并进同一个项目组折叠起来，找不到这一行
      dir: slowDir,
      port: SLOW_PORT,
      url: SLOW_URL,
      type: 'node',
      remark: '自动化验证用，脚本结束即删除',
    }),
  }).then((r) => r.json())

  const projectId = created?.data?.id
  check('临时项目已建立', Boolean(projectId), projectId || JSON.stringify(created).slice(0, 120))

  if (projectId) {
    await send('Page.navigate', { url: `${BASE}/projects` })
    await sleep(3000)

    let opened = 'not-found'
    for (let i = 0; i < 40; i += 1) {
      opened = await evaluate(`(() => {
        const el = [...document.querySelectorAll('.project-row')].find((row) => row.innerText.includes('__e2e_embed_probe__'))
        if (!el) return 'not-found'
        const link = el.querySelector('.project-row__url')
        if (!link) return 'no-url'
        link.click()
        return 'clicked'
      })()`)
      if (opened === 'clicked') break
      await sleep(250)
    }
    check('在列表里找到临时项目并点开', opened === 'clicked', opened)

    // 慢服务要 3 秒才响应。只采"遮罩还在"的那一段——
    // 遮罩撤掉之后画面里就是应用页面本身，那个白是应用的白，不是工作台的闪白，
    // 两者混在一起统计会把结论搅乱（上一版就是这么误判成 80% 的）。
    // 采样口径必须精确：**只在遮罩在场时**判定。
    // 遮罩一撤，画面里就是应用页面本身，那个白是应用自己的白底（多数应用都是白底），
    // 不算工作台的闪白。早先把两者混着统计，于是永远拿到 ~80%，白怀疑一场。
    //
    // 用"截图驱动"：每拍一张就先问遮罩还在不在，在就计入样本、不在就停。
    // 这比"先轮询再截图"更贴近真实观感，也不会因为两段耗时错开而漏采。
    const brightness = []
    let layers = null
    let veilRounds = 0
    let frameRounds = 0
    const t0 = Date.now()
    while (Date.now() - t0 < 15000) {
      const state = await evaluate(`(() => {
        const veil = document.querySelector('.embed-loading')
        const frame = document.querySelector('.embed-frame')
        if (document.querySelector('.embed-notice')) return { phase: 'down' }
        if (!veil) return { phase: document.querySelector('.embed-shell') ? 'ready' : 'none' }
        return {
          phase: 'veil',
          frame: !!frame,
          veilZ: getComputedStyle(veil).zIndex,
          veilPos: getComputedStyle(veil).position,
          frameZ: frame ? getComputedStyle(frame).zIndex : null,
        }
      })()`)
      if (state.phase === 'down') break
      if (state.phase === 'ready') break
      if (state.phase === 'none') {
        await sleep(30)
        continue
      }
      veilRounds += 1
      if (state.frame) frameRounds += 1
      if (!layers) layers = state
      const idx = brightness.length
      const ratio = await whiteRatio(idx === 0 ? 'embed-probe-first.png' : null)
      // 截图本身要几十毫秒，期间遮罩可能刚好撤掉——那样这张图量到的是
      // 应用自己的白底，不是"遮罩没盖住"。所以拍完再确认一次，两次都在场才算有效样本。
      const stillVeiled = await evaluate(`!!document.querySelector('.embed-loading')`)
      if (!stillVeiled) break
      brightness.push(ratio)
      if (ratio > 0.25) {
        // 抓到亮帧就地留证，并记下当时的阶段文字
        const txt = await evaluate(`(document.querySelector('.embed-loading')||{}).innerText || ''`)
        console.log(`  · 第 ${idx} 张亮 ${(ratio * 100).toFixed(0)}% · 文字「${String(txt).replace(/\s+/g, ' ').slice(0, 30)}」`)
        await whiteRatio(`embed-bright-${idx}.png`)
      }
      await sleep(40)
    }

    check(
      '加载期确实覆盖了探测与加载两段',
      veilRounds >= 10,
      `遮罩在场 ${veilRounds} 轮 · iframe 已存在 ${frameRounds} 轮 · 共 ${Date.now() - t0}ms`,
    )

    const maxBright2 = brightness.length ? Math.max(...brightness) : -1
    check('加载期采到了足够多的画面', brightness.length >= 5, `${brightness.length} 张`)
    check(
      '遮罩在场期间没有任何亮帧（应用白底透不出来）',
      maxBright2 >= 0 && maxBright2 < 0.25,
      `最亮 ${(maxBright2 * 100).toFixed(1)}% · ${brightness.length} 张`,
    )

    // "加载期画面不亮"证明不了遮罩真的**叠在 iframe 之上**：
    // iframe 慢加载时是空文档、又垫了深色底，把遮罩挪下去也一样黑。
    // 层级才是权威判据，也是唯一能把"遮住了"和"恰好都黑"分开的东西。
    // （不能用 elementFromPoint：它碰到 iframe 一律返回 iframe 本身。）
    const veilZ = Number(layers?.veilZ)
    const frameZ = layers?.frameZ === 'auto' || layers?.frameZ == null ? 0 : Number(layers.frameZ)
    check(
      '加载遮罩叠在 iframe 之上（应用白底先画出来也盖得住）',
      Boolean(layers) && layers.veilPos === 'absolute' && Number.isFinite(veilZ) && veilZ > frameZ,
      layers ? `veil z=${layers.veilZ} / frame z=${layers.frameZ ?? '(iframe 未出现)'}` : '没抓到遮罩',
    )

    const frameInfo = await evaluate(`(() => {
      const f = document.querySelector('.embed-frame')
      return { has: !!f, src: f ? f.getAttribute('src') : '', cls: f ? f.className : '' }
    })()`)
    check('iframe 已指向临时项目地址', frameInfo.has && frameInfo.src === SLOW_URL, `${frameInfo.src || '(无 iframe)'} / ${frameInfo.cls}`)

    await sleep(3200)
    const ready = await evaluate(`(() => {
      const f = document.querySelector('.embed-frame')
      return { cls: f ? f.className : '', loading: !!document.querySelector('.embed-loading') }
    })()`)
    check('3 秒后加载完成（iframe 在且遮罩已撤）', Boolean(ready.cls) && !ready.loading, JSON.stringify(ready))

    await send('Page.captureScreenshot', { format: 'png' }).then((r) =>
      writeFileSync(join(SHOTS, 'embed-drawer-ready.png'), Buffer.from(r.data, 'base64')),
    )

    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Escape', code: 'Escape', windowsVirtualKeyCode: 27 })
    await sleep(200)

    const removed = await fetch(`${BASE}/api/projects/${projectId}`, { method: 'DELETE' }).then((r) => r.json())
    check('临时项目已清理', removed?.ok !== false, String(removed?.ok))
  }

  const pageCount = (await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json()).filter((t) => t.type === 'page').length
  check('全程没开新窗口（仍只有 1 个页面）', pageCount === 1, `页面数 ${pageCount}`)
}

main()
  .catch((err) => {
    console.error('E2E 异常:', err.message)
    results.push({ name: '脚本无异常', ok: false })
  })
  .finally(() => {
    const failed = results.filter((r) => !r.ok).length
    console.log(`\n${results.length - failed}/${results.length} 通过`)
    try {
      chrome.kill()
    } catch {
      /* 已退出 */
    }
    slowServer.close()
    process.exit(failed ? 1 : 0)
  })
