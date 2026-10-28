import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client.js'
import { Icon } from './Icons.jsx'
import { Button, Card, ErrorNotice } from './ui.jsx'
import { useToast } from '../hooks/useToast.jsx'
import { copyText } from '../utils/clipboard.js'

/**
 * 环境体检卡：把「这台机器到底缺什么」直接摆在总览页。
 *
 * 为什么要做：新手最常见的失败不是「用错功能」，而是某个依赖没装 / 没进 PATH，
 * 界面上只回一句技术错误，看不出该改什么。这里每项都用真实命令探测过，
 * 缺的直接给出「影响哪个功能 + 怎么装」，命令可点一下复制。
 *
 * 折叠策略：全都就绪时收成一行（不占地方）；有必需项缺失时自动展开并标红。
 * 用户手动开合后以手动为准（manualOpen），避免每次刷新把人家刚展开的又收起来。
 */
export function PreflightCard() {
  const toast = useToast()
  const [data, setData] = useState(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [manualOpen, setManualOpen] = useState(null)

  const load = useCallback(async (refresh) => {
    setLoading(true)
    setError('')
    try {
      setData(await api.preflight(refresh))
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    load(false)
  }, [load])

  const items = data?.items || []
  const summary = data?.summary || { total: 0, okCount: 0, missing: [], requiredMissing: [] }
  const requiredMissing = summary.requiredMissing || []
  const optionalMissing = (summary.missing || []).filter((id) => !requiredMissing.includes(id))
  const open = manualOpen === null ? requiredMissing.length > 0 : manualOpen

  const copyFix = useCallback(
    async (command) => {
      const ok = await copyText(command)
      if (ok) toast.success('已复制安装命令', '粘贴到 PowerShell 里执行即可')
      else toast.error('复制失败', '请手动选中命令复制')
    },
    [toast],
  )

  const headline = loading && !data ? '检测中…' : `${summary.okCount}/${summary.total} 就绪`

  return (
    <Card
      title="环境体检"
      icon="activity"
      subtitle="这台机器缺不缺工作台要用的东西"
      actions={
        <>
          <span className={`footnote pf__count ${requiredMissing.length > 0 ? 'is-bad' : ''}`}>{headline}</span>
          <Button size="sm" icon="refresh" loading={loading} onClick={() => load(true)}>
            重新检测
          </Button>
          <button
            type="button"
            className="card__toggle"
            aria-expanded={open}
            onClick={() => setManualOpen(!open)}
          >
            <Icon name={open ? 'chevronDown' : 'chevronRight'} size={13} />
            {open ? '收起' : '查看明细'}
          </button>
        </>
      }
    >
      {error ? <ErrorNotice error={error} onRetry={() => load(true).catch(() => {})} retryLabel="重新体检" /> : null}

      {!error && !data && loading ? <div className="pf__loading">正在检测本机依赖（会实际执行命令，约 1-3 秒）…</div> : null}

      {data && open ? (
        <>
          {requiredMissing.length > 0 ? (
            <div className="pf__banner">
              <Icon name="alert" size={13} />
              有 {requiredMissing.length} 项必需组件没就绪，对应功能会不可用。按下面的提示装好，再点「重新检测」。
            </div>
          ) : null}

          <div className="pf__list">
            {items.map((item) => {
              const tone = item.ok ? 'ok' : item.required ? 'bad' : 'warn'
              return (
                <div className={`pf__row is-${tone}`} key={item.id}>
                  <span className={`pf__dot is-${tone}`} />
                  <div className="pf__main">
                    <div className="pf__name">
                      {item.label}
                      {item.required ? null : <span className="pf__opt">可选</span>}
                    </div>
                    <div className="pf__detail">{item.detail || (item.ok ? '可用' : '未检测到')}</div>
                    {!item.ok ? (
                      <div className="pf__fix">
                        <div className="pf__why">{item.why}</div>
                        {item.fix?.text ? <div className="pf__fixtext">{item.fix.text}</div> : null}
                        {item.fix?.command ? (
                          <button
                            type="button"
                            className="pf__cmd"
                            title="点击复制安装命令"
                            onClick={() => copyFix(item.fix.command)}
                          >
                            <Icon name="copy" size={11} />
                            <code>{item.fix.command}</code>
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                  <span className={`pf__state is-${tone}`}>{item.ok ? '就绪' : item.required ? '缺失' : '未装'}</span>
                </div>
              )
            })}
          </div>
        </>
      ) : null}

      {data && !open ? (
        <div className="pf__collapsed">
          {requiredMissing.length === 0
            ? optionalMissing.length === 0
              ? '全部就绪，不需要处理。'
              : `必需项都已就绪；未装的可选项：${items
                  .filter((item) => !item.ok && !item.required)
                  .map((item) => item.label)
                  .join('、')}（不影响其它功能）。`
            : `${requiredMissing.length} 项必需组件缺失，点「查看明细」看怎么装。`}
        </div>
      ) : null}
    </Card>
  )
}

export default PreflightCard
