import { Button, EmptyState, Fact, Meter, Notice } from './ui.jsx'
import { formatBytes, formatDateTime, formatLatency, formatLoad, formatUptime, usageTone } from '../utils/format.js'

/** 服务器资源面板：SSH 只读采集到的 CPU / 内存 / 磁盘 / 负载 / 系统信息 */
export function ServerResources({ server, onProbe, probing }) {
  const resources = server.resources
  const monitor = server.monitor || {}

  if (!resources) {
    return (
      <div style={{ padding: 4 }}>
        <EmptyState
          title="还没有采集数据"
          hint={
            server.monitorEnabled === false
              ? '这台服务器已关闭 SSH 监控。'
              : '运行 SSH 检测后读取系统指标与真实监听端口。'
          }
          action={
            <Button variant="primary" icon="wifi" loading={probing} onClick={() => onProbe?.(server)}>
              SSH 检测
            </Button>
          }
        />
        {monitor.error ? (
          <Notice tone="error" icon="alert">
            上次采集失败（{formatDateTime(monitor.at)}）：{monitor.error}
          </Notice>
        ) : null}
      </div>
    )
  }

  const memory = resources.memory
  const disk = resources.disk
  const diskList = server.metrics?.diskAll || server.metrics?.disk || []

  return (
    <div className="server-res">
      <div className="res-grid">
        <Meter
          label="CPU 使用率"
          percent={resources.cpuUsagePercent}
          tone={usageTone(resources.cpuUsagePercent)}
          hint={`${resources.cpuCores ?? '—'} 核 · 负载 ${formatLoad(resources.load)}`}
        />
        <Meter
          label="内存"
          percent={memory?.usedPercent}
          tone={usageTone(memory?.usedPercent)}
          hint={memory ? `${formatBytes(memory.usedBytes)} / ${formatBytes(memory.totalBytes)}（可用 ${formatBytes(memory.availableBytes)}）` : '未采集'}
        />
        <Meter
          label={`磁盘 ${disk?.mount || '/'}`}
          percent={disk?.usePercent}
          tone={usageTone(disk?.usePercent)}
          hint={disk ? `${formatBytes(disk.usedBytes)} / ${formatBytes(disk.sizeBytes)}` : '未采集'}
        />
        <Meter
          label="Swap"
          percent={memory?.swapTotalBytes ? (memory.swapUsedBytes / memory.swapTotalBytes) * 100 : null}
          tone={usageTone(memory?.swapTotalBytes ? (memory.swapUsedBytes / memory.swapTotalBytes) * 100 : null)}
          hint={memory?.swapTotalBytes ? `${formatBytes(memory.swapUsedBytes)} / ${formatBytes(memory.swapTotalBytes)}` : '无 Swap'}
        />
      </div>

      <div className="res-facts">
        <Fact icon="server" label="主机名" value={resources.hostname || '—'} />
        <Fact icon="cpu" label="系统" value={resources.os || '—'} />
        <Fact icon="layers" label="内核" value={resources.kernel || '—'} />
        <Fact icon="clock" label="运行时长" value={formatUptime(resources.uptimeSec)} />
        <Fact icon="user" label="登录用户" value={resources.loginUser || server.username || '—'} />
        <Fact icon="wifi" label="SSH 延迟" value={formatLatency(monitor.latencyMs)} />
        <Fact icon="refresh" label="采集时间" value={formatDateTime(resources.collectedAt)} />
        <Fact icon="ports" label="真实监听端口" value={`${resources.portCount ?? 0} 个`} />
      </div>

      {diskList.length > 1 ? (
        <div style={{ marginTop: 12, overflowX: 'auto' }}>
          <table className="table">
            <thead>
              <tr>
                <th>挂载点</th>
                <th>文件系统</th>
                <th>类型</th>
                <th style={{ width: 96 }}>已用</th>
                <th style={{ width: 96 }}>总量</th>
                <th style={{ width: 132 }}>使用率</th>
              </tr>
            </thead>
            <tbody>
              {diskList.map((item) => (
                <tr key={`${item.mount}-${item.filesystem}`}>
                  <td className="mono">{item.mount}</td>
                  <td className="mono" style={{ color: 'var(--muted)' }}>
                    {item.filesystem}
                  </td>
                  <td style={{ color: 'var(--muted)' }}>{item.type || '—'}</td>
                  <td>{formatBytes(item.usedBytes)}</td>
                  <td>{formatBytes(item.sizeBytes)}</td>
                  <td>
                    <span className="row" style={{ gap: 8 }}>
                      <span className="meter__track" style={{ flex: 1, minWidth: 48 }}>
                        <span
                          className="meter__fill"
                          style={{
                            width: `${Math.min(100, item.usePercent)}%`,
                            background:
                              item.usePercent >= 90 ? 'var(--red)' : item.usePercent >= 75 ? 'var(--amber)' : undefined,
                          }}
                        />
                      </span>
                      <span style={{ width: 38, textAlign: 'right' }}>{item.usePercent}%</span>
                    </span>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}

      {monitor.mode === 'ssh' && monitor.online === false ? (
        <Notice tone="error" icon="alert">
          最近一次 SSH 采集失败：{monitor.error}
        </Notice>
      ) : null}
    </div>
  )
}
