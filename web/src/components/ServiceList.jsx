import { Icon } from './Icons.jsx'
import { Button, EmptyState, StatusDot, statusLabel } from './ui.jsx'
import { formatBytes, formatDuration, formatLatency, formatUptime, groupStatusWord, timeAgo } from '../utils/format.js'

/**
 * 子服务列表（第五阶段）：一个项目组下面的多个进程/端口。
 * 每个子服务都保留自己的事实字段（PID、端口、地址、进程名、命令行、启动时间）。
 */
export function ServiceList({
  services = [],
  busy = {},
  onAssociate,
  onIgnore,
  onDissociate,
  onRegisterSingle,
  onEditRegister,
  showProject = false,
  compact = false,
  emptyText = '这个项目组下暂时没有监听中的进程。',
}) {
  if (!services.length) return <EmptyState title={emptyText} />

  return (
    <div style={{ overflowX: 'auto' }}>
      <table className="table">
        <thead>
          <tr>
            <th style={{ width: 84 }}>状态</th>
            <th style={{ width: 64 }}>端口</th>
            <th>服务 / 类型</th>
            <th style={{ width: 170 }}>进程（PID / 名称）</th>
            <th style={{ width: 132 }}>监听地址</th>
            {showProject ? <th style={{ width: 120 }}>所属项目</th> : null}
            <th>命令行</th>
            <th style={{ width: 84 }}>运行时长</th>
            <th style={{ width: 186, textAlign: 'right' }}>操作</th>
          </tr>
        </thead>
        <tbody>
          {services.map((service) => {
            const live = service.live !== false
            const pid = service.livePid ?? service.pid
            const processName = service.liveProcessName || service.processName
            const key = service.key || service.fingerprint || service.id
            return (
              <tr key={key}>
                <td>
                  <span className="row" style={{ gap: 6 }}>
                    <StatusDot status={live ? 'running' : 'stopped'} />
                    <span className="status-word">{statusLabel(live ? 'running' : 'stopped')}</span>
                  </span>
                </td>
                <td className="table__port">{service.port ?? '—'}</td>
                <td>
                  <span className="row" style={{ gap: 7 }}>
                    <span>{service.serviceName || service.name}</span>
                    {service.isNewSubService ? <span className="status-word is-warn">新发现</span> : null}
                    {!live ? <span className="status-word muted">仅记录</span> : null}
                    {service.ignored ? <span className="status-word muted">已忽略</span> : null}
                  </span>
                  <div className="tech muted">{service.type || '—'}</div>
                </td>
                <td>
                  <span className="tech">{pid ?? '—'}</span>
                  <div className="tech" style={{ color: 'var(--muted-2)' }}>{processName || '—'}</div>
                  {service.parentName ? <div className="tech" style={{ color: 'var(--muted-2)' }}>父 {service.parentName}</div> : null}
                </td>
                <td className="tech" style={{ color: 'var(--muted)' }}>
                  {service.liveAddress || service.address || '—'}
                </td>
                {showProject ? (
                  <td>
                    {service.registeredProjectName || service.declaredFrom?.projectName || '—'}
                  </td>
                ) : null}
                <td>
                  <span
                    className="tech"
                    style={{ color: 'var(--muted-2)', display: 'inline-block', maxWidth: compact ? 200 : 320, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', verticalAlign: 'bottom' }}
                    title={service.commandLine}
                  >
                    {service.commandLine || (live ? '（进程信息不可读）' : '来自项目记录')}
                  </span>
                </td>
                <td className="tech" style={{ color: 'var(--muted)' }}>{live ? formatUptime(Math.round((service.uptimeMs || 0) / 1000)) : '—'}</td>
                <td>
                  <div className="table__actions">
                    {service.isNewSubService && onAssociate ? (
                      <Button
                        size="sm"
                        icon="plus"
                        loading={busy[`assoc:${service.key}`]}
                        onClick={() => onAssociate(service)}
                        title="关联为当前项目的子服务"
                      >
                        关联
                      </Button>
                    ) : null}
                    {live && !service.registeredProjectId && onRegisterSingle ? (
                      <Button size="sm" icon="check" loading={busy[`reg:${service.key}`]} onClick={() => onRegisterSingle(service)}>
                        登记
                      </Button>
                    ) : null}
                    <span className="row-actions">
                      {!live && onDissociate ? (
                        <Button size="sm" icon="x" loading={busy[`dissoc:${service.id}`]} onClick={() => onDissociate(service)}>
                          解除关联
                        </Button>
                      ) : null}
                      {live && !service.registeredProjectId && onEditRegister ? (
                        <Button size="sm" icon="edit" onClick={() => onEditRegister(service)}>
                          编辑登记
                        </Button>
                      ) : null}
                      {live && service.registrationState !== 'ignored' && onIgnore ? (
                        <Button size="sm" icon="x" loading={busy[`ign:${service.key}`]} onClick={() => onIgnore(service)}>
                          忽略
                        </Button>
                      ) : null}
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

/** 项目组行（未登记）：一行给出名称、状态、技术栈、目录与端口/进程数量，展开看子服务 */
export function ProjectGroupCard({
  group,
  expanded,
  onToggle,
  busy = {},
  onRegisterGroup,
  onIgnoreGroup,
  onRegisterSingle,
  onEditRegister,
  onAssociate,
  onIgnoreService,
  selectable = false,
  selected = false,
  onToggleSelect = null,
}) {
  const counts = group.summary || {}
  const portList = counts.portList || []
  const stackKinds = group.stack?.kinds || []
  const unregistered = group.registrationState !== 'registered'

  return (
    <div className={`group-card ${group.status === 'conflict' ? 'group-card--conflict' : ''}`}>
      <div className="group-card__head" onClick={() => onToggle?.(group.id)}>
        {selectable && unregistered ? (
          <span
            className={`group-card__check ${selected ? 'is-checked' : ''}`}
            onClick={(event) => {
              event.stopPropagation()
              onToggleSelect?.(group.id)
            }}
            role="checkbox"
            aria-checked={selected}
            title={selected ? '取消选择' : '选择此组批量登记'}
          >
            <Icon name={selected ? 'check' : 'square'} size={17} />
          </span>
        ) : null}
        <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={14} className={`chevron ${expanded ? 'is-open' : ''}`} />
        <div style={{ minWidth: 0, flex: 1 }}>
          <div className="group-card__title">
            <StatusDot status={group.status === 'all-stopped' ? 'stopped' : group.status === 'conflict' ? 'conflict' : 'running'} />
            <span className="group-card__name">{group.name}</span>
            <span className={`status-word ${group.status === 'conflict' ? 'is-error' : group.status === 'partial-running' ? 'is-warn' : ''}`}>
              {groupStatusWord(group.status)}
            </span>
            <span className={`status-word ${unregistered ? 'is-warn' : 'muted'}`}>{unregistered ? '待登记' : '已登记'}</span>
            {stackKinds.length ? <span className="tech muted">{stackKinds.join(' · ')}</span> : null}
            {counts.newSubServices > 0 ? <span className="status-word is-warn">新子服务 {counts.newSubServices}</span> : null}
          </div>
          <div className="group-card__facts">
            <span className="tech" title={group.projectDir}>
              {group.projectDir || '未识别目录'}
            </span>
            <span>
              端口 <b>{portList.length ? portList.join(' ') : '—'}</b>
            </span>
            <span>
              进程 <b>{counts.processes ?? 0}</b>
            </span>
            <span>
              运行 <b>{counts.live ?? 0}/{counts.services ?? 0}</b>
            </span>
            {group.registeredProjectName && group.registeredProjectName !== group.name ? (
              <span>
                项目 <b>{group.registeredProjectName}</b>
              </span>
            ) : null}
          </div>
        </div>
        <div className="group-card__actions" onClick={(event) => event.stopPropagation()}>
          {unregistered ? (
            <Button
              size="sm"
              variant="primary"
              icon="check"
              loading={busy[`grp:${group.id}`]}
              onClick={() => onRegisterGroup?.(group)}
              title="只创建一个项目，同目录的其它服务作为子服务"
            >
              登记
            </Button>
          ) : null}
          {unregistered ? (
            <span className="row-actions">
              <Button size="sm" icon="x" loading={busy[`grpign:${group.id}`]} onClick={() => onIgnoreGroup?.(group)}>
                全部忽略
              </Button>
            </span>
          ) : null}
        </div>
      </div>

      {expanded ? (
        <div className="group-card__body">
          {group.conflicts?.length ? (
            <div className="notice notice--error" style={{ marginBottom: 10 }}>
              <Icon name="alert" size={14} style={{ marginTop: 2, flex: '0 0 auto' }} />
              <div>
                {group.conflicts.map((conflict) => (
                  <div key={`${conflict.port}-${conflict.type}`}>{conflict.message}</div>
                ))}
              </div>
            </div>
          ) : null}
          <ServiceList
            services={group.services}
            busy={busy}
            onAssociate={onAssociate}
            onIgnore={onIgnoreService}
            onRegisterSingle={onRegisterSingle}
            onEditRegister={onEditRegister}
          />
        </div>
      ) : null}
    </div>
  )
}

export { formatBytes, formatDuration, formatLatency, timeAgo }
