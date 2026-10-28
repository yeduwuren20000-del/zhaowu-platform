import { Component } from 'react'
import { Button } from './ui.jsx'
import { Icon } from './Icons.jsx'

/**
 * 页面级兜底：某个页面渲染时抛错，不再整个应用白屏。
 *
 * 为什么需要它：白屏对新手是最坏的情况——没有文字、没有按钮，唯一出路是关掉重开，
 * 而且重开后大概率还是一样。有了它，侧栏和顶栏都还在，用户能去其他页面，
 * 也能一键重试这一页；错误详情折叠着，懂的人按 F12 之外还能直接复制走。
 *
 * 放在 <main> 里包 <Outlet/>，用 location.pathname 做 key：导航到新页面自动重置边界，
 * 崩过的页面不会把用户困在原地。
 */
export class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { error: null, copied: false }
  }

  static getDerivedStateFromError(error) {
    return { error }
  }

  componentDidCatch(error, info) {
    // 控制台留全量（含组件栈），F12 能看到，不打断用户
    console.error('[工作台] 页面渲染出错：', error, info)
  }

  handleRetry = () => {
    this.setState({ error: null, copied: false })
  }

  handleCopy = async () => {
    const { error } = this.state
    const text = `${error?.name || 'Error'}: ${error?.message || String(error)}\n\n${error?.stack || ''}`
    try {
      await navigator.clipboard.writeText(text)
      this.setState({ copied: true })
      setTimeout(() => this.setState({ copied: false }), 2000)
    } catch {
      // 剪贴板被浏览器拦了（非 HTTPS / 无权限）：不打扰用户，详情还在折叠区里能手动选
    }
  }

  render() {
    const { error, copied } = this.state
    if (!error) return this.props.children

    return (
      <div className="page-crash" role="alert">
        <div className="page-crash__card">
          <div className="page-crash__icon">
            <Icon name="alert" size={18} />
          </div>
          <div className="page-crash__title">这一页出了点问题</div>
          <div className="page-crash__desc">
            页面显示时发生了错误，但工作台本身还在运行。你可以重试这一页，或用左侧导航去其他页面——数据不会丢。
          </div>
          <div className="page-crash__msg">{error?.message || String(error)}</div>
          <div className="page-crash__actions">
            <Button variant="primary" icon="refresh" onClick={this.handleRetry}>
              重试这一页
            </Button>
            <Button icon={copied ? 'check' : 'copy'} onClick={this.handleCopy}>
              {copied ? '已复制' : '复制错误详情'}
            </Button>
          </div>
          <details className="page-crash__detail">
            <summary>技术详情（发给懂的人看）</summary>
            <pre>{error?.stack || `${error?.name || 'Error'}: ${error?.message || String(error)}`}</pre>
          </details>
        </div>
      </div>
    )
  }
}
