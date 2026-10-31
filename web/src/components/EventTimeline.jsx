import { Fragment } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client.js'
import { useAsync } from '../hooks/useAsync.js'
import { EmptyState, ErrorNotice, Loading } from './ui.jsx'
import { eventDotColor, eventMeta, formatClock, formatDateTime, formatDayLabel } from '../utils/format.js'

const SOURCE_TEXT = { action: '手动' }

/** 事实字段：端口 / PID / 进程 / 地址；消息里已经写过的数字不再重复一遍 */
function EventFacts({ event }) {
  const message = event.message || ''
  const facts = []
  const add = (text, probe) => {
    if (text && !message.includes(probe ?? text)) facts.push(text)
  }
  add(event.serviceName)
  if (event.port) add(`:${event.port}`, String(event.port))
  add(event.processName)
  if (event.pid) add(`PID ${event.pid}`, String(event.pid))
  add(event.address)
  add(event.code)
  if (!facts.length) return null
  return (
    <div className="timeline__facts">
      {facts.map((text) => (
        <span key={text}>{text}</span>
      ))}
    </div>
  )
}

function TimelineRow({ event }) {
  const meta = eventMeta(event.type)
  const tone = event.level === 'error' ? 'is-error' : event.level === 'warn' ? 'is-warn' : ''
  return (
    <div className="timeline__item">
      <span className="timeline__time" title={formatDateTime(event.at)}>
        {formatClock(event.at)}
      </span>
      <span className="timeline__dot" style={{ background: eventDotColor(event.level) }} />
      <div className="timeline__main">
        <div className="timeline__head">
          <span className={`status-word ${tone}`}>{meta.text}</span>
          <span className="timeline__msg">{event.message}</span>
          {SOURCE_TEXT[event.source] ? <span className="timeline__tag">{SOURCE_TEXT[event.source]}</span> : null}
        </div>
        {event.detail ? <div className="timeline__detail">{event.detail}</div> : null}
        <EventFacts event={event} />
      </div>
    </div>
  )
}

/** 按主体（项目 / 服务器 / 服务 / 系统）把连续事件聚成组，保持事件原有顺序 */
function groupBySubject(events) {
  const groups = []
  events.forEach((event, index) => {
    const subject = event.projectName || event.serverName || event.serviceName || '系统'
    const last = groups[groups.length - 1]
    if (last && last.subject === subject) {
      last.items.push(event)
    } else {
      groups.push({
        subject,
        key: `${subject}-${index}`,
        projectId: event.projectId || null,
        serverId: event.serverId || null,
        items: [event],
      })
    }
  })
  return groups
}

/** 同一天内按主体分组的事件块（复用既有视觉与跳转） */
function SubjectGroups({ events, showSubject }) {
  const navigate = useNavigate()
  const groups = groupBySubject(events)
  return groups.map((group) => {
    const jump = () => {
      if (group.projectId) navigate('/projects', { state: { focus: group.projectId } })
      else if (group.serverId) navigate('/servers', { state: { focus: group.serverId } })
    }
    return (
      <div className="timeline__group" key={group.key}>
        {showSubject && group.subject !== '系统' ? (
          <div className="timeline__group-head">
            {group.projectId || group.serverId ? (
              <button type="button" className="timeline__group-name link" onClick={jump}>
                {group.subject}
              </button>
            ) : (
              <span className="timeline__group-name">{group.subject}</span>
            )}
            <span className="timeline__group-count">{group.items.length}</span>
          </div>
        ) : null}
        {group.items.map((event, index) => (
          <TimelineRow key={event.id || `${event.at}-${index}`} event={event} />
        ))}
      </div>
    )
  })
}

/** 把事件按日期分块（最近的天在前），每天一组 */
function groupByDay(events) {
  const map = new Map()
  for (const event of events) {
    const d = new Date(event.at)
    if (Number.isNaN(d.getTime())) continue
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
    if (!map.has(key)) map.set(key, [])
    map.get(key).push(event)
  }
  return [...map.entries()]
    .sort((a, b) => b[0].localeCompare(a[0]))
    .map(([key, items]) => ({ dayKey: key, dayLabel: formatDayLabel(key), events: items }))
}

/**
 * 事件流：时间 / 状态点 / 内容三列对齐。
 * 默认只按主体分组；groupByDate 时外层再按日期分块并加吸顶锚点，跨多天便于定位。
 */
export function EventTimeline({ events = [], maxHeight, showSubject = true, emptyText = '暂无事件', groupByDate = false }) {
  if (events.length === 0) return <EmptyState title={emptyText} />

  // groupByDate 关闭时，整段事件视为一个"日期组"，外层无锚点——与改动前行为完全一致
  const dayGroups = groupByDate ? groupByDay(events) : [{ dayKey: 'all', dayLabel: null, events }]

  return (
    <div className="timeline" style={maxHeight ? { maxHeight, overflowY: 'auto' } : undefined}>
      {dayGroups.map((day) => (
        <Fragment key={day.dayKey}>
          {day.dayLabel ? <div className="timeline__day">{day.dayLabel}</div> : null}
          <SubjectGroups events={day.events} showSubject={showSubject} />
        </Fragment>
      ))}
    </div>
  )
}

/** 项目详情里的时间线：只取这个项目的事件 */
export function ProjectTimeline({ projectId, limit = 20 }) {
  const { data, loading, error, reload } = useAsync(() => api.events({ projectId, limit }), { deps: [projectId, limit] })
  const navigate = useNavigate()

  if (loading && !data) return <Loading text="读取事件…" />
  if (error) return <ErrorNotice error={error} onRetry={() => reload().catch(() => {})} />
  const items = data.items || []
  return (
    <div className="project-timeline">
      <div className="row" style={{ justifyContent: 'space-between', marginBottom: 6 }}>
        <span className="footnote">生命周期事件 {items.length}</span>
        <button type="button" className="link" onClick={() => navigate('/timeline', { state: { projectId } })}>
          查看完整时间线
        </button>
      </div>
      <EventTimeline events={items} maxHeight={280} showSubject={false} emptyText="这个项目还没有状态变化。" />
    </div>
  )
}

/** 服务器详情的时间线标签：只取这台服务器的事件 */
export function ServerTimeline({ serverId, limit = 60 }) {
  const { data, loading, error, reload } = useAsync(() => api.events({ serverId, limit }), { deps: [serverId, limit] })

  if (loading && !data) return <Loading text="读取事件…" />
  if (error) return <ErrorNotice error={error} onRetry={() => reload().catch(() => {})} />
  return <EventTimeline events={data.items || []} showSubject={false} emptyText="这台服务器还没有状态变化。" />
}
