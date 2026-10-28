import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client.js'
import { useAsync, usePolling } from '../hooks/useAsync.js'
import { useProjectActions } from '../hooks/useProjectActions.js'
import { useServerActions } from '../hooks/useServerActions.js'
import { ProjectCard } from '../components/ProjectCard.jsx'
import { EventTimeline } from '../components/EventTimeline.jsx'
import { OnboardingCard } from '../components/OnboardingCard.jsx'
import { PageHint } from '../components/PageHint.jsx'
import { PreflightCard } from '../components/PreflightCard.jsx'
import { Icon } from '../components/Icons.jsx'
import { Button, Card, EmptyState, ErrorNotice, SkeletonList, Switch } from '../components/ui.jsx'
import { timeAgo } from '../utils/format.js'

/**
 * 总览：只回答"现在怎么样、有没有异常"。
 * 顶部四个核心状态 + 当前运行项目 + 最近活动，其余细节都在各自页面。
 */
export function DashboardPage() {
  const navigate = useNavigate()
  const { data, loading, error, reload } = useAsync(() => api.dashboard(true), { deps: [] })
  // 环境体检：后端 30 秒缓存，跟随总览同一节奏轮询；缺必需组件时「待处理」里要有一条
  const { data: preflight, reload: reloadPreflight } = useAsync(() => api.preflight(false), { deps: [] })
  const [autoRefresh, setAutoRefresh] = useState(true)
  const probedRef = useRef(false)

  const actions = useProjectActions(reload)
  const servers = useServerActions(reload)

  // 首屏渲染后异步做一次"过期即采集"的 SSH 检测，不阻塞页面
  useEffect(() => {
    if (probedRef.current || !data) return
    probedRef.current = true
    api
      .sshProbeAll(false, 60000)
      .then((result) => {
        if (result?.probed > 0) reload().catch(() => {})
      })
      .catch(() => {})
  }, [data, reload])

  usePolling(() => reload().catch(() => {}), 20000, autoRefresh)
  usePolling(() => reloadPreflight().catch(() => {}), 20000, autoRefresh)

  const projects = data?.projects || []
  const stats = data?.stats
  const docker = data?.docker
  const timeline = data?.timeline || []
  const discovery = data?.discovery
  const lastMonitorAt = (data?.servers || [])
    .map((server) => server.monitor?.at)
    .filter(Boolean)
    .sort()
    .pop()

  const runningProjects = projects.filter((project) => project.status === 'running' || project.status === 'starting')
  const conflictCount = stats?.conflicts?.value ?? projects.filter((project) => project.status === 'conflict').length
  // 环境体检里「必需但没就绪」的项：缺 Python 网盘功能就废了，必须进待处理
  const preflightMissing = (preflight?.items || []).filter((item) => !item.ok && item.required)
  const anomalyCount =
    projects.filter((project) => !project.dirExists).length + (docker?.unhealthy ?? 0) + preflightMissing.length

  const openLog = useCallback((project) => navigate('/logs', { state: { source: `project:${project.id}` } }), [navigate])

  /** 环境问题没有专属页面，点击「去处理」就是把体检卡滚出来并展开（缺必需项时它本就自动展开） */
  const scrollToPreflight = useCallback(() => {
    document.getElementById('preflight-card')?.scrollIntoView({ behavior: 'smooth', block: 'center' })
  }, [])

  async function dismissDiscoveryNotice() {
    try {
      await api.discoveryAcknowledge((discovery?.newCandidates || []).map((item) => item.fingerprint))
      await reload()
    } catch (err) {
      console.warn('标记已读失败', err)
    }
  }

  const missingDirs = projects.filter((project) => !project.dirExists).length
  const serversOnline = stats?.serversOnline.value ?? 0
  const states = [
    {
      label: '运行中项目',
      value: stats?.localRunning.value ?? runningProjects.length,
      total: stats?.localRunning.total,
      route: '/projects',
      dot: runningProjects.length > 0 ? 'running' : 'stopped',
    },
    {
      label: '待处理',
      value: anomalyCount,
      route: '/projects',
      alert: anomalyCount > 0,
      dot: anomalyCount > 0 ? 'conflict' : 'stopped',
      title: `目录不存在 ${missingDirs} · 异常容器 ${docker?.unhealthy ?? 0} · 环境组件缺失 ${preflightMissing.length}`,
      // 环境问题占大头时，点击应直接把体检卡滚出来，而不是跳去无关的「本地项目」
      onClick: preflightMissing.length > 0 ? scrollToPreflight : undefined,
    },
    {
      label: '在线服务器',
      value: serversOnline,
      total: stats?.serversOnline.total,
      route: '/servers',
      dot: serversOnline > 0 ? 'running' : 'stopped',
    },
    {
      label: '端口冲突',
      value: conflictCount,
      route: '/ports',
      alert: conflictCount > 0,
      dot: conflictCount > 0 ? 'conflict' : 'stopped',
    },
  ]

  // 「一目了然」：有异常时异常项排最前，正常状态垫后 —— 一眼先看到"哪里不对"
  const orderedStates = [...states].sort((a, b) => (b.alert ? 1 : 0) - (a.alert ? 1 : 0))

  // 端口冲突里如果混着"疑似重复登记"，要分开说：前者是故障，后者只是登记冗余
  const portConflicts = data?.conflicts || []
  const hasDuplicateRegistration = portConflicts.some((item) => item.type === 'duplicate-registration')

  // 待处理清单：只列真正需要用户动手的，每条都能一键跳到能解决它的地方
  // 「未登记服务」也归入这里，不再单独挂一条横幅 —— 同一件事不该让人处理两遍
  const discoveryNames = (discovery?.newCandidates || [])
    .slice(0, 3)
    .map((item) => (item.processName ? `${item.processName}:${item.port}` : item.serviceName || `:${item.port}`))
  const discoveryDetail =
    discoveryNames.length > 0
      ? ` · ${discoveryNames.join('、')}${discovery.newCount > 3 ? ` 等 ${discovery.newCount} 个` : ''}`
      : ''
  const todos = [
    // 环境缺失排最前：它是"别的功能为什么用不了"的根因，比项目级异常更优先
    ...preflightMissing.map((item) => ({
      id: `preflight-${item.id}`,
      level: 'error',
      text: `${item.label} 没就绪：${item.why}`,
      go: scrollToPreflight,
    })),
    ...(discovery?.newCount > 0
      ? [
          {
            id: 'discovery',
            level: 'warn',
            text: `${discovery.newCount} 个本机监听服务还没登记${discoveryDetail}`,
            go: () => navigate('/projects', { state: { discovery: true } }),
          },
        ]
      : []),
    ...(missingDirs > 0
      ? [
          {
            id: 'missing-dirs',
            level: 'warn',
            text: `${missingDirs} 个项目的目录不存在（可能磁盘没挂载或路径改了）`,
            go: () => navigate('/projects'),
          },
        ]
      : []),
    ...(conflictCount > 0
      ? [
          {
            id: 'port-conflict',
            // 「疑似重复登记」不是故障（同一个服务被登记了两次而已），不该用红色高危语气
            level: hasDuplicateRegistration ? 'warn' : 'error',
            text: hasDuplicateRegistration
              ? `${conflictCount} 个端口被重复登记（父子目录的项目声明了同一个端口）`
              : `${conflictCount} 个端口冲突，服务可能起不来`,
            go: () => navigate('/ports'),
          },
        ]
      : []),
    ...(docker?.unhealthy > 0
      ? [
          {
            id: 'docker',
            level: 'error',
            text: `${docker.unhealthy} 个容器健康检查异常`,
            go: () => navigate('/servers'),
          },
        ]
      : []),
  ]

  // 首屏整体加载态：dashboard 一次要跑端口扫描 + 项目状态 + 服务器列表，实测约 3-5 秒。
  // 期间若什么都不渲染，用户看到的就是"黑屏"（外壳在、内容区空着）。
  // 这里明确告知正在做什么，比空白更可信。
  const firstLoad = loading && !data

  return (
    <div className="page">
      <div className="page__header">
        <div className="page__title">总览</div>
        <div className="page__actions">
          <Switch checked={autoRefresh} onChange={setAutoRefresh} label="自动刷新" />
          <Button icon="refresh" loading={loading} onClick={() => reload().catch(() => {})}>
            刷新
          </Button>
          <Button variant="primary" icon="wifi" loading={servers.isBusy('all:ssh')} onClick={servers.sshProbeAll}>
            SSH 检测
          </Button>
        </div>
      </div>

      {/* 每页一次性提示：新手落地第一眼就知道这页是干嘛的（见 PageHint） */}
      <PageHint id="dashboard" icon="dashboard">
        这页回答「现在怎么样」：哪些项目在跑、有没有要处理的事。出现异常时先看「待处理」，每条都能一键跳到能解决它的页面。
      </PageHint>

      {error ? <ErrorNotice error={error} onRetry={() => reload().catch(() => {})} /> : null}

      {firstLoad ? (
        <Card>
          <div className="boot-hint">
            <span className="spinner" />
            <div>
              <div className="boot-hint__title">正在读取本机状态…</div>
              <div className="boot-hint__desc">需要扫描监听端口、核对项目运行状态，通常 3 到 5 秒</div>
            </div>
          </div>
        </Card>
      ) : null}

      {/* 空环境才出现的上手引导：登记 → 启动 → 查端口，做完自动消失 */}
      {!firstLoad && !error ? (
        <OnboardingCard projects={projects} onGo={(path, state) => navigate(path, { state })} />
      ) : null}

      {/* 依赖体检：缺东西时自动展开标红，全就绪时收成一行 */}
      {!firstLoad && !error ? (
        <div id="preflight-card">
          <PreflightCard />
        </div>
      ) : null}

      <div className="status-strip">
        {orderedStates.map((item) => (
          <button
            key={item.label}
            type="button"
            className={`status-strip__item ${item.alert ? 'is-alert' : ''}`}
            title={item.title}
            onClick={item.onClick ?? (() => navigate(item.route))}
          >
            <span className={`status-dot status-dot--${item.dot}`} />
            <span className="status-strip__label">{item.label}</span>
            <span className="status-strip__value">
              {item.value}
              {item.total !== undefined && item.total !== null ? <small>/{item.total}</small> : null}
            </span>
          </button>
        ))}
        {lastMonitorAt ? <span className="status-strip__note">SSH 采集 {timeAgo(lastMonitorAt)}</span> : null}
      </div>

      {/* 待处理：把所有"需要你动手"的事集中到一处，而不是散落在各个页面里找 */}
      {todos.length > 0 ? (
        <div className="card todos">
          <div className="card__title">
            <Icon name="alert" size={15} style={{ color: 'var(--amber)' }} />
            待处理
            <span className="card__title-sub">{todos.length} 项</span>
          </div>
          {discovery?.newCount > 0 ? (
            <div className="todos__dismiss">
              <Button size="sm" icon="check" onClick={dismissDiscoveryNotice}>
                知道了
              </Button>
            </div>
          ) : null}
          <div className="todos__list">
            {todos.map((todo) => (
              <button key={todo.id} type="button" className="todo" onClick={todo.go}>
                <span className={`todo__dot todo__dot--${todo.level}`} />
                <span className="todo__text">{todo.text}</span>
                <span className="todo__go">
                  去处理
                  <Icon name="chevronRight" size={12} />
                </span>
              </button>
            ))}
          </div>
        </div>
      ) : null}

      <div className="grid grid--main">
        <Card
          title="当前运行项目"
          subtitle={String(runningProjects.length)}
          icon="play"
          flush
          actions={
            <Button size="sm" icon="external" onClick={() => navigate('/projects')}>
              本地项目
            </Button>
          }
        >
          {loading && !data ? (
            <SkeletonList rows={3} />
          ) : runningProjects.length === 0 ? (
            <EmptyState
              title="没有正在运行的项目"
              hint={projects.length === 0 ? '还没有登记项目，先去自动发现本机服务，或手动新增一个。' : '项目都在，去「本地项目」点启动。'}
              action={
                projects.length === 0 ? (
                  <Button variant="primary" icon="search" onClick={() => navigate('/projects', { state: { discovery: true } })}>
                    自动发现本机服务
                  </Button>
                ) : (
                  <Button icon="external" onClick={() => navigate('/projects')}>
                    去本地项目
                  </Button>
                )
              }
            />
          ) : (
            runningProjects.map((project) => (
              <ProjectCard
                key={project.id}
                project={project}
                action={actions.actionOf(project.id)}
                onStart={actions.start}
                onStop={actions.stop}
                onRestart={actions.restart}
                onOpenDir={actions.openDir}
                onOpenUrl={actions.openUrl}
                onCopyUrl={actions.copyUrl}
                onLog={openLog}
                onEdit={() => navigate('/projects', { state: { edit: project.id } })}
                onDelete={() => navigate('/projects', { state: { focus: project.id } })}
              />
            ))
          )}
        </Card>

        <Card
          title="最近活动"
          icon="clock"
          flush
          actions={
            <Button size="sm" icon="external" onClick={() => navigate('/timeline')}>
              时间线
            </Button>
          }
        >
          <div style={{ padding: 8 }}>
            <EventTimeline events={timeline} maxHeight={360} emptyText={loading && !data ? '正在读取…' : '暂无事件'} />
          </div>
        </Card>
      </div>
    </div>
  )
}
