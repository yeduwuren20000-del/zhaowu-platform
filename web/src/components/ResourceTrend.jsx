import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client.js'
import { Icon } from './Icons.jsx'
import { Button } from './ui.jsx'
import { Sparkline, SparkStat } from './Sparkline.jsx'
import { timeAgo } from '../utils/format.js'

const WINDOWS = [
  { value: '1h', label: '1 小时' },
  { value: '6h', label: '6 小时' },
  { value: '24h', label: '24 小时' },
  { value: '7d', label: '7 天' },
]

/**
 * 资源历史趋势（第七阶段·第三轮）。
 *
 * 只展示真实采样：点数不足时明说"数据还太少"，不画假趋势；
 * 采集断档如实标出；最后一个点太旧会提示"数据不新鲜"（多半是自动采集没开）。
 */
export function ResourceTrend({ server, onOpenAutoMonitor }) {
  // 注意：不要把这个状态叫 window —— 它会遮蔽全局 window，是个踩过的坑
  const [range, setRange] = useState('24h')
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState(null)

  const load = useCallback(
    async (win) => {
      setLoading(true)
      setError(null)
      try {
        setData(await api.serverHistory(server.id, win))
      } catch (err) {
        setError(err.message)
      } finally {
        setLoading(false)
      }
    },
    [server.id],
  )

  useEffect(() => {
    load(range)
  }, [load, range])

  const series = data?.series || null
  const spikes = data?.spikes || []
  const hasData = series && series.count >= 2
  const thresholds = data?.limits || {}

  return (
    <div className="trend">
      <div className="trend__head">
        <span className="trend__title">
          <Icon name="activity" size={14} style={{ color: 'var(--cyan)' }} />
          历史趋势
          {series?.count ? <span className="footnote">（{series.count} 个采样点）</span> : null}
        </span>
        <div className="row" style={{ gap: 6 }}>
          {WINDOWS.map((item) => (
            <button
              key={item.value}
              type="button"
              className={`tab-chip ${range === item.value ? 'is-active' : ''}`}
              onClick={() => setRange(item.value)}
            >
              {item.label}
            </button>
          ))}
          <button type="button" className="icon-button icon-button--sm" title="重新读取历史" onClick={() => load(range)}>
            <Icon name="refresh" size={13} />
          </button>
        </div>
      </div>

      {error ? (
        <div className="footnote" style={{ color: 'var(--red)' }}>读取历史失败：{error}</div>
      ) : loading && !data ? (
        <div className="footnote">读取历史…</div>
      ) : !hasData ? (
        <div className="trend__empty">
          <span className="footnote">
            真实采样点不足（当前 {series?.count ?? 0} 个，至少需要 2 个才画趋势）。
            开启「后台自动采集」后会按间隔持续积累数据。
          </span>
          {onOpenAutoMonitor ? (
            <Button size="sm" icon="clock" onClick={onOpenAutoMonitor}>
              去开启自动采集
            </Button>
          ) : null}
        </div>
      ) : (
        <>
          {series.stale ? (
            <div className="trend__stale">
              <Icon name="alert" size={12} />
              数据不新鲜：最后一次采样是 {timeAgo(series.to)}，自动采集可能已停止
            </div>
          ) : null}

          {series.gaps?.length ? (
            <div className="trend__gaps">
              <Icon name="alert" size={12} />
              有 {series.gaps.length} 处采集断档（最长 {Math.round(Math.max(...series.gaps.map((g) => g.ms)) / 60000)} 分钟），图中以虚线标出，未插值补点
            </div>
          ) : null}

          <div className="trend__grid">
            <TrendCell
              label="CPU 使用率"
              metric="cpuPercent"
              unit="%"
              series={series}
              samples={data.samples}
              threshold={thresholds.spikeCpuPercent}
            />
            <TrendCell
              label="内存使用率"
              metric="memoryUsedPercent"
              unit="%"
              series={series}
              samples={data.samples}
              threshold={thresholds.spikeMemoryPercent}
            />
            <TrendCell label="负载 (1m)" metric="load1" unit="" series={series} samples={data.samples} />
            <TrendCell label="根磁盘使用率" metric="diskUsedPercent" unit="%" series={series} samples={data.samples} />
            <TrendCell label="容器 CPU 合计" metric="containerCpuPercent" unit="%" series={series} samples={data.samples} />
            <TrendCell
              label="容器内存"
              metric="containerMemoryBytes"
              unit=""
              bytes
              series={series}
              samples={data.samples}
            />
          </div>
        </>
      )}

      {spikes.length > 0 ? (
        <div className="trend__spikes">
          <div className="footnote" style={{ marginBottom: 4 }}>
            尖峰记录（同一指标 {Math.round((thresholds.spikeCooldownMs || 0) / 60000)} 分钟内只记一次）
          </div>
          {spikes.slice(0, 6).map((spike, index) => (
            <div key={`${spike.at}-${spike.metric}-${index}`} className="trend__spike">
              <span className="tech">{timeAgo(spike.at)}</span>
              <span className={`status-word ${spike.metric === 'cpu' ? 'is-warn' : 'is-error'}`}>
                {spike.metric === 'cpu' ? 'CPU' : spike.metric === 'memory' ? '内存' : spike.metric}
              </span>
              <span className="footnote">{spike.message}</span>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

function TrendCell({ label, metric, unit, series, samples, threshold = null, bytes = false }) {
  const stats = series?.stats?.[metric]
  return (
    <div className="trend__cell">
      {/* bytes 时统计数字走 formatBytes；趋势线仍按原始字节数归一化，不做任何换算造点 */}
      <SparkStat label={label} stats={stats} unit={unit} threshold={threshold} bytes={bytes} />
      <Sparkline samples={samples} gaps={series?.gaps} metric={metric} threshold={threshold} unit={unit} label={label} />
    </div>
  )
}
