import { useState } from 'react'
import { Button, EmptyState, Notice } from './ui.jsx'
import { formatBytes, formatDateTime, formatPercent, formatUptime, timeAgo } from '../utils/format.js'

/** docker ps 的 State -> 中文短词（键仍是 docker 原词，只翻显示）；颜色只留给需要多看一眼的异常 */
const STATE_META = {
  running: { text: '运行中', tone: '' },
  exited: { text: '已退出', tone: 'muted' },
  created: { text: '已创建', tone: 'muted' },
  paused: { text: '已暂停', tone: 'is-warn' },
  restarting: { text: '重启中', tone: 'is-warn' },
  dead: { text: '已失效', tone: 'is-error' },
  removing: { text: '删除中', tone: 'is-warn' },
}

const HEALTH_META = {
  healthy: { text: '健康', tone: 'muted' },
  unhealthy: { text: '健康检查异常', tone: 'is-error' },
  starting: { text: '启动中', tone: 'is-warn' },
}

const AUDIT_META = {
  ok: { text: '一致', tone: 'muted' },
  recordedStopped: { text: '记录未运行', tone: 'is-warn' },
  containerNotRecorded: { text: '未登记', tone: 'is-error' },
}

function MiniMeter({ percent }) {
  const value = Number.isFinite(Number(percent)) ? Math.max(0, Math.min(100, Number(percent))) : null
  const high = value !== null && value >= 90 ? 'var(--red)' : value !== null && value >= 75 ? 'var(--amber)' : undefined
  return (
    <span className="row" style={{ gap: 6 }}>
      <span className="meter__track" style={{ width: 40 }}>
        <span className="meter__fill" style={{ width: `${value ?? 0}%`, background: high }} />
      </span>
      <span className="mono" style={{ fontSize: 11.5, width: 42, color: 'var(--text-soft)' }}>
        {value === null ? '—' : `${value.toFixed(1)}%`}
      </span>
    </span>
  )
}

/** 端口映射展示：8080→3000/tcp */
function PortList({ ports }) {
  if (!ports?.length) return <span style={{ color: 'var(--muted-2)' }}>—</span>
  return (
    <span className="port-cell">
      {ports.map((port) => (
        <span
          key={`${port.hostIp}-${port.hostPort}-${port.containerPort}-${port.proto}`}
          className={port.published ? '' : 'muted'}
          title={port.published ? `${port.hostIp}:${port.hostPort} → 容器 ${port.containerPort}/${port.proto}` : `仅容器内暴露 ${port.containerPort}/${port.proto}`}
        >
          {port.published ? `${port.hostPort}→${port.containerPort}/${port.proto}` : `${port.containerPort}/${port.proto}`}
        </span>
      ))}
    </span>
  )
}

/**
 * Docker 容器只读面板：
 * 容器列表 / 镜像 / 状态与健康 / 运行时长 / CPU 与内存 / 端口映射 / 与 APP 的三类核对。
 * 第一版严格只读 —— 页面上没有任何 start / stop / restart / exec / rm 入口。
 */
export function DockerPanel({ server, onProbe, probing, onRegisterPort }) {
  const [showImages, setShowImages] = useState(false)
  const docker = server.docker || null
  const summary = docker?.summary || null
  const auditItems = docker?.audit?.items || []
  const auditByContainer = new Map()
  for (const item of auditItems) {
    if (item.container?.id) auditByContainer.set(item.container.id, item)
  }
  const auditSummary = docker?.audit?.summary || null
  const containers = docker?.containers || []
  const images = docker?.images || []

  if (!server.ssh?.at) {
    return (
      <EmptyState
        title="还没有做过 SSH 采集"
        hint="Docker 信息随 SSH 只读采集一起获取（docker ps / images / inspect / stats --no-stream）。"
        action={
          <Button variant="primary" icon="wifi" loading={probing} onClick={() => onProbe?.(server)}>
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
          SSH 采集失败（{formatDateTime(server.ssh.at)}）：{server.ssh.error}
        </Notice>
        <div style={{ marginTop: 10 }}>
          <Button icon="refresh" loading={probing} onClick={() => onProbe?.(server)}>
            重新检测
          </Button>
        </div>
      </div>
    )
  }

  if (!docker) {
    return (
      <EmptyState
        title="这次采集没有 Docker 数据"
        hint="可能是在「编辑服务器」里关闭了 Docker 采集，或采集尚未执行。"
        action={
          <Button variant="primary" icon="refresh" loading={probing} onClick={() => onProbe?.(server)}>
            重新采集
          </Button>
        }
      />
    )
  }

  if (!docker.installed) {
    return (
      <Notice tone="info" icon="box">
        这台服务器没有安装 Docker（{docker.error || '未检测到 docker 命令'}）。如果确实有容器在跑，请检查登录用户的 PATH 与权限。
      </Notice>
    )
  }

  if (!docker.daemonOk) {
    return (
      <div>
        <Notice tone="error" icon="alert">
          Docker 已安装但不可用：{docker.error}
        </Notice>
        <div style={{ marginTop: 10 }}>
          <Button icon="refresh" loading={probing} onClick={() => onProbe?.(server)}>
            重新检测
          </Button>
        </div>
      </div>
    )
  }

  return (
    <div>
      <div className="row row--wrap" style={{ gap: 10, marginBottom: 10 }}>
        <span className="docker-version">Docker {docker.version || '—'}</span>
        <span className="footnote">
          {summary.total} 个容器 · 运行 <b>{summary.running}</b> · 停止 <b>{summary.exited + summary.paused}</b>
          {summary.restarting > 0 ? <span className="status-word is-warn"> · 重启中 {summary.restarting}</span> : null}
          {summary.unhealthy > 0 ? <span className="status-word is-error"> · 健康检查异常 {summary.unhealthy}</span> : null}
          {' '}· 镜像 <b>{images.length}</b>
        </span>
        <span className="footnote">
          CPU 合计 {formatPercent(summary.cpuPercentTotal, 1)} · 内存合计 {formatBytes(summary.memoryUsedBytes)} · 采集于 {timeAgo(docker.at)}
        </span>
        <div className="spacer" />
        <Button size="sm" icon="refresh" loading={probing} onClick={() => onProbe?.(server)}>
          重新采集
        </Button>
      </div>

      {auditSummary ? (
        <div className="footnote" style={{ marginBottom: 10 }}>
          与 APP 记录核对：一致 <b>{auditSummary.ok}</b>
          {auditSummary.recordedStopped > 0 ? <span className="status-word is-warn"> · 记录未运行 {auditSummary.recordedStopped}</span> : null}
          {auditSummary.containerNotRecorded > 0 ? (
            <span className="status-word is-error"> · 未登记 {auditSummary.containerNotRecorded}</span>
          ) : null}
        </div>
      ) : null}

      {containers.length === 0 ? (
        <EmptyState title="没有容器" hint="这台机器上 docker ps -a 没有任何容器。" />
      ) : (
        <div style={{ overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>容器</th>
                <th>镜像</th>
                <th style={{ width: 150 }}>状态</th>
                <th style={{ width: 96 }}>运行时长</th>
                <th style={{ width: 108 }}>CPU</th>
                <th style={{ width: 168 }}>内存</th>
                <th>端口映射</th>
                <th style={{ width: 132 }}>与 APP 核对</th>
                <th style={{ width: 118, textAlign: 'right' }}>操作</th>
              </tr>
            </thead>
            <tbody>
              {containers.map((container) => {
                const stateMeta = STATE_META[container.state] || { text: container.state, tone: 'muted' }
                const healthMeta = HEALTH_META[container.health] || null
                const audit = auditByContainer.get(container.id) || null
                const auditMeta = audit ? AUDIT_META[audit.state] : null
                const published = container.ports.filter((port) => port.published)
                return (
                  <tr key={container.id}>
                    <td>
                      <span className="docker-name">{container.name}</span>
                      <div className="mono" style={{ fontSize: 11, color: 'var(--muted-2)' }}>
                        {container.shortId}
                        {container.composeProject ? ` · ${container.composeProject}/${container.composeService}` : ''}
                      </div>
                    </td>
                    <td>
                      <span className="mono" style={{ fontSize: 11.5, color: 'var(--text-soft)' }}>
                        {container.image}
                      </span>
                    </td>
                    <td>
                      <span className="row row--wrap" style={{ gap: 7 }}>
                        <span className={`status-word ${stateMeta.tone}`}>{stateMeta.text}</span>
                        {healthMeta ? <span className={`status-word ${healthMeta.tone}`}>{healthMeta.text}</span> : null}
                        {container.restartCount > 0 ? <span className="status-word is-warn">重启 {container.restartCount}</span> : null}
                      </span>
                    </td>
                    <td style={{ fontSize: 11.5 }}>{container.state === 'running' ? formatUptime(container.uptimeSec) : container.runningFor || '—'}</td>
                    <td>
                      {container.state === 'running' ? (
                        <MiniMeter percent={container.cpuPercent} />
                      ) : (
                        <span style={{ color: 'var(--muted-2)' }}>—</span>
                      )}
                    </td>
                    <td>
                      {container.state === 'running' ? (
                        <div>
                          <MiniMeter percent={container.memoryPercent} />
                          <div className="mono" style={{ fontSize: 11, color: 'var(--muted-2)' }}>
                            {formatBytes(container.memoryUsedBytes)}
                            {container.memoryLimitBytes ? ` / ${formatBytes(container.memoryLimitBytes)}` : ''}
                          </div>
                        </div>
                      ) : (
                        <span style={{ color: 'var(--muted-2)' }}>—</span>
                      )}
                    </td>
                    <td>
                      <PortList ports={container.ports} />
                    </td>
                    <td>
                      {auditMeta ? (
                        <span className={`status-word ${auditMeta.tone}`}>{auditMeta.text}</span>
                      ) : (
                        <span style={{ color: 'var(--muted-2)' }}>—</span>
                      )}
                    </td>
                    <td>
                      <div className="table__actions">
                        {audit?.state === 'containerNotRecorded' && published.length > 0 ? (
                          <Button
                            size="sm"
                            variant="primary"
                            icon="plus"
                            onClick={() =>
                              onRegisterPort?.(server, {
                                name: container.name,
                                port: published[0].hostPort,
                                deployPath: '',
                                status: container.state === 'running' ? 'running' : 'stopped',
                                remark: `由 Docker 容器核对登记（镜像 ${container.image}）`,
                              })
                            }
                          >
                            登记为 APP
                          </Button>
                        ) : (
                          <span className="row-actions">
                            <Button
                              size="sm"
                              icon="copy"
                              onClick={() => navigator.clipboard?.writeText(container.name).catch(() => {})}
                              title="复制容器名（工作台不提供任何写操作）"
                            >
                              复制名称
                            </Button>
                          </span>
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

      <div className="row" style={{ marginTop: 12, gap: 8 }}>
        <Button size="sm" icon={showImages ? 'chevronDown' : 'chevronRight'} onClick={() => setShowImages((prev) => !prev)}>
          {showImages ? '收起镜像列表' : `展开镜像列表（${images.length}）`}
        </Button>
        <span style={{ fontSize: 11.5, color: 'var(--muted-2)' }}>
          只读采集：docker ps / images / inspect / stats --no-stream / info / version，不提供 exec、restart、stop、rm 等写操作
        </span>
      </div>

      {showImages ? (
        <div style={{ overflowX: 'auto', marginTop: 10 }}>
          <table className="table">
            <thead>
              <tr>
                <th>镜像</th>
                <th style={{ width: 130 }}>镜像 ID</th>
                <th style={{ width: 96 }}>大小</th>
                <th style={{ width: 130 }}>创建时间</th>
              </tr>
            </thead>
            <tbody>
              {images.map((image) => (
                <tr key={`${image.repository}:${image.tag}`}>
                  <td className="mono">
                    {image.repository}:{image.tag}
                  </td>
                  <td className="mono" style={{ color: 'var(--muted)', fontSize: 11.5 }}>
                    {image.shortId}
                  </td>
                  <td>{image.sizeText || formatBytes(image.sizeBytes)}</td>
                  <td style={{ color: 'var(--muted)' }}>{image.createdSince}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  )
}
