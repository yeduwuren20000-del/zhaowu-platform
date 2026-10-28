import { useCallback, useEffect, useMemo, useState } from 'react'
import { useLocation } from 'react-router-dom'
import { api } from '../api/client.js'
import { useAsync } from '../hooks/useAsync.js'
import { useToast } from '../hooks/useToast.jsx'
import { LogPanel, normalizeEvents, normalizeTextLines } from '../components/LogPanel.jsx'
import { PageHint } from '../components/PageHint.jsx'
import { Button, Card, ErrorNotice, SkeletonLines, Switch } from '../components/ui.jsx'

const WORKBENCH = 'workbench'

export function LogsPage() {
  const location = useLocation()
  const toast = useToast()
  const { data: projects } = useAsync(() => api.projects(), { deps: [] })
  const [source, setSource] = useState(WORKBENCH)
  const [entries, setEntries] = useState([])
  const [loading, setLoading] = useState(false)
  const [live, setLive] = useState(true)
  const [error, setError] = useState(null)
  const [logFile, setLogFile] = useState('')

  useEffect(() => {
    if (location.state?.source) setSource(location.state.source)
  }, [location.state])

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    try {
      if (source.startsWith('project:')) {
        const result = await api.projectLog(source.slice('project:'.length), 400)
        setEntries(normalizeTextLines(result.lines))
        setLogFile(result.file)
      } else {
        const result = await api.logs(400)
        setEntries(normalizeEvents(result.events))
        setLogFile(result.file)
      }
    } catch (err) {
      setError(err)
    } finally {
      setLoading(false)
    }
  }, [source])

  useEffect(() => {
    load()
  }, [load])

  // 实时追踪：SSE 推送（后端每秒比对文件内容）
  useEffect(() => {
    if (!live) return undefined
    const stream = new EventSource(api.logStreamUrl(source))
    stream.onmessage = (event) => {
      try {
        const payload = JSON.parse(event.data)
        if (payload.error) return
        if (payload.events) setEntries(normalizeEvents(payload.events))
        else if (payload.lines) setEntries(normalizeTextLines(payload.lines))
      } catch {
        /* 忽略心跳等非 JSON 数据 */
      }
    }
    stream.onerror = () => {
      /* 断线由浏览器自动重连 */
    }
    return () => stream.close()
  }, [live, source])

  const options = useMemo(
    () => [{ id: WORKBENCH, name: '工作台事件' }, ...(projects || []).map((project) => ({ id: `project:${project.id}`, name: `项目进程 · ${project.name}` }))],
    [projects],
  )

  // 空态按来源给指引：工作台事件靠"发生事情"产生，项目日志靠"跑起来"产生
  const isProjectLog = source.startsWith('project:')
  const logEmpty = isProjectLog
    ? { text: '这个项目还没有进程日志。', hint: '在「本地项目」点一次启动，它的输出会实时出现在这；起不来时，最后几行通常就是原因。' }
    : { text: '工作台事件日志还是空的。', hint: '启动 / 停止项目、做 SSH 检测、发现新服务，都会自动记到这里。' }

  async function clear() {
    try {
      if (source.startsWith('project:')) {
        await api.clearProjectLog(source.slice('project:'.length))
      } else {
        await api.clearLogs()
      }
      toast.success('日志已清空', source === WORKBENCH ? '工作台事件日志' : '该项目的过程日志')
      await load()
    } catch (err) {
      toast.error('清空失败', err.message)
    }
  }

  return (
    <div className="page">
      <div className="page__header">
        <div className="page__title">日志中心</div>
        <div className="page__actions">
          <Switch checked={live} onChange={setLive} label="实时追踪" />
          <Button icon="refresh" loading={loading} onClick={load}>
            刷新
          </Button>
          <Button variant="danger" icon="trash" onClick={clear}>
            清空
          </Button>
        </div>
      </div>

      {/* 每页一次性提示：新手落地第一眼就知道这页是干嘛的（见 PageHint） */}
      <PageHint id="logs" icon="terminal">
        工作台事件和每个项目的进程输出都集中在这。项目起不来时，在上方选「项目进程 · 项目名」，看它最后打印了什么。
      </PageHint>

      <div className="toolbar">
        <select className="select" style={{ maxWidth: 420 }} value={source} onChange={(event) => setSource(event.target.value)}>
          {options.map((option) => (
            <option key={option.id} value={option.id}>
              {option.name}
            </option>
          ))}
        </select>
        <span className="footnote">共 {entries.length} 行</span>
        <span className={`status-word ${live ? '' : 'muted'}`}>{live ? '实时推送中' : '已暂停'}</span>
        <div className="spacer" />
        <span className="tech muted">{logFile}</span>
      </div>

      {error ? <ErrorNotice error={error} onRetry={() => load().catch(() => {})} /> : null}

      <Card flush>
        <div style={{ padding: 12 }}>
          {loading && entries.length === 0 ? <SkeletonLines rows={8} /> : <LogPanel entries={entries} height={460} emptyText={logEmpty.text} emptyHint={logEmpty.hint} />}
        </div>
      </Card>
    </div>
  )
}
