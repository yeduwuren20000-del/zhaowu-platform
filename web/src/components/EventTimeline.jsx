import { useNavigate } from 'react-router-dom'
import { api } from '../api/client.js'
import { useAsync } from '../hooks/useAsync.js'
import { EmptyState, ErrorNotice, Loading } from './ui.jsx'
import { eventDotColor, eventMeta, formatClock, formatDateTime } from '../utils/format.js'

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

/** 事件流：时间 / 状态点 / 内容三列对齐，同一主体的连续事件归为一组 */
export function EventTimeline({ events = [], maxHeight, showSubject = true, emptyText = '暂无事件' }) {
  const navigate = useNavigate()

  if (events.length === 0) return <EmptyState title={emptyText} />

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

  return (
    <div className="timeline" style={maxHeight ? { maxHeight, overflowY: 'auto' } : undefined}>
      {groups.map((group) => {
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
      })}
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
