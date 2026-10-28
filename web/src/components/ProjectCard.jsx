import { Icon } from './Icons.jsx'
import { Button, Menu, StatusDot, statusLabel } from './ui.jsx'
import { StartFailureCard } from './StartFailureCard.jsx'
import { formatBytes, formatDuration, groupStatusWord, localUrl } from '../utils/format.js'

/**
 * 项目行（紧凑列表）：默认只显示名称、技术栈、路径、状态、端口、PID。
 * 次要操作在 hover / 聚焦 / 展开时才出现，避免整页都是按钮。
 */
export function ProjectCard({
  project,
  action,
  onStart,
  onStop,
  onRestart,
  onOpenDir,
  onOpenUrl,
  onLog,
  onEdit,
  onDelete,
  onCopyUrl,
  onNavigate,
  failure = null,
  onDismissFailure = null,
  showRemark = true,
  serviceSummary = null,
  groupStatus = null,
  expanded = false,
  onToggleExpand = null,
}) {
  const busy = Boolean(action)
  const url = localUrl(project)
  const running = project.status === 'running' || project.status === 'starting'

  return (
    <div className={`project-row ${expanded ? 'is-open' : ''}`}>
      <div className="project-row__main">
        <div className="project-row__title">
          <StatusDot status={project.status} />
          <span className="project-row__name">{project.name}</span>
          <span className="status-word">{statusLabel(project.status)}</span>
          {project.type ? <span className="tech muted">{project.type}</span> : null}
          {!project.dirExists ? <span className="status-word is-error">目录不存在</span> : null}
          {groupStatus && (groupStatus.tone === 'red' || groupStatus.tone === 'amber') ? (
            <span className={`status-word ${groupStatus.tone === 'red' ? 'is-error' : 'is-warn'}`}>
              子服务整体 {groupStatusWord(groupStatus.status)}
            </span>
          ) : null}
        </div>

        <div className="project-row__facts">
          <span>
            端口 <b>{project.port ?? '—'}</b>
          </span>
          <span>
            PID <b>{project.pid ?? '—'}</b>
            {project.processName ? <em>{project.processName}</em> : null}
          </span>
          <span>
            内存 <b>{formatBytes(project.memory)}</b>
          </span>
          <span>
            运行 <b>{running ? formatDuration(project.uptimeMs) : '—'}</b>
          </span>
          {serviceSummary ? (
            <button
              type="button"
              className="project-row__toggle"
              onClick={() => onToggleExpand?.(project.id)}
              title={expanded ? '收起子服务' : '展开子服务'}
            >
              <Icon name={expanded ? 'chevronDown' : 'chevronRight'} size={11} />
              子服务 {serviceSummary.ports} 端口 / {serviceSummary.processes} 进程
              {serviceSummary.newSubServices > 0 ? <em className="is-warn">新 {serviceSummary.newSubServices}</em> : null}
            </button>
          ) : null}
        </div>

        <div className={`project-row__path ${project.dirExists ? '' : 'is-missing'}`} title={project.dir}>
          {project.dir || '未配置目录'}
          {url ? (
            <span className="project-row__url" onClick={() => onOpenUrl?.(project)} title="用默认浏览器打开">
              {url}
            </span>
          ) : null}
        </div>

        {showRemark && project.conflict ? <div className="status-word is-error">{project.conflict.message}</div> : null}
        {showRemark && !project.conflict && project.remark ? <div className="project-row__remark">{project.remark}</div> : null}
        {/* 启动失败诊断：常驻在卡片里，直到下次启动成功或用户手动收起 */}
        {failure ? (
          <StartFailureCard failure={failure} onNavigate={onNavigate} onDismiss={() => onDismissFailure?.(project.id)} />
        ) : null}
      </div>

      <div className="project-row__actions">
        {/* 高频操作常驻，其余收进「⋯」—— 一行只留一个主按钮，扫读更快 */}
        <Button
          size="sm"
          variant={running ? undefined : 'primary'}
          icon={running ? 'stop' : 'play'}
          loading={action === 'start' || action === 'stop' || action === 'restart'}
          disabled={busy}
          onClick={() => (running ? onStop?.(project) : onStart?.(project))}
        >
          {running ? '停止' : '启动'}
        </Button>
        <Menu
          align="right"
          width={196}
          label={`${project.name} 的更多操作`}
          trigger={({ toggle, ariaLabel }) => (
            <button type="button" className="icon-button" onClick={toggle} title={ariaLabel} aria-label={ariaLabel}>
              <Icon name="more" size={14} />
            </button>
          )}
          items={[
            { key: 'restart', label: '重启', icon: 'restart', disabled: busy || !running, onClick: () => onRestart?.(project) },
            { key: 'dir', label: '打开目录', icon: 'folderOpen', hint: project.dir || '', onClick: () => onOpenDir?.(project) },
            { key: 'url', label: '打开网页', icon: 'external', hint: url || '未设置访问地址', disabled: !url, onClick: () => onOpenUrl?.(project) },
            { key: 'log', label: '查看日志', icon: 'fileText', onClick: () => onLog?.(project) },
            { key: 'copy', label: '复制访问地址', icon: 'copy', disabled: !url, onClick: () => onCopyUrl?.(project) },
            { key: 'edit', label: '编辑项目', icon: 'edit', onClick: () => onEdit?.(project) },
            { key: 'delete', label: '删除项目', icon: 'trash', danger: true, onClick: () => onDelete?.(project) },
          ]}
        />
      </div>
    </div>
  )
}
