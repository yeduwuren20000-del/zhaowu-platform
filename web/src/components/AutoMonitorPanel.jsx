import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client.js'
import { Icon } from './Icons.jsx'
import { Button } from './ui.jsx'
import { formatDateTime, timeAgo } from '../utils/format.js'

const INTERVALS = [
  { value: 60000, label: '1 分钟' },
  { value: 120000, label: '2 分钟' },
  { value: 300000, label: '5 分钟' },
  { value: 600000, label: '10 分钟' },
  { value: 1800000, label: '30 分钟' },
]

/**
 * SSH 自动刷新面板（第七阶段·第二轮）。
 *
 * 与页面右上角的「自动刷新(60s)」不同：
 *   - 那个开关只是**前端定时拉取列表**，离开页面就停；
 *   - 这个开关让**后端定时器**按间隔去采集服务器，关掉页面也继续跑，设置持久化。
 * 后端带熔断退避：连续失败的机器会被暂停，不会把日志刷爆。
 */
export function AutoMonitorPanel({ onChanged }) {
  const [status, setStatus] = useState(null)
  const [busy, setBusy] = useState('')

  const load = useCallback(async () => {
    try {
      setStatus(await api.autoMonitor())
    } catch {
      /* 状态读不到不影响页面，静默 */
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // 开着面板就每 15 秒同步一次后端状态
  useEffect(() => {
    const t = setInterval(load, 15000)
    return () => clearInterval(t)
  }, [load])

  async function act(key, fn, done) {
    setBusy(key)
    try {
      await fn()
      await load()
      onChanged?.()
      if (done) done()
    } catch (error) {
      console.warn('[auto-monitor]', error.message)
    } finally {
      setBusy('')
    }
  }

  const toggle = (checked) =>
    act('toggle', async () => {
      if (checked) await api.autoMonitorStart(status?.settings?.intervalMs)
      else await api.autoMonitorStop()
    })

  const changeInterval = (value) => act('interval', () => api.autoMonitorInterval(Number(value)))

  const runNow = () => act('run', () => api.autoMonitorRun())

  if (!status) return null

  const { settings, running, lastRun, heldServers = [] } = status
  const held = heldServers.length

  return (
    <div className="am-panel">
      <div className="am-panel__main">
        <label className="am-switch">
          <input type="checkbox" checked={Boolean(running)} onChange={(event) => toggle(event.target.checked)} />
          <span className="am-switch__track" aria-hidden />
          <span className="am-switch__label">
            <Icon name="clock" size={13} />
            后台自动采集
          </span>
        </label>

        <select className="select am-interval" value={settings.intervalMs} onChange={(event) => changeInterval(event.target.value)} title="采集间隔">
          {INTERVALS.map((item) => (
            <option key={item.value} value={item.value}>
              每 {item.label}
            </option>
          ))}
        </select>

        <Button size="sm" icon="wifi" loading={busy === 'run'} onClick={runNow} title="立刻按同样的熔断规则采集一轮">
          立即采集一轮
        </Button>

        <span className="am-panel__state">
          {running ? <span className="status-word">运行中</span> : <span className="status-word muted">已停止</span>}
          {lastRun ? (
            <span className="footnote">
              上次 {timeAgo(lastRun.at)} · 采集 {lastRun.probed} 台 · 成功 {lastRun.ok} · 失败 {lastRun.failed}
              {lastRun.onHold ? ` · 暂停 ${lastRun.onHold}` : ''}
              {lastRun.timeout ? ' · 本轮超时' : ''}
            </span>
          ) : (
            <span className="footnote">还没有自动采集过</span>
          )}
        </span>
      </div>

      {held > 0 ? (
        <div className="am-held">
          <span className="footnote">
            <Icon name="shield" size={12} /> {held} 台机器连续失败，已暂停自动重试（退避中）：
          </span>
          {heldServers.slice(0, 4).map((item) => (
            <span key={item.serverId} className="tech" title={item.lastError || ''}>
              {item.name || item.serverId} · {item.failures} 次 · {item.retryAfter ? `${formatDateTime(item.retryAfter).slice(11, 16)} 后重试` : ''}
            </span>
          ))}
          {heldServers.length > 4 ? <span className="tech muted">等 {heldServers.length} 台</span> : null}
        </div>
      ) : null}

      <div className="footnote am-panel__hint">
        与右上角「自动刷新」不同：这个开关让<b>后端定时器</b>按间隔采集，关闭页面也继续；连续失败的机器会自动退避，不会刷爆日志。
      </div>
    </div>
  )
}
