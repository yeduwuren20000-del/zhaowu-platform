import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { api } from '../api/client.js'
import { useAsync, usePolling } from '../hooks/useAsync.js'
import { useServerActions } from '../hooks/useServerActions.js'
import { useToast } from '../hooks/useToast.jsx'
import { AppFormModal, ServerFormModal } from '../components/forms.jsx'
import { ServerRow } from '../components/ServerRow.jsx'
import { ServerDetail } from '../components/ServerDetail.jsx'
import { AutoMonitorPanel } from '../components/AutoMonitorPanel.jsx'
import { PageHint } from '../components/PageHint.jsx'
import { Button, ConfirmDialog, EmptyState, ErrorNotice, SearchBox, SkeletonList, Switch, Tabs } from '../components/ui.jsx'
import { RES_OVER_THRESHOLD, serverMetricPercent } from '../utils/format.js'

export function ServersPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const toast = useToast()
  const { data: servers, loading, error, reload } = useAsync(() => api.servers(), { deps: [] })
  const actions = useServerActions(reload)

  const [query, setQuery] = useState('')
  const [filter, setFilter] = useState('all')
  // 默认开启：数据自己会保鲜，用户不必惦记"要不要刷新"。
  // 代价很低——后端 staleMs 去重，且只采"过期"的服务器。
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [selectedId, setSelectedId] = useState(null)
  const [tab, setTab] = useState('overview')
  const [serverForm, setServerForm] = useState({ open: false, initial: null })
  const [appForm, setAppForm] = useState({ open: false, server: null, initial: null })
  const [submitting, setSubmitting] = useState(false)
  const [pendingDelete, setPendingDelete] = useState(null)
  const [pendingAppDelete, setPendingAppDelete] = useState(null)
  const [deleting, setDeleting] = useState(false)
  // 来自首页资源卡片的钻取：只显示某指标超标的服务器（null 表示不钻取）
  const [over, setOver] = useState(null)
  // 多选模式：勾选若干台后批量 SSH 检测
  const [selectMode, setSelectMode] = useState(false)
  const [selectedIds, setSelectedIds] = useState(() => new Set())

  useEffect(() => {
    const state = location.state
    if (!state || !servers) return
    if (state.create) setServerForm({ open: true, initial: null })
    if (state.addAppFor) {
      const server = servers.find((item) => item.id === state.addAppFor)
      if (server) setAppForm({ open: true, server, initial: null })
    }
    if (state.focus) {
      setSelectedId(state.focus)
      window.setTimeout(() => {
        document.querySelector(`[data-server-id="${state.focus}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }, 220)
    }
    if (state.over) {
      setOver(state.over)
      setFilter('all')
    }
    if (state.q) setQuery(state.q)
    navigate(location.pathname, { replace: true, state: null })
  }, [location.state, location.pathname, navigate, servers])

  // 打开自动刷新时，只做"过期数据"的低频采集（60 秒），避免频繁登录服务器
  usePolling(
    () => {
      api
        .sshProbeAll(false, 60000)
        .then((result) => (result?.probed > 0 ? reload() : null))
        .catch(() => {})
    },
    60000,
    autoRefresh,
  )

  // 首次进入：若存在"从没采集过 / 数据很旧"的服务器，静默采一次。
  // 目的：打开页面就有数据，不用先想"我是不是得点一下 SSH 检测"。
  // 后端 staleMs=120s 保证不会连着刷新；同一浏览器会话只做一次（probedRef）。
  const probedOnOpenRef = useRef(false)
  useEffect(() => {
    if (probedOnOpenRef.current || !servers || servers.length === 0) return
    const stale = servers.some((server) => {
      if (server.monitorEnabled === false) return false
      const at = server.monitoredAt || server.monitor?.at
      return !at || Date.now() - Date.parse(at) > 120000
    })
    if (!stale) return
    probedOnOpenRef.current = true
    api
      .sshProbeAll(false, 120000)
      .then((result) => (result?.probed > 0 ? reload() : null))
      .catch(() => {})
  }, [servers, reload])

  const counts = useMemo(() => {
    const list = servers || []
    return {
      all: list.length,
      online: list.filter((server) => server.monitor?.online).length,
      offline: list.filter((server) => server.monitor?.at && !server.monitor.online).length,
      unregistered: list.filter((server) => (server.auditSummary?.listeningNotRecorded || 0) > 0).length,
    }
  }, [servers])

  // 首页资源卡片钻取：筛出该指标 ≥ 阈值的、在线且有采集数据的服务器
  const overServers = useMemo(() => {
    if (!over) return null
    return (servers || []).filter(
      (server) =>
        server.monitor?.online &&
        server.resources &&
        (serverMetricPercent(server, over) ?? -1) >= RES_OVER_THRESHOLD,
    )
  }, [servers, over])

  const filtered = useMemo(() => {
    const text = query.trim().toLowerCase()
    // 钻取模式下只看超标服务器，标签页筛选让位给钻取结果
    const list = overServers || servers || []
    return list.filter((server) => {
      if (!over) {
        if (filter === 'online' && !server.monitor?.online) return false
        if (filter === 'offline' && !(server.monitor?.at && !server.monitor.online)) return false
        if (filter === 'unregistered' && !((server.auditSummary?.listeningNotRecorded || 0) > 0)) return false
      }
      if (!text) return true
      return [server.name, server.host, server.os, server.remark, server.sshPort, server.username]
        .filter((value) => value !== null && value !== undefined)
        .some((value) => String(value).toLowerCase().includes(text))
    })
  }, [servers, query, filter, overServers])

  // 没有选中项时默认展开第一台，详情页始终有内容
  const selected = useMemo(() => filtered.find((server) => server.id === selectedId) || filtered[0] || null, [filtered, selectedId])

  async function handleServerSubmit(payload) {
    setSubmitting(true)
    try {
      if (serverForm.initial?.id) {
        await api.updateServer(serverForm.initial.id, payload)
        toast.success('服务器已更新', payload.name)
      } else {
        await api.createServer(payload)
        toast.success('服务器已新增', `${payload.name}（${payload.host}）`)
      }
      setServerForm({ open: false, initial: null })
      await reload()
    } catch (err) {
      toast.error('保存失败', err.message)
    } finally {
      setSubmitting(false)
    }
  }

  async function handleAppSubmit(payload) {
    if (!appForm.server) return
    setSubmitting(true)
    try {
      if (appForm.initial?.id) {
        await api.updateServerApp(appForm.server.id, appForm.initial.id, payload)
        toast.success('应用记录已更新', payload.name)
      } else {
        await api.createServerApp(appForm.server.id, payload)
        toast.success('应用记录已新增', `${payload.name}${payload.port ? ` · 端口 ${payload.port}` : ''}`)
      }
      setAppForm({ open: false, server: null, initial: null })
      await reload()
    } catch (err) {
      toast.error('保存失败', err.message)
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDeleteServer() {
    if (!pendingDelete) return
    setDeleting(true)
    try {
      await api.deleteServer(pendingDelete.id)
      toast.success('服务器记录已删除', pendingDelete.name)
      setPendingDelete(null)
      await reload()
    } catch (err) {
      toast.error('删除失败', err.message)
    } finally {
      setDeleting(false)
    }
  }

  async function handleDeleteApp() {
    if (!pendingAppDelete) return
    setDeleting(true)
    try {
      await api.deleteServerApp(pendingAppDelete.server.id, pendingAppDelete.app.id)
      toast.success('应用记录已删除', pendingAppDelete.app.name)
      setPendingAppDelete(null)
      await reload()
    } catch (err) {
      toast.error('删除失败', err.message)
    } finally {
      setDeleting(false)
    }
  }

  async function sshProbeAll() {
    const result = await actions.sshProbeAll()
    if (result?.failed > 0) setFilter('all')
  }

  function toggleSelect(id) {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  }

  async function sshProbeSelected() {
    const ids = [...selectedIds]
    if (ids.length === 0) return
    const result = await actions.sshProbeServers(ids)
    setSelectedIds(new Set())
    setSelectMode(false)
    if (result?.failed > 0) setFilter('all')
  }

  return (
    <div className="page">
      <div className="page__header">
        <div className="page__title">服务器</div>
        <div className="page__actions">
          <Switch checked={autoRefresh} onChange={setAutoRefresh} label="页面轮询(60s)" />
          <Button icon="refresh" loading={loading} onClick={() => reload().catch(() => {})}>
            刷新
          </Button>
          <Button variant="primary" icon="wifi" loading={actions.isBusy('all:ssh')} onClick={sshProbeAll}>
            全部 SSH 检测
          </Button>
          <Button
            icon={selectMode ? 'checkSquare' : 'square'}
            variant={selectMode ? 'primary' : undefined}
            onClick={() => {
              setSelectMode((value) => !value)
              setSelectedIds(new Set())
            }}
          >
            {selectMode ? '退出选择' : '选择'}
          </Button>
          <Button icon="plus" onClick={() => setServerForm({ open: true, initial: null })}>
            新增服务器
          </Button>
        </div>
      </div>

      {/* 每页一次性提示：新手落地第一眼就知道这页是干嘛的（见 PageHint） */}
      <PageHint id="servers" icon="server">
        添加 SSH 服务器后，工作台只读采集 CPU / 内存 / 磁盘 / 监听端口，并与登记的 APP 做端口核对。密码走环境变量不落盘，私钥只存路径。
      </PageHint>

      <AutoMonitorPanel onChanged={() => reload().catch(() => {})} />

      <div className="toolbar">
        <Tabs
          value={filter}
          onChange={setFilter}
          options={[
            { value: 'all', label: '全部', count: counts.all },
            { value: 'online', label: '在线', count: counts.online },
            { value: 'offline', label: '离线', count: counts.offline },
            { value: 'unregistered', label: '未登记端口', count: counts.unregistered },
          ].filter((item) => item.value === 'all' || item.count > 0 || item.value === filter)}
        />
        <SearchBox value={query} onChange={setQuery} placeholder="搜索服务器 / IP / 应用 / 路径…" width={280} />
        <div className="spacer" />
        <span className="footnote">
          在线 {counts.online}/{counts.all}
        </span>
      </div>

      {/* 首页资源卡片钻取：只列出某指标超标的服务器，可一键清除回到全部 */}
      {over ? (
        <div className="over-banner">
          <span>
            显示 <b>{(overServers || []).length}</b> 台「
            {over === 'cpu' ? 'CPU 占用偏高' : over === 'mem' ? '内存占用偏高' : '磁盘占用偏高'}」的服务器
          </span>
          <Button size="sm" icon="x" onClick={() => setOver(null)}>
            清除筛选
          </Button>
        </div>
      ) : null}

      {/* 多选模式：勾选若干台后批量 SSH 检测 */}
      {selectMode ? (
        <div className="select-bar">
          <span>
            已选 <b>{selectedIds.size}</b> 台
          </span>
          <div className="spacer" />
          <Button size="sm" icon="wifi" variant="primary" loading={actions.isBusy('all:ssh')} disabled={selectedIds.size === 0} onClick={sshProbeSelected}>
            对选中 SSH 检测
          </Button>
          <Button size="sm" icon="x" onClick={() => { setSelectedIds(new Set()); setSelectMode(false) }}>
            取消
          </Button>
        </div>
      ) : null}

      {error ? <ErrorNotice error={error} onRetry={() => reload().catch(() => {})} /> : null}

      {loading && !servers ? (
        <div className="card">
          <SkeletonList rows={4} />
        </div>
      ) : filtered.length === 0 ? (
        <div className="card card--empty">
          <EmptyState
            title={over ? '没有该指标超标的服务器' : query || filter !== 'all' ? '没有匹配的服务器' : '还没有添加服务器'}
            hint={
              over
                ? '当前在线服务器该指标都在正常范围内。'
                : query || filter !== 'all'
                  ? '换个关键字或筛选条件试试。'
                  : '添加服务器后，工作台会通过 SSH 只读采集 CPU / 内存 / 磁盘 / 监听端口，并与你登记的 APP 做端口核对。'
            }
            action={
              query || filter !== 'all' ? null : (
                <div className="row" style={{ gap: 8, justifyContent: 'center' }}>
                  <Button variant="primary" icon="plus" onClick={() => setServerForm({ open: true, initial: null })}>
                    添加服务器
                  </Button>
                  <Button icon="terminal" onClick={() => navigate('/settings')}>
                    凭据怎么配？
                  </Button>
                </div>
              )
            }
          />
        </div>
      ) : (
        <>
          <div className="server-list">
            {filtered.map((server) => (
              <ServerRow
                key={server.id}
                server={server}
                selected={server.id === selectedId}
                busy={actions.busy}
                selectMode={selectMode}
                checked={selectedIds.has(server.id)}
                onToggleSelect={toggleSelect}
                onSelect={setSelectedId}
                onSshProbe={actions.sshProbe}
                onTcpProbe={actions.tcpProbe}
                onEditServer={(target) => setServerForm({ open: true, initial: target })}
                onDeleteServer={setPendingDelete}
              />
            ))}
          </div>

          {selected ? (
            <div className="card" style={{ marginTop: 12 }}>
              <ServerDetail
                server={selected}
                tab={tab}
                onTab={setTab}
                busy={actions.busy}
                onSshProbe={actions.sshProbe}
                onProbeApp={actions.probeApp}
                onAddApp={(target) => setAppForm({ open: true, server: target, initial: null })}
                onEditApp={(target, app) => setAppForm({ open: true, server: target, initial: app })}
                onDeleteApp={(target, app) => setPendingAppDelete({ server: target, app })}
                onEditServer={(target) => setServerForm({ open: true, initial: target })}
                onRegisterPort={(target, preset) => setAppForm({ open: true, server: target, initial: { ...preset } })}
              />
            </div>
          ) : null}

          <div className="footnote" style={{ marginTop: 10 }}>
            SSH 只读采集：一台服务器一条固定脚本读取系统指标与真实监听端口（ss -lntup），日志只读配置里登记的路径；密码走环境变量，私钥只存路径。
          </div>
        </>
      )}

      <ServerFormModal
        open={serverForm.open}
        initial={serverForm.initial}
        submitting={submitting}
        onClose={() => setServerForm({ open: false, initial: null })}
        onSubmit={handleServerSubmit}
      />

      <AppFormModal
        open={appForm.open}
        initial={appForm.initial}
        serverName={appForm.server?.name}
        submitting={submitting}
        onClose={() => setAppForm({ open: false, server: null, initial: null })}
        onSubmit={handleAppSubmit}
      />

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title={`删除服务器「${pendingDelete?.name || ''}」`}
        message="会同时删除这台服务器下的所有 APP 记录与监控数据，不影响服务器本身。"
        loading={deleting}
        onClose={() => setPendingDelete(null)}
        onConfirm={handleDeleteServer}
      />

      <ConfirmDialog
        open={Boolean(pendingAppDelete)}
        title={`删除应用「${pendingAppDelete?.app?.name || ''}」`}
        message={`将从「${pendingAppDelete?.server?.name || ''}」的资产记录中移除这条 APP。`}
        loading={deleting}
        onClose={() => setPendingAppDelete(null)}
        onConfirm={handleDeleteApp}
      />
    </div>
  )
}
