import { Router } from 'express'
import { runFile, spawnDetached } from '../utils/exec.js'
import { portScanner } from '../services/portScanner.js'
import { HttpError, asyncRoute, sendOk } from '../utils/http.js'
import { PROJECT_ROOT } from '../config.js'

/**
 * 文档转换：把 GitHub 上最火的本地自托管转换工具 Stirling-PDF 接进工作台。
 * 它本质是「一个 Docker 容器 + 一套 50+ 工具的 Web 界面 + REST API」，
 * 文件全程不出本机（隐私优于 iLovePDF / Smallpdf 这类在线工具）。
 *
 * 这里只负责把容器「一键拉起 / 停止 / 查状态」，以及把工作台的
 * 「原生快速转换」请求代理到它的 REST API（前端同源、绕过 CORS）。
 * 真正的格式互转（PDF↔Word/Excel/PPT/图片/HTML/Markdown、OCR、压缩…）
 * 全由 Stirling-PDF 自己完成——我们只做「接入」，不重复造轮子。
 */

const router = Router()

const CONTAINER = 'workbench-stirling'
const IMAGE = 'stirlingtools/stirling-pdf:latest'
const CONTAINER_PORT = 8080
const DEFAULT_HOST_PORT = 8790
const PULL_LOG = 'stirling-pull.log'

/** 执行 docker 命令（execFile 不经 shell，无注入风险） */
async function docker(args, opts) {
  return runFile('docker', args, opts)
}

/** Docker 是否可用：true / 'daemon-down'（装了没启动）/ false（没装） */
async function dockerState() {
  try {
    await docker(['version', '--format', '{{.Server.Version}}'], { timeout: 10000 })
    return true
  } catch {
    try {
      await docker(['version', '--format', '{{.Client.Version}}'], { timeout: 10000 })
      return 'daemon-down'
    } catch {
      return false
    }
  }
}

/** 本地是否已存在该镜像（用来区分「首次拉取」和「直接创建容器」） */
async function imagePresent() {
  try {
    await docker(['image', 'inspect', IMAGE], { timeout: 10000 })
    return true
  } catch {
    return false
  }
}

/** 解析 docker ps 的 Ports 字段，取出映射到容器 8080 的宿主端口 */
function hostPortOf(rawPorts) {
  const text = String(rawPorts || '')
  const match = text.match(/:(\d+)->(?:0\.0\.0\.0:)?\d+\/tcp/)
  return match ? Number(match[1]) : null
}

/** 查容器现状 */
async function inspectContainer() {
  const { stdout } = await docker(['ps', '-a', '--filter', `name=^${CONTAINER}$`, '--format', '{{json .}}'], {
    timeout: 15000,
  })
  const line = stdout.trim().split('\n').find(Boolean)
  if (!line) return { exists: false, running: false, hostPort: null, url: null }
  let raw
  try {
    raw = JSON.parse(line)
  } catch {
    return { exists: false, running: false, hostPort: null, url: null }
  }
  const state = String(raw.State || '')
  const running = state === 'running'
  const hostPort = hostPortOf(raw.Ports)
  return { exists: true, running, hostPort, url: hostPort ? `http://localhost:${hostPort}` : null }
}

/** 等待容器处于「存在且运行中」，返回最新状态 */
async function waitRunning(timeoutMs) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const info = await inspectContainer()
    if (info.exists && info.running && info.url) return info
    if (Date.now() >= deadline) return info
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }
}

// ---- 状态 ----
router.get(
  '/',
  asyncRoute(async (req, res) => {
    const state = await dockerState()
    if (state !== true) {
      sendOk(res, {
        installed: state === 'daemon-down' ? null : false,
        daemonOk: false,
        imagePresent: false,
        container: { exists: false, running: false, hostPort: null, url: null },
        targets: TARGET_LIST,
        error:
          state === 'daemon-down'
            ? 'Docker Desktop 未启动（看托盘鲸鱼图标是否稳定），或守护进程尚未就绪'
            : 'Docker 未安装或不在 PATH',
      })
      return
    }
    const [container, hasImage] = await Promise.all([inspectContainer(), imagePresent()])
    sendOk(res, { installed: true, daemonOk: true, imagePresent: hasImage, container, targets: TARGET_LIST, error: null })
  }),
)

// ---- 启动（一键拉起）----
router.post(
  '/start',
  asyncRoute(async (req, res) => {
    const state = await dockerState()
    if (state !== true) {
      throw new HttpError(502, state === 'daemon-down' ? 'Docker Desktop 未启动' : 'Docker 未安装或不在 PATH')
    }

    const info = await inspectContainer()
    if (info.exists && info.running && info.url) {
      sendOk(res, { ...info, phase: 'running' })
      return
    }

    // 已存在但停了：直接起（秒级）
    if (info.exists) {
      await docker(['start', CONTAINER], { timeout: 60000 })
      const ready = await waitRunning(60000)
      sendOk(res, { ...ready, phase: ready.running ? 'running' : 'starting' })
      return
    }

    // 不存在：先看镜像在不在
    const hasImage = await imagePresent()
    if (!hasImage) {
      // 首次使用：后台拉镜像，立刻返回让前端轮询，避免 HTTP 长阻塞（镜像可能上 GB）
      spawnDetached(`docker pull ${IMAGE}`, { cwd: PROJECT_ROOT })
      sendOk(res, { phase: 'pulling', imagePresent: false, container: info })
      return
    }

    const hostPort = await portScanner.findFreePort(DEFAULT_HOST_PORT, { limit: 200 })
    if (!hostPort) throw new HttpError(500, '找不到可用端口来映射 Stirling-PDF')
    await docker(
      [
        'run',
        '-d',
        '--name',
        CONTAINER,
        '-p',
        `${hostPort}:${CONTAINER_PORT}`,
        '-e',
        'SECURITY_ENABLELOGIN=false', // 本地单用户，关掉登录/API Key，开箱即用
        '-e',
        'SECURITY_CSP_DISABLE=true', // 关掉 CSP 才能被工作台 iframe 内嵌
        '-e',
        'SYSTEM_DEFAULTLOCALE=zh-CN', // 默认中文界面
        '--restart',
        'unless-stopped',
        IMAGE,
      ],
      { timeout: 120000 },
    )
    const ready = await waitRunning(90000)
    sendOk(res, { ...ready, phase: ready.running ? 'running' : 'starting' })
  }),
)

// ---- 停止 ----
router.post(
  '/stop',
  asyncRoute(async (req, res) => {
    const info = await inspectContainer()
    if (!info.exists) {
      sendOk(res, { ...info, phase: 'stopped' })
      return
    }
    try {
      await docker(['stop', CONTAINER], { timeout: 60000 })
    } catch (error) {
      const detail = String(error?.stderr || error?.message || error).split('\n')[0]
      throw new HttpError(502, `停止容器失败：${detail}`)
    }
    const after = await inspectContainer()
    sendOk(res, { ...after, phase: 'stopped' })
  }),
)

// ---- 原生快速转换：工作台上拖文件、选目标、直接下载 ----
// 代理到 Stirling-PDF 的 REST API（前端同源，绕开浏览器跨域限制）。
// 用 node:http/https 直接发请求（不走全局 fetch）：本机若设了 HTTP_PROXY，
// undici 的 EnvHttpProxyAgent 会把 localhost 也误导向代理而失败，http 模块不受影响。
import http from 'node:http'
import https from 'node:https'
import { URL } from 'node:url'

// 每个 target 可选 params：渲染到「快速转换」面板的可选参数。
//   type:'select' 用下拉；缺省为文本输入。default 为默认值；文本参数留空则「不传该字段」（走上游默认）。
// alt：上游在多个 Stirling 版本里路径漂移（如压缩 general↔misc），主路径 404 时回退到此路径。
// input：期望的源文件类型（前端用它提示「选的文件和目标不匹配」，避免白等几十秒后拿到英文报错）：
//   office=Word/Excel/PPT 等办公文档，pdf，html，markdown，image=图片，any=不限。
const TARGETS = {
  // —— 转成 PDF ——
  'office-to-pdf': { endpoint: '/api/v1/convert/file/pdf', ext: 'pdf', type: 'application/pdf', group: '转成 PDF', label: 'Office → PDF（Word / Excel / PPT）', input: 'office' },
  'html-to-pdf': { endpoint: '/api/v1/convert/html/pdf', ext: 'pdf', type: 'application/pdf', group: '转成 PDF', label: 'HTML → PDF', input: 'html' },
  'markdown-to-pdf': { endpoint: '/api/v1/convert/markdown/pdf', ext: 'pdf', type: 'application/pdf', group: '转成 PDF', label: 'Markdown → PDF', input: 'markdown' },
  'image-to-pdf': { endpoint: '/api/v1/convert/img/pdf', ext: 'pdf', type: 'application/pdf', group: '转成 PDF', label: '图片 → PDF', input: 'image' },
  // —— PDF 转其它 ——
  'pdf-to-word': {
    endpoint: '/api/v1/convert/pdf/word',
    ext: 'docx',
    type: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    group: 'PDF 转其它',
    label: 'PDF → Word（.docx）',
    input: 'pdf',
  },
  'pdf-to-ppt': {
    endpoint: '/api/v1/convert/pdf/presentation',
    ext: 'pptx',
    type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation',
    group: 'PDF 转其它',
    label: 'PDF → PowerPoint（.pptx）',
    input: 'pdf',
  },
  'pdf-to-excel': {
    endpoint: '/api/v1/convert/pdf/xlsx',
    ext: 'xlsx',
    type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    group: 'PDF 转其它',
    label: 'PDF → Excel（.xlsx）',
    input: 'pdf',
  },
  'pdf-to-html': { endpoint: '/api/v1/convert/pdf/html', ext: 'zip', type: 'application/zip', group: 'PDF 转其它', label: 'PDF → HTML（ZIP 压缩包）', input: 'pdf' },
  'pdf-to-markdown': { endpoint: '/api/v1/convert/pdf/markdown', ext: 'md', type: 'text/markdown', group: 'PDF 转其它', label: 'PDF → Markdown（.md）', input: 'pdf' },
  'pdf-to-text': { endpoint: '/api/v1/convert/pdf/text', ext: 'txt', type: 'text/plain', group: 'PDF 转其它', label: 'PDF → 纯文本（.txt）', input: 'pdf' },
  'pdf-to-epub': { endpoint: '/api/v1/convert/pdf/epub', ext: 'epub', type: 'application/epub+zip', group: 'PDF 转其它', label: 'PDF → EPUB（电子书）', input: 'pdf' },
  'pdf-to-image': { endpoint: '/api/v1/convert/pdf/img', ext: 'zip', type: 'application/zip', group: 'PDF 转其它', label: 'PDF → 图片（ZIP 压缩包）', input: 'pdf' },
  // —— Office 转其它（Word/Excel/PPT → 目标格式，经「转 PDF → 再转目标」流水线一次完成）——
  'word-to-ppt': { pipeline: ['/api/v1/convert/file/pdf', '/api/v1/convert/pdf/presentation'], ext: 'pptx', type: 'application/vnd.openxmlformats-officedocument.presentationml.presentation', group: 'Office 转其它', label: 'Word → PowerPoint（.pptx）', input: 'office' },
  'word-to-xlsx': { pipeline: ['/api/v1/convert/file/pdf', '/api/v1/convert/pdf/xlsx'], ext: 'xlsx', type: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', group: 'Office 转其它', label: 'Word → Excel（.xlsx，需含表格）', input: 'office' },
  'word-to-html': { pipeline: ['/api/v1/convert/file/pdf', '/api/v1/convert/pdf/html'], ext: 'zip', type: 'application/zip', group: 'Office 转其它', label: 'Word → HTML（ZIP 压缩包）', input: 'office' },
  'word-to-markdown': { pipeline: ['/api/v1/convert/file/pdf', '/api/v1/convert/pdf/markdown'], ext: 'md', type: 'text/markdown', group: 'Office 转其它', label: 'Word → Markdown（.md）', input: 'office' },
  'word-to-epub': { pipeline: ['/api/v1/convert/file/pdf', '/api/v1/convert/pdf/epub'], ext: 'epub', type: 'application/epub+zip', group: 'Office 转其它', label: 'Word → EPUB（电子书）', input: 'office' },
  'word-to-text': { pipeline: ['/api/v1/convert/file/pdf', '/api/v1/convert/pdf/text'], ext: 'txt', type: 'text/plain', group: 'Office 转其它', label: 'Word → 纯文本（.txt）', input: 'office' },
  // —— PDF 页面操作 ——
  'split-pages': {
    endpoint: '/api/v1/general/split-pages',
    ext: 'zip',
    type: 'application/zip',
    group: 'PDF 页面操作',
    label: '拆分 PDF（按页 → ZIP）',
    input: 'pdf',
    params: [{ name: 'pageNumbers', label: '拆分点', placeholder: '如 2,5 或 1-3,5（留空=每页一份）' }],
  },
  'rotate-pdf': {
    endpoint: '/api/v1/general/rotate-pdf',
    ext: 'pdf',
    type: 'application/pdf',
    group: 'PDF 页面操作',
    label: '旋转 PDF',
    input: 'pdf',
    params: [{ name: 'angle', label: '旋转角度', type: 'select', options: ['90', '180', '270'], default: '90' }],
  },
  // —— PDF 优化 / 增强 ——
  'compress-pdf': {
    endpoint: '/api/v1/misc/compress-pdf',
    alt: '/api/v1/general/compress-pdf',
    ext: 'pdf',
    type: 'application/pdf',
    group: 'PDF 优化 / 增强',
    label: '压缩 PDF（减小体积）',
    input: 'pdf',
    params: [{ name: 'optimizeLevel', label: '压缩级别', type: 'select', options: ['1', '2', '3', '4', '5'], default: '3' }],
  },
  'ocr-pdf': {
    endpoint: '/api/v1/misc/ocr-pdf',
    ext: 'pdf',
    type: 'application/pdf',
    group: 'PDF 优化 / 增强',
    label: 'OCR 文字识别（扫描件 → 可搜索 PDF）',
    input: 'pdf',
    params: [{ name: 'languages', label: '识别语言', placeholder: 'eng 英文 / chi_sim 简体（多个用逗号）', default: 'eng' }],
  },
}

/** 导出给前端做下拉项：单一事实来源，避免前后端两套列表漂移（含 params 供前端渲染可选参数） */
const TARGET_LIST = Object.entries(TARGETS).map(([value, t]) => ({
  value,
  label: t.label,
  group: t.group,
  input: t.input || 'any',
  params: t.params || [],
}))

/** 把 base64 解码成 Buffer，并挡掉非法 / 空内容 */
function safeBuffer(fileBase64) {
  let buffer
  try {
    buffer = Buffer.from(fileBase64, 'base64')
  } catch {
    throw new HttpError(400, 'fileBase64 不是合法的 base64')
  }
  if (buffer.length === 0) throw new HttpError(400, '文件内容为空')
  return buffer
}

/** 构造 multipart/form-data 请求体（手动拼，避免引入额外依赖） */
function buildMultipart(fields) {
  const boundary = `----workbench${Date.now()}`
  const chunks = []
  let length = 0
  for (const field of fields) {
    const head = Buffer.from(
      `--${boundary}\r\n` +
        `Content-Disposition: form-data; name="${field.name}"` +
        (field.filename ? `; filename="${field.filename}"` : '') +
        `\r\n` +
        (field.filename ? `Content-Type: ${field.type || 'application/octet-stream'}\r\n` : '') +
        `\r\n`,
    )
    const body = field.data
    const tail = Buffer.from('\r\n')
    chunks.push(head, body, tail)
    length += head.length + body.length + tail.length
  }
  const end = Buffer.from(`--${boundary}--\r\n`)
  length += end.length
  return { boundary, body: Buffer.concat([...chunks, end]), length }
}

/** 向本机 Stirling-PDF 发 multipart POST，返回 { status, contentType, buffer } */
function postMultipart(targetUrl, endpoint, fields) {
  const url = new URL(endpoint, targetUrl)
  const { boundary, body, length } = buildMultipart(fields)
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http
    const req = lib.request(
      {
        protocol: url.protocol,
        host: url.hostname,
        port: url.port,
        path: url.pathname,
        method: 'POST',
        headers: {
          'Content-Type': `multipart/form-data; boundary=${boundary}`,
          'Content-Length': length,
        },
      },
      (resp) => {
        const chunks = []
        resp.on('data', (c) => chunks.push(c))
        resp.on('end', () =>
          resolve({
            status: resp.statusCode,
            contentType: resp.headers['content-type'],
            buffer: Buffer.concat(chunks),
          }),
        )
      },
    )
    req.on('error', reject)
    req.write(body)
    req.end()
  })
}

/**
 * 把 Stirling / LibreOffice 的英文技术报错翻译成用户能行动的中文。
 * 这些报错高频出现（加密 PDF、损坏文件、源文档没有对应内容），
 * 原样透传等于让用户自己对着一句 "Failed to convert file" 猜。
 */
function explainUpstreamError(status, text) {
  const raw = String(text || '').slice(0, 200)
  if (/password|encrypt|protected/i.test(raw)) {
    return '文件已加密（带密码）：请先移除密码再转换（Stirling 界面里也有「移除密码」工具）'
  }
  if (/not a valid pdf|invalid pdf|damaged|corrupt|malformed/i.test(raw)) {
    return '文件不是有效的 PDF（可能已损坏，或实际不是 PDF）'
  }
  if (/no pages|no page|empty|blank/i.test(raw)) {
    return '文件里没有可处理的页面内容（空文档或扫描页无内容）'
  }
  if (/timeout|timed out/i.test(raw)) {
    return '转换超时：文件可能过大或过于复杂，可试试拆分后转换'
  }
  if (status === 400) {
    return `文件无法解析（HTTP 400）：${raw || '格式不受支持或文件已损坏'}`
  }
  if (status === 404) {
    return `当前 Stirling 版本没有该接口（HTTP 404）：${raw || '可在工具界面里手动操作'}`
  }
  if (/unsupported|failed to convert|conversion failed|error/i.test(raw)) {
    return `转换失败：${raw || '源文件格式不受支持或已损坏，可在工具界面里重试'}`
  }
  return raw || '请直接在打开的工具界面里操作'
}

/** 统一的「调 Stirling → 校验 → 返回文件字节」逻辑，convert / merge 共用 */
async function callStirling({ endpoint, alt, fields }) {
  const info = await inspectContainer()
  if (!info.running || !info.url) {
    throw new HttpError(409, '转换服务未运行，请先在页面上「一键启动」（或直接用打开的工具界面）')
  }
  let upstream
  try {
    upstream = await postMultipart(info.url, endpoint, fields)
    // Stirling 不同版本路径漂移（如压缩 general↔misc）：主路径 404 时回退 alt
    if (upstream.status === 404 && alt) {
      upstream = await postMultipart(info.url, alt, fields)
    }
  } catch (err) {
    throw new HttpError(502, `无法连接转换服务：${err.message}（请确认服务已运行）`)
  }
  if (upstream.status < 200 || upstream.status >= 300) {
    throw new HttpError(502, explainUpstreamError(upstream.status, upstream.buffer.toString('utf8')))
  }
  return upstream.buffer
}

router.post(
  '/convert',
  asyncRoute(async (req, res) => {
    const { fileName, fileBase64, target, params } = req.body || {}
    if (!fileName || !fileBase64 || !target) {
      throw new HttpError(400, '缺少 fileName / fileBase64 / target')
    }
    const op = TARGETS[target]
    if (!op) {
      throw new HttpError(400, `暂不支持该目标格式：${target}（可在右侧打开的工具界面里操作）`)
    }

    const fileField = { name: 'fileInput', filename: fileName, type: 'application/octet-stream', data: safeBuffer(fileBase64) }

    let endpoint
    let alt = null
    let fields
    if (op.pipeline) {
      // 多步流水线（如 Word → PDF → HTML）：一次请求串联多个操作
      endpoint = '/api/v1/pipeline/handleData'
      const json = JSON.stringify({ name: `wb-${target}`, pipeline: op.pipeline.map((operation) => ({ operation, parameters: {} })) })
      fields = [fileField, { name: 'json', data: Buffer.from(json) }]
    } else {
      endpoint = op.endpoint
      alt = op.alt
      // 把 target 声明的可选参数拼进 multipart（文本参数留空则不传，走上游默认）
      const extra = []
      for (const p of op.params || []) {
        let v = params?.[p.name]
        if (v === undefined || v === null) v = p.default
        if (v === undefined || v === null || v === '') continue
        extra.push({ name: p.name, data: Buffer.from(String(v)) })
      }
      fields = [fileField, ...extra]
    }

    const out = await callStirling({ endpoint, alt, fields })
    const base = String(fileName).replace(/\.[^.]+$/, '')
    res.setHeader('Content-Type', op.type)
    res.setHeader('Content-Disposition', `attachment; filename="${base}.${op.ext}"`)
    res.send(out)
  }),
)

// ---- 多文件合并：把多份 PDF 合成一个（Stirling 的 merge-pdfs）----
router.post(
  '/merge',
  asyncRoute(async (req, res) => {
    const { files, sortType } = req.body || {}
    if (!Array.isArray(files) || files.length < 2) {
      throw new HttpError(400, '合并至少需要 2 个文件')
    }
    const fields = []
    for (const f of files) {
      if (!f.fileName || !f.fileBase64) {
        throw new HttpError(400, '每个文件都需要 fileName 和 fileBase64')
      }
      fields.push({ name: 'fileInput', filename: f.fileName, type: 'application/octet-stream', data: safeBuffer(f.fileBase64) })
    }
    fields.push({ name: 'sortType', data: Buffer.from(String(sortType || 'orderProvided')) })

    const out = await callStirling({ endpoint: '/api/v1/general/merge-pdfs', fields })
    res.setHeader('Content-Type', 'application/pdf')
    res.setHeader('Content-Disposition', 'attachment; filename="merged.pdf"')
    res.send(out)
  }),
)

export default router
