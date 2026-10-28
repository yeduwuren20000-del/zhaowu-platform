import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client.js'
import { useToast } from '../hooks/useToast.jsx'
import { LogPanel, normalizeTextLines } from './LogPanel.jsx'
import { Button, EmptyState, ErrorNotice, Notice } from './ui.jsx'
import { formatBytes, formatDateTime, timeAgo } from '../utils/format.js'

/**
 * 远程日志查看：**只能**读取服务器配置里预先登记的 logPaths，
 * 没有命令输入框，路径用下拉选择；读取走只读通道（SFTP）。
 */
export function ServerLogViewer({ server, onEditServer }) {
  const toast = useToast()
  const allowed = server.logPaths || []
  const [selected, setSelected] = useState('')
  const [entries, setEntries] = useState([])
  const [info, setInfo] = useState(null)
  const [error, setError] = useState(null)
  const [loading, setLoading] = useState(false)
  const [checking, setChecking] = useState(false)
  const [checkResult, setCheckResult] = useState(null)

  const load = useCallback(
    async (path) => {
      if (allowed.length === 0) return
      setLoading(true)
      setError(null)
      try {
        const result = await api.serverLog(server.id, path || allowed[0], 300)
        setEntries(normalizeTextLines(result.lines))
        setInfo(result)
      } catch (err) {
        setError(err.message)
        setEntries([])
        setInfo(null)
      } finally {
        setLoading(false)
      }
    },
    [allowed, server.id],
  )

  useEffect(() => {
    if (allowed.length > 0) {
      setSelected(allowed[0])
      load(allowed[0])
    } else {
      setEntries([])
      setInfo(null)
    }
  }, [allowed, load])

  async function checkPaths() {
    setChecking(true)
    try {
      const result = await api.serverLogCheck(server.id)
      setCheckResult(result.paths || [])
    } catch (err) {
      toast.error('检查日志路径失败', err.message)
    } finally {
      setChecking(false)
    }
  }

  if (allowed.length === 0) {
    return (
      <EmptyState
        title="还没有配置可读日志路径"
        hint="为避免任意命令执行，只允许读取预先登记的文件。请在「编辑服务器」里填写日志路径，例如 /var/log/nginx/error.log。"
        action={
          <Button variant="primary" icon="edit" onClick={() => onEditServer?.(server)}>
            去配置日志路径
          </Button>
        }
      />
    )
  }

  return (
    <div>
      <div className="row row--wrap" style={{ marginBottom: 10, gap: 8 }}>
        <select className="select" style={{ maxWidth: 340 }} value={selected} onChange={(event) => setSelected(event.target.value)}>
          {allowed.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
        <Button size="sm" icon="fileText" loading={loading} onClick={() => load(selected)}>
          读取
        </Button>
        <Button size="sm" icon="check" loading={checking} onClick={checkPaths}>
          检查路径
        </Button>
        <div className="spacer" />
        <span style={{ fontSize: 11.5, color: 'var(--muted-2)' }}>
          {info ? `${info.lines.length} 行 · ${formatBytes(info.size)} · 修改于 ${formatDateTime(info.mtime)}` : '只读读取（SFTP），不会在服务器上执行你输入的任意命令'}
        </span>
      </div>

      {checkResult ? (
        <div className="footnote" style={{ marginBottom: 8 }}>
          {checkResult.map((item) => (
            <span key={item.path} style={{ marginRight: 14 }}>
              <span className={item.exists ? 'status-word muted' : 'status-word is-error'}>
                {item.exists ? '存在' : '不存在'}
              </span>{' '}
              <span className="tech">{item.path}</span>
            </span>
          ))}
        </div>
      ) : null}

      {error ? <ErrorNotice error={error} onRetry={() => load().catch(() => {})} retryLabel="重新读取" /> : null}
      {server.logRead?.error && !error && entries.length === 0 ? (
        <Notice tone="warn" icon="alert">
          上次读取失败（{timeAgo(server.logRead.at)}）：{server.logRead.error}
        </Notice>
      ) : null}

      <LogPanel entries={entries} height={340} emptyText="这个日志文件还没有可读内容。" />
    </div>
  )
}
