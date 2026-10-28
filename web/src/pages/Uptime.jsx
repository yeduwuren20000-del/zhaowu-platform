import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client.js'
import { PageHint } from '../components/PageHint.jsx'
import { Button, Card, ErrorNotice, Loading, Notice } from '../components/ui.jsx'
import { Icon } from '../components/Icons.jsx'
import { useToast } from '../hooks/useToast.jsx'

/**
 * 服务监控：把 GitHub 上最火的自托管监控工具 Uptime Kuma（86k+ ★，MIT）接进工作台。
 *
 * 两种用法：
 *   1. 下方大窗口直接内嵌 Kuma 的监控看板（首次打开按引导创建管理员账号即可）；
 *   2. 「建议监控项」卡片：由工作台已登记的项目 / 服务器自动生成待监控地址，
 *      一键复制、粘进 Kuma 的「添加监控」即可，不用自己回忆每个服务在哪个端口。
 *
 * 监控数据（监控项、历史、告警渠道）存在 Docker 命名卷 workbench-uptime-kuma-data 里，
 * 删除 / 重建容器都不会丢。
 */

const STEPS = [
  '首次打开会要求创建管理员账号——账号密码只存在本机卷里，不会外传',
  '点「添加监控」，类型选 HTTP（远程服务器选 Ping），粘贴下方建议清单里的地址',
  '想掉线时收到提醒，在「设置 → 通知」里配一个渠道（邮件 / Telegram / Webhook 等 90+）',
]

/** 复制文本：优先 clipboard API，旧浏览器回退 execCommand */
async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text)
    return true
  } catch {
    try {
      const ta = document.createElement('textarea')
      ta.value = text
      ta.style.position = 'fixed'
      ta.style.opacity = '0'
      document.body.appendChild(ta)
      ta.select()
      const ok = document.execCommand('copy')
      ta.remove()
      return ok
    } catch {
      return false
    }
  }
}

export function UptimePage() {
  const toast = useToast()
  const [status, setStatus] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [busy, setBusy] = useState(null)
  const [polling, setPolling] = useState(false)
  const [iframeLoading, setIframeLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      setStatus(await api.uptime())
    } catch (err) {
      setError(err)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // 容器重启后 iframe 要重新 loading
  useEffect(() => {
    setIframeLoading(true)
  }, [status?.container?.url])

  // 轮询：覆盖「首次拉镜像 → 创建容器 → 等待就绪」的全过程
  useEffect(() => {
    if (!polling) return undefined
    const timer = setInterval(async () => {
      try {
        const s = await api.uptime()
        setStatus(s)
        if (s.container?.running) {
          setPolling(false)
          setBusy(null)
          return
        }
        // 镜像已拉完但容器还没建：补一次启动（这次会创建并运行容器）
        if (s.imagePresent && !s.container?.exists) {
          await api.uptimeStart()
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
      const r = await api.uptimeStart()
      // 后端保证 container 始终是嵌套对象；合并而非替换，保留 daemonOk / 建议清单
      setStatus((prev) => ({ ...(prev || {}), container: r.container, imagePresent: r.imagePresent ?? prev?.imagePresent }))
      if (r.phase === 'pulling') {
        toast.info('首次使用：正在拉取 Uptime Kuma 镜像（约数百 MB，请稍候）…')
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
      const r = await api.uptimeStop()
      setStatus((prev) => ({ ...(prev || {}), container: r.container }))
      toast.success('已停止监控服务（监控数据已保存，下次启动不丢）')
    } catch (err) {
      toast.error('停止失败', err.message)
    } finally {
      setBusy(null)
    }
  }

  async function handleCopy(item) {
    const ok = await copyText(item.url)
    if (ok) {
      toast.success(`已复制：${item.url}`, '去 Kuma 里「添加监控」粘贴即可')
    } else {
      toast.error('复制失败', '请手动选中地址复制')
    }
  }

  const container = status?.container
  const running = Boolean(container?.running && container?.url)
  const daemonDown = status && status.daemonOk === false
  const suggestions = status?.suggestions || []

  if (loading && !status) {
    return (
      <div>
        <div className="page__header">
          <div>
            <h1 className="page__title">服务监控</h1>
            <p className="page__subtitle">本地自托管的 Uptime Kuma（GitHub 86K★）</p>
          </div>
        </div>
        <Card>
          <Loading text="读取监控服务状态…" />
        </Card>
      </div>
    )
  }

  return (
    <div>
      <div className="page__header">
        <div>
          <h1 className="page__title">服务监控</h1>
          <p className="page__subtitle">
            本地自托管的 <strong>Uptime Kuma</strong>（GitHub 86K★，MIT）—— 掉线告警，数据不出本机
          </p>
        </div>
        <div className="page__actions">
          <Button variant="ghost" onClick={load} disabled={loading || polling}>
            <Icon name="refresh" size={13} /> 刷新
          </Button>
        </div>
      </div>

      <PageHint id="uptime">
        这一页把 GitHub 上最火的自托管监控工具 <strong>Uptime Kuma</strong>（86K★）接进了工作台：给本机项目、
        远程服务器配上 <strong>HTTP / Ping 监控</strong>，掉线时按「通知」渠道发提醒（邮件 / Telegram / Webhook 等 90+）。
        首次使用先点下方「一键启动」，打开看板创建管理员账号，再用「建议监控项」清单逐个添加。
      </PageHint>

      {error ? <ErrorNotice error={error} onRetry={load} /> : null}

      {daemonDown ? (
        <Notice tone="warn" icon="alert">
          <strong>连不上 Docker：{status?.error}</strong>
          <div style={{ marginTop: 6 }}>
            先看 Windows 托盘有没有鲸鱼图标：没有就打开 Docker Desktop 等它稳定；有就右键选 Restart。
            Uptime Kuma 跑在 Docker 容器里，Docker 没起来时无法启动。
          </div>
        </Notice>
      ) : null}

      {status?.daemonOk ? (
        <Card
          title="监控服务"
          icon="activity"
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
            {container?.hostPort ? <span className="tech muted">宿主端口 {container.hostPort} → 容器 3001</span> : null}
            <span className="tech muted">镜像 louislam/uptime-kuma:1</span>
            <span className="tech muted">数据卷 workbench-uptime-kuma-data</span>
          </div>
          {!running && !polling ? (
            <div className="muted" style={{ marginTop: 10, fontSize: 13, lineHeight: 1.7 }}>
              首次启动会自动拉取镜像（约数百 MB，稍慢），之后秒级启动。该服务同时登记在「项目」页
              （Uptime Kuma 服务监控），可从那里统一启动 / 停止；停止只停容器，不动 Docker 引擎。
            </div>
          ) : null}
          {running ? (
            <div className="muted" style={{ marginTop: 10, fontSize: 13, lineHeight: 1.8 }}>
              <div style={{ marginBottom: 4 }}>三步上手：</div>
              {STEPS.map((s, i) => (
                <div key={s} className="row" style={{ gap: 6, alignItems: 'baseline' }}>
                  <span className="tech muted" style={{ flex: 'none' }}>{i + 1}.</span>
                  <span>{s}</span>
                </div>
              ))}
            </div>
          ) : null}
        </Card>
      ) : null}

      {/* 建议监控项：由工作台已登记的项目 / 服务器生成，改端口这里自动跟着变 */}
      {status?.daemonOk ? (
        <Card
          title="建议监控项"
          icon="copy"
          subtitle="来自「本地项目 / 服务器」页已登记的数据，复制地址粘进 Kuma 即可"
        >
          {suggestions.length === 0 ? (
            <div className="muted" style={{ fontSize: 13 }}>
              暂无可建议的监控项——先在「本地项目 / 服务器」页登记带端口的服务，这里会自动出现。
            </div>
          ) : (
            <div style={{ display: 'grid', gap: 6 }}>
              {suggestions.map((item) => (
                <div
                  key={`${item.monitorType}-${item.url}`}
                  className="row"
                  style={{
                    gap: 8,
                    justifyContent: 'space-between',
                    alignItems: 'center',
                    padding: '7px 10px',
                    border: '1px solid var(--border)',
                    borderRadius: 8,
                  }}
                >
                  <span className="row" style={{ gap: 8, minWidth: 0, alignItems: 'baseline' }}>
                    <span
                      className="tech"
                      style={{
                        flex: 'none',
                        fontSize: 11,
                        padding: '1px 6px',
                        borderRadius: 4,
                        border: '1px solid var(--border)',
                        color: item.monitorType === 'ping' ? 'var(--blue)' : 'var(--green)',
                      }}
                    >
                      {item.monitorType === 'ping' ? 'Ping' : 'HTTP'}
                    </span>
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{item.name}</span>
                    <span className="tech muted" style={{ flex: 'none' }}>
                      {item.url}
                    </span>
                    {item.note ? (
                      <span className="tech muted" style={{ flex: 'none' }}>
                        {item.note}
                      </span>
                    ) : null}
                  </span>
                  <Button variant="ghost" size="sm" onClick={() => handleCopy(item)} style={{ flex: 'none' }}>
                    <Icon name="copy" size={13} /> 复制
                  </Button>
                </div>
              ))}
              <div className="muted" style={{ fontSize: 12, marginTop: 4 }}>
                添加方法：Kuma 里点「添加监控」→ 类型选 HTTP / Ping → 粘贴地址 → 保存。远程服务器若不通，
                先确认它本身在线（「服务器」页可探测）；想自定义名称 / 间隔 / 告警阈值，在 Kuma 里改即可。
              </div>
            </div>
          )}
        </Card>
      ) : null}

      {/* 主界面：直接内嵌 Uptime Kuma 看板 */}
      {running ? (
        <Card flush>
          <div style={{ position: 'relative' }}>
            {iframeLoading ? (
              <div
                className="row muted"
                style={{ height: 'min(82vh, 920px)', justifyContent: 'center', alignItems: 'center', gap: 8, fontSize: 13 }}
              >
                <Icon name="refresh" size={14} /> 正在加载 Uptime Kuma 监控看板…
              </div>
            ) : null}
            <iframe
              src={container.url}
              title="Uptime Kuma"
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
