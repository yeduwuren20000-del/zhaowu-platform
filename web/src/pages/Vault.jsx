import { useCallback, useEffect, useState } from 'react'
import { api } from '../api/client.js'
import { Icon } from '../components/Icons.jsx'
import { Button, Card, EmptyState, Field, Modal, Notice, SkeletonList } from '../components/ui.jsx'
import { PageHint } from '../components/PageHint.jsx'
import { useToast } from '../hooks/useToast.jsx'

/** 复制文本到剪贴板，统一处理降级与提示 */
function copyText(text, toast, okMsg = '已复制') {
  if (!navigator.clipboard?.writeText) {
    toast.error('复制失败，请手动选择')
    return
  }
  navigator.clipboard.writeText(text).then(
    () => toast.success(okMsg),
    () => toast.error('复制失败，请手动选择'),
  )
}

/**
 * 内容默认打码，点一下才显示 —— 避免旁观者一眼看到完整私钥。
 * 多行内容（私钥/证书/服务器清单）展开后每行独立「复制此行」，另有「复制全部」；
 * 单行内容直接显示原值并带复制。长行自动换行（见 .secret-line__text 的 pre-wrap）。
 */
function ContentCell({ content }) {
  const [open, setOpen] = useState(false)
  const toast = useToast()
  if (!content) return <span className="muted">（空）</span>

  const isBlock = content.includes('\n')
  if (!isBlock) {
    return (
      <span className="secret-inline">
        <code className="secret-inline__value">{open ? content : '••••••••'}</code>
        <button type="button" className="secret-inline__toggle" onClick={() => setOpen((p) => !p)} title={open ? '隐藏' : '显示'}>
          <Icon name={open ? 'eye-off' : 'eye'} size={13} />
        </button>
        <button
          type="button"
          className="secret-inline__toggle"
          title="复制"
          onClick={() => copyText(content, toast)}
        >
          <Icon name="copy" size={13} />
        </button>
      </span>
    )
  }

  const lines = content.split('\n')
  const copyLine = (line) => copyText(line, toast, '已复制该行')
  const copyAll = () => copyText(content, toast, `已复制 ${lines.length} 行`)

  return (
    <div className="secret-block">
      <div className="secret-block__bar">
        <Button size="sm" icon={open ? 'eye-off' : 'eye'} onClick={() => setOpen((p) => !p)}>
          {open ? '隐藏' : `显示 ${lines.length} 行`}
        </Button>
        <Button size="sm" icon="copy" onClick={copyAll}>
          复制全部
        </Button>
      </div>
      {open ? (
        <div className="secret-block__lines">
          {lines.map((line, i) => (
            <div className="secret-line" key={i}>
              <div className="secret-line__text">{line || ' '}</div>
              {line.trim() ? (
                <button type="button" className="secret-line__copy" title="复制此行" onClick={() => copyLine(line)}>
                  <Icon name="copy" size={12} />
                </button>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
    </div>
  )
}

/** 编辑框：标题 + 内容。内容支持两种录入方式——多行整块粘贴 / 单行逐条增删改 */
function EntryForm({ initial, onSubmit, onClose, submitting }) {
  const [title, setTitle] = useState(initial?.title || '')
  const [content, setContent] = useState(initial?.content || '')
  const [mode, setMode] = useState(initial?.content?.includes('\n') ? 'multi' : 'single')
  const [lines, setLines] = useState(initial?.content ? initial.content.split('\n') : [])
  const [newLine, setNewLine] = useState('')

  const switchMode = (next) => {
    if (next === mode) return
    if (next === 'single') {
      setLines(content.split('\n'))
    } else {
      setContent(lines.join('\n'))
    }
    setMode(next)
  }

  const addLine = () => {
    const v = newLine.replace(/\r/g, '')
    if (!v) return
    setLines((p) => [...p, v])
    setNewLine('')
  }

  const editLine = (i, v) => setLines((p) => p.map((l, idx) => (idx === i ? v : l)))
  const removeLine = (i) => setLines((p) => p.filter((_, idx) => idx !== i))

  // 提交前的归一：去掉末尾空行
  const finalContent = () => {
    if (mode === 'single') {
      const arr = [...lines]
      while (arr.length && arr[arr.length - 1] === '') arr.pop()
      return arr.join('\n')
    }
    let c = content
    while (c.endsWith('\n')) c = c.slice(0, -1)
    return c
  }

  const hasContent = mode === 'single' ? lines.some((l) => l.trim()) : Boolean(content.trim())

  return (
    <Modal
      open
      title={initial?.id ? '编辑' : '新增'}
      onClose={onClose}
      footer={
        <>
          <Button onClick={onClose}>取消</Button>
          <Button variant="primary" icon="check" loading={submitting} disabled={!title.trim() || !hasContent} onClick={() => onSubmit({ id: initial?.id, title, content: finalContent() })}>
            保存
          </Button>
        </>
      }
    >
      <div className="form-grid">
        <Field label="标题 *" full>
          <input className="input" value={title} placeholder="部门服务器 / 生产机 root 私钥" onChange={(e) => setTitle(e.target.value)} />
        </Field>
        <Field label="内容 *" full hint="多行编辑：整段粘贴私钥/证书或服务器清单；单行编辑：一行一条，逐条加入、修改、删除">
          <div className="entry-tabs">
            <button type="button" className={`entry-tab${mode === 'multi' ? ' is-active' : ''}`} onClick={() => switchMode('multi')}>
              多行编辑
            </button>
            <button type="button" className={`entry-tab${mode === 'single' ? ' is-active' : ''}`} onClick={() => switchMode('single')}>
              单行编辑
            </button>
          </div>
          {mode === 'multi' ? (
            <textarea
              className="textarea"
              rows={9}
              value={content}
              placeholder={'-----BEGIN OPENSSH PRIVATE KEY-----\n…\n-----END OPENSSH PRIVATE KEY-----'}
              onChange={(e) => setContent(e.target.value)}
            />
          ) : (
            <div className="entry-single">
              <div className="entry-single__list">
                {lines.length === 0 ? (
                  <div className="entry-single__empty">还没有内容，在下面加一行</div>
                ) : (
                  lines.map((l, i) => (
                    <div className="entry-single__row" key={i}>
                      <input
                        className="input entry-single__input"
                        value={l}
                        placeholder={`第 ${i + 1} 行`}
                        onChange={(e) => editLine(i, e.target.value)}
                      />
                      <button type="button" className="entry-single__del" title="删除此行" onClick={() => removeLine(i)}>
                        <Icon name="trash" size={13} />
                      </button>
                    </div>
                  ))
                )}
              </div>
              <div className="entry-single__add">
                <input
                  className="input"
                  value={newLine}
                  placeholder="输入一行，回车或点「加入」"
                  onChange={(e) => setNewLine(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') {
                      e.preventDefault()
                      addLine()
                    }
                  }}
                />
                <Button size="sm" icon="plus" onClick={addLine} disabled={!newLine.replace(/\r/g, '').trim()}>
                  加入
                </Button>
              </div>
            </div>
          )}
        </Field>
      </div>
    </Modal>
  )
}

/**
 * 凭据库：只有「标题 + 内容」两个概念。
 * 锁着时只有一个主密码输入框；解锁后列出全部条目。
 */
export function VaultPage() {
  const toast = useToast()
  const [status, setStatus] = useState(null)
  const [loading, setLoading] = useState(true)
  const [password, setPassword] = useState('')
  const [mode, setMode] = useState('recoverable')
  const [unlocking, setUnlocking] = useState(false)
  const [error, setError] = useState('')
  const [entries, setEntries] = useState([])
  const [query, setQuery] = useState('')
  const [form, setForm] = useState({ open: false, initial: null })
  const [saving, setSaving] = useState(false)
  const [pendingDelete, setPendingDelete] = useState(null)

  const refresh = useCallback(async () => {
    try {
      const s = await api.vaultStatus()
      setStatus(s)
      setEntries(s.unlocked ? (await api.vaultEntries()).entries || [] : [])
    } catch (err) {
      setError(err.message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    refresh()
  }, [refresh])

  async function unlock() {
    if (!password) return
    setUnlocking(true)
    setError('')
    try {
      await api.vaultUnlock(password, mode)
      setPassword('')
      await refresh()
      toast.success('已解锁')
    } catch (err) {
      setError(err.message)
    } finally {
      setUnlocking(false)
    }
  }

  async function toggleRecovery(enable) {
    if (!enable && !window.confirm('关闭后如果忘记主密码，凭据将永久无法恢复。确定关闭吗？')) return
    const input = password || window.prompt('请输入当前主密码以确认身份')
    if (!input) return
    try {
      await api.vaultSetRecoveryMode(enable, input)
      setPassword('')
      await refresh()
      toast.success(enable ? '已开启本机找回' : '已关闭本机找回')
    } catch (err) {
      toast.error(err.message)
    }
  }

  async function saveEntry(payload) {
    setSaving(true)
    try {
      await api.vaultSaveEntry(payload)
      setForm({ open: false, initial: null })
      await refresh()
      toast.success('已保存')
    } catch (err) {
      toast.error(err.message)
    } finally {
      setSaving(false)
    }
  }

  async function removeEntry() {
    try {
      await api.vaultDeleteEntry(pendingDelete.id)
      setPendingDelete(null)
      await refresh()
      toast.success('已删除')
    } catch (err) {
      toast.error(err.message)
    }
  }

  const filtered = query
    ? entries.filter((e) => `${e.title} ${e.content}`.toLowerCase().includes(query.toLowerCase()))
    : entries

  // 首屏：骨架屏描出列表形状，避免裸转圈
  if (loading) {
    return (
      <div className="page">
        <div className="page__header">
          <div className="page__title">凭据库</div>
        </div>
        <div className="card">
          <SkeletonList rows={3} />
        </div>
      </div>
    )
  }

  // ---- 锁态 ----
  if (!status?.unlocked) {
    const isFirstTime = !status?.exists
    return (
      <div className="page">
        <div className="page__header">
          <div className="page__title">凭据库</div>
        </div>
        <Card>
          <div className="vault-lock">
            <Icon name="shield" size={22} />
            <div className="vault-lock__title">{isFirstTime ? '设置主密码' : '输入主密码解锁'}</div>
            <div className="vault-lock__hint">
              {isFirstTime
                ? '主密码不会保存。第一次用，可以选是否额外生成一把本机恢复密钥。'
                : `${status.entryCount} 条凭据以密文保存在磁盘上，解锁后才能查看`}
            </div>

            {isFirstTime ? (
              <div className="vault-modes">
                <label className={`vault-mode ${mode === 'offline' ? 'is-picked' : ''}`}>
                  <input type="radio" name="recovery" checked={mode === 'offline'} onChange={() => setMode('offline')} />
                  <div className="vault-mode__body">
                    <div className="vault-mode__title">不存任何密码</div>
                    <div className="vault-mode__desc">
                      只存在你脑子里。密码忘了 = <strong>数据永久无法恢复</strong>。
                    </div>
                  </div>
                </label>
                <label className={`vault-mode ${mode === 'recoverable' ? 'is-picked' : ''}`}>
                  <input type="radio" name="recovery" checked={mode === 'recoverable'} onChange={() => setMode('recoverable')} />
                  <div className="vault-mode__body">
                    <div className="vault-mode__title">本机可找回（推荐）</div>
                    <div className="vault-mode__desc">
                      额外生成一把用 Windows 加密的恢复密钥，<strong>同一台电脑、同一账户</strong>可以找回。
                    </div>
                  </div>
                </label>
                <p className="vault-mode__note">
                  恢复密钥<strong>恢复不了主密码本身</strong>；它防的是凭据文件被拷走后被解开。
                </p>
              </div>
            ) : null}

            <div className="vault-lock__form">
              <input
                className="input"
                type="password"
                value={password}
                placeholder="主密码"
                autoFocus
                onChange={(e) => setPassword(e.target.value)}
                onKeyDown={(e) => e.key === 'Enter' && unlock()}
              />
              <Button variant="primary" icon="check" loading={unlocking} disabled={!password} onClick={unlock}>
                {isFirstTime ? '创建' : '解锁'}
              </Button>
            </div>

            {error ? <p className="vault-lock__error">{error}</p> : null}
            {status?.header ? (
              <p className="vault-lock__meta">
                {status.header.cipher.toUpperCase()} · PBKDF2 {status.header.iterations.toLocaleString()} 次
              </p>
            ) : null}
          </div>
        </Card>
      </div>
    )
  }

  // ---- 解锁态 ----
  return (
    <div className="page">
      <div className="page__header">
        <div className="page__title">凭据库</div>
        <div className="page__actions">
          <input
            className="input vault-search"
            value={query}
            placeholder="搜索标题或内容"
            onChange={(e) => setQuery(e.target.value)}
          />
          <Button icon="lock" onClick={async () => { await api.vaultLock().catch(() => {}); setEntries([]); setQuery(''); await refresh(); toast.info('已锁定') }}>
            锁定
          </Button>
          <Button variant="primary" icon="plus" onClick={() => setForm({ open: true, initial: null })}>
            新增
          </Button>
        </div>
      </div>

      {/* 每页一次性提示：新手落地第一眼就知道这页是干嘛的（见 PageHint） */}
      <PageHint id="vault" icon="shield">
        密码 / 私钥 / Token 都存这：磁盘上只有密文，主密码只在内存里，内容默认打码、点开才显示。离开时点「锁定」即清除内存。
      </PageHint>

      <Notice tone={status?.recovery?.canRecover ? 'info' : 'warn'} icon="shield">
        磁盘上只有密文，主密码只在内存里，点「锁定」立即清除。
        {status?.recovery?.canRecover ? ' 当前可在本机找回。' : ' 当前无法找回。'}
        {' '}
        <button type="button" className="vault-linkbtn" onClick={() => toggleRecovery(!status?.recovery?.canRecover)}>
          {status?.recovery?.canRecover ? '关闭本机找回' : '开启本机找回'}
        </button>
      </Notice>

      {entries.length === 0 ? (
        <Card>
          <EmptyState
            title="还没有内容"
            hint="标题加一段内容就够了：私钥、密码、Token、证书都能贴。"
            action={
              <Button variant="primary" icon="plus" onClick={() => setForm({ open: true, initial: null })}>
                新增第一条
              </Button>
            }
          />
        </Card>
      ) : filtered.length === 0 ? (
        <Card>
          <EmptyState title={`没有匹配「${query}」的内容`} />
        </Card>
      ) : (
        <div className="vault-list">
          {filtered.map((entry) => (
            <div key={entry.id} className="vault-item">
              <div className="vault-item__head">
                <span className="vault-item__title">{entry.title}</span>
                <span className="spacer" />
                <Button size="sm" icon="edit" onClick={() => setForm({ open: true, initial: entry })}>
                  编辑
                </Button>
                <Button size="sm" icon="trash" onClick={() => setPendingDelete(entry)}>
                  删除
                </Button>
              </div>
              <ContentCell content={entry.content} />
            </div>
          ))}
        </div>
      )}

      {form.open ? (
        <EntryForm
          initial={form.initial}
          submitting={saving}
          onClose={() => setForm({ open: false, initial: null })}
          onSubmit={saveEntry}
        />
      ) : null}

      <Modal
        open={Boolean(pendingDelete)}
        title="删除"
        onClose={() => setPendingDelete(null)}
        footer={
          <>
            <Button onClick={() => setPendingDelete(null)}>取消</Button>
            <Button variant="danger" icon="trash" onClick={removeEntry}>
              确认删除
            </Button>
          </>
        }
      >
        <p>确认删除「{pendingDelete?.title}」？删除后无法恢复。</p>
      </Modal>
    </div>
  )
}

export default VaultPage