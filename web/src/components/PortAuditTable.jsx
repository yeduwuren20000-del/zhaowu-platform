import { Button, EmptyState, Notice } from './ui.jsx'
import { auditClass, auditMeta, formatDateTime } from '../utils/format.js'

/**
 * 端口核对表：真实监听端口 vs 工作台登记的 APP/端口
 *   ok                     —— 正常（已登记且正在监听）
 *   recordedNotListening   —— 记录存在但未监听
 *   listeningNotRecorded   —— 监听但未登记
 */
export function PortAuditTable({ server, audit, busy = {}, onProbeApp, onEditApp, onRegisterPort, onRefresh, loading }) {
  const items = audit?.items || []
  const summary = audit?.summary

  if (!server.ssh?.at) {
    return (
      <EmptyState
        title="还没有做过 SSH 采集"
        hint="运行 SSH 检测后读取真实监听端口（ss -lntup）。"
        action={
          <Button variant="primary" icon="wifi" loading={loading} onClick={() => onRefresh?.(server)}>
            SSH 检测
          </Button>
        }
      />
    )
  }

  if (!server.ssh.ok) {
    return (
      <div>
        <Notice tone="error" icon="alert">
          上次采集失败（{formatDateTime(server.ssh.at)}）：{server.ssh.error}
        </Notice>
        <div style={{ marginTop: 10 }}>
          <Button icon="refresh" loading={loading} onClick={() => onRefresh?.(server)}>
            重新检测
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div>
      <div className="row row--wrap" style={{ marginBottom: 10, gap: 10 }}>
        <span className="footnote">
          共 <b>{items.length}</b> 条 · 正常 <b>{summary?.ok ?? 0}</b>
          {summary?.recordedNotListening ? <span className="status-word is-warn"> · 记录未监听 {summary.recordedNotListening}</span> : null}
          {summary?.listeningNotRecorded ? <span className="status-word is-error"> · 监听未登记 {summary.listeningNotRecorded}</span> : null}
        </span>
        <span className="footnote">
          真实监听 {summary?.totalListening ?? 0} 个端口 · 采集于 {formatDateTime(server.metrics?.collectedAt)}
        </span>
        <div className="spacer" />
        <Button size="sm" icon="refresh" loading={loading} onClick={() => onRefresh?.(server)}>
          重新采集
        </Button>
      </div>

      {items.length === 0 ? (
        <EmptyState title="没有可比对的端口" hint="添加 APP 记录后即可与真实监听端口核对。" />
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th style={{ width: 150 }}>核对状态</th>
                <th style={{ width: 74 }}>端口</th>
                <th>APP / 进程</th>
                <th>监听信息</th>
                <th>部署路径</th>
                <th style={{ width: 168, textAlign: 'right' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {items.map((item) => {
                const meta = auditMeta(item.state)
                const key = `${item.state}-${item.port}-${item.appId || item.appName}`
                return (
                  <tr key={key}>
                    <td>
                      <span className={`status-word ${auditClass(item.state)}`} title={meta.hint}>
                        {meta.text}
                      </span>
                    </td>
                    <td className="table__port">{item.port ?? '—'}</td>
                    <td>
                      <div>{item.appName}</div>
                      {item.listen?.process ? (
                        <div className="mono" style={{ fontSize: 11.5, color: 'var(--muted-2)' }}>
                          {item.listen.process}
                          {item.listen.pid ? ` · PID ${item.listen.pid}` : ''}
                        </div>
                      ) : null}
                    </td>
                    <td>
                      {item.listen ? (
                        <span className="mono" style={{ fontSize: 12 }}>
                          {item.listen.proto?.toUpperCase()} {item.listen.address}
                        </span>
                      ) : (
                        <span style={{ color: 'var(--muted-2)' }}>未监听</span>
                      )}
                    </td>
                    <td>
                      <span className="table__path" title={item.deployPath}>
                        {item.deployPath || '—'}
                      </span>
                    </td>
                    <td>
                      <div className="table__actions">
                        {item.appId ? (
                          <>
                            <Button
                              size="sm"
                              icon="wifi"
                              loading={busy[`app:${server.id}:${item.appId}`]}
                              onClick={() => onProbeApp?.(server, { id: item.appId, name: item.appName, port: item.port })}
                            >
                              端口探测
                            </Button>
                            <span className="row-actions">
                              <Button
                                size="sm"
                                icon="edit"
                                onClick={() => onEditApp?.(server, (server.apps || []).find((app) => app.id === item.appId))}
                              >
                                编辑
                              </Button>
                            </span>
                          </>
                        ) : (
                          <Button
                            size="sm"
                            variant="primary"
                            icon="plus"
                            onClick={() =>
                              onRegisterPort?.(server, {
                                name: item.listen?.process || item.appName || '',
                                port: item.port,
                                status: 'running',
                                remark: `由 SSH 端口核对登记（${item.listen?.proto?.toUpperCase() || ''} ${item.listen?.address || ''}）`,
                              })
                            }
                          >
                            登记为 APP
                          </Button>
                        )}
                      </div>
                    </td>
                  </tr>
                )
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  )
}
