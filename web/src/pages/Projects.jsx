import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { api } from '../api/client.js'
import { useAsync, usePolling } from '../hooks/useAsync.js'
import { useProjectActions } from '../hooks/useProjectActions.js'
import { useToast } from '../hooks/useToast.jsx'
import { ProjectCard } from '../components/ProjectCard.jsx'
import { ProjectFormModal } from '../components/forms.jsx'
import { DiscoveryPanel } from '../components/DiscoveryPanel.jsx'
import { ProjectGroupCard, ServiceList } from '../components/ServiceList.jsx'
import { PageHint } from '../components/PageHint.jsx'
import { ProjectResources } from '../components/ProjectResources.jsx'
import { ProjectTimeline } from '../components/EventTimeline.jsx'
import { Icon } from '../components/Icons.jsx'
import { Button, ConfirmDialog, EmptyState, ErrorNotice, Modal, Notice, SearchBox, SkeletonList, Switch, Tabs } from '../components/ui.jsx'

const FILTERS = [
  { value: 'all', label: '全部' },
  { value: 'running', label: '运行中' },
  { value: 'stopped', label: '已停止' },
  { value: 'pending', label: '待登记' },
  { value: 'conflict', label: '冲突' },
]

/**
 * 本地项目页（第五阶段）：按 **项目目录** 聚合展示。
 *   - 已登记项目：项目卡片 + 子服务列表（同目录的多个进程/端口）
 *   - 未登记的项目组：一个卡片，可一次登记（只创建一个项目）
 *   - 未识别目录的独立服务：单独分组，不与任何项目合并
 */
export function ProjectsPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const toast = useToast()

  const { data: projects, loading: projectsLoading, error: projectsError, reload: reloadProjects } = useAsync(() => api.projects(), { deps: [] })
  const { data: grouping, loading: groupsLoading, error: groupsError, reload: reloadGroups } = useAsync(() => api.discoveryGroups(), { deps: [] })
  // 第七阶段：登记项目 ↔ 远程服务器关联时要用服务器清单
  const { data: servers } = useAsync(() => api.servers(), { deps: [] })
  const actions = useProjectActions(reloadProjects)

  const reload = useCallback(async () => {
    await Promise.all([reloadProjects(), reloadGroups()])
  }, [reloadProjects, reloadGroups])

  const [filter, setFilter] = useState('all')
  const [query, setQuery] = useState('')
  const [autoRefresh, setAutoRefresh] = useState(true)
  const [expanded, setExpanded] = useState({})
  // 「未识别目录的服务」默认折叠：这类候选在真实机器上常有几十个
  const [looseExpanded, setLooseExpanded] = useState(false)
  const [busy, setBusy] = useState({})
  const [formOpen, setFormOpen] = useState(false)
  const [editing, setEditing] = useState(null)
  const [submitting, setSubmitting] = useState(false)
  const [pendingDelete, setPendingDelete] = useState(null)
  const [deleting, setDeleting] = useState(false)
  const [stopThenDeleting, setStopThenDeleting] = useState(false)
  const [discoveryOpen, setDiscoveryOpen] = useState(false)
  // 启动失败诊断：projectId -> diagnosis。常驻到下次启动成功 / 停止 / 保存 / 手动收起
  const [failures, setFailures] = useState({})
  const clearFailure = useCallback((id) => {
    setFailures((prev) => {
      if (!prev[id]) return prev
      const next = { ...prev }
      delete next[id]
      return next
    })
  }, [])

  /**
   * 启动 / 重启的包装：actions 只负责弹 toast，这里把诊断结果接住——
   * 失败时写进 failures 让卡片显示横幅，成功时清掉旧横幅（上次的失败不该留着吓人）。
   */
  const handleStart = async (project) => {
    const data = await actions.start(project)
    const result = data?.result
    if (!result) return
    if (result.diagnosis) setFailures((prev) => ({ ...prev, [project.id]: result.diagnosis }))
    else clearFailure(project.id)
  }
  const handleRestart = async (project) => {
    const data = await actions.restart(project)
    const result = data?.result?.started
    if (!result) return
    if (result.diagnosis) setFailures((prev) => ({ ...prev, [project.id]: result.diagnosis }))
    else clearFailure(project.id)
  }
  const handleStop = async (project) => {
    await actions.stop(project)
    clearFailure(project.id)
  }

  useEffect(() => {
    const state = location.state
    if (!state) return
    if (state.create) {
      setEditing(null)
      setFormOpen(true)
    }
    if (state.edit && projects) {
      const target = projects.find((project) => project.id === state.edit)
      if (target) {
        setEditing(target)
        setFormOpen(true)
      }
    }
    if (state.q) setQuery(state.q)
    if (state.discovery) setDiscoveryOpen(true)
    if (state.focus) {
      setExpanded((prev) => ({ ...prev, [state.focus]: true }))
      window.setTimeout(() => {
        document.querySelector(`[data-project-id="${state.focus}"]`)?.scrollIntoView({ behavior: 'smooth', block: 'center' })
      }, 260)
    }
    navigate(location.pathname, { replace: true, state: null })
  }, [location.state, location.pathname, navigate, projects])

  usePolling(() => reload().catch(() => {}), 20000, autoRefresh)

  const projectById = useMemo(() => new Map((projects || []).map((project) => [project.id, project])), [projects])
  const groups = grouping?.groups || []
  const loose = grouping?.loose || []
  const systemServices = grouping?.system || []

  const items = useMemo(
    () =>
      groups.map((group) => ({
        id: group.id,
        group,
        project: group.registeredProjectId ? projectById.get(group.registeredProjectId) || null : null,
      })),
    [groups, projectById],
  )

  const counts = useMemo(
    () => ({
      all: items.length,
      running: items.filter((item) => item.group.status === 'all-running').length,
      stopped: items.filter((item) => item.group.status === 'all-stopped').length,
      pending: items.filter((item) => item.group.registrationState !== 'registered').length,
      conflict: items.filter((item) => item.group.status === 'conflict').length,
      registered: items.filter((item) => item.group.registrationState === 'registered').length,
      subServices: groups.reduce((sum, group) => sum + (group.summary?.services || 0), 0),
    }),
    [items, groups],
  )

  const filtered = useMemo(() => {
    const text = query.trim().toLowerCase()
    return items.filter((item) => {
      const group = item.group
      if (filter === 'running' && group.status !== 'all-running') return false
      if (filter === 'stopped' && group.status !== 'all-stopped') return false
      if (filter === 'pending' && group.registrationState === 'registered') return false
      if (filter === 'conflict' && group.status !== 'conflict') return false
      if (!text) return true
      return [group.name, group.projectDir, group.registeredProjectName, ...(group.summary?.portList || [])]
        .filter((value) => value !== null && value !== undefined)
        .some((value) => String(value).toLowerCase().includes(text))
    })
  }, [items, filter, query])

  async function withBusy(key, fn, messages) {
    setBusy((prev) => ({ ...prev, [key]: true }))
    try {
      const data = await fn()
      if (messages?.success) toast.success(messages.success, data?.project?.name || messages.detail)
      await reload()
      return data
    } catch (error) {
      toast.error(messages?.error || '操作失败', error.message)
      return null
    } finally {
      setBusy((prev) => {
        const next = { ...prev }
        delete next[key]
        return next
      })
    }
  }

  const registerGroup = (group) =>
    withBusy(`grp:${group.id}`, () => api.discoveryRegisterGroup(group.id), {
      success: `已登记（合并 ${group.summary.live} 个服务）`,
      error: '登记项目组失败',
    })

  const ignoreGroupServices = (group) =>
    withBusy(
      `grpign:${group.id}`,
      async () => {
        const fingerprints = group.services.filter((service) => service.live && service.key).map((service) => service.key)
        return api.discoveryIgnore(fingerprints, '整组忽略')
      },
      { success: '已忽略该目录下的服务（后续扫描不再提示）', error: '忽略失败' },
    )

  const associateService = (service, projectId) =>
    withBusy(`assoc:${service.key}`, () => api.discoveryAssociate(service.key, projectId), {
      success: '已关联为子服务',
      error: '关联失败',
    })

  const ignoreService = (service) =>
    withBusy(`ign:${service.key}`, () => api.discoveryIgnore([service.key], '子服务忽略'), {
      success: '已忽略这个子服务',
      error: '忽略失败',
    })

  const dissociateService = (service) =>
    withBusy(`dissoc:${service.id}`, () => api.discoveryDissociate(service.registeredProjectId, service.id), {
      success: '已解除子服务关联',
      error: '解除失败',
    })

  const registerSingle = (service) =>
    withBusy(`reg:${service.key}`, () => api.discoveryRegister(service.key), { success: '已登记为独立项目', error: '登记失败' })

  // ---- 第七阶段：项目 ↔ 远程服务器的显式关联（端口对不上时的兜底） ----
  const [linkPicker, setLinkPicker] = useState(null) // { projectId, groupId, candidates: [...] }

  const openLinkPicker = (group) => {
    const projectId = group.registeredProjectId
    if (!projectId) return
    // 候选 = 所有服务器（去掉已经关联过的），供用户挑一个
    const linked = new Set((group.project?.remoteLinks || []).map((link) => link.serverId))
    const candidates = (servers || []).filter((item) => !linked.has(item.id))
    if (candidates.length === 0) {
      toast.warn('没有可关联的服务器', '所有服务器都已关联到该项目')
      return
    }
    setLinkPicker({ projectId, groupId: group.id, candidates })
  }

  const confirmLink = async (serverId) => {
    if (!linkPicker) return
    await withBusy(`link:${linkPicker.projectId}:${serverId}`, () => api.discoveryProjectLink(linkPicker.projectId, serverId), {
      success: '已登记项目与服务器的关联',
      error: '关联失败',
    })
    setLinkPicker(null)
  }

  const unlinkServer = async (group) => {
    const link = (group.project?.remoteLinks || [])[0]
    if (!link) return
    await withBusy(`unlink:${group.id}`, () => api.discoveryProjectLink(link.projectId || group.registeredProjectId, link.serverId, { remove: true }), {
      success: '已取消手工关联',
      error: '取消失败',
    })
  }

  async function handleSubmit(payload) {
    setSubmitting(true)
    try {
      if (editing?.id) {
        await api.updateProject(editing.id, payload)
        clearFailure(editing.id)
        toast.success('项目已更新', payload.name)
      } else {
        await api.createProject(payload)
        toast.success('项目已新增', payload.name)
      }
      setFormOpen(false)
      setEditing(null)
      await reload()
    } catch (err) {
      toast.error('保存失败', err.message)
    } finally {
      setSubmitting(false)
    }
  }

  async function handleDelete() {
    if (!pendingDelete) return
    setDeleting(true)
    try {
      await api.deleteProject(pendingDelete.id)
      toast.success('项目记录已删除', pendingDelete.name)
      setPendingDelete(null)
      await reload()
    } catch (err) {
      toast.error('删除失败', err.message)
    } finally {
      setDeleting(false)
    }
  }

  /**
   * 「先停止，再删除」：删运行中的项目只会删记录、留下占端口的孤儿进程，
   * 新手十有八九会踩这个坑（之后同端口全报冲突）——给一条不用先想明白的稳妥路径。
   */
  async function handleStopThenDelete() {
    if (!pendingDelete) return
    setStopThenDeleting(true)
    try {
      await actions.stop(pendingDelete)
      await api.deleteProject(pendingDelete.id)
      clearFailure(pendingDelete.id)
      toast.success('已停止并删除', pendingDelete.name)
      setPendingDelete(null)
      await reload()
    } catch (err) {
      toast.error('操作失败', err.message)
    } finally {
      setStopThenDeleting(false)
    }
  }

  const error = projectsError || groupsError

  return (
    <div className="page">
      <div className="page__header">
        <div className="page__title">本地项目</div>
        <div className="page__actions">
          <Switch checked={autoRefresh} onChange={setAutoRefresh} label="自动刷新" />
          <Button icon="refresh" loading={projectsLoading || groupsLoading} onClick={() => reload().catch(() => {})}>
            刷新
          </Button>
          <Button icon="search" onClick={() => setDiscoveryOpen((prev) => !prev)}>
            自动发现
          </Button>
          <Button
            variant="primary"
            icon="plus"
            onClick={() => {
              setEditing(null)
              setFormOpen(true)
            }}
          >
            新增项目
          </Button>
        </div>
      </div>

      {/* 每页一次性提示：新手落地第一眼就知道这页是干嘛的（见 PageHint） */}
      <PageHint id="projects" icon="folder" action={{ label: '自动发现', onClick: () => setDiscoveryOpen(true) }}>
        把本机项目登记进来，就能一键启停、看端口和日志。不知道有哪些在跑？点「自动发现」扫描监听端口，按目录自动聚成项目组。
      </PageHint>

      {discoveryOpen ? <DiscoveryPanel onClose={() => setDiscoveryOpen(false)} onRegistered={reload} /> : null}

      <div className="toolbar">
        <Tabs
          value={filter}
          onChange={setFilter}
          options={FILTERS.map((item) => ({ ...item, count: counts[item.value] })).filter(
            // 降噪：0 条的筛选不占位置；但正选中它时要保留，否则无法切回「全部」
            (item) => item.value === 'all' || item.count > 0 || item.value === filter,
          )}
        />
        <SearchBox value={query} onChange={setQuery} placeholder="按项目名 / 目录 / 端口筛选…" width={260} />
        <div className="spacer" />
        <span className="footnote">
          项目组 {counts.all} · 已登记 {counts.registered} · 待登记 {counts.pending} · 子服务 {counts.subServices}
        </span>
      </div>

      {error ? <ErrorNotice error={error} onRetry={() => reload().catch(() => {})} /> : null}

      {/* 系统进程提示：折叠成一行，放工具栏下方，归属明确，不再孤零零飘在页脚 */}
      {systemServices.length > 0 ? (
        <div className="inline-hint">
          <Icon name="shield" size={13} />
          <span>
            另有 {systemServices.length} 个系统进程在监听（已自动过滤，不计入项目）
          </span>
        </div>
      ) : null}

      {!grouping ? (
        <div className="card">
          <SkeletonList rows={4} />
        </div>
      ) : (
        <>
          <div className="stack">
            {filtered.length === 0 ? (
              <div className="card card--empty">
                <EmptyState
                  title={items.length === 0 ? '还没有项目' : '没有匹配的项目'}
                  hint={
                    items.length === 0
                      ? '把本机在跑的项目登记进来，之后就能一键启动 / 停止、看端口占用和日志。'
                      : '换个关键字或筛选条件试试。'
                  }
                  action={
                    items.length === 0 ? (
                      <div className="row" style={{ gap: 8, justifyContent: 'center' }}>
                        <Button variant="primary" icon="search" onClick={() => setDiscoveryOpen(true)}>
                          自动发现本机服务
                        </Button>
                        <Button icon="plus" onClick={() => { setEditing(null); setFormOpen(true) }}>
                          手动新增
                        </Button>
                      </div>
                    ) : null
                  }
                />
              </div>
            ) : null}

            {filtered.map((item) => {
              const group = item.group
              if (item.project) {
                const isOpen = Boolean(expanded[group.id])
                return (
                  <div key={group.id} data-project-id={item.project.id} className="group-card">
                    <ProjectCard
                      project={item.project}
                      action={actions.actionOf(item.project.id)}
                      onStart={handleStart}
                      onStop={handleStop}
                      onRestart={handleRestart}
                      onOpenDir={actions.openDir}
                      onOpenUrl={actions.openUrl}
                      onCopyUrl={actions.copyUrl}
                      onLog={(project) => navigate('/logs', { state: { source: `project:${project.id}` } })}
                      onNavigate={(target) => navigate(target.to, { state: target.state })}
                      failure={failures[item.project.id] || null}
                      onDismissFailure={clearFailure}
                      onEdit={(project) => {
                        setEditing(project)
                        setFormOpen(true)
                      }}
                      onDelete={setPendingDelete}
                      serviceSummary={group.summary}
                      groupStatus={{ status: group.status, tone: group.statusTone }}
                      expanded={isOpen}
                      onToggleExpand={() => setExpanded((prev) => ({ ...prev, [group.id]: !prev[group.id] }))}
                    />
                    {isOpen ? (
                      <div className="group-card__body">
                        {group.conflicts?.length ? (
                          <Notice tone="error" icon="alert">
                            {group.conflicts.map((conflict) => (
                              <div key={`${conflict.port}-${conflict.type}`}>{conflict.message}</div>
                            ))}
                          </Notice>
                        ) : null}
                        <ServiceList
                          services={group.services}
                          busy={busy}
                          onAssociate={(service) => associateService(service, item.project.id)}
                          onIgnore={ignoreService}
                          onDissociate={dissociateService}
                          onRegisterSingle={registerSingle}
                          onEditRegister={() => setDiscoveryOpen(true)}
                          emptyText="这个项目下的服务当前都没有在监听。"
                        />
                        <ProjectResources
                          resources={group.resources}
                          loading={groupsLoading}
                          onLinkServer={() => openLinkPicker(group)}
                          onUnlink={() => unlinkServer(group)}
                        />
                        <ProjectTimeline projectId={item.project.id} />
                      </div>
                    ) : null}
                  </div>
                )
              }

              return (
                <ProjectGroupCard
                  key={group.id}
                  group={group}
                  expanded={Boolean(expanded[group.id])}
                  onToggle={() => setExpanded((prev) => ({ ...prev, [group.id]: !prev[group.id] }))}
                  busy={busy}
                  onRegisterGroup={registerGroup}
                  onIgnoreGroup={ignoreGroupServices}
                  onRegisterSingle={registerSingle}
                  onEditRegister={() => setDiscoveryOpen(true)}
                  onIgnoreService={ignoreService}
                />
              )
            })}
          </div>

          {loose.length > 0 ? (
            <div className="card" style={{ marginTop: 16 }}>
              <header className="card__header">
                <div className="card__title">
                  <button
                    type="button"
                    className="card__toggle"
                    aria-expanded={looseExpanded}
                    onClick={() => setLooseExpanded((prev) => !prev)}
                  >
                    <Icon name={looseExpanded ? 'chevronDown' : 'chevronRight'} size={13} />
                    未识别目录的服务
                  </button>
                </div>
                <div className="card__actions">
                  <span className="status-word muted">
                    {loose.length} 组 · {loose.reduce((sum, group) => sum + group.services.length, 0)} 个服务
                  </span>
                  <Button size="sm" icon="search" onClick={() => setDiscoveryOpen(true)}>
                    去登记
                  </Button>
                </div>
              </header>
              {/* 默认折叠：真实机器上这类候选常有几十个（实测 56 行），
                  默认铺开会把已登记的项目挤到视口之外。按需渲染，与其它分组卡交互一致。 */}
              {looseExpanded ? (
                <div className="card__body">
                  {loose.map((group) => (
                    <div key={group.id} style={{ marginBottom: 12 }}>
                      <div className="row" style={{ gap: 8, marginBottom: 4 }}>
                        <span className="group-card__name">{group.name}</span>
                        <span className="tech muted">
                          {group.summary.portList.join(' ') || '—'} · {group.summary.processes} 进程
                        </span>
                      </div>
                      <ServiceList
                        services={group.services}
                        busy={busy}
                        onIgnore={ignoreService}
                        onRegisterSingle={registerSingle}
                        onEditRegister={() => setDiscoveryOpen(true)}
                        compact
                      />
                    </div>
                  ))}
                </div>
              ) : null}
            </div>
          ) : null}

          {/* 项目很少时补一段引导：既填掉大片空白，也告诉新用户下一步能做什么 */}
          {filtered.length > 0 && filtered.length <= 2 ? (
            <div className="card onboarding">
              <div className="card__title">
                <Icon name="layers" size={15} style={{ color: 'var(--accent)' }} />
                还能做这些
              </div>
              <div className="onboarding__grid">
                <button type="button" className="onboarding__item" onClick={() => setDiscoveryOpen(true)}>
                  <Icon name="search" size={16} />
                  <span className="onboarding__title">自动发现本机服务</span>
                  <span className="onboarding__desc">扫描监听端口，按目录聚合成项目组，不用一个个手填</span>
                </button>
                <button type="button" className="onboarding__item" onClick={() => { setEditing(null); setFormOpen(true) }}>
                  <Icon name="plus" size={16} />
                  <span className="onboarding__title">手动新增项目</span>
                  <span className="onboarding__desc">已知目录和启动命令时，直接登记并一键启停</span>
                </button>
                <button type="button" className="onboarding__item" onClick={() => navigate('/ports')}>
                  <Icon name="ports" size={16} />
                  <span className="onboarding__title">查看端口占用</span>
                  <span className="onboarding__desc">哪些端口被谁占了，一眼看清，避免启动时撞端口</span>
                </button>
              </div>
            </div>
          ) : null}
        </>
      )}

      <ProjectFormModal
        open={formOpen}
        initial={editing}
        submitting={submitting}
        onClose={() => {
          setFormOpen(false)
          setEditing(null)
        }}
        onSubmit={handleSubmit}
      />

      <ConfirmDialog
        open={Boolean(pendingDelete)}
        title={`删除项目「${pendingDelete?.name || ''}」`}
        message={
          pendingDelete && (pendingDelete.status === 'running' || pendingDelete.status === 'starting')
            ? `这个项目正在运行${pendingDelete.port ? `（端口 ${pendingDelete.port}）` : ''}。删除只移除工作台里的记录，不会结束进程——端口会继续被占用，之后同端口的项目会一直报冲突。建议先停止再删除。`
            : '只会删除工作台里的记录（含其子服务关联），不会删除磁盘上的项目文件，也不会结束正在运行的进程。'
        }
        loading={deleting || stopThenDeleting}
        secondary={
          pendingDelete && (pendingDelete.status === 'running' || pendingDelete.status === 'starting')
            ? { label: '先停止，再删除', onClick: handleStopThenDelete, loading: stopThenDeleting }
            : null
        }
        onClose={() => setPendingDelete(null)}
        onConfirm={handleDelete}
      />

      {/* 第七阶段：选择要关联的服务器 */}
      {linkPicker ? (
        <Modal open title="登记项目与服务器的关联" onClose={() => setLinkPicker(null)}>
          <p className="footnote" style={{ marginBottom: 10 }}>
            自动关联只认端口。如果这台机器上的服务和本项目确实相关，但端口没对上，可以在这里手工登记一条关联（记录下来的是你确认过的关系，不是按名字猜）。
          </p>
          <div className="stack">
            {linkPicker.candidates.map((server) => (
              <div key={server.id} className="res-link-row">
                <div style={{ minWidth: 0, flex: 1 }}>
                  <div className="row" style={{ gap: 6 }}>
                    <span className="res-name">{server.name}</span>
                    <span className="tech muted">{server.host}</span>
                    {server.ssh?.ok ? <span className="status-word">在线</span> : <span className="status-word muted">未采集</span>}
                  </div>
                  {server.metrics?.cpuUsagePercent !== undefined && server.metrics?.cpuUsagePercent !== null ? (
                    <div className="footnote">整机 CPU {server.metrics.cpuUsagePercent}%</div>
                  ) : (
                    <div className="footnote">还没有采集过这台机器的资源</div>
                  )}
                </div>
                <Button size="sm" icon="link" onClick={() => confirmLink(server.id)}>
                  关联
                </Button>
              </div>
            ))}
          </div>
        </Modal>
      ) : null}
    </div>
  )
}
