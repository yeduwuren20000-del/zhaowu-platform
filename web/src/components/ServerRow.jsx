import { Icon } from './Icons.jsx'
import { Button, Menu, StatusDot } from './ui.jsx'
import { formatLatency, formatPercent, usageTone } from '../utils/format.js'
import { monitorMeta, sshTarget } from './serverShared.js'

/**
 * 服务器列表行：一眼看清「在不在 / 资源多少 / 有没有异常」，点开看细节。
 *
 * 与项目行同一套约定：
 *   - 主操作（SSH 检测）常驻，其余收进「⋯」；
 *   - 异常（未登记端口 / 记录未监听 / 容器异常）才上色，正常项保持灰。
 */
export function ServerRow({ server, selected, busy = {}, onSelect, onSshProbe, onTcpProbe, onEditServer, onDeleteServer }) {
  const meta = monitorMeta(server)
  const apps = server.apps || []
  const unrecorded = server.portAudit?.summary?.listeningNotRecorded || 0
  const notListening = server.portAudit?.summary?.recordedNotListening || 0
  const unhealthy = server.dockerSummary?.unhealthy || 0

  const cpu = server.resources?.cpuUsagePercent
  const mem = server.resources?.memory?.usedPercent
  const containers = server.dockerSummary?.running

  return (
    <div
      className={`server-row ${selected ? 'is-selected' : ''}`}
      data-server-id={server.id}
      role="button"
      tabIndex={0}
      onClick={() => onSelect?.(server.id)}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') {
          event.preventDefault()
          onSelect?.(server.id)
        }
      }}
    >
      <StatusDot status={meta.status} />
      <span className="server-row__name">{server.name}</span>
      <span className={`status-word ${meta.status === 'conflict' ? 'is-error' : ''}`}>{meta.text}</span>

      {/* 资源水位常显：这是"一目了然"最关键的一眼，不必点进详情 */}
      <span className="server-row__resources">
        <span className="srv-res" title="CPU 使用率（整机）">
          CPU <b style={{ color: usageTone(cpu) }}>{formatPercent(cpu)}</b>
        </span>
        <span className="srv-res" title="内存使用率（整机）">
          内存 <b style={{ color: usageTone(mem) }}>{formatPercent(mem)}</b>
        </span>
        {containers ? (
          <span className="srv-res" title="运行中的容器">
            容器 <b>{containers}</b>
          </span>
        ) : null}
      </span>

      <span className="tech">{sshTarget(server)}</span>
      <span className="tech muted" title={server.os}>
        {server.os || '—'}
      </span>

      <span className="server-row__facts">
        <span>
          延迟 <b>{formatLatency(server.monitor?.latencyMs)}</b>
        </span>
        <span>
          应用 <b>{apps.length}</b>
        </span>
        {unrecorded > 0 ? <span className="status-word is-error">未登记端口 {unrecorded}</span> : null}
        {notListening > 0 ? <span className="status-word is-warn">记录未监听 {notListening}</span> : null}
        {unhealthy > 0 ? <span className="status-word is-error">容器异常 {unhealthy}</span> : null}
        {server.monitorEnabled === false ? <span className="status-word muted">监控已关闭</span> : null}
      </span>

      <div className="server-row__actions" onClick={(event) => event.stopPropagation()}>
        <Button
          size="sm"
          variant={meta.status === 'running' ? undefined : 'primary'}
          icon="wifi"
          loading={busy[`ssh:${server.id}`]}
          onClick={() => onSshProbe?.(server)}
        >
          SSH 检测
        </Button>
        <Menu
          align="right"
          width={186}
          label={`${server.name} 的更多操作`}
          trigger={({ toggle, ariaLabel }) => (
            <button type="button" className="icon-button" onClick={toggle} title={ariaLabel} aria-label={ariaLabel}>
              <Icon name="more" size={14} />
            </button>
          )}
          items={[
            { key: 'tcp', label: 'TCP 连通性探测', icon: 'activity', hint: '只测端口通不通，不登录', onClick: () => onTcpProbe?.(server) },
            { key: 'edit', label: '编辑服务器', icon: 'edit', onClick: () => onEditServer?.(server) },
            { key: 'delete', label: '删除服务器', icon: 'trash', danger: true, onClick: () => onDeleteServer?.(server) },
          ]}
        />
      </div>
    </div>
  )
}
