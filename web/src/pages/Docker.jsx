import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api/client.js'
import { PageHint } from '../components/PageHint.jsx'
import { LogPanel, normalizeTextLines } from '../components/LogPanel.jsx'
import { Button, Card, EmptyState, ErrorNotice, Loading, Modal, Notice, SearchBox, SkeletonList, Switch } from '../components/ui.jsx'
import { Icon } from '../components/Icons.jsx'
import { useAsync } from '../hooks/useAsync.js'
import { useToast } from '../hooks/useToast.jsx'

/**
 * 本地 Docker 容器管理。与 ServerDetail 里的远程 Docker 面板同构，
 * 但数据来自本机 docker CLI——Dify 就跑在这些容器里。
 */
const CONTAINER_STATE = {
  running: { word: '运行中', className: '' },
  exited: { word: '已停止', className: 'muted' },
  created: { word: '已创建', className: 'muted' },
  paused: { word: '已暂停', className: 'is-warn' },
  restarting: { word: '重启中', className: 'is-warn' },
  dead: { word: '已僵死', className: 'is-error' },
}

export default function DockerPage() {
  const toast = useToast()
  const [query, setQuery] = useState('')
  const [runningOnly, setRunningOnly] = useState(false)
  const [busyId, setBusyId] = useState(null)
  const [logTarget, setLogTarget] = useState(null)
  // 「一键拉起引擎」：后端只发起启动，进度靠这里轮询
  const [daemon, setDaemon] = useState(null)
  const [starting, setStarting] = useState(false)
  const [elapsed, setElapsed] = useState(0)

  // 一起取引擎状态：桌面版版本号（4.95 这种）只有 daemon 接口有，缺了就会让人以为"版本对不上"
  const load = useCallback(async () => {
    const [overview, daemonInfo] = await Promise.all([api.docker(), api.dockerDaemon().catch(() => null)])
    return { ...overview, daemon: daemonInfo }
  }, [])
  const { data, loading, error, reload } = useAsync(load)

  useEffect(() => {
    if (!starting) return undefined
    const timer = setInterval(() => setElapsed((value) => value + 1), 1000)
    return () => clearInterval(timer)
  }, [starting])

  const containers = data?.containers || []
  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return containers.filter((item) => {
      if (runningOnly && item.state !== 'running') return false
      if (!q) return true
      return item.name.toLowerCase().includes(q) || item.image.toLowerCase().includes(q) || item.id.toLowerCase().includes(q)
    })
  }, [containers, query, runningOnly])

  async function act(container, action) {
    setBusyId(`${container.id}:${action}`)
    try {
      await api.dockerAction(container.id, action)
      toast.success(`已${({ start: '启动', stop: '停止', restart: '重启' })[action]}容器 ${container.name}`)
      await reload()
    } catch (err) {
      toast.error(`${action} 失败：${err.message}`)
    } finally {
      setBusyId(null)
    }
  }

  /**
   * 一键拉起：后端发起启动后立刻返回，这里轮询 /docker/daemon 直到就绪。
   * 单次请求都不长（各 1 秒内），所以不会被代理/浏览器超时打断。
   */
  async function handleStartDaemon() {
    setStarting(true)
    setElapsed(0)
    try {
      const first = await api.dockerDaemonStart()
      setDaemon(first)
      if (first.ready) {
        // 已经能连上：这句必须说清「不是我拉起的」，否则就是抢用户的功劳
        toast.success('Docker 引擎已经在运行', first.origin === 'external' ? '不是这次拉起的：原本就在跑' : undefined)
        await reload()
        return
      }
      const begun = Date.now()
      for (;;) {
        await new Promise((resolve) => setTimeout(resolve, 1500))
        const current = await api.dockerDaemon()
        setDaemon(current)
        if (current.ready) {
          if (current.origin === 'external') {
            // 典型场景：自己拉起的进程早退了，用户手动开的桌面版把引擎带起来了
            toast.success('Docker 引擎已就绪', '但不是工作台拉起的：看起来是你手动启动了桌面版')
          } else {
            toast.success(`Docker 已就绪${current.version ? `（引擎 ${current.version}）` : ''}`)
          }
          await reload()
          return
        }
        if (current.phase === 'timeout' || current.phase === 'error') {
          toast.error(current.error || 'Docker 没能起来', '可以再点一次「一键拉起」，或手动看托盘鲸鱼图标')
          return
        }
        if (Date.now() - begun > 200000) {
          toast.warn('Docker 还在启动', '已等 3 分钟，可稍后点「刷新」看结果')
          return
        }
      }
    } catch (err) {
      toast.error('拉起 Docker 失败', err.message)
    } finally {
      setStarting(false)
    }
  }

  const daemonDown = data && data.daemonOk === false

  return (
    <div>
      <div className="page__header">
        <div>
          <h1 className="page__title">Docker 容器</h1>
          <p className="page__subtitle">
            本机 Docker 的容器都在这里：看状态、启停、翻日志
            {data?.daemonOk && data?.version ? ` · 引擎 ${data.version}` : ''}
            {(daemon || data?.daemon)?.desktopVersion ? ` · 桌面版 ${(daemon || data?.daemon).desktopVersion}` : ''}
          </p>
        </div>
        <div className="page__actions">
          <Button variant="ghost" onClick={() => reload().catch(() => {})} disabled={loading}>
            <Icon name="refresh" size={13} /> 刷新
          </Button>
        </div>
      </div>

      <PageHint pageKey="docker">
        这一页管本机 Docker 的<strong>所有容器</strong>（Dify 的全家桶就在里面）。
        「运行中」的才能停；停掉的容器数据不会丢，随时可以再启动。
      </PageHint>

      {error ? <ErrorNotice error={error} onRetry={() => reload().catch(() => {})} /> : null}

      {daemonDown ? (
        <Notice tone="warn" icon="alert">
          <div className="row" style={{ gap: 12, alignItems: 'flex-start' }}>
            <div style={{ flex: 1, minWidth: 0 }}>
              <strong>连不上 Docker：{data.error}</strong>
              <div style={{ marginTop: 6 }}>
                {starting ? (
                  <>
                    {daemon?.method === 'Docker Desktop（已在运行）'
                      ? '桌面版已经在运行了（不是工作台拉起的），正在等引擎就绪'
                      : `正在拉起 ${daemon?.method || 'Docker Desktop'}`}
                    ，已等 <strong>{elapsed}s</strong>
                    {daemon?.phase === 'starting' ? '（首次启动、或初始化 WSL 后端时 30~90 秒都算正常）' : ''}
                  </>
                ) : (
                  <>
                    引擎没起来时，依赖它的项目（如 Dify）也起不来。点右边「一键拉起」，工作台会打开 Docker Desktop
                    并一直盯到引擎真的能连上。
                  </>
                )}
              </div>
              {!starting && daemon?.error && daemon?.phase !== 'stopped' ? (
                <div style={{ marginTop: 6 }} className="muted">
                  上次尝试：{daemon.error}
                </div>
              ) : null}
              {!starting && data.installed === null ? (
                <div style={{ marginTop: 6 }} className="muted">
                  连 docker 命令都没找到——如果确实没装，先装 Docker Desktop；装在非默认位置就设环境变量
                  DSM_DOCKER_DESKTOP 指向它。
                </div>
              ) : null}
            </div>
            <Button variant="primary" onClick={handleStartDaemon} loading={starting} disabled={starting}>
              <Icon name="play" size={13} /> {starting ? '启动中…' : '一键拉起 Docker'}
            </Button>
          </div>
        </Notice>
      ) : null}

      {data?.daemonOk ? (
        <div className="toolbar">
          <SearchBox value={query} onChange={setQuery} placeholder="搜索容器名 / 镜像 / ID" />
          <label className="row" style={{ gap: 7, alignItems: 'center' }}>
            <Switch checked={runningOnly} onChange={setRunningOnly} />
            <span className="muted">只看运行中</span>
          </label>
          <span className="muted" style={{ marginLeft: 'auto' }}>
            共 {containers.length} 个 · 运行中 {containers.filter((c) => c.state === 'running').length} 个
          </span>
        </div>
      ) : null}

      {loading && !data ? (
        <Card>
          <SkeletonList rows={5} />
        </Card>
      ) : null}

      {data?.daemonOk ? (
        filtered.length === 0 ? (
          <Card>
            <EmptyState
              title={containers.length === 0 ? '一个容器都没有' : '没有匹配的容器'}
              hint={
                containers.length === 0
                  ? '用 docker run 或启动项目（如 Dify）后，容器会出现在这里。'
                  : '换个关键词，或取消「只看运行中」。'
              }
            />
          </Card>
        ) : (
          <Card flush>
            <div style={{ overflowX: 'auto' }}>
              <table className="table">
                <thead>
                  <tr>
                    <th>容器</th>
                    <th>镜像</th>
                    <th style={{ width: 88 }}>状态</th>
                    <th style={{ width: 180 }}>端口映射</th>
                    <th style={{ width: 120, textAlign: 'right' }}>操作</th>
                  </tr>
                </thead>
                <tbody>
                  {filtered.map((container) => {
                    const meta = CONTAINER_STATE[container.state] || { word: container.state || '未知', className: 'muted' }
                    const hostPorts = container.ports.filter((p) => p.host).map((p) => p.host)
                    return (
                      <tr key={container.id}>
                        <td>
                          <div className="row" style={{ gap: 6 }}>
                            <span className={`status-word ${meta.className}`}>{meta.word}</span>
                            <strong>{container.name}</strong>
                          </div>
                          <div className="sub">
                            ID {container.id.slice(0, 12)}
                            {container.status ? ` · ${container.status}` : ''}
                            {hostPorts.length > 0 ? ` · 宿主端口 ${hostPorts.join('、')}` : ''}
                          </div>
                        </td>
                        <td className="tech">
                          {/* 长镜像名必须用 .cell-clip 截断：table-layout:fixed 下裸文本会溢出到相邻列 */}
                          <span className="cell-clip" title={container.image}>
                            {container.image}
                          </span>
                        </td>
                        <td className="tech muted">{container.state}</td>
                        <td className="tech">
                          {container.ports.length > 0 ? (
                            <span
                              className="cell-clip"
                              title={container.ports.map((p) => p.text).join('，')}
                            >
                              {/* 紧凑写法：0.0.0.0:8080->80/tcp 显示成 8080→80/tcp，一列放得下 */}
                              {container.ports.map((p) => (p.host ? `${p.host}→${p.container}` : p.container)).join('，')}
                            </span>
                          ) : (
                            '—'
                          )}
                        </td>
                        <td style={{ textAlign: 'right' }}>
                          <span className="row" style={{ gap: 6, justifyContent: 'flex-end' }}>
                            {container.state === 'running' ? (
                              <>
                                <Button
                                  variant="ghost"
                                  onClick={() => act(container, 'restart')}
                                  disabled={busyId !== null}
                                  title="重启容器"
                                >
                                  <Icon name="restart" size={13} />
                                </Button>
                                <Button
                                  variant="danger"
                                  onClick={() => act(container, 'stop')}
                                  disabled={busyId !== null}
                                  title="停止容器"
                                >
                                  <Icon name="stop" size={13} />
                                </Button>
                              </>
                            ) : (
                              <Button
                                variant="primary"
                                onClick={() => act(container, 'start')}
                                disabled={busyId !== null}
                                title="启动容器"
                              >
                                <Icon name="play" size={13} />
                              </Button>
                            )}
                            <Button variant="ghost" onClick={() => setLogTarget(container)} title="查看日志">
                              <Icon name="terminal" size={13} />
                            </Button>
                          </span>
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            </div>
          </Card>
        )
      ) : null}

      {logTarget ? <ContainerLogModal container={logTarget} onClose={() => setLogTarget(null)} /> : null}
    </div>
  )
}

function ContainerLogModal({ container, onClose }) {
  const [lines, setLines] = useState(100)
  const { data, loading, error } = useAsync(() => api.dockerLogs(container.id, lines), {
    deps: [container.id, lines],
  })

  return (
    <Modal open title={`容器日志 · ${container.name}`} onClose={onClose}>
      <div className="toolbar" style={{ marginBottom: 10 }}>
        <span className="muted">镜像 {container.image}</span>
        <span style={{ marginLeft: 'auto' }} className="row">
          {[100, 500].map((n) => (
            <Button key={n} variant={lines === n ? 'primary' : 'ghost'} onClick={() => setLines(n)}>
              最近 {n} 行
            </Button>
          ))}
        </span>
      </div>
      {error ? <ErrorNotice error={error} /> : null}
      {loading && !data ? <Loading text="读取容器日志…" /> : null}
      {data ? <LogPanel entries={normalizeTextLines(String(data.lines || '').split('\n'))} height={420} /> : null}
    </Modal>
  )
}
