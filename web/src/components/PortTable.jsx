import { useState } from 'react'
import { Button, EmptyState, StatusDot } from './ui.jsx'
import { auditClass, auditMeta, sourceMeta, statusMeta } from '../utils/format.js'

/**
 * 服务端口表：一行一个真实监听端口。
 * 本地行来自端口扫描，服务器行来自 SSH 采集与资产记录。
 */
export function PortTable({ rows, onScan, onOpenUrl, onCopyPath, onOpenProject, emptyHint = '还没有端口记录，先在项目或服务器里登记端口。' }) {
  const [scanned, setScanned] = useState({})

  if (!rows?.length) return <EmptyState title="没有匹配的端口记录" hint={emptyHint} />

  async function handleScan(row) {
    if (!row.port) return
    setScanned((prev) => ({ ...prev, [row.key]: { loading: true } }))
    const result = await onScan?.(row.port)
    setScanned((prev) => ({ ...prev, [row.key]: { loading: false, result } }))
  }

  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="table">
        <thead>
          <tr>
            <th style={{ width: 78 }}>端口</th>
            <th>应用 / 服务</th>
            <th style={{ width: 64 }}>环境</th>
            <th>所属项目 / 服务器</th>
            <th>路径</th>
            <th style={{ width: 104 }}>状态</th>
            <th style={{ width: 96 }}>SSH 核对</th>
            <th style={{ width: 168, textAlign: 'right' }}>操作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const scan = scanned[row.key]
            return (
              <tr key={row.key}>
                <td className="table__port">
                  {row.port ?? '—'}
                  {row.pid ? <div className="sub">PID {row.pid}</div> : null}
                </td>
                <td>
                  <div>{row.app}</div>
                  {row.source && row.source !== 'unknown' ? (
                    <div className="sub" title={row.sourceDetail || sourceMeta(row.source).hint}>
                      {sourceMeta(row.source).text}
                    </div>
                  ) : null}
                  {row.processName ? <div className="sub tech">{row.processName}</div> : null}
                  {scan?.result ? (
                    <div className="sub tech">
                      {scan.result.listening
                        ? `实测占用 ${scan.result.owners.map((owner) => `${owner.pid}/${owner.processName || '未知'}`).join('、')}`
                        : '实测：端口空闲'}
                    </div>
                  ) : null}
                </td>
                <td>
                  <span className="status-word muted">{row.env}</span>
                </td>
                <td>
                  {row.projectId && onOpenProject ? (
                    <span className="link" onClick={() => onOpenProject(row.projectId)} title="跳到对应的本地项目（含子服务列表）">
                      {row.owner}
                    </span>
                  ) : (
                    <span>{row.owner}</span>
                  )}
                  {row.isSubService ? <div className="sub">子服务</div> : null}
                  {row.host ? <div className="sub tech">{row.host}</div> : null}
                </td>
                <td>
                  <span className="table__path" title={row.path}>
                    {row.path || '—'}
                  </span>
                </td>
                <td>
                  <span className="row" style={{ gap: 6 }}>
                    <StatusDot status={row.status} />
                    <span className="status-word" title={row.statusText}>{statusMeta(row.status).text}</span>
                  </span>
                  {row.conflict ? (
                    <div className="sub status-word is-error">
                      {row.conflict.type === 'duplicate' ? '端口重复' : '被其他进程占用'}
                    </div>
                  ) : null}
                </td>
                <td>
                  {row.auditState ? (
                    <span className={`status-word ${auditClass(row.auditState)}`} title={auditMeta(row.auditState).hint}>
                      {auditMeta(row.auditState).text}
                    </span>
                  ) : row.envKey === 'server' ? (
                    <span className="status-word muted">未采集</span>
                  ) : (
                    <span style={{ color: 'var(--muted-2)' }}>—</span>
                  )}
                </td>
                <td>
                  <div className="table__actions">
                    <Button size="sm" icon="refresh" loading={scan?.loading} onClick={() => handleScan(row)}>
                      检测
                    </Button>
                    <span className="row-actions">
                      {row.url ? (
                        <Button size="sm" icon="external" onClick={() => onOpenUrl?.(row.url, row.processName || `端口 ${row.port}`)}>
                          打开
                        </Button>
                      ) : null}
                      <Button size="sm" icon="copy" onClick={() => onCopyPath?.(row.path)}>
                        复制
                      </Button>
                    </span>
                  </div>
                </td>
              </tr>
            )
          })}
        </tbody>
      </table>
    </div>
  )
}
