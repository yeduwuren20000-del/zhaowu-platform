import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api/client.js'
import { useToast } from '../hooks/useToast.jsx'
import { ProjectGroupCard, ServiceList } from './ServiceList.jsx'
import { Button, EmptyState, SearchBox, Switch } from './ui.jsx'
import { formatDateTime } from '../utils/format.js'

/** 自动发现面板：默认按项目目录分组，事实字段只来自系统采集 */
export function DiscoveryPanel({ onRegistered, onClose }) {
  const toast = useToast()
  const [scanning, setScanning] = useState(false)
  const [includeAi, setIncludeAi] = useState(false)
  const [grouping, setGrouping] = useState(null)
  const [latest, setLatest] = useState(null)
  const [busy, setBusy] = useState({})
  const [expanded, setExpanded] = useState({})
  const [query, setQuery] = useState('')
  const [showFiltered, setShowFiltered] = useState(false)
  const [showIgnored, setShowIgnored] = useState(false)
  const [batchMode, setBatchMode] = useState(false)
  const [selected, setSelected] = useState(() => new Set())

  const loadLatest = useCallback(async () => {
    try {
      const [groups, latestData] = await Promise.all([api.discoveryGroups(), api.discoveryLatest()])
      setGrouping(groups)
      setLatest(latestData)
    } catch (error) {
      toast.error('读取扫描结果失败', error.message)
    }
  }, [toast])

  useEffect(() => {
    loadLatest()
  }, [loadLatest])

  const runScan = useCallback(async () => {
    setScanning(true)
    try {
      const result = await api.discoveryScan(includeAi)
      await loadLatest()
      const summary = result.groupSummary || {}
      toast.success(
        `扫描完成（${result.durationMs}ms）`,
        `监听端口 ${result.summary.listeningCount} 个 · 聚合出 ${summary.directoryGroups ?? 0} 个项目目录分组 · 待登记 ${summary.unregisteredGroups ?? 0} 组 · 已登记 ${summary.registeredGroups ?? 0} 组 · 过滤 ${result.summary.filtered} 个`,
      )
    } catch (error) {
      toast.error('扫描失败', error.message)
    } finally {
      setScanning(false)
    }
  }, [includeAi, loadLatest, toast])

  const groups = grouping?.groups || []
  const loose = grouping?.loose || []
  const systemServices = grouping?.system || []
  const summary = grouping?.summary || {}
  const ignored = latest?.ignored || []
  const aiInfo = latest?.ai || null

  const visibleGroups = useMemo(() => {
    const text = query.trim().toLowerCase()
    if (!text) return groups
    return groups.filter((group) =>
      [group.name, group.projectDir, group.registeredProjectName, ...(group.summary?.portList || []), ...(group.summary?.types || [])]
        .filter((value) => value !== null && value !== undefined)
        .some((value) => String(value).toLowerCase().includes(text)),
    )
  }, [groups, query])

  async function withBusy(key, fn, messages) {
    setBusy((prev) => ({ ...prev, [key]: true }))
    try {
      const data = await fn()
      if (messages?.success) toast.success(messages.success, data?.project?.name || messages.detail)
      await loadLatest()
      await onRegistered?.()
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

  const registerGroup = (group, primaryFingerprint = null) =>
    withBusy(`grp:${group.id}`, () => api.discoveryRegisterGroup(group.id, {}, primaryFingerprint), {
      success: `已按目录登记「${group.name}」（同目录 ${group.summary.live} 个服务合并为一个项目）`,
      error: '登记项目组失败',
    })

  const ignoreGroup = (group) =>
    withBusy(
      `grpign:${group.id}`,
      async () => {
        const fingerprints = group.services.filter((service) => service.live && service.key).map((service) => service.key)
        return api.discoveryIgnore(fingerprints, '整组忽略')
      },
      { success: `已忽略「${group.name}」下的服务`, error: '忽略失败' },
    )

  const registerSingle = (service) =>
    withBusy(`reg:${service.key}`, () => api.discoveryRegister(service.key), { success: '已登记为独立项目', error: '登记失败' })

  const associate = (service, projectId) =>
    withBusy(`assoc:${service.key}`, () => api.discoveryAssociate(service.key, projectId), {
      success: '已关联为项目子服务',
      error: '关联失败',
    })

  // ---- 批量登记 ----
  const selectableGroups = groups.filter((group) => group.registrationState !== 'registered')

  const toggleSelect = (groupId) => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(groupId)) next.delete(groupId)
      else next.add(groupId)
      return next
    })
  }

  const selectAll = () => {
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.size === selectableGroups.length) next.clear()
      else for (const group of selectableGroups) next.add(group.id)
      return next
    })
  }

  const exitBatch = () => {
    setBatchMode(false)
    setSelected(new Set())
  }

  const batchRegister = () =>
    withBusy(
      'batch',
      async () => {
        const data = await api.discoveryRegisterGroups([...selected])
        const created = data.created ?? 0
        const skipped = data.skipped ?? 0
        const failed = data.failed ?? 0
        setSelected(new Set())
        setBatchMode(false)
        if (created === 0 && skipped > 0) {
          throw new Error(`没有可登记的项目组（${skipped} 组已登记或无可登记服务）`)
        }
        return data
      },
      {
        success: (data) => {
          const created = data?.created ?? 0
          const skipped = data?.skipped ?? 0
          const failed = data?.failed ?? 0
          return `批量登记完成：成功 ${created} 组${skipped ? ` · 跳过 ${skipped} 组` : ''}${failed ? ` · 失败 ${failed} 组` : ''}`
        },
        error: '批量登记失败',
      },
    )

  const ignoreService = (service) =>
    withBusy(`ign:${service.key}`, () => api.discoveryIgnore([service.key], '用户在自动发现面板忽略'), {
      success: '已忽略该服务（后续扫描不再提示）',
      error: '忽略失败',
    })

  const restore = (fingerprint) =>
    withBusy(`res:${fingerprint}`, () => api.discoveryRestore([fingerprint]), { success: '已恢复该服务的提示', error: '恢复失败' })

  const identify = (fingerprint) =>
    withBusy(`ai:${fingerprint}`, () => api.discoveryIdentify(fingerprint), {
      success: 'AI 建议已生成（只作为参考，不会改写事实字段）',
      error: 'AI 识别失败',
    })

  return (
    <div className="card" style={{ marginBottom: 16 }}>
      <header className="card__header">
        <div className="card__title">
          自动发现
          {grouping?.scanAt ? <span className="card__title-sub">扫描于 {formatDateTime(grouping.scanAt)}</span> : null}
        </div>
        <div className="card__actions">
          <Switch checked={includeAi} onChange={setIncludeAi} label="启用 AI 辅助识别" />
          {batchMode ? (
            <Button icon="x" onClick={exitBatch}>
              退出批量选择
            </Button>
          ) : (
            <Button icon="check" disabled={!selectableGroups.length} onClick={() => setBatchMode(true)} title="勾选多个待登记的项目组，一次性登记">
              批量登记
            </Button>
          )}
          <Button variant="primary" icon="refresh" loading={scanning} onClick={runScan}>
            立即扫描
          </Button>
          {onClose ? <Button icon="x" onClick={onClose} /> : null}
        </div>
      </header>

      <div className="card__body">
        <div className="footnote" style={{ marginBottom: 10 }}>
          同一个 <span className="mono">projectDir</span> 下的多个进程/端口聚合为一个项目组，无目录的服务按 PID 单独分组；PID、端口、路径、命令行均来自系统实时采集，扫描只读取项目元数据文件，
          <b>不会执行</b>目标项目的任何脚本。
        </div>

        {!grouping ? (
          <EmptyState title="还没有扫描结果" hint="点「立即扫描」会读取本机监听端口、进程事实与项目元数据，并按项目目录聚合。" />
        ) : (
          <>
            <div className="row row--wrap" style={{ gap: 10, margin: '10px 0' }}>
              <span className="footnote">
                端口 {summary.ports ?? 0} · 项目组 {summary.directoryGroups ?? 0}（待登记 {summary.unregisteredGroups ?? 0} / 已登记 {summary.registeredGroups ?? 0}）· 无目录 {summary.looseGroups ?? 0} · 已过滤 {summary.systemServices ?? 0} · 已忽略 {summary.ignoredServices ?? 0}
                {summary.newSubServices ? ` · 新子服务 ${summary.newSubServices}` : ''}
              </span>
              {summary.conflicts ? <span className="status-word is-error">冲突 {summary.conflicts}</span> : null}
              <div className="spacer" />
              {batchMode ? (
                <Button
                  size="sm"
                  icon="check"
                  onClick={selectAll}
                  title={selected.size === selectableGroups.length ? '取消全选' : '全选待登记项目组'}
                >
                  {selected.size === selectableGroups.length && selectableGroups.length > 0 ? '取消全选' : '全选待登记'}
                </Button>
              ) : null}
              <SearchBox value={query} onChange={setQuery} placeholder="筛选项目组（名称/目录/端口）…" width={230} />
            </div>

            {aiInfo && !aiInfo.available ? (
              <div className="footnote" style={{ marginBottom: 10 }}>
                AI 辅助识别未启用：{aiInfo.note}。候选全部由确定性规则识别。
              </div>
            ) : grouping?.aiNote ? (
              <div className="footnote" style={{ marginBottom: 10 }}>{grouping.aiNote}</div>
            ) : null}

            {visibleGroups.length === 0 ? (
              <EmptyState
                title={groups.length === 0 ? '没有发现任何项目组' : '没有匹配的项目组'}
                hint={groups.length === 0 ? '启动一个带项目目录的服务后重新扫描即可发现。' : '换个关键字试试。'}
              />
            ) : (
              <div className="stack">
                {visibleGroups.map((group) => (
                  <ProjectGroupCard
                    key={group.id}
                    group={group}
                    expanded={expanded[group.id] !== false}
                    onToggle={(id) => setExpanded((prev) => ({ ...prev, [id]: prev[id] === false }))}
                    busy={busy}
                    onRegisterGroup={registerGroup}
                    onIgnoreGroup={ignoreGroup}
                    onRegisterSingle={registerSingle}
                    onEditRegister={registerSingle}
                    onAssociate={(service) => associate(service, group.registeredProjectId)}
                    onIgnoreService={ignoreService}
                    selectable={batchMode}
                    selected={selected.has(group.id)}
                    onToggleSelect={toggleSelect}
                  />
                ))}
              </div>
            )}

            {loose.length > 0 ? (
              <div style={{ marginTop: 14 }}>
                <div className="footnote" style={{ marginBottom: 8 }}>
                  未识别项目目录的独立服务 {loose.length} 组，按进程（PID）分组，不与任何项目合并
                </div>
                {loose.map((group) => (
                  <div key={group.id} style={{ marginBottom: 10 }}>
                    <div className="row row--wrap" style={{ gap: 8, marginBottom: 6 }}>
                      <span className="docker-name">{group.name}</span>
                      <span className="footnote tech">
                        端口 {group.summary.portList.join('、') || '—'} · 进程 {group.summary.processes}
                      </span>
                      {aiInfo?.available && group.services.some((service) => service.candidate?.aiEligible) ? (
                        <Button
                          size="sm"
                          icon="cpu"
                          loading={busy[`ai:${group.services[0].key}`]}
                          onClick={() => identify(group.services[0].key)}
                        >
                          AI 识别
                        </Button>
                      ) : null}
                    </div>
                    <ServiceList
                      services={group.services}
                      busy={busy}
                      onRegisterSingle={registerSingle}
                      onIgnore={ignoreService}
                      onEditRegister={registerSingle}
                      compact
                    />
                  </div>
                ))}
              </div>
            ) : null}

            <div className="row" style={{ gap: 10, marginTop: 14 }}>
              <Button size="sm" icon={showFiltered ? 'chevronDown' : 'chevronRight'} onClick={() => setShowFiltered((prev) => !prev)}>
                系统与非开发进程（{systemServices.length}）
              </Button>
              <Button size="sm" icon={showIgnored ? 'chevronDown' : 'chevronRight'} onClick={() => setShowIgnored((prev) => !prev)}>
                已忽略（{ignored.length}）
              </Button>
            </div>

            {showFiltered ? (
              <div style={{ marginTop: 10, maxHeight: 260, overflowY: 'auto' }}>
                <table className="table">
                  <thead>
                    <tr>
                      <th style={{ width: 90 }}>端口</th>
                      <th style={{ width: 90 }}>PID</th>
                      <th>进程</th>
                      <th>过滤原因</th>
                    </tr>
                  </thead>
                  <tbody>
                    {systemServices.map((item) => (
                      <tr key={item.fingerprint}>
                        <td className="table__port">{item.port}</td>
                        <td className="tech">{item.pid}</td>
                        <td className="tech">{item.processName || '—'}</td>
                        <td style={{ color: 'var(--muted)' }}>{item.filterReason}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : null}

            {showIgnored ? (
              <div style={{ marginTop: 10, maxHeight: 260, overflowY: 'auto' }}>
                {ignored.length === 0 ? (
                  <EmptyState title="没有忽略记录" hint="被忽略的服务会记录指纹（与 PID 无关），后续扫描不再提示。" />
                ) : (
                  <table className="table">
                    <thead>
                      <tr>
                        <th>指纹</th>
                        <th>标记</th>
                        <th>忽略时间</th>
                        <th style={{ width: 100, textAlign: 'right' }}>操作</th>
                      </tr>
                    </thead>
                    <tbody>
                      {ignored.map((item) => (
                        <tr key={item.fingerprint}>
                          <td className="mono">{item.fingerprint}</td>
                          <td>{item.label || '—'}</td>
                          <td style={{ color: 'var(--muted)' }}>{formatDateTime(item.at)}</td>
                          <td>
                            <div className="table__actions">
                              <Button size="sm" icon="refresh" loading={busy[`res:${item.fingerprint}`]} onClick={() => restore(item.fingerprint)}>
                                恢复
                              </Button>
                            </div>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </div>
            ) : null}
          </>
        )}

        {batchMode && selected.size > 0 ? (
          <div className="batch-bar">
            <span className="batch-bar__info">
              已选 <b>{selected.size}</b> 个待登记项目组
            </span>
            <Button size="sm" icon="x" onClick={exitBatch}>
              取消
            </Button>
            <Button size="sm" variant="primary" icon="check" loading={busy.batch} onClick={batchRegister}>
              登记所选 {selected.size} 组
            </Button>
          </div>
        ) : null}
      </div>
    </div>
  )
}
