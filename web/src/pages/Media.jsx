import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api/client.js'
import { PageHint } from '../components/PageHint.jsx'
import { Button, Card, ErrorNotice, Loading, Notice } from '../components/ui.jsx'
import { Icon } from '../components/Icons.jsx'
import { useToast } from '../hooks/useToast.jsx'

/**
 * 本地影院：把「本地私人影院 2.0」（tools/mediaserver，纯 Python 标准库）接进工作台。
 *
 *   片库      —— 视频丢进 library/ 就是海报墙，点开即播、可拖进度、边下边播，自动记忆续播
 *   AI 修复   —— Real-ESRGAN 逐帧超分（2x/3x/4x），后台跑、成品自动入库
 *   聚合搜索  —— Apple CMS V10 多源并行搜索 + m3u8 代理改写，源由你自己填
 *   下载入库  —— yt-dlp 抓公开视频链接直接进片库
 *
 * 页面本身只做「托管」：启动 / 停止 / 探活 / 打开片库目录 / 看日志，
 * 真正的界面是下面内嵌的影院本体（iframe）。它只听 127.0.0.1，不对外。
 */

/** 能力徽标：数据来自影院自己的 /api/list 与 /api/dl，不是工作台猜的 */
function CapabilityBadge({ ok, label, hint }) {
  return (
    <span
      className="tech"
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 5,
        padding: '3px 9px',
        borderRadius: 999,
        border: '1px solid var(--border)',
        color: ok ? 'var(--green)' : 'var(--muted)',
        fontSize: 12,
      }}
      title={hint}
    >
      <Icon name={ok ? 'check' : 'alert'} size={11} />
      {label}
    </span>
  )
}

function formatClock(iso) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const pad = (n) => String(n).padStart(2, '0')
  return `${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

export function MediaPage() {
  const toast = useToast()
  const [status, setStatus] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(null)
  const [starting, setStarting] = useState(false)
  const [iframeLoading, setIframeLoading] = useState(true)
  const pollRef = useRef(null)
  const [logText, setLogText] = useState('')
  const [logOpen, setLogOpen] = useState(false)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      const s = await api.media()
      setStatus(s)
      if (!s.running) setIframeLoading(false)
      return s
    } catch (err) {
      setError(err)
      return null
    } finally {
      setLoading(false)
    }
  }, [])

  /** 停掉「启动中」轮询定时器（统一出口，避免漏清） */
  const stopPoll = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current)
      pollRef.current = null
    }
  }, [])

  /**
   * 启动后轮询：mediaserver 是独立子进程，按下「一键启动」后进程已起，但 HTTP 端口
   * 可能还要一两秒才就绪（start() 可能先返回 running:false）。这里每 1.5s 探一次状态，
   * 一旦运行态出现就自动刷新 UI（内嵌 iframe 自动出现），不用用户手动点「刷新」。
   * 18s 仍没起来则停轮询并提示手动刷新，防止卡死在「启动中」。
   */
  const startPoll = useCallback(() => {
    stopPoll()
    pollRef.current = setInterval(async () => {
      const s = await load()
      if (s?.running) {
        setStarting(false)
        stopPoll()
      }
    }, 1500)
    setTimeout(() => {
      if (pollRef.current) {
        stopPoll()
        setStarting(false)
        toast.warn('启动较慢', '如仍未就绪，请点「刷新」再试')
      }
    }, 18000)
  }, [load, stopPoll, toast])

  useEffect(() => {
    load()
  }, [load])

  // 地址变了（重启 / 换端口）iframe 要重新 loading
  useEffect(() => {
    if (status?.url) setIframeLoading(true)
  }, [status?.url])

  // 运行态心跳：影院可能在本机被手动关掉 / 崩溃 / 端口被回收。每 12s 探一次，
  // 状态变了就更新 UI（iframe 自动消失、卡片回到「未运行」），不让界面停在过时的「运行中」。
  useEffect(() => {
    if (!status?.running) return undefined
    const id = setInterval(() => {
      load()
    }, 12000)
    return () => clearInterval(id)
  }, [status?.running, status?.url, load])

  // 卸载时清掉「启动中」轮询，防止定时器打到已卸载组件
  useEffect(() => () => stopPoll(), [stopPoll])

  async function handleStart() {
    setBusy('start')
    try {
      const r = await api.mediaStart()
      setStatus(r)
      if (r.running) {
        setStarting(false)
        stopPoll()
        toast.success(r.message || '影院已启动')
      } else {
        // 进程已拉起但端口还没就绪：轮询直到运行态出现，免得用户手动刷新
        setStarting(true)
        toast.info(r.message || '正在启动影院…')
        startPoll()
      }
    } catch (err) {
      setStarting(false)
      stopPoll()
      toast.error('启动失败', err.message)
    } finally {
      setBusy(null)
    }
  }

  async function handleStop() {
    setBusy('stop')
    setStarting(false)
    stopPoll()
    try {
      const r = await api.mediaStop()
      setStatus({ ...(status || {}), running: false, url: null, pid: null })
      toast.success(r.portReleased ? '影院已停止' : '已发出停止指令（端口释放中，可再点停止）')
    } catch (err) {
      toast.error('停止失败', err.message)
    } finally {
      setBusy(null)
    }
  }

  async function handleOpenDir() {
    setBusy('dir')
    try {
      await api.openMediaDir()
    } catch (err) {
      toast.error('打开失败', err.message)
    } finally {
      setBusy(null)
    }
  }

  async function toggleLog() {
    const next = !logOpen
    setLogOpen(next)
    if (next) {
      try {
        const r = await api.mediaLog(120)
        setLogText(r.log || '（暂无日志）')
      } catch (err) {
        setLogText(`读取日志失败：${err.message}`)
      }
    }
  }

  const running = Boolean(status?.running && status?.url)
  const caps = status?.capabilities

  if (loading && !status) {
    return (
      <div>
        <div className="page__header">
          <div>
            <h1 className="page__title">本地影院</h1>
            <p className="page__subtitle">海报墙 · 点开即播 · AI 修复 · 聚合搜索</p>
          </div>
        </div>
        <Card>
          <Loading text="读取影院状态…" />
        </Card>
      </div>
    )
  }

  return (
    <div>
      <div className="page__header">
        <div>
          <h1 className="page__title">本地影院</h1>
          <p className="page__subtitle">
            海报墙点开即播 · <strong>Real-ESRGAN</strong> 逐帧修复 · 聚合搜索 · 下载入库（全部只在你本机）
          </p>
        </div>
        <div className="page__actions">
          <Button variant="ghost" onClick={load} disabled={loading || busy !== null}>
            <Icon name="refresh" size={13} /> 刷新
          </Button>
        </div>
      </div>

      <PageHint id="media" icon="play">
        这一页是「本地私人影院」：把视频文件丢进片库文件夹，刷新就是海报墙，<strong>点开即播</strong>、
        能拖进度、边下边播，还会记住上次看到哪。卡片上的 <strong>⚡ AI 修复</strong> 可以用显卡逐帧超分
        （先试 60 秒估时间）。没看完的片会自动排在最上面「继续观看」。
      </PageHint>

      {error ? <ErrorNotice error={error} onRetry={load} /> : null}

      <Card
        title="影院服务"
        icon="play"
        actions={
          <span className="row" style={{ gap: 8 }}>
            {running ? (
              <>
                <Button variant="ghost" onClick={() => window.open(status.url, '_blank', 'noopener')}>
                  <Icon name="external" size={13} /> 新标签打开
                </Button>
                <Button variant="ghost" onClick={handleOpenDir} loading={busy === 'dir'} disabled={busy !== null}>
                  <Icon name="folder" size={13} /> 打开片库
                </Button>
                <Button variant="danger" onClick={handleStop} loading={busy === 'stop'} disabled={busy !== null}>
                  <Icon name="stop" size={13} /> 停止
                </Button>
              </>
            ) : (
              <>
                <Button variant="ghost" onClick={handleOpenDir} loading={busy === 'dir'} disabled={busy !== null || starting}>
                  <Icon name="folder" size={13} /> 打开片库
                </Button>
                {starting ? (
                  <Button variant="primary" loading disabled>
                    启动中…
                  </Button>
                ) : (
                  <Button variant="primary" onClick={handleStart} loading={busy === 'start'} disabled={busy !== null}>
                    <Icon name="play" size={13} /> 一键启动
                  </Button>
                )}
              </>
            )}
          </span>
        }
      >
        <div className="row" style={{ gap: 10, flexWrap: 'wrap', alignItems: 'center' }}>
          <span className={`status-word ${running ? '' : 'muted'}`}>{running ? '运行中' : starting ? '启动中…' : '未运行'}</span>
          {running ? <span className="tech muted">127.0.0.1:{status.port}</span> : null}
          {status?.adopted ? <span className="tech muted">（认领了已在运行的实例）</span> : null}
          {status?.startedAt && running ? <span className="tech muted">启动于 {formatClock(status.startedAt)}</span> : null}
        </div>

        {running && caps ? (
          <div className="row" style={{ gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
            <CapabilityBadge ok={caps.upscaler} label="AI 修复" hint="Real-ESRGAN 超分引擎（tools/upscaler）" />
            <CapabilityBadge ok={caps.ffmpeg} label="自动海报" hint="ffmpeg 抽帧生成封面；没有就放同名 .jpg" />
            <CapabilityBadge ok={caps.ytdlp} label="下载入库" hint={caps.ytdlp ? `yt-dlp ${caps.ytdlpVersion || ''}` : '未安装 yt-dlp'} />
            {caps.videoCount != null ? (
              <span className="tech" style={{ color: 'var(--muted)', fontSize: 12, alignSelf: 'center' }}>
                片库 {caps.videoCount} 个视频
              </span>
            ) : null}
          </div>
        ) : null}

        {!running ? (
          <div className="muted" style={{ marginTop: 10, fontSize: 13, lineHeight: 1.8 }}>
            启动后这里会内嵌影院的完整界面：<b>片库</b>（海报墙 / 续播）、<b>聚合搜索</b>（Apple CMS
            源，在「采集源管理」里自己填）、<b>下载入库</b>（yt-dlp 抓公开链接）、<b>⚡ AI 修复</b>（超分）。
            <br />
            片库目录：<code className="tech">{status?.libraryDir}</code>
            （把视频文件或子文件夹放进去即可，刷新后自动出现）。
          </div>
        ) : null}

        <div className="row" style={{ gap: 8, marginTop: 12 }}>
          <Button variant="ghost" size="sm" onClick={toggleLog}>
            <Icon name="terminal" size={12} /> {logOpen ? '收起日志' : '查看启动日志'}
          </Button>
        </div>
        {logOpen ? (
          <pre
            className="tech"
            style={{
              marginTop: 8,
              padding: 10,
              borderRadius: 8,
              border: '1px solid var(--border)',
              background: 'var(--bg-soft, rgba(0,0,0,.03))',
              maxHeight: 220,
              overflow: 'auto',
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-all',
              fontSize: 12,
              lineHeight: 1.6,
            }}
          >
            {logText}
          </pre>
        ) : null}
      </Card>

      {!running && !starting && !busy ? (
        <Notice tone="info" icon="play">
          <strong>第一次用？三步走</strong>
          <div style={{ marginTop: 6, lineHeight: 1.8 }}>
            1. 点上方「一键启动」（纯 Python 标准库，不需要装任何依赖）；
            2. 把视频文件丢进片库目录（支持子文件夹，mp4 / mkv / webm / mov / ts / avi）；
            3. 刷新页面，点封面即播。想搜网络资源？在影院界面的「聚合搜索」页填采集源；
            想抓公开视频链接？用「下载入库」页粘贴地址（yt-dlp）。
          </div>
        </Notice>
      ) : null}

      {/* 影院本体：整页内嵌（只听 127.0.0.1，不对外） */}
      {running ? (
        <Card flush>
          <div style={{ position: 'relative' }}>
            {iframeLoading ? (
              <div
                className="row muted"
                style={{ height: 'min(82vh, 920px)', justifyContent: 'center', alignItems: 'center', gap: 8, fontSize: 13 }}
              >
                <Icon name="refresh" size={14} /> 正在加载影院界面…
              </div>
            ) : null}
            <iframe
              src={status.url}
              title="本地影院"
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
