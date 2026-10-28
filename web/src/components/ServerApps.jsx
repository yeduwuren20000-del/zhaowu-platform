import { Button, EmptyState, StatusDot } from './ui.jsx'

const APP_STATUS = { running: '运行中', stopped: '已停止', unknown: '未知' }

/** 应用与部署路径：端口 / 名称 / 路径 / 状态，操作在 hover 时出现 */
export function ServerApps({ server, busy = {}, onAddApp, onProbeApp, onEditApp, onDeleteApp }) {
  const apps = server.apps || []

  if (!apps.length) {
    return (
      <EmptyState
        title="没有应用记录"
        action={
          <Button variant="primary" icon="plus" onClick={() => onAddApp?.(server)}>
            新增 APP
          </Button>
        }
      />
    )
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="table">
        <thead>
          <tr>
            <th style={{ width: 72 }}>端口</th>
            <th>应用 / 服务</th>
            <th>部署路径</th>
            <th style={{ width: 96 }}>状态</th>
            <th style={{ width: 190, textAlign: 'right' }}>操作</th>
          </tr>
        </thead>
        <tbody>
          {apps.map((app) => (
            <tr key={app.id}>
              <td className="table__port">{app.port ?? '—'}</td>
              <td>
                {app.name}
                {app.url ? <div className="tech muted">{app.url}</div> : null}
              </td>
              <td>
                <span className="table__path" title={app.deployPath}>
                  {app.deployPath || '—'}
                </span>
              </td>
              <td>
                <span className="row" style={{ gap: 6 }}>
                  <StatusDot status={app.status === 'running' ? 'running' : app.status === 'stopped' ? 'stopped' : 'unknown'} />
                  <span className="status-word">{APP_STATUS[app.status] || 'Unknown'}</span>
                </span>
              </td>
              <td>
                <div className="table__actions">
                  <Button size="sm" icon="wifi" loading={busy[`app:${server.id}:${app.id}`]} onClick={() => onProbeApp?.(server, app)}>
                    端口探测
                  </Button>
                  <span className="row-actions">
                    <Button size="sm" icon="edit" onClick={() => onEditApp?.(server, app)}>
                      编辑
                    </Button>
                    <Button size="sm" icon="trash" onClick={() => onDeleteApp?.(server, app)}>
                      删除
                    </Button>
                  </span>
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}
