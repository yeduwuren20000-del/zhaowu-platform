import { useEffect, useMemo, useRef, useState } from 'react'
import { useLocation, useNavigate } from 'react-router-dom'
import { api } from '../api/client.js'
import { useAsync, usePolling } from '../hooks/useAsync.js'
import { useToast } from '../hooks/useToast.jsx'
import { useEmbed } from '../hooks/useEmbed.jsx'
import { PortTable } from '../components/PortTable.jsx'
import { PageHint } from '../components/PageHint.jsx'
import { statusMeta } from '../utils/format.js'
import { Button, Card, ErrorNotice, Notice, SearchBox, SkeletonList, Switch, Tabs } from '../components/ui.jsx'

export function PortsPage() {
  const location = useLocation()
  const navigate = useNavigate()
  const toast = useToast()
  const embed = useEmbed()
  // 轮询走缓存（端口状态最多 10s 滞后，足够一个轮询看板）；只有手动「刷新」才强制重新枚举全机监听表
  const forceRef = useRef(false)
  const { data, loading, error, reload } = useAsync(() => api.ports(forceRef.current), { deps: [] })
  const [env, setEnv] = useState('all')
  const [query, setQuery] = useState('')
  const [autoRefresh, setAutoRefresh] = useState(true)

  async function refresh() {
    forceRef.current = true
    try {
      await reload()
    } finally {
      forceRef.current = false
    }
  }

  useEffect(() => {
    if (location.state?.q) setQuery(location.state.q)
  }, [location.state])

  usePolling(() => reload().catch(() => {}), 15000, autoRefresh)

  const rows = data?.rows || []
  const conflicts = data?.conflicts || []
  const stats = data?.stats

  const filtered = useMemo(() => {
    const text = query.trim().toLowerCase()
    return rows.filter((row) => {
      if (env !== 'all' && row.envKey !== env) return false
      if (!text) return true
      return [row.port, row.app, row.owner, row.path, row.host, row.statusText, statusMeta(row.status).text, row.env, row.processName]
        .filter((value) => value !== null && value !== undefined)
        .some((value) => String(value).toLowerCase().includes(text))
    })
  }, [rows, env, query])

  async function scanPort(port) {
    try {
      return await api.scanPort(port)
    } catch (err) {
      toast.error('端口查询失败', err.message)
      return null
    }
  }

  // 同样走工作台内嵌抽屉：新窗口会有建窗白屏，内嵌没有
  function openUrl(url, name) {
    if (!url) return
    embed.openEmbed({ url, name: name || '端口页面' })
  }

  async function copyPath(path) {
    if (!path) {
      toast.warn('这条记录没有路径', '可以在编辑里补上部署路径')
      return
    }
    try {
      await navigator.clipboard.writeText(path)
      toast.success('已复制到剪贴板', path)
    } catch {
      toast.warn('浏览器拒绝了剪贴板访问', '请手动复制：' + path)
    }
  }

  return (
    <div className="page">
      <div className="page__header">
        <div className="page__title">服务端口</div>
        <div className="page__actions">
          <Switch checked={autoRefresh} onChange={setAutoRefresh} label="自动刷新" />
          <Button icon="refresh" loading={loading} onClick={() => refresh().catch(() => {})}>
            刷新
          </Button>
        </div>
      </div>

      {/* 每页一次性提示：新手落地第一眼就知道这页是干嘛的（见 PageHint） */}
      <PageHint id="ports" icon="ports">
        所有监听端口和登记记录都在这。启动报「端口被占」时来这里看是谁占的、对应哪个项目，能直接跳过去处理。
      </PageHint>

      <div className="toolbar">
        <Tabs
          value={env}
          onChange={setEnv}
          options={[
            { value: 'all', label: '全部', count: stats?.total ?? rows.length },
            { value: 'local', label: '本地', count: stats?.local ?? 0 },
            { value: 'server', label: '服务器', count: stats?.server ?? 0 },
          ]}
        />
        <SearchBox value={query} onChange={setQuery} placeholder="搜索端口 / APP / 项目 / 路径…" width={300} />
        <div className="spacer" />
        <span className="footnote">
          运行中 {stats?.running ?? 0} · 冲突 {stats?.conflicts ?? 0}
        </span>
      </div>

      {error ? <ErrorNotice error={error} onRetry={() => refresh().catch(() => {})} /> : null}

      {conflicts.length > 0 ? (
        <Notice tone="warn" icon="alert">
          <div style={{ fontWeight: 600, marginBottom: 4 }}>发现 {conflicts.length} 处端口冲突</div>
          {conflicts.map((conflict, index) => (
            <div key={`${conflict.port}-${index}`}>· {conflict.message}</div>
          ))}
        </Notice>
      ) : null}

      <Card flush>
        {loading && !data ? (
          <SkeletonList rows={6} />
        ) : (
          <PortTable
            rows={filtered}
            onScan={scanPort}
            onOpenUrl={openUrl}
            onCopyPath={copyPath}
            onOpenProject={(projectId) => navigate('/projects', { state: { focus: projectId } })}
          />
        )}
      </Card>
    </div>
  )
}
