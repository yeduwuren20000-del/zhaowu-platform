import { useEffect, useRef, useState } from 'react'
import { NavLink, Outlet, useLocation, useNavigate } from 'react-router-dom'
import { GlobalSearch } from './GlobalSearch.jsx'
import { HelpModal } from './HelpModal.jsx'
import { Icon } from './Icons.jsx'
import { ErrorBoundary } from './ErrorBoundary.jsx'

/**
 * 全部入口平铺：藏进"更多"等于让人找不到，宁可侧栏长一点。
 * 用轻量分组标题分段（常用 / 工具 / 记录），11 项也一眼扫得完。
 */
const NAV_GROUPS = [
  {
    title: '常用',
    items: [
      { to: '/', label: '总览', icon: 'dashboard', end: true, hint: '现在怎么样' },
      { to: '/projects', label: '本地项目', icon: 'folder', hint: '启动 / 停止' },
      { to: '/servers', label: '服务器', icon: 'server', hint: '远程资源' },
      { to: '/docker', label: 'Docker', icon: 'layers', hint: '容器' },
    ],
  },
  {
    title: '工具',
    items: [
      { to: '/ports', label: '服务端口', icon: 'ports', hint: '谁占了端口' },
      { to: '/wsl', label: 'WSL', icon: 'box', hint: '子系统' },
      { to: '/pans', label: '网盘直链', icon: 'link', hint: '解析下载' },
      { to: '/media', label: '本地影院', icon: 'play', hint: '海报墙 / 聚合' },
      { to: '/converter', label: '文档转换', icon: 'fileText', hint: 'PDF / Office' },
      { to: '/uptime', label: '服务监控', icon: 'activity', hint: '掉线告警' },
      { to: '/vault', label: '凭据库', icon: 'shield', hint: '密码 / 密钥' },
    ],
  },
  {
    title: '记录',
    items: [
      { to: '/logs', label: '日志', icon: 'terminal', hint: '运行输出' },
      { to: '/timeline', label: '时间线', icon: 'clock', hint: '做过什么' },
      { to: '/settings', label: '设置', icon: 'settings', hint: '配置 / 备份' },
    ],
  },
]

export function AppShell() {
  const navigate = useNavigate()
  const location = useLocation()
  const [addOpen, setAddOpen] = useState(false)
  const [helpOpen, setHelpOpen] = useState(false)
  // 窄屏时侧栏收成抽屉（原来直接 display:none，小窗口下就彻底没有导航了）
  const [drawerOpen, setDrawerOpen] = useState(false)
  const addRef = useRef(null)

  useEffect(() => {
    setAddOpen(false)
    setDrawerOpen(false)
  }, [location.pathname])

  // 点击外部 / Esc 关闭"新增"下拉
  useEffect(() => {
    const onDown = (event) => {
      if (addRef.current && !addRef.current.contains(event.target)) setAddOpen(false)
    }
    const onKey = (event) => {
      if (event.key === 'Escape') {
        setAddOpen(false)
        setDrawerOpen(false)
      }
    }
    document.addEventListener('mousedown', onDown)
    document.addEventListener('keydown', onKey)
    return () => {
      document.removeEventListener('mousedown', onDown)
      document.removeEventListener('keydown', onKey)
    }
  }, [])

  return (
    <div className="app-shell">
      {drawerOpen ? <div className="sidebar__backdrop" onClick={() => setDrawerOpen(false)} /> : null}

      <aside className={`sidebar ${drawerOpen ? 'is-open' : ''}`}>
        <div className="brand">
          <span className="brand__logo">
            <Icon name="layers" size={14} />
          </span>
          <div className="brand__title">工作台</div>
        </div>

        <nav className="nav">
          {NAV_GROUPS.map((group) => (
            <div className="nav__group" key={group.title}>
              <div className="nav__group-title">{group.title}</div>
              {group.items.map((item) => (
                <NavLink
                  key={item.to}
                  to={item.to}
                  end={item.end}
                  className={({ isActive }) => `nav__item ${isActive ? 'is-active' : ''}`}
                >
                  <Icon name={item.icon} size={15} />
                  <span className="nav__label">{item.label}</span>
                  {item.hint ? <span className="nav__hint">{item.hint}</span> : null}
                </NavLink>
              ))}
            </div>
          ))}
        </nav>

        {/* 新手随时能看到"这页是干嘛的"；固定在侧栏底部，不与导航抢位置 */}
        <div className="sidebar__foot">
          <button type="button" className="sidebar__help" onClick={() => setHelpOpen(true)}>
            <Icon name="alert" size={13} />
            每个页面是干嘛的？
          </button>
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          {/* 只有窄屏出现：大屏侧栏常驻，不需要这个按钮 */}
          <button
            type="button"
            className="topbar__menu"
            onClick={() => setDrawerOpen((prev) => !prev)}
            aria-label="打开导航"
          >
            <Icon name="more" size={15} />
          </button>
          <GlobalSearch />
          <div className="topbar__actions">
            {/* 两个"新增"合并成一个入口，减少顶栏噪音；具体动作仍在目标页里完成 */}
            <div className="menu-wrap" ref={addRef}>
              <button type="button" className="btn btn--primary" onClick={() => setAddOpen((prev) => !prev)}>
                <Icon name="plus" size={13} />
                新增
                <Icon name="chevronDown" size={11} style={{ opacity: 0.75 }} />
              </button>
              {addOpen ? (
                <div className="menu menu--right">
                  <button
                    type="button"
                    className="menu__item"
                    onClick={() => navigate('/projects', { state: { create: true, from: location.pathname } })}
                  >
                    <Icon name="folder" size={14} />
                    本地项目
                    <span className="menu__hint">目录 + 启动命令，一键启停</span>
                  </button>
                  <button
                    type="button"
                    className="menu__item"
                    onClick={() => navigate('/servers', { state: { create: true, from: location.pathname } })}
                  >
                    <Icon name="server" size={14} />
                    服务器
                    <span className="menu__hint">SSH 只读采集 CPU / 内存 / 端口</span>
                  </button>
                </div>
              ) : null}
            </div>
          </div>
        </header>

        <main className="content">
          {/* 页面崩了不白屏：侧栏/顶栏照常可用，导航到新页 key 变化自动重置边界 */}
          <ErrorBoundary key={location.pathname}>
            <Outlet />
          </ErrorBoundary>
        </main>
      </div>

      <HelpModal open={helpOpen} onClose={() => setHelpOpen(false)} />
    </div>
  )
}