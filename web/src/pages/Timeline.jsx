import { useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { api } from '../api/client.js'
import { useAsync } from '../hooks/useAsync.js'
import { useToast } from '../hooks/useToast.jsx'
import { EventTimeline } from '../components/EventTimeline.jsx'
import { PageHint } from '../components/PageHint.jsx'
import { Button, Card, ConfirmDialog, EmptyState, ErrorNotice, SearchBox, SkeletonList, Tabs } from '../components/ui.jsx'

/**
 * 第六阶段：服务生命周期时间线页。
 * 事件只在"状态真的变化"时产生（启动 / 停止 / 异常退出 / 恢复 / 端口冲突或变化 / 发现新服务 / SSH 与 Docker 变化），
 * 因此这里看到的是变化历史，不是每秒快照。可按项目、服务器与事件类型筛选。
 */
export function TimelinePage() {
  const location = useLocation()
  const toast = useToast()
  const [projectId, setProjectId] = useState(location.state?.projectId || '')
  const [serverId, setServerId] = useState('')
  const [type, setType] = useState('all')
  const [query, setQuery] = useState('')
  const [pendingClear, setPendingClear] = useState(false)
  const [clearing, setClearing] = useState(false)

  const { data: projects } = useAsync(() => api.projects(), { deps: [] })
  const { data: servers } = useAsync(() => api.servers(), { deps: [] })
  const { data, loading, error, reload } = useAsync(
    () =>
      api.events({
        projectId: projectId || null,
        serverId: serverId || null,
        type: type === 'all' ? null : type,
        limit: 300,
      }),
    { deps: [projectId, serverId, type] },
  )

  useEffect(() => {
    if (location.state?.projectId) setProjectId(location.state.projectId)
  }, [location.state])

  const items = useMemo(() => {
    const list = data?.items || []
    const text = query.trim().toLowerCase()
    if (!text) return list
    return list.filter((event) =>
      [event.message, event.detail, event.projectName, event.serverName, event.serviceName, event.processName, event.port]
        .filter((value) => value !== null && value !== undefined)
        .some((value) => String(value).toLowerCase().includes(text)),
    )
  }, [data, query])

  // 降噪：默认只显示「有事件」的类型标签，0 条的不占位置；
  // 但如果用户正选中某个 0 条的类型，仍然保留它，否则会失去切回「全部」的退路。
  const typeOptions = useMemo(() => {
    const all = { value: 'all', label: '全部', count: data?.total ?? 0 }
    const list = (data?.typeOptions || []).map((item) => ({ value: item.value, label: item.label, count: item.count }))
    const visible = list.filter((item) => item.count > 0 || item.value === type)
    return [all, ...visible]
  }, [data, type])

  async function handleClear() {
    setClearing(true)
    try {
      const result = await api.clearEvents()
      toast.success('时间线已清空', `移除 ${result?.removed ?? 0} 条事件（当前状态指纹保留，不会重放成"刚刚变化"）`)
      setPendingClear(false)
      await reload()
    } catch (err) {
      toast.error('清空失败', err.message)
    } finally {
      setClearing(false)
    }
  }

  return (
    <div className="page">
      <div className="page__header">
        <div className="page__title">时间线</div>
        <div className="page__actions">
          <Button icon="refresh" loading={loading} onClick={() => reload().catch(() => {})}>
            刷新
          </Button>
          <Button variant="danger" icon="trash" onClick={() => setPendingClear(true)}>
            清空时间线
          </Button>
        </div>
      </div>

      {/* 每页一次性提示：新手落地第一眼就知道这页是干嘛的（见 PageHint） */}
      <PageHint id="timeline" icon="clock">
        启动、停止、报错、端口变化都会记在这。想不起「刚才动过什么」时，按项目或类型往回翻。
      </PageHint>

      <div className="card">
        <div className="toolbar">
          <select
            className="select"
            style={{ maxWidth: 260 }}
            value={projectId}
            onChange={(event) => {
              setProjectId(event.target.value)
              setServerId('')
            }}
          >
            <option value="">全部项目</option>
            {(projects || []).map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}（{project.port ?? '未记录端口'}）
              </option>
            ))}
          </select>
          <select
            className="select"
            style={{ maxWidth: 220 }}
            value={serverId}
            onChange={(event) => {
              setServerId(event.target.value)
              setProjectId('')
            }}
          >
            <option value="">全部服务器</option>
            {(servers || []).map((server) => (
              <option key={server.id} value={server.id}>
                {server.name}
              </option>
            ))}
          </select>
          <SearchBox value={query} onChange={setQuery} placeholder="按消息 / 进程 / 端口筛选…" width={240} />
          <div className="spacer" />
          <span className="footnote">
            共 {data?.total ?? 0} 条 · 本次返回 {items.length} 条
          </span>
        </div>
        <Tabs value={type} onChange={setType} options={typeOptions} />
      </div>

      {error ? <ErrorNotice error={error} onRetry={() => reload().catch(() => {})} /> : null}

      <Card flush>
        <div style={{ padding: 12 }}>
          {loading && !data ? (
            <SkeletonList rows={5} />
          ) : items.length === 0 ? (
            <EmptyState
              title={data?.total ? '没有匹配的事件' : '还没有事件'}
              hint={data?.total ? '换个筛选条件试试。' : '启动或停止一个项目、做一次 SSH 检测，这里就会记录变化。'}
            />
          ) : (
            <EventTimeline events={items} groupByDate />
          )}
        </div>
      </Card>

      <ConfirmDialog
        open={pendingClear}
        title="清空事件时间线"
        message="只会删除已记录的事件列表，各项目的当前状态指纹会保留，因此清空后不会把现有服务重放成「刚刚启动」。"
        confirmText="确认清空"
        loading={clearing}
        onClose={() => setPendingClear(false)}
        onConfirm={handleClear}
      />
    </div>
  )
}
