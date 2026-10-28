import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api/client.js'
import { PageHint } from '../components/PageHint.jsx'
import { Button, Card, ErrorNotice, Loading, Notice } from '../components/ui.jsx'
import { Icon } from '../components/Icons.jsx'
import { useToast } from '../hooks/useToast.jsx'

/**
 * 文档转换：把 GitHub 上最火的本地自托管转换工具 Stirling-PDF（90k+ ★，MIT）
 * 接进工作台。文件全程不出本机，比 iLovePDF / Smallpdf 这类在线工具更隐私。
 *
 * 两种用法：
 *   1. 主界面直接内嵌 Stirling-PDF 的完整 Web 工具（60+ 工具，拖拽即用）；
 *   2. 上方「快速转换 / 合并」面板，在工作台里拖文件、选目标、直接下载，不必切界面。
 *      快速转换支持多文件批量（按顺序逐个转换，逐个下载，最后给汇总）。
 */

// ---- 目标格式的「输入类型」→ 扩展名：用来在选错文件时提前拦住 ----
// 数据源是后端 TARGETS 的 input 声明（GET /api/converter 的 targets 里带 input）。
const INPUT_EXTS = {
  office: ['doc', 'docx', 'xls', 'xlsx', 'ppt', 'pptx', 'odt', 'ods', 'odp', 'rtf', 'txt'],
  pdf: ['pdf'],
  html: ['html', 'htm'],
  markdown: ['md', 'markdown'],
  image: ['png', 'jpg', 'jpeg', 'gif', 'bmp', 'tif', 'tiff', 'webp'],
  any: null, // 不限
}
const INPUT_LABEL = {
  office: '办公文档',
  pdf: 'PDF',
  html: 'HTML',
  markdown: 'Markdown',
  image: '图片',
  any: '任意文件',
}

// 单个文件上限：服务器 express.json 上限 50MB，base64 会膨胀约 1/3，
// 留出余量定 35MB——超了在客户端就挡掉，别等服务器回一句英文 413。
const MAX_FILE_BYTES = 35 * 1024 * 1024
const RECENT_KEY = 'dsm-converter-recent'
const RECENT_MAX = 8

/** 把平铺的 targets 按 group 聚合成 optgroup 结构 */
function groupTargets(list) {
  const groups = new Map()
  for (const t of list) {
    if (!groups.has(t.group)) groups.set(t.group, [])
    groups.get(t.group).push(t)
  }
  return [...groups.entries()].map(([group, items]) => ({ group, items }))
}

/** 当前目标格式的完整定义（数据源为后端 GET /api/converter 下发的 targets） */
function targetDef(target, list) {
  return (list || []).find((t) => t.value === target) || null
}

function targetParams(target, list) {
  return targetDef(target, list)?.params || []
}

function targetLabel(target, list) {
  return targetDef(target, list)?.label || target
}

function extOf(name) {
  const match = String(name || '').toLowerCase().match(/\.([a-z0-9]+)$/)
  return match ? match[1] : ''
}

/** 文件扩展名与目标 input 不匹配时为 true（any / 无扩展名 / 未声明都不拦，让上游决定） */
function inputMismatch(fileName, input) {
  const exts = INPUT_EXTS[input]
  if (!exts) return false
  const ext = extOf(fileName)
  if (!ext) return false
  return !exts.includes(ext)
}

function formatSize(bytes) {
  if (!Number.isFinite(bytes)) return ''
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

function formatClock(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

function readFileAsBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      const result = String(reader.result)
      const comma = result.indexOf(',')
      resolve(comma >= 0 ? result.slice(comma + 1) : result)
    }
    reader.onerror = () => reject(reader.error)
    reader.readAsDataURL(file)
  })
}

/** 触发浏览器下载（转换 / 合并结果） */
function downloadBlob(blob, fileName) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = fileName
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

function loadRecent() {
  try {
    const list = JSON.parse(localStorage.getItem(RECENT_KEY) || '[]')
    return Array.isArray(list) ? list : []
  } catch {
    return []
  }
}

function pushRecent(entry) {
  const list = [entry, ...loadRecent()].slice(0, RECENT_MAX)
  try {
    localStorage.setItem(RECENT_KEY, JSON.stringify(list))
  } catch {
    /* 隐私模式等写不进去就算了，不影响转换 */
  }
  return list
}

/** 统一的拖拽 / 点击上传区（快速转换与合并共用） */
function FileDrop({ accept, multiple, icon, hint, subHint, onFiles }) {
  const inputRef = useRef(null)
  const [over, setOver] = useState(false)
  return (
    <div
      onDragOver={(e) => {
        e.preventDefault()
        setOver(true)
      }}
      onDragLeave={() => setOver(false)}
      onDrop={(e) => {
        e.preventDefault()
        setOver(false)
        onFiles(e.dataTransfer.files)
      }}
      onClick={() => inputRef.current?.click()}
      style={{
        border: `1.5px dashed ${over ? 'var(--accent)' : 'var(--border)'}`,
        borderRadius: 10,
        padding: '18px 16px',
        textAlign: 'center',
        cursor: 'pointer',
        background: over ? 'var(--accent-soft)' : 'transparent',
        transition: 'border-color .15s, background .15s',
      }}
    >
      <input
        ref={inputRef}
        type="file"
        accept={accept}
        multiple={multiple}
        style={{ display: 'none' }}
        onChange={(e) => {
          onFiles(e.target.files)
          e.target.value = ''
        }}
      />
      <Icon name={icon} size={20} style={{ color: 'var(--muted)', marginBottom: 6 }} />
      <div>{hint}</div>
      {subHint ? (
        <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
          {subHint}
        </div>
      ) : null}
    </div>
  )
}

/** 批量队列单行：待转换 / 转换中 / 完成 / 失败 */
function QueueRow({ item, index, onRemove, disabled }) {
  const tone = item.status === 'done' ? 'var(--green)' : item.status === 'error' ? 'var(--red)' : item.status === 'doing' ? 'var(--blue)' : 'var(--muted-2)'
  const statusText = item.status === 'done' ? '完成' : item.status === 'error' ? '失败' : item.status === 'doing' ? '转换中…' : '等待'
  return (
    <div
      className="row"
      style={{
        gap: 8,
        justifyContent: 'space-between',
        alignItems: 'center',
        padding: '6px 10px',
        border: '1px solid var(--border)',
        borderRadius: 8,
      }}
    >
      <span className="row" style={{ gap: 8, minWidth: 0 }}>
        <span className="tech muted" style={{ flex: 'none' }}>
          {index + 1}
        </span>
        <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.file.name}</span>
        <span className="tech muted" style={{ flex: 'none' }}>
          {formatSize(item.file.size)}
        </span>
      </span>
      <span className="row" style={{ gap: 8, flex: 'none' }}>
        {item.status === 'done' && item.out ? (
          <span className="tech muted">
            → {item.out.name}（{formatSize(item.out.size)}）
          </span>
        ) : null}
        <span className="tech" style={{ color: tone }}>
          {item.status === 'done' ? <Icon name="check" size={12} /> : null}
          {item.status === 'error' ? <Icon name="alert" size={12} /> : null}
          {statusText}
        </span>
        <Button variant="ghost" size="sm" onClick={() => onRemove(item.id)} disabled={disabled}>
          <Icon name="x" size={13} />
        </Button>
      </span>
    </div>
  )
}

export function ConverterPage() {
  const toast = useToast()
  const [status, setStatus] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(null)
  const [polling, setPolling] = useState(false)
  const [showQuick, setShowQuick] = useState(false)
  const [iframeLoading, setIframeLoading] = useState(true)

  // 原生快速转换面板状态（多文件批量队列）
  const [queue, setQueue] = useState([])
  const [target, setTarget] = useState('office-to-pdf')
  const [params, setParams] = useState({})
  const [converting, setConverting] = useState(false)
  const [convertError, setConvertError] = useState(null)
  const [elapsed, setElapsed] = useState(0)

  // 合并 PDF 面板状态（多文件）
  const [mergeFiles, setMergeFiles] = useState([])
  const [merging, setMerging] = useState(false)
  const [mergeError, setMergeError] = useState(null)

  // 最近转换记录（localStorage，刷新不丢）
  const [recent, setRecent] = useState(loadRecent)

  // 目标格式列表：单一事实来源来自后端（GET /api/converter 的 targets）
  const targets = status?.targets || []

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setStatus(await api.converter())
    } catch (err) {
      setError(err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  useEffect(() => {
    setRecent(loadRecent())
  }, [])

  // 切换目标格式时，把可选参数重置为该格式的默认值（不依赖 status，避免启动轮询刷新时清空已填值）
  useEffect(() => {
    const init = {}
    for (const p of targetParams(target, targets)) init[p.name] = p.default ?? ''
    setParams(init)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [target])

  // 容器重启后 iframe 要重新 loading
  useEffect(() => {
    setIframeLoading(true)
  }, [status?.container?.url])

  // 轮询：覆盖「首次拉镜像 → 创建容器 → 等待就绪」的全过程，避免 HTTP 长时间阻塞
  useEffect(() => {
    if (!polling) return undefined
    const timer = setInterval(async () => {
      try {
        const s = await api.converter()
        setStatus(s)
        if (s.container?.running) {
          setPolling(false)
          setBusy(null)
          return
        }
        // 镜像已拉完但容器还没建：补一次启动（这次会创建并运行容器）
        if (s.imagePresent && !s.container?.exists) {
          await api.converterStart()
        }
      } catch {
        /* 轮询失败先忽略，下一拍再试 */
      }
    }, 3000)
    return () => clearInterval(timer)
  }, [polling])

  async function handleStart() {
    setBusy('start')
    try {
      const r = await api.converterStart()
      setStatus(r)
      if (r.phase === 'pulling') {
        toast.info('首次使用：正在拉取 Stirling-PDF 镜像（约数百 MB，请稍候）…')
      }
      if (!r.container?.running) {
        setPolling(true)
      } else {
        setBusy(null)
      }
    } catch (err) {
      toast.error('启动失败', err.message)
      setBusy(null)
    }
  }

  async function handleStop() {
    setBusy('stop')
    setPolling(false)
    try {
      const r = await api.converterStop()
      setStatus(r)
      toast.success('已停止文档转换服务')
    } catch (err) {
      toast.error('停止失败', err.message)
    } finally {
      setBusy(null)
    }
  }

  /** 添加文件到批量队列：挡掉超大文件（服务器 50MB JSON 上限，base64 还会膨胀） */
  function addQueueFiles(fileList) {
    const incoming = Array.from(fileList || [])
    if (incoming.length === 0) return
    const tooBig = incoming.filter((f) => f.size > MAX_FILE_BYTES)
    const ok = incoming.filter((f) => f.size <= MAX_FILE_BYTES)
    if (tooBig.length > 0) {
      toast.error('文件过大', `${tooBig.map((f) => f.name).join('、')} 超过 35MB，请压缩或拆分后重试`)
    }
    if (ok.length > 0) {
      setQueue((prev) => [...prev, ...ok.map((file) => ({ id: `${file.name}-${file.size}-${file.lastModified}-${Math.random().toString(36).slice(2, 7)}`, file, status: 'pending', error: null, out: null }))])
    }
  }

  async function handleConvertAll() {
    const pending = queue.filter((i) => i.status !== 'done')
    if (pending.length === 0) {
      toast.warn('先添加文件')
      return
    }
    setConverting(true)
    setConvertError(null)
    startElapsed()
    // 本次新产生的记录（最新的在前），结束后一次性并入 localStorage，
    // 不能往 loadRecent() 的副本里 unshift——pushRecent 自己会再拼一次旧列表，会重复。
    const newEntries = []
    let okCount = 0
    let failCount = 0
    for (const item of pending) {
      setQueue((prev) => prev.map((q) => (q.id === item.id ? { ...q, status: 'doing', error: null } : q)))
      try {
        const base64 = await readFileAsBase64(item.file)
        const { blob, fileName } = await api.converterConvert({ fileName: item.file.name, fileBase64: base64, target, params })
        downloadBlob(blob, fileName)
        okCount += 1
        newEntries.unshift({ at: new Date().toISOString(), file: item.file.name, target: targetLabel(target, targets), size: blob.size })
        setQueue((prev) => prev.map((q) => (q.id === item.id ? { ...q, status: 'done', out: { name: fileName, size: blob.size } } : q)))
      } catch (err) {
        failCount += 1
        setQueue((prev) => prev.map((q) => (q.id === item.id ? { ...q, status: 'error', error: err.message } : q)))
      }
    }
    stopElapsed()
    setConverting(false)
    if (newEntries.length > 0) setRecent(pushRecent(newEntries))
    if (failCount === 0) {
      toast.success(`转换完成：${okCount} 个文件已下载`)
    } else if (okCount === 0) {
      toast.error('全部失败', `共 ${failCount} 个文件转换失败，原因见下方列表`)
      setConvertError('本次批量全部失败，请先看列表里每个文件的具体原因')
    } else {
      toast.info(`转换完成：成功 ${okCount} 个，失败 ${failCount} 个（失败原因见列表）`)
    }
  }

  function addMergeFiles(fileList) {
    const incoming = Array.from(fileList || []).filter((f) => f.type === 'application/pdf' || /\.pdf$/i.test(f.name))
    if (incoming.length === 0) {
      toast.warn('只能添加 PDF 文件')
      return
    }
    const tooBig = incoming.filter((f) => f.size > MAX_FILE_BYTES)
    const ok = incoming.filter((f) => f.size <= MAX_FILE_BYTES)
    if (tooBig.length > 0) {
      toast.error('文件过大', `${tooBig.map((f) => f.name).join('、')} 超过 35MB，请压缩或拆分后重试`)
    }
    if (ok.length > 0) {
      setMergeFiles((prev) => [...prev, ...ok])
    }
  }

  async function handleMerge() {
    if (mergeFiles.length < 2) {
      toast.warn('至少选 2 个 PDF')
      return
    }
    setMerging(true)
    setMergeError(null)
    startElapsed()
    try {
      const files = []
      for (const f of mergeFiles) {
        files.push({ fileName: f.name, fileBase64: await readFileAsBase64(f) })
      }
      const { blob, fileName } = await api.converterMerge({ files, sortType: 'orderProvided' })
      downloadBlob(blob, fileName)
      toast.success(`已合并 ${mergeFiles.length} 个文件 → ${fileName}`)
    } catch (err) {
      setMergeError(err.message)
      toast.error('合并失败', err.message)
    } finally {
      stopElapsed()
      setMerging(false)
    }
  }

  // 转换 / 合并共用的「已等待 N 秒」计时器
  const timerRef = useRef(null)
  function startElapsed() {
    stopElapsed()
    const startedAt = Date.now()
    setElapsed(0)
    timerRef.current = setInterval(() => setElapsed(Math.floor((Date.now() - startedAt) / 1000)), 1000)
  }
  function stopElapsed() {
    if (timerRef.current) {
      clearInterval(timerRef.current)
      timerRef.current = null
    }
  }
  useEffect(() => stopElapsed, [])

  const container = status?.container
  const running = Boolean(container?.running && container?.url)
  const daemonDown = status && status.daemonOk === false

  // 队列里待转换的文件与当前目标的类型匹配检查（选错目标时提前拦，别白等几十秒）
  const pendingItems = queue.filter((i) => i.status !== 'done')
  const currentInput = targetDef(target, targets)?.input || 'any'
  const mismatchItems = pendingItems.filter((i) => inputMismatch(i.file.name, currentInput))
  const pendingExts = pendingItems.map((i) => extOf(i.file.name))
  const doneCount = queue.length - pendingItems.length

  if (loading && !status) {
    return (
      <div>
        <div className="page__header">
          <div>
            <h1 className="page__title">文档转换</h1>
            <p className="page__subtitle">本地自托管的 Stirling-PDF（GitHub 90k★）</p>
          </div>
        </div>
        <Card>
          <Loading text="读取转换服务状态…" />
        </Card>
      </div>
    )
  }

  return (
    <div>
      <div className="page__header">
        <div>
          <h1 className="page__title">文档转换</h1>
          <p className="page__subtitle">
            本地自托管的 <strong>Stirling-PDF</strong>（GitHub 90k★，MIT）—— 文件全程不出本机
          </p>
        </div>
        <div className="page__actions">
          <Button variant="ghost" onClick={load} disabled={loading || polling}>
            <Icon name="refresh" size={13} /> 刷新
          </Button>
        </div>
      </div>

      <PageHint id="converter">
        这一页把 GitHub 上最火的本地文档转换工具 <strong>Stirling-PDF</strong>（60+ 工具）接进了工作台：合并 / 拆分 /
        旋转 / 压缩 / <strong>OCR 文字识别</strong> / 加签名 / 加密，以及 <strong>PDF ↔ Word / Excel / PPT / 图片 /
        HTML / Markdown</strong> 互转；还能把 <strong>Word → PPT / Excel / EPUB / HTML / Markdown / 纯文本</strong>。
        下面的大窗口就是它本体的界面，也可以在工作台里直接用「快速转换」面板拖文件转换（支持多文件批量）。
      </PageHint>

      {error ? <ErrorNotice error={error} onRetry={load} /> : null}

      {daemonDown ? (
        <Notice tone="warn" icon="alert">
          <strong>连不上 Docker：{status?.error}</strong>
          <div style={{ marginTop: 6 }}>
            先看 Windows 托盘有没有鲸鱼图标：没有就打开 Docker Desktop 等它稳定；有就右键选 Restart。
            Stirling-PDF 跑在 Docker 容器里，Docker 没起来时无法启动。
          </div>
        </Notice>
      ) : null}

      {status?.daemonOk ? (
        <Card
          title="转换服务"
          icon="fileText"
          actions={
            <span className="row" style={{ gap: 8 }}>
              {running ? (
                <>
                  <Button variant="ghost" onClick={() => window.open(container.url, '_blank', 'noopener')}>
                    <Icon name="external" size={13} /> 新标签打开
                  </Button>
                  <Button variant="danger" onClick={handleStop} loading={busy === 'stop'} disabled={busy !== null}>
                    <Icon name="stop" size={13} /> 停止
                  </Button>
                </>
              ) : (
                <Button variant="primary" onClick={handleStart} loading={busy === 'start' || polling} disabled={busy !== null}>
                  <Icon name="play" size={13} /> 一键启动
                </Button>
              )}
            </span>
          }
        >
          <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
            <span className={`status-word ${running ? '' : 'muted'}`}>{running ? '运行中' : polling ? '启动中…' : '未运行'}</span>
            {container?.hostPort ? (
              <span className="tech muted">宿主端口 {container.hostPort} → 容器 8080</span>
            ) : null}
            <span className="tech muted">镜像 stirlingtools/stirling-pdf:latest</span>
          </div>
          {!running && !polling ? (
            <div className="muted" style={{ marginTop: 10, fontSize: 13, lineHeight: 1.7 }}>
              首次启动会自动拉取镜像（约数百 MB，稍慢），之后秒级启动。启动后即可在下方窗口里直接转换，
              或用上面的「快速转换 / 合并」面板。所有文件只在你本机处理，不会上传到任何第三方。
              该服务同时登记在「项目」页（Stirling-PDF 文档转换），可从那里统一启动 / 停止。
            </div>
          ) : null}
        </Card>
      ) : null}

      {/* 快速转换面板：在工作台内拖文件、选目标、直接下载（支持多文件批量） */}
      {status?.daemonOk ? (
        <Card
          title="快速转换"
          icon="arrowUpRight"
          actions={
            <Button variant="ghost" size="sm" onClick={() => setShowQuick((v) => !v)}>
              {showQuick ? '收起' : '展开'}
            </Button>
          }
        >
          {!showQuick ? (
            <div className="muted" style={{ fontSize: 13 }}>
              常用转换不必切界面：展开后拖入文件（可多选批量）、选目标格式即可直接下载。
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 12 }}>
              {!running ? (
                <div className="muted" style={{ fontSize: 13 }}>
                  转换服务未运行，先点上方「一键启动」后才能转换。
                </div>
              ) : null}

              <FileDrop
                multiple
                icon="fileText"
                hint={queue.length > 0 ? `已添加 ${queue.length} 个文件，可继续点击或拖拽追加` : '点击或拖拽文件到这里（可多选，批量转换）'}
                subHint={`单个文件 ≤ 35MB · 已完成 ${doneCount} 个`}
                onFiles={addQueueFiles}
              />

              <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
                <select className="select" value={target} onChange={(e) => setTarget(e.target.value)} style={{ minWidth: 300 }}>
                  {groupTargets(targets).map(({ group, items }) => (
                    <optgroup key={group} label={group}>
                      {items.map((opt) => {
                        // 已选文件与该目标不匹配时，在选项上直接标注，免得选错
                        const exts = INPUT_EXTS[opt.input]
                        const marked = exts && pendingExts.some((e) => e && !exts.includes(e))
                        return (
                          <option key={opt.value} value={opt.value}>
                            {marked ? `${opt.label}（需 ${INPUT_LABEL[opt.input] || opt.input}）` : opt.label}
                          </option>
                        )
                      })}
                    </optgroup>
                  ))}
                </select>
                <Button
                  variant="primary"
                  onClick={handleConvertAll}
                  loading={converting}
                  disabled={pendingItems.length === 0 || !running || mismatchItems.length > 0}
                >
                  <Icon name="arrowUpRight" size={13} /> {converting ? `转换中 ${elapsed}s` : queue.length > 1 ? `转换全部（${pendingItems.length}）并下载` : '转换并下载'}
                </Button>
                {queue.length > 0 ? (
                  <Button variant="ghost" size="sm" onClick={() => setQueue([])} disabled={converting}>
                    清空列表
                  </Button>
                ) : null}
              </div>

              {targetParams(target, targets).length > 0 ? (
                <div style={{ display: 'grid', gap: 8 }}>
                  {targetParams(target, targets).map((p) => (
                    <label key={p.name} className="row" style={{ gap: 8, alignItems: 'center', fontSize: 13 }}>
                      <span style={{ minWidth: 80, color: 'var(--muted)' }}>{p.label}</span>
                      {p.type === 'select' ? (
                        <select
                          className="select"
                          style={{ minWidth: 120 }}
                          value={params[p.name] ?? ''}
                          onChange={(e) => setParams((prev) => ({ ...prev, [p.name]: e.target.value }))}
                        >
                          {p.options.map((o) => (
                            <option key={o} value={o}>
                              {o}
                            </option>
                          ))}
                        </select>
                      ) : (
                        <input
                          className="select"
                          style={{ flex: 1, minWidth: 200 }}
                          placeholder={p.placeholder || ''}
                          value={params[p.name] ?? ''}
                          onChange={(e) => setParams((prev) => ({ ...prev, [p.name]: e.target.value }))}
                        />
                      )}
                    </label>
                  ))}
                </div>
              ) : null}

              {mismatchItems.length > 0 ? (
                <Notice tone="warn" icon="alert">
                  <strong>
                    有 {mismatchItems.length} 个文件与「{targetLabel(target, targets)}」不匹配
                  </strong>
                  <div style={{ marginTop: 4 }}>
                    该目标需要 <b>{INPUT_LABEL[currentInput] || currentInput}</b>，但你添加了：
                    {mismatchItems.map((i) => i.file.name).join('、')}。
                    办公文档请先选「Office → PDF」，PDF 类操作请确保文件是 .pdf。
                  </div>
                </Notice>
              ) : null}

              {queue.length > 0 ? (
                <div style={{ display: 'grid', gap: 6 }}>
                  {queue.map((item, i) => (
                    <div key={item.id}>
                      <QueueRow item={item} index={i} disabled={converting} onRemove={(id) => setQueue((prev) => prev.filter((q) => q.id !== id))} />
                      {item.status === 'error' && item.error ? (
                        <div style={{ fontSize: 12, color: 'var(--red)', padding: '4px 10px 0' }}>{item.error}</div>
                      ) : null}
                    </div>
                  ))}
                </div>
              ) : null}

              {converting ? (
                <div className="muted row" style={{ gap: 6, fontSize: 12, alignItems: 'center' }}>
                  <Icon name="clock" size={12} /> 已等待 {elapsed} 秒——大文件或 LibreOffice 首次转换较慢，属正常现象，请勿重复点击。
                </div>
              ) : null}

              {convertError ? (
                <Notice tone="error" icon="alert">
                  {convertError}
                </Notice>
              ) : null}
              <div className="muted" style={{ fontSize: 12 }}>
                OCR / 拆分 / 旋转 / 压缩 / Office 转其它 已可在上方直接用；更多能力（加密、去签名、PDF/A、页面重排 等）请用下方工具窗口。
              </div>
            </div>
          )}
        </Card>
      ) : null}

      {/* 合并 PDF：多文件合成一个（按添加顺序） */}
      {status?.daemonOk ? (
        <Card title="合并 PDF" icon="layers">
          {!running ? (
            <div className="muted" style={{ fontSize: 13, marginBottom: 10 }}>
              转换服务未运行，先点上方「一键启动」后才能合并。
            </div>
          ) : null}
          <FileDrop
            accept="application/pdf,.pdf"
            multiple
            icon="layers"
            hint="点击或拖拽多个 PDF 到这里（按添加顺序合并）"
            subHint="仅支持 PDF · 单个文件 ≤ 35MB"
            onFiles={addMergeFiles}
          />

          {mergeFiles.length > 0 ? (
            <div style={{ marginTop: 12, display: 'grid', gap: 6 }}>
              {mergeFiles.map((f, i) => (
                <div
                  key={`${f.name}-${i}`}
                  className="row"
                  style={{
                    gap: 8,
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '6px 10px',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                  }}
                >
                  <span className="row" style={{ gap: 8, minWidth: 0 }}>
                    <span className="tech muted" style={{ flex: 'none' }}>
                      {i + 1}
                    </span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{f.name}</span>
                    <span className="tech muted" style={{ flex: 'none' }}>
                      {formatSize(f.size)}
                    </span>
                  </span>
                  <Button variant="ghost" size="sm" onClick={() => setMergeFiles((prev) => prev.filter((_, idx) => idx !== i))}>
                    <Icon name="x" size={13} />
                  </Button>
                </div>
              ))}
              <div className="row" style={{ gap: 10, marginTop: 4 }}>
                <Button variant="primary" onClick={handleMerge} loading={merging} disabled={mergeFiles.length < 2 || !running}>
                  <Icon name="layers" size={13} /> {merging ? `合并中 ${elapsed}s` : '合并并下载'}
                </Button>
                <Button variant="ghost" size="sm" onClick={() => setMergeFiles([])} disabled={merging}>
                  清空
                </Button>
              </div>
            </div>
          ) : null}

          {mergeError ? (
            <div style={{ marginTop: 8 }}>
              <Notice tone="error" icon="alert">
                {mergeError}
              </Notice>
            </div>
          ) : null}
        </Card>
      ) : null}

      {/* 最近转换记录（localStorage，刷新不丢） */}
      {recent.length > 0 ? (
        <Card
          title="最近转换"
          icon="clock"
          actions={
            <Button variant="ghost" size="sm" onClick={() => { setRecent([]); try { localStorage.removeItem(RECENT_KEY) } catch { /* 忽略 */ } }}>
              <Icon name="trash" size={13} /> 清空
            </Button>
          }
        >
          <div style={{ display: 'grid', gap: 4 }}>
            {recent.map((r, i) => (
              <div key={`${r.at}-${i}`} className="row" style={{ gap: 8, fontSize: 13, alignItems: 'baseline' }}>
                <span className="tech muted" style={{ flex: 'none' }}>{formatClock(r.at)}</span>
                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{r.file}</span>
                <span className="tech muted" style={{ flex: 'none' }}>→ {r.target}</span>
                <span className="tech muted" style={{ flex: 'none', marginLeft: 'auto' }}>{formatSize(r.size)}</span>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {/* 主界面：直接内嵌 Stirling-PDF 完整工具 */}
      {running ? (
        <Card flush>
          <div style={{ position: 'relative' }}>
            {iframeLoading ? (
              <div
                className="row muted"
                style={{ height: 'min(82vh, 920px)', justifyContent: 'center', alignItems: 'center', gap: 8, fontSize: 13 }}
              >
                <Icon name="refresh" size={14} /> 正在加载 Stirling-PDF 工具界面…
              </div>
            ) : null}
            <iframe
              src={container.url}
              title="Stirling-PDF"
              onLoad={() => setIframeLoading(false)}
              style={{
                width: '100%',
                height: 'min(82vh, 920px)',
                border: '0',
                display: 'block',
                borderRadius: '0 0 12px 12px',
                opacity: iframeLoading ? 0 : 1,
                transition: 'opacity .2s',
              }}
            />
          </div>
        </Card>
      ) : null}
    </div>
  )
}
