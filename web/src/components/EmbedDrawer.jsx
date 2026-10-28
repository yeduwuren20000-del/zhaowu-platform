import { useEffect, useRef, useState } from 'react'
import { api } from '../api/client.js'
import { Icon } from './Icons.jsx'

/**
 * 内嵌抽屉：在工作台内部用 iframe 打开项目页面，不再开新浏览器窗口。
 *
 * 为什么这样做：新开窗口时浏览器要先建窗口、白色画布先画出来，再等页面首帧，
 * 这段等待就是"闪白"。同页 iframe 没有建窗这一步，容器本身就是深色底。
 *
 * 还有一处暗坑：目标没在监听时，浏览器会渲染自己的错误页（浅灰 r≈221），
 * 那片浅灰同样是刺眼的"白"。所以打开前先问一次端口活着没有，
 * 不通就根本不加载 iframe，直接给出可操作的提示。
 */

/** 遮罩在页面 load 之后至少还要压住的时间（毫秒） */
const MIN_VEIL = 350

/** 从地址里抠出端口，抠不到返回 null */
function portOf(url) {
  try {
    const u = new URL(url)
    if (u.port) return Number(u.port)
    return u.protocol === 'https:' ? 443 : 80
  } catch {
    return null
  }
}

export function EmbedDrawer({ target, onClose }) {
  const [phase, setPhase] = useState('probing') // probing | loading | ready | down | blocked
  const [elapsed, setElapsed] = useState(0)
  // load 事件常常早于首帧绘制完成，立刻撤遮罩会露出应用页面自己的白底。
  // onLoad 之后至少再压 MIN_VEIL 毫秒，让页面把首帧画稳再交给用户。
  const [loadedAt, setLoadedAt] = useState(0)
  const frameRef = useRef(null)

  const url = target?.url || ''
  const key = target?.key || ''
  const port = portOf(url)

  // 换目标 / 重开：先探活，再决定加不加载
  useEffect(() => {
    if (!url) return undefined
    setPhase('probing')
    setElapsed(0)
    setLoadedAt(0) // 重开同一目标也要重新计遮罩时长，否则第二次会"一开就撤遮罩"
    let alive = true

    if (!port) {
      setPhase('loading')
      return () => {
        alive = false
      }
    }

    api
      .scanPort(port)
      .then((data) => {
        if (!alive) return
        setPhase(data?.listening ? 'loading' : 'down')
      })
      .catch(() => {
        // 探活自身失败不该拦住用户：让它试着加载，还有超时兜底
        if (alive) setPhase('loading')
      })

    return () => {
      alive = false
    }
  }, [url, key, port])

  // 遮罩最短停留：load 后压够时间再撤
  useEffect(() => {
    if (!loadedAt) return undefined
    const rest = Math.max(0, MIN_VEIL - (Date.now() - loadedAt))
    const t = setTimeout(() => setPhase('ready'), rest)
    return () => clearTimeout(t)
  }, [loadedAt])

  // Esc 关闭
  useEffect(() => {
    if (!url) return undefined
    function onKey(event) {
      if (event.key === 'Escape') onClose?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [url, onClose])

  // 探测 / 加载计时
  useEffect(() => {
    if (phase !== 'loading' && phase !== 'probing') return undefined
    const start = Date.now()
    const timer = setInterval(() => setElapsed(Math.round((Date.now() - start) / 100) / 10), 100)
    return () => clearInterval(timer)
  }, [phase])

  // 加载超时兜底：8 秒还没 load 就给显式出口，不让人一直转圈
  useEffect(() => {
    if (phase !== 'loading') return undefined
    const timer = setTimeout(() => setPhase('blocked'), 8000)
    return () => clearTimeout(timer)
  }, [phase])

  if (!url) return null

  const showFrame = phase === 'loading' || phase === 'ready' || phase === 'blocked'

  return (
    <div className="embed-mask" onMouseDown={(event) => event.target === event.currentTarget && onClose?.()}>
      <div className="embed-shell" role="dialog" aria-modal="true" aria-label={target.name || '应用预览'}>
        <header className="embed-head">
          <span className="embed-head__title">
            <Icon name="external" size={14} />
            <b>{target.name || '应用'}</b>
            <span className="embed-head__url muted">{url}</span>
          </span>
          <span className="embed-head__actions">
            <a className="btn btn--sm" href={url} target="_blank" rel="noopener noreferrer" title="用默认浏览器打开（新窗口）">
              <Icon name="external" size={13} /> 新窗口
            </a>
            <button type="button" className="btn btn--sm" onClick={() => onClose?.()} title="关闭（Esc）">
              <Icon name="x" size={13} /> 关闭
            </button>
          </span>
        </header>

        <div className="embed-body">
          {/* 服务没在跑：不加载 iframe（否则会看到浏览器那张浅灰错误页） */}
          {phase === 'down' ? (
            <div className="embed-notice">
              <Icon name="alert" size={18} />
              <div>
                <b>这个服务现在没在运行</b>
                <p className="muted">
                  端口 {port} 没有监听，所以还没有页面可以打开。先在工作台里点「启动」，起来之后再打开这里就有内容了。
                </p>
                <p className="muted">
                  地址：<code>{url}</code>
                </p>
              </div>
            </div>
          ) : null}

          {phase === 'probing' ? (
            <div className="embed-loading">
              <span className="spinner" />
              <span>正在检查端口…</span>
            </div>
          ) : null}

          {showFrame ? (
            <iframe
              ref={frameRef}
              src={url}
              title={target.name || '应用预览'}
              className="embed-frame"
              onLoad={() => setLoadedAt(Date.now())}
              allow="clipboard-read; clipboard-write; fullscreen"
            />
          ) : null}

          {/* 加载遮罩压在 iframe 之上：应用自己的页面可能是白底（白底极常见），
              在它还没画完之前，这块深色遮罩把整个区域盖住，用户看不到任何白。
              load 之后淡出、延迟卸载，避免遮罩闪一下就走。 */}
          {phase === 'loading' || phase === 'blocked' ? (
            <div className="embed-loading">
              <span className="spinner" />
              <span>
                正在载入 {target.name || '应用'}
                {elapsed > 0.3 ? ` · ${elapsed.toFixed(1)}s` : ''}
              </span>
              {phase === 'blocked' ? (
                <span className="embed-loading__hint">
                  载入较慢，或此站点禁止内嵌。
                  <a href={url} target="_blank" rel="noopener noreferrer">在浏览器打开</a>
                </span>
              ) : null}
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
