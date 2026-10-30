import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api } from '../api/client.js'
import { statusMeta } from '../utils/format.js'
import { Icon } from './Icons.jsx'
import { useToast } from '../hooks/useToast.jsx'
import { useEmbed } from '../hooks/useEmbed.jsx'

/**
 * 全局命令面板（Ctrl/Cmd + K）：
 *   1. 命令      —— 不输入也能用：跳页面、新增、刷新
 *   2. 搜索      —— 项目 / 服务器 / 端口 / 路径
 *   3. 直接动作  —— 对命中的项目就地「启动 / 停止 / 打开目录 / 打开网页 / 看日志」
 *   4. 键盘操作  —— ↑↓ 选择、Enter 执行、Esc 关闭
 *
 * 目标：日常操作不必在菜单里找，输入即可直达。
 */
/**
 * 默认展示的命令顺序 = 新用户最可能做的几件事（空输入时只展示前几条）。
 * 顺序即优先级：先"看看现在有什么在跑"，再"加新的"，最后才是低频的跳转。
 */
const COMMANDS = [
  { id: 'act-discover', title: '自动发现本机服务', hint: '扫描监听端口并按目录聚合', icon: 'search', run: (navigate) => navigate('/projects', { state: { discovery: true } }) },
  { id: 'act-add-project', title: '新增本地项目', hint: '登记目录与启动命令', icon: 'plus', run: (navigate) => navigate('/projects', { state: { create: true } }) },
  { id: 'nav-projects', title: '打开本地项目', hint: '启动 / 停止', icon: 'folder', run: (navigate) => navigate('/projects') },
  { id: 'act-add-server', title: '新增服务器', hint: 'SSH 只读采集', icon: 'plus', run: (navigate) => navigate('/servers', { state: { create: true } }) },
  { id: 'nav-dashboard', title: '打开总览', hint: '现在怎么样', icon: 'dashboard', run: (navigate) => navigate('/') },
  { id: 'nav-servers', title: '打开服务器', hint: '远程资源', icon: 'server', run: (navigate) => navigate('/servers') },
  { id: 'nav-docker', title: '打开 Docker', hint: '本机容器', icon: 'layers', run: (navigate) => navigate('/docker') },
  { id: 'nav-ports', title: '打开服务端口', hint: '端口被谁占了', icon: 'ports', run: (navigate) => navigate('/ports') },
  { id: 'nav-wsl', title: '打开 WSL', hint: '子系统里的服务', icon: 'box', run: (navigate) => navigate('/wsl') },
  { id: 'nav-pans', title: '打开网盘直链', hint: '解析分享链接', icon: 'link', run: (navigate) => navigate('/pans') },
  { id: 'nav-converter', title: '打开文档转换', hint: '本地 Stirling-PDF', icon: 'fileText', run: (navigate) => navigate('/converter') },
  { id: 'nav-uptime', title: '打开服务监控', hint: 'Uptime Kuma 掉线告警', icon: 'activity', run: (navigate) => navigate('/uptime') },
  { id: 'nav-vault', title: '打开凭据库', hint: '密码 / 密钥', icon: 'shield', run: (navigate) => navigate('/vault') },
  { id: 'nav-logs', title: '打开日志', hint: '进程输出', icon: 'terminal', run: (navigate) => navigate('/logs') },
  { id: 'nav-timeline', title: '打开时间线', hint: '刚才发生了什么', icon: 'clock', run: (navigate) => navigate('/timeline') },
  { id: 'nav-settings', title: '打开设置', hint: '数据与凭据', icon: 'settings', run: (navigate) => navigate('/settings') },
]

/** 空输入时展示的命令条数 */
const DEFAULT_COMMAND_COUNT = 5

export function GlobalSearch() {
  const navigate = useNavigate()
  const toast = useToast()
  const embed = useEmbed()
  const [query, setQuery] = useState('')
  const [result, setResult] = useState(null)
  const [open, setOpen] = useState(false)
  const [loading, setLoading] = useState(false)
  const [cursor, setCursor] = useState(0)
  const [busyId, setBusyId] = useState('')
  const inputRef = useRef(null)
  const boxRef = useRef(null)
  const listRef = useRef(null)

  useEffect(() => {
    const onKey = (event) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault()
        inputRef.current?.focus()
        inputRef.current?.select()
        setOpen(true)
      }
      if (event.key === 'Escape') {
        setOpen(false)
        inputRef.current?.blur()
      }
    }
    const onClick = (event) => {
      if (boxRef.current && !boxRef.current.contains(event.target)) setOpen(false)
    }
    window.addEventListener('keydown', onKey)
    window.addEventListener('mousedown', onClick)
    return () => {
      window.removeEventListener('keydown', onKey)
      window.removeEventListener('mousedown', onClick)
    }
  }, [])

  // 远端搜索：只有输入时才请求
  useEffect(() => {
    const text = query.trim()
    if (!text) {
      setResult(null)
      return undefined
    }
    setLoading(true)
    const timer = setTimeout(async () => {
      try {
        setResult(await api.search(text))
      } catch {
        setResult(null)
      } finally {
        setLoading(false)
      }
    }, 220)
    return () => clearTimeout(timer)
  }, [query])

  /** 对项目直接执行动作 */
  const runProjectAction = useCallback(
    async (project, action) => {
      setBusyId(`${project.id}:${action}`)
      try {
        if (action === 'start' || action === 'stop') {
          await api[action === 'start' ? 'startProject' : 'stopProject'](project.id)
          toast.success(action === 'start' ? `已启动 ${project.name}` : `已停止 ${project.name}`)
          setOpen(false)
          setQuery('')
        } else if (action === 'url') {
          const url = project.url || (project.port ? `http://localhost:${project.port}` : '')
          if (!url) {
            toast.warn('该项目没有访问地址', '编辑项目补充 url 或端口')
            return
          }
          // 和项目页 / 端口页一致：内部项目地址走内嵌抽屉，不再开新窗口闪白
          setOpen(false)
          setQuery('')
          embed.openEmbed({ url, name: project.name })
        } else if (action === 'log') {
          navigate('/logs', { state: { source: `project:${project.id}` } })
          setOpen(false)
        }
      } catch (error) {
        toast.error('操作失败', error.message)
      } finally {
        setBusyId('')
      }
    },
    [navigate, toast, embed],
  )

  const text = query.trim().toLowerCase()

  // 命令：空输入时给全部（挑常用 5 个），有输入时按关键字过滤
  const commandGroups = useMemo(() => {
    const match = COMMANDS.filter(
      (cmd) => !text || cmd.title.toLowerCase().includes(text) || (cmd.hint || '').toLowerCase().includes(text),
    )
    const list = !text ? match.slice(0, DEFAULT_COMMAND_COUNT) : match
    return list.length ? [{ key: 'commands', title: '命令', items: list }] : []
  }, [text])

  const searchGroups = useMemo(() => {
    if (!result) return []
    const list = []
    if (result.projects?.length) {
      list.push({
        key: 'projects',
        title: '本地项目',
        items: result.projects.slice(0, 5).map((project) => ({
          id: project.id,
          title: project.name,
          tags: [statusMeta(project.status).text, project.port ? `:${project.port}` : '未记录端口'],
          sub: project.dir,
          running: project.status === 'running' || project.status === 'starting',
          project,
          go: () => navigate('/projects', { state: { q: query, focus: project.id } }),
        })),
      })
    }
    if (result.servers?.length) {
      list.push({
        key: 'servers',
        title: '服务器资产',
        items: result.servers.slice(0, 4).flatMap((hit) =>
          hit.apps.length
            ? hit.apps.map((app) => ({
                id: `${hit.server.id}-${app.id}`,
                title: `${hit.server.name} · ${app.name}`,
                tags: [statusMeta(app.status).text, app.port ? `:${app.port}` : '未记录端口', hit.server.host],
                sub: app.deployPath || hit.server.os,
                go: () => navigate('/servers', { state: { q: query, focus: hit.server.id } }),
              }))
            : [
                {
                  id: hit.server.id,
                  title: hit.server.name,
                  tags: [hit.server.online ? '在线' : '离线', hit.server.host, hit.server.os],
                  sub: hit.server.remark,
                  go: () => navigate('/servers', { state: { q: query, focus: hit.server.id } }),
                },
              ],
        ),
      })
    }
    if (result.ports?.length) {
      list.push({
        key: 'ports',
        title: '服务端口',
        items: result.ports.slice(0, 6).map((row) => ({
          id: row.key,
          title: row.port ? `${row.port} · ${row.app}` : row.app,
          tags: [row.env, statusMeta(row.status).text],
          sub: row.path || row.host,
          go: () => navigate('/ports', { state: { q: query } }),
        })),
      })
    }
    return list
  }, [result, navigate, query])

  // 扁平化用于键盘导航
  const flat = useMemo(() => {
    const out = []
    for (const group of [...commandGroups, ...searchGroups]) {
      for (const item of group.items) out.push({ group, item })
    }
    return out
  }, [commandGroups, searchGroups])

  useEffect(() => setCursor(0), [query])

  // ↑↓ / Enter 键盘操作
  useEffect(() => {
    if (!open) return undefined
    const onKey = (event) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault()
        setCursor((prev) => (prev + 1) % Math.max(1, flat.length))
      } else if (event.key === 'ArrowUp') {
        event.preventDefault()
        setCursor((prev) => (prev - 1 + flat.length) % Math.max(1, flat.length))
      } else if (event.key === 'Enter') {
        const entry = flat[cursor]
        if (entry) {
          event.preventDefault()
          entry.item.run ? entry.item.run(navigate) : entry.item.go()
          setOpen(false)
          setQuery('')
        }
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, cursor, flat, navigate])

  const total = flat.length

  return (
    <div className="topbar__search" ref={boxRef}>
      <div className="search-input">
        <Icon name="search" size={15} style={{ color: 'var(--muted)' }} />
        <input
          ref={inputRef}
          value={query}
          placeholder="搜索或输入命令…（↑↓ 选择，Enter 执行）"
          onChange={(event) => {
            setQuery(event.target.value)
            setOpen(true)
          }}
          onFocus={() => setOpen(true)}
        />
        {loading ? <span className="spinner" /> : null}
        <span className="kbd">Ctrl K</span>
      </div>

      {open ? (
        <div className="search-pop">
          {total === 0 ? (
            <div className="search-pop__empty">{loading ? '搜索中…' : `没有匹配「${query}」的命令或记录`}</div>
          ) : (
            <>
              {[...commandGroups, ...searchGroups].map((group) => (
                <div key={group.key}>
                  <div className="search-pop__group">{group.title}</div>
                  {group.items.map((item) => {
                    const index = flat.findIndex((entry) => entry.item === item)
                    const isCursor = index === cursor
                    return (
                      <div
                        key={item.id}
                        className={`search-pop__item ${isCursor ? 'is-cursor' : ''}`}
                        onMouseEnter={() => setCursor(index)}
                        onClick={() => {
                          item.run ? item.run(navigate) : item.go()
                          setOpen(false)
                          setQuery('')
                        }}
                      >
                        <div className="search-pop__item-main">
                          <div className="search-pop__item-title">
                            {item.icon ? <Icon name={item.icon} size={13} style={{ marginRight: 6, color: 'var(--muted)' }} /> : null}
                            {item.title}
                            {item.tags?.filter(Boolean).length ? (
                              <span className="search-pop__tags">{item.tags.filter(Boolean).join(' · ')}</span>
                            ) : null}
                          </div>
                          {item.sub ? <div className="search-pop__item-sub">{item.sub}</div> : null}
                        </div>

                        {/* 项目命中：就地给常用动作，省得跳过去再点 */}
                        {item.project ? (
                          <div className="search-pop__actions" onClick={(event) => event.stopPropagation()}>
                            <button
                              type="button"
                              className="btn btn--sm"
                              disabled={Boolean(busyId)}
                              onClick={() => runProjectAction(item.project, item.running ? 'stop' : 'start')}
                            >
                              <Icon name={item.running ? 'stop' : 'play'} size={12} />
                              {item.running ? '停止' : '启动'}
                            </button>
                            <button type="button" className="icon-button icon-button--sm" title="打开网页" onClick={() => runProjectAction(item.project, 'url')}>
                              <Icon name="external" size={13} />
                            </button>
                            <button type="button" className="icon-button icon-button--sm" title="查看日志" onClick={() => runProjectAction(item.project, 'log')}>
                              <Icon name="fileText" size={13} />
                            </button>
                          </div>
                        ) : null}
                      </div>
                    )
                  })}
                </div>
              ))}
            </>
          )}
        </div>
      ) : null}
    </div>
  )
}