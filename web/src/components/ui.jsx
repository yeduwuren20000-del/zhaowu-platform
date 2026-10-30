import { useEffect, useRef, useState } from 'react'
import { Icon } from './Icons.jsx'
import { statusMeta } from '../utils/format.js'
import { friendlyError } from '../utils/errors.js'

export function Button({ children, variant = 'default', size = 'md', icon, loading = false, className = '', ...rest }) {
  const classes = ['btn', variant !== 'default' ? `btn--${variant}` : '', size === 'sm' ? 'btn--sm' : '', className]
    .filter(Boolean)
    .join(' ')
  return (
    <button type="button" className={classes} disabled={loading || rest.disabled} {...rest}>
      {loading ? <span className="spinner" /> : icon ? <Icon name={icon} size={size === 'sm' ? 13 : 14} /> : null}
      {children}
    </button>
  )
}

export function IconButton({ icon, title, onClick, disabled }) {
  return (
    <button type="button" className="icon-button" title={title} onClick={onClick} disabled={disabled}>
      <Icon name={icon} size={15} />
    </button>
  )
}

export function StatusDot({ status }) {
  return <span className={`status-dot status-dot--${status || 'unknown'}`} />
}

export function statusLabel(status) {
  return statusMeta(status).text
}

export function Card({ title, subtitle, icon, actions, children, flush = false, className = '' }) {
  return (
    <section className={`card ${className}`}>
      {title || actions ? (
        <header className="card__header">
          <div className="card__title">
            {icon ? <Icon name={icon} size={15} /> : null}
            {title}
            {subtitle ? <span className="card__title-sub">{subtitle}</span> : null}
          </div>
          {actions ? <div className="card__actions">{actions}</div> : null}
        </header>
      ) : null}
      <div className={`card__body ${flush ? 'card__body--flush' : ''}`}>{children}</div>
    </section>
  )
}

export function EmptyState({ title = '暂无数据', hint, action, icon = 'box' }) {
  return (
    <div className="empty">
      <div className="empty__icon">
        <Icon name={icon} size={24} />
      </div>
      <div className="empty__title">{title}</div>
      {hint ? <div>{hint}</div> : null}
      {action ? <div style={{ marginTop: 12 }}>{action}</div> : null}
    </div>
  )
}

export function Loading({ text = '加载中…' }) {
  return (
    <div className="loading-row">
      <span className="spinner" />
      {text}
    </div>
  )
}

/**
 * 骨架屏：首屏加载时用占位块描出内容的形状，而不是干等一个转圈。
 * 形状贴合各自的列表（标题行 + 细节行），数据到位后整体替换——
 * 页面不会先空一下再跳出来，观感上"一直在加载"。
 */
export function Skeleton({ width = '100%', height = 12 }) {
  return <span className="skel" style={{ width, height }} />
}

/** 列表骨架：贴合「项目行 / 服务器行」的形状（名称 + 两行细节） */
export function SkeletonList({ rows = 4 }) {
  return (
    <div className="skel-list">
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="skel-list__row">
          <Skeleton width="32%" height={14} />
          <Skeleton width="58%" height={10} />
          <Skeleton width="44%" height={10} />
        </div>
      ))}
    </div>
  )
}

/** 日志骨架：左窄右宽的一行行占位，贴合日志面板 */
export function SkeletonLines({ rows = 8 }) {
  return (
    <div className="skel-list">
      {Array.from({ length: rows }).map((_, index) => (
        <div key={index} className="skel-list__row">
          <Skeleton width={`${55 + ((index * 13) % 40)}%`} height={10} />
        </div>
      ))}
    </div>
  )
}

export function Notice({ tone = 'info', icon = 'alert', children }) {
  return (
    <div className={`notice notice--${tone}`}>
      <Icon name={icon} size={14} style={{ marginTop: 2, flex: '0 0 auto' }} />
      <div>{children}</div>
    </div>
  )
}

/**
 * 统一的数据错误展示：把技术错误翻译成新手能行动的话（见 friendlyError），
 * 带「重试」按钮和折叠的技术详情。
 * 取代过去散落各页的「读取XX失败：{error.message}」——那种文案对新手等于没写，
 * 而且没有重试，用户唯一的出路是刷新整个页面。
 */
export function ErrorNotice({ error, onRetry, retryLoading = false, retryLabel = '重试' }) {
  const friendly = friendlyError(error)
  return (
    <Notice tone="error" icon="alert">
      <div className="err">
        <div className="err__title">{friendly.title}</div>
        <div className="err__hint">{friendly.hint}</div>
        <div className="err__actions">
          {onRetry ? (
            <Button size="sm" variant="primary" icon="refresh" loading={retryLoading} onClick={onRetry}>
              {retryLabel}
            </Button>
          ) : null}
        </div>
        {friendly.detail ? (
          <details className="err__detail">
            <summary>技术详情</summary>
            <code>{friendly.detail}</code>
          </details>
        ) : null}
      </div>
    </Notice>
  )
}

export function Modal({ open, title, icon, onClose, children, footer, size = 'md' }) {
  useEffect(() => {
    if (!open) return undefined
    const onKey = (event) => {
      if (event.key === 'Escape') onClose?.()
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null
  return (
    <div className="modal-overlay" onMouseDown={(event) => event.target === event.currentTarget && onClose?.()}>
      <div className={`modal ${size === 'sm' ? 'modal--sm' : ''}`}>
        <header className="modal__header">
          {icon ? <Icon name={icon} size={15} /> : null}
          <div className="modal__title">{title}</div>
          <div className="spacer" />
          <IconButton icon="x" title="关闭" onClick={onClose} />
        </header>
        <div className="modal__body">{children}</div>
        {footer ? <footer className="modal__footer">{footer}</footer> : null}
      </div>
    </div>
  )
}

export function ConfirmDialog({ open, title, message, confirmText = '确认删除', onConfirm, onClose, loading, secondary = null }) {
  return (
    <Modal
      open={open}
      title={title}
      icon="alert"
      size="sm"
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          {secondary ? (
            <Button icon="stop" loading={secondary.loading} onClick={secondary.onClick}>
              {secondary.label}
            </Button>
          ) : null}
          <Button variant="danger" icon="trash" loading={loading} onClick={onConfirm}>
            {confirmText}
          </Button>
        </>
      }
    >
      <div style={{ color: 'var(--text-soft)', fontSize: 13 }}>{message}</div>
    </Modal>
  )
}

export function Switch({ checked, onChange, label }) {
  return (
    <span className={`switch ${checked ? 'is-on' : ''}`} onClick={() => onChange(!checked)}>
      <span className="switch__track" />
      {label}
    </span>
  )
}

export function Tabs({ value, onChange, options }) {
  return (
    <div className="tabs">
      {options.map((option) => {
        // 「全部」这类不筛选项用 is-all 区分：视觉更轻，避免和具体筛选条件抢注意力
        const isAll = option.value === 'all'
        return (
          <button
            key={option.value}
            type="button"
            className={`tab ${isAll ? 'tab--all' : ''} ${option.value === value ? 'is-active' : ''}`}
            onClick={() => onChange(option.value)}
          >
            {option.label}
            {option.count !== undefined ? ` ${option.count}` : ''}
          </button>
        )
      })}
    </div>
  )
}

export function SearchBox({ value, onChange, placeholder = '搜索…', width }) {
  return (
    <span className="search-inline" style={width ? { minWidth: width } : undefined}>
      <Icon name="search" size={14} style={{ color: 'var(--muted)' }} />
      <input value={value} placeholder={placeholder} onChange={(event) => onChange(event.target.value)} />
      {value ? (
        <button type="button" className="link" onClick={() => onChange('')}>
          清除
        </button>
      ) : null}
    </span>
  )
}

export function Field({ label, hint, full = false, children }) {
  return (
    <label className={`field ${full ? 'field--full' : ''}`}>
      <span className="field__label">{label}</span>
      {children}
      {hint ? <span className="field__hint">{hint}</span> : null}
    </label>
  )
}

const TONE_COLOR = {
  green: 'var(--green)',
  blue: 'var(--blue)',
  amber: 'var(--amber)',
  red: 'var(--red)',
  purple: 'var(--purple)',
  cyan: 'var(--cyan)',
  gray: 'var(--muted-2)',
}

/** 资源占用条：默认中性，只有真的偏高才变色 */
export function Meter({ label, percent, value, hint, tone = 'gray', width }) {
  const safePercent = Number.isFinite(Number(percent)) ? Math.max(0, Math.min(100, Number(percent))) : null
  return (
    <div className="meter" style={width ? { width } : undefined}>
      <div className="meter__head">
        <span className="meter__label">{label}</span>
        <span className="meter__value" style={tone !== 'gray' ? { color: TONE_COLOR[tone] } : undefined}>
          {value ?? (safePercent === null ? '—' : `${safePercent.toFixed(0)}%`)}
        </span>
      </div>
      <div className="meter__track">
        <div
          className="meter__fill"
          style={{ width: `${safePercent ?? 0}%`, background: tone === 'gray' ? undefined : TONE_COLOR[tone] }}
        />
      </div>
      {hint ? <div className="meter__hint">{hint}</div> : null}
    </div>
  )
}

/** 服务器资源/端口/日志区块用的小标签组 */
export function Fact({ icon, label, value, tone }) {
  return (
    <span className="fact" title={label}>
      {icon ? <Icon name={icon} size={12} /> : null}
      <span className="fact__label">{label}</span>
      <b style={tone ? { color: TONE_COLOR[tone] } : undefined}>{value}</b>
    </span>
  )
}

/**
 * 通用下拉菜单：把低频操作收进「⋯」，让一行只留主操作。
 * 自动处理「点击外部关闭」与「Esc 关闭」，避免各处重复实现。
 *
 * items: [{ key, label, icon, hint, danger?, disabled?, onClick }]
 */
export function Menu({ trigger, items, align = 'right', width = 200, label = '更多操作' }) {
  const [open, setOpen] = useState(false)
  const ref = useRef(null)

  useEffect(() => {
    if (!open) return undefined
    const onDown = (event) => {
      if (ref.current && !ref.current.contains(event.target)) setOpen(false)
    }
    const onKey = (event) => {
      if (event.key === 'Escape') setOpen(false)
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [open])

  return (
    <div className="menu-wrap" ref={ref}>
      {trigger({ open, toggle: () => setOpen((prev) => !prev), ariaLabel: label })}
      {open ? (
        <div className={`menu menu--${align}`} style={{ minWidth: width }}>
          {items.map((item) => (
            <button
              key={item.key}
              type="button"
              className={`menu__item ${item.danger ? 'menu__item--danger' : ''}`}
              disabled={item.disabled}
              onClick={() => {
                setOpen(false)
                item.onClick?.()
              }}
            >
              {item.icon ? <Icon name={item.icon} size={14} /> : <span className="menu__spacer" />}
              <span className="menu__label">{item.label}</span>
              {item.hint ? <span className="menu__hint">{item.hint}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  )
}
