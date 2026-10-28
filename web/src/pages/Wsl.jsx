import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client.js'
import { Icon } from '../components/Icons.jsx'
import { Button, Card, EmptyState, ErrorNotice, Loading, Notice } from '../components/ui.jsx'
import { PageHint } from '../components/PageHint.jsx'
import { timeAgo } from '../utils/format.js'

/**
 * WSL 页面：只做"看得见"——把每个 WSL 发行版里在监听的服务列出来。
 *
 * 为什么要单独做一页：WSL2 有独立网络命名空间，里面监听的服务
 * 在 Windows 侧完全查不到（实测 ss 显示 LISTEN 0.0.0.0:18099，
 * 而 Get-NetTCPConnection 一片空白）。所以这里只能主动进发行版去问。
 *
 * 不做启停：WSL 只读，不执行任何控制命令。
 */
export function WslPage() {
  const [data, setData] = useState(null)
  const [available, setAvailable] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [showProcesses, setShowProcesses] = useState(false)
  const [at, setAt] = useState(null)

  const load = useCallback(async () => {
    setLoading(true)
    setError('')
    try {
      const [avail, result] = await Promise.all([
        api.wslAvailable(),
        api.wslCollect(showProcesses),
      ])
      setAvailable(avail)
      setData(result)
      setAt(new Date().toISOString())
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [showProcesses])

  useEffect(() => {
    load()
  }, [load])

  const results = data?.results || []
  const totalPorts = results.reduce((sum, item) => sum + (item.ports?.length || 0), 0)

  return (
    <div className="page">
      <div className="page__header">
        <div className="page__title">WSL</div>
        <div className="page__actions">
          <Button icon={showProcesses ? 'eye' : 'eye-off'} onClick={() => setShowProcesses((p) => !p)}>
            {showProcesses ? '隐藏进程' : '显示进程'}
          </Button>
          <Button icon="refresh" loading={loading} onClick={load}>
            刷新
          </Button>
        </div>
      </div>

      {/* 每页一次性提示：新手落地第一眼就知道这页是干嘛的（见 PageHint） */}
      <PageHint id="wsl" icon="box">
        WSL2 有独立的网络，里面监听的服务在 Windows 侧查不到，所以要单独进来问一次。这里是只读查看，不会对 WSL 执行任何启停命令。
      </PageHint>

      {available && available.available === false ? (
        <Notice tone="warn" icon="alert">
          {available.reason}
        </Notice>
      ) : null}
      {error ? <ErrorNotice error={error} onRetry={() => load().catch(() => {})} /> : null}

      {loading && !data ? (
        <Loading text="正在进入 WSL 发行版采集…" />
      ) : results.length === 0 ? (
        <Card>
          <EmptyState title="没有找到 WSL 发行版" hint="先在 PowerShell 里执行 wsl --list --installable 看看，或用 wsl --install 安装。" />
        </Card>
      ) : (
        <>
          <div className="wsl-summary">
            <span>
              {results.length} 个发行版 · {totalPorts} 个监听端口
            </span>
            <span className="footnote">{at ? `采集于 ${timeAgo(at)}` : ''}</span>
          </div>

          {results.map((item) => (
            <Card
              key={item.name}
              title={item.name}
              icon="terminal"
              subtitle={item.ok ? `${item.ports.length} 个端口` : '无数据'}
              actions={<span className="footnote">{item.durationMs}ms</span>}
              flush
            >
              {item.error && !item.ok ? (
                <div style={{ padding: 12 }}>
                  <Notice tone="warn" icon="alert">
                    {item.error}
                  </Notice>
                </div>
              ) : null}

              {item.ports.length === 0 ? (
                <div style={{ padding: 12 }}>
                  <span className="muted">这个发行版里当前没有对外监听的端口。</span>
                </div>
              ) : (
                <table className="table">
                  <thead>
                    <tr>
                      <th>端口</th>
                      <th>监听地址</th>
                      <th>进程</th>
                      <th>命令行</th>
                    </tr>
                  </thead>
                  <tbody>
                    {item.ports.map((port) => (
                      <tr key={`${port.port}-${port.address}`}>
                        <td className="table__port">{port.port}</td>
                        <td className="tech">{port.address || '*'}</td>
                        <td>
                          <span className="tech">{port.processName || '—'}</span>
                          {port.pid ? <span className="muted"> PID {port.pid}</span> : null}
                        </td>
                        <td className="tech muted wsl-cmd">{port.commandLine || '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              )}

              {showProcesses && item.processes.length > 0 ? (
                <details className="wsl-procs">
                  <summary>全部进程（{item.processes.length}）</summary>
                  <div className="wsl-procs__list">
                    {item.processes.map((proc) => (
                      <div key={proc.pid} className="wsl-procs__row">
                        <span className="tech muted">{proc.pid}</span>
                        <span className="tech">{proc.processName}</span>
                        <span className="muted">{proc.commandLine}</span>
                      </div>
                    ))}
                  </div>
                </details>
              ) : null}
            </Card>
          ))}

          <Notice tone="info" icon="info">
            WSL2 有独立的网络命名空间，这些端口在 Windows 侧的「服务端口」页里<b>看不到</b>，属于正常现象。
            这里是只读查看，不会对 WSL 执行任何启停命令。
          </Notice>
        </>
      )}
    </div>
  )
}

export default WslPage