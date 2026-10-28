import { Icon } from './Icons.jsx'
import { Button, StatusDot } from './ui.jsx'
import { DockerPanel } from './DockerPanel.jsx'
import { PortAuditTable } from './PortAuditTable.jsx'
import { ServerLogViewer } from './ServerLogViewer.jsx'
import { ServerResources } from './ServerResources.jsx'
import { ResourceTrend } from './ResourceTrend.jsx'
import { ServerApps } from './ServerApps.jsx'
import { ServerTimeline } from './EventTimeline.jsx'
import { SERVER_TABS, monitorMeta, sshTarget } from './serverShared.js'
import { timeAgo } from '../utils/format.js'

/** 服务器详情：概览 / 应用 / Docker / 端口 / 日志 / 时间线 */
export function ServerDetail({
  server,
  tab = 'overview',
  onTab,
  busy = {},
  onSshProbe,
  onProbeApp,
  onAddApp,
  onEditApp,
  onDeleteApp,
  onEditServer,
  onRegisterPort,
}) {
  const meta = monitorMeta(server)
  const apps = server.apps || []
  const audit = server.portAudit?.summary
  const probing = Boolean(busy[`ssh:${server.id}`])
  const counts = {
    apps: apps.length || null,
    docker: server.dockerSummary?.running || null,
    ports: audit?.listeningNotRecorded || null,
  }

  return (
    <div className="server-detail">
      <header className="server-detail__head">
        <StatusDot status={meta.status} />
        <span className="server-detail__name">{server.name}</span>
        {/* 这三项是可伸缩的：窄屏时先让它们收缩，按钮必须始终留在可视区内
            （实测 640px 宽时会被推出屏幕 373px）*/}
        <span className="tech server-detail__opt">{sshTarget(server)}</span>
        <span className={`status-word server-detail__opt ${meta.status === 'conflict' ? 'is-error' : ''}`}>{meta.text}</span>
        <span className="footnote server-detail__opt">采集 {server.monitor?.at ? timeAgo(server.monitor.at) : '未进行'}</span>
        {/* spacer 只在宽屏时占位；窄屏时它会 flex:1 把右侧按钮推出可视区 */}
        <span className="spacer server-detail__spacer" />
        <Button size="sm" icon="wifi" loading={probing} onClick={() => onSshProbe?.(server)}>
          SSH 检测
        </Button>
        <button type="button" className="icon-button icon-button--sm" title="编辑服务器" onClick={() => onEditServer?.(server)}>
          <Icon name="edit" size={13} />
        </button>
      </header>

      <nav className="server-tabs">
        {SERVER_TABS.map((item) => (
          <button key={item.value} type="button" className={`server-tab ${tab === item.value ? 'is-active' : ''}`} onClick={() => onTab?.(item.value)}>
            {item.label}
            {counts[item.value] ? <span className={`server-tab__count ${item.value === 'ports' ? 'server-tab__count--warn' : ''}`}>{counts[item.value]}</span> : null}
            {item.value === 'docker' && server.dockerSummary?.unhealthy ? (
              <span className="server-tab__count server-tab__count--warn">{server.dockerSummary.unhealthy}</span>
            ) : null}
          </button>
        ))}
      </nav>

      <div className="server-tab-body">
        {tab === 'overview' ? (
          <>
            <ServerResources server={server} probing={probing} onProbe={onSshProbe} />
            <ResourceTrend server={server} />
          </>
        ) : null}
        {tab === 'apps' ? (
          <ServerApps server={server} busy={busy} onAddApp={onAddApp} onProbeApp={onProbeApp} onEditApp={onEditApp} onDeleteApp={onDeleteApp} />
        ) : null}
        {tab === 'docker' ? <DockerPanel server={server} probing={probing} onProbe={onSshProbe} onRegisterPort={onRegisterPort} /> : null}
        {tab === 'ports' ? (
          <PortAuditTable
            server={server}
            audit={server.portAudit}
            busy={busy}
            loading={probing}
            onProbeApp={onProbeApp}
            onEditApp={onEditApp}
            onRegisterPort={onRegisterPort}
            onRefresh={onSshProbe}
          />
        ) : null}
        {tab === 'logs' ? <ServerLogViewer server={server} onEditServer={onEditServer} /> : null}
        {tab === 'timeline' ? <ServerTimeline serverId={server.id} /> : null}
      </div>
    </div>
  )
}
