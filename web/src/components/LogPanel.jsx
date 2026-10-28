import { useEffect, useRef } from 'react'
import { Icon } from './Icons.jsx'

/** 工作台事件 -> 统一日志行 */
export function normalizeEvents(events = []) {
  return events.map((event) => ({
    time: event.at,
    level: event.level || 'info',
    source: event.source || 'workbench',
    message: event.message || '',
    plain: false,
  }))
}

/** 项目进程日志（纯文本）-> 统一日志行；自动识别 [ERROR]/[WARN] 关键字 */
export function normalizeTextLines(lines = []) {
  return lines.map((line) => {
    const match = line.match(/^\[?(\d{4}-\d{2}-\d{2}T[\d:.]+Z?)\]?\s*(.*)$/)
    const upper = line.toUpperCase()
    let level = 'plain'
    if (upper.includes('[ERROR]') || upper.includes('ERROR ') || upper.includes('EADDRINUSE')) level = 'error'
    else if (upper.includes('[WARN]') || upper.includes('WARNING')) level = 'warn'
    else if (upper.includes('[INFO]') || upper.includes('LISTENING') || upper.includes('READY')) level = 'info'
    return {
      time: match ? match[1] : null,
      level,
      source: '',
      message: line,
      plain: true,
    }
  })
}

function clockOf(value) {
  if (!value) return '--:--:--'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return '--:--:--'
  const pad = (number) => String(number).padStart(2, '0')
  return `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

/** 日志面板：自动滚到底部，等级着色 */
export function LogPanel({ entries = [], height = 300, autoScroll = true, emptyText = '暂无日志', emptyHint = '' }) {
  const ref = useRef(null)

  useEffect(() => {
    if (autoScroll && ref.current) ref.current.scrollTop = ref.current.scrollHeight
  }, [entries, autoScroll])

  if (!entries.length) {
    return (
      <div className="log-panel" style={{ height }}>
        <div className="log-line log-line--plain">
          <span className="log-msg" style={{ color: 'var(--muted)' }}>
            {emptyText}
          </span>
        </div>
        {emptyHint ? (
          <div className="log-line log-line--plain">
            <span className="log-msg" style={{ color: 'var(--muted-2)' }}>
              {emptyHint}
            </span>
          </div>
        ) : null}
      </div>
    )
  }

  return (
    <div className="log-panel" style={{ height }} ref={ref}>
      {entries.map((entry, index) => (
        <div key={`${entry.time || 'line'}-${index}`} className={`log-line log-line--${entry.level}`}>
          {/* 纯文本日志自带时间戳，不再重复加一列 */}
          {entry.plain ? null : <span className="log-time">{clockOf(entry.time)}</span>}
          {entry.plain ? null : <span className="log-level">[{String(entry.level).toUpperCase()}]</span>}
          {entry.source ? <span className="log-source">{entry.source}</span> : null}
          <span className="log-msg">{entry.message}</span>
        </div>
      ))}
    </div>
  )
}
