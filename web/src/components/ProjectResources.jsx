import { Icon } from './Icons.jsx'
import { Button } from './ui.jsx'
import { formatBytes, formatPercent, usageTone } from '../utils/format.js'

/**
 * 项目资源占用面板（第七阶段）。
 *
 * 只展示**已经采集到**的数据，不做任何估算：
 *   - 合计 = 能归因到本项目的**容器** CPU / 内存（自动关联依据只有端口，或用户手工登记的关联）；
 *   - 整机 CPU / 内存 / 磁盘单列为「参照」，明确标注不计入合计；
 *   - 没有关联到容器时显示"暂无归集到的容器资源"，而不是编一个数字。
 */
export function ProjectResources({ resources, onLinkServer = null, onUnlink = null }) {
  if (!resources) return null

  const { totals, servers = [], containers = [], unlinkedServers = [] } = resources

  return (
    <div className="res-panel">
      <div className="res-panel__head">
        <span className="res-panel__title">
          <Icon name="activity" size={14} style={{ color: '#7dd3fc' }} />
          资源占用
        </span>
        {totals.hasData ? (
          <span className="row" style={{ gap: 12 }}>
            <span className="tech">
              CPU <b style={{ color: usageTone(totals.cpuPercent) }}>{formatPercent(totals.cpuPercent, 1)}</b>
            </span>
            <span className="tech">
              内存 <b>{formatBytes(totals.memoryUsedBytes)}</b>
            </span>
            <span className="tech">
              容器 <b>{totals.runningContainerCount}</b>
            </span>
          </span>
        ) : (
          <span className="status-word muted">暂无归集到的容器资源</span>
        )}
      </div>

      <div className="footnote" style={{ marginBottom: 6 }}>
        合计只统计能归因到本项目的容器；整机指标不计入（{totals.note}）
      </div>

      {containers.length > 0 ? (
        <div className="res-table">
          {containers.map((container) => (
            <div key={`${container.serverId}/${container.name}`} className="res-table__row">
              <span className="res-name" title={container.image || container.name}>
                {container.name}
              </span>
              <span className="tech muted">{container.serverName}</span>
              <span className={`status-word ${container.auto ? 'muted' : 'is-warn'}`}>{container.basis}</span>
              <span className="tech" style={{ color: usageTone(container.cpuPercent), textAlign: 'right' }}>
                {container.cpuPercent === null || container.cpuPercent === undefined ? '—' : formatPercent(container.cpuPercent, 1)}
              </span>
              <span className="tech" style={{ textAlign: 'right' }}>
                {container.memoryUsedBytes ? formatBytes(container.memoryUsedBytes) : '—'}
              </span>
            </div>
          ))}
        </div>
      ) : null}

      {servers.filter((item) => item.system).length > 0 ? (
        <div className="res-system">
          <div className="footnote" style={{ marginBottom: 4 }}>
            整机指标（仅作参照，不计入上方合计）
          </div>
          {servers
            .filter((item) => item.system)
            .map((server) => (
              <div key={server.serverId} className="res-system__row">
                <span className="row" style={{ gap: 6 }}>
                  <Icon name="server" size={12} />
                  <span className="res-name">{server.serverName}</span>
                  {!server.online ? <span className="status-word is-error">离线</span> : null}
                </span>
                <span className="footnote">
                  CPU {server.system.cpuUsagePercent === null || server.system.cpuUsagePercent === undefined ? '—' : formatPercent(server.system.cpuUsagePercent, 1)} · 内存{' '}
                  {server.system.memoryUsedPercent === null || server.system.memoryUsedPercent === undefined ? '—' : formatPercent(server.system.memoryUsedPercent, 1)}（
                  {formatBytes(server.system.memoryUsedBytes)} / {formatBytes(server.system.memoryTotalBytes)}）
                </span>
              </div>
            ))}
        </div>
      ) : null}

      {unlinkedServers.length > 0 ? (
        <div className="row row--wrap" style={{ gap: 8, marginTop: 8 }}>
          <span className="footnote">未关联：</span>
          {unlinkedServers.map((item) => (
            <span key={item.serverId} className="tech" title={item.reason}>
              {item.serverName}
            </span>
          ))}
          {onLinkServer ? (
            <Button size="sm" icon="link" onClick={onLinkServer}>
              登记关联
            </Button>
          ) : null}
        </div>
      ) : null}

      {onUnlink ? (
        <div className="row" style={{ gap: 8, marginTop: 6 }}>
          <Button size="sm" icon="x" onClick={onUnlink}>
            取消手工关联
          </Button>
        </div>
      ) : null}
    </div>
  )
}
