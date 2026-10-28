import { useEffect, useState } from 'react'
import { Icon } from './Icons.jsx'

const KEY_PREFIX = 'dsm.hint.'

/**
 * 每页一次性提示条：
 *   第一次进某页时，用一句话说清「这页是干嘛的 + 第一步做什么」，
 *   点「知道了」（或执行动作）后写 localStorage，之后不再出现。
 *
 * 为什么放在页面里而不是只在侧栏的使用说明里：新手落地任何页面第一眼
 * 就应该看到这页是干嘛的，而不是先发现「有个帮助按钮」再点开。
 * 一次性 + 可关闭，对老用户零打扰。
 */
export function PageHint({ id, icon = 'alert', children, action = null }) {
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    try {
      setVisible(localStorage.getItem(KEY_PREFIX + id) !== '1')
    } catch {
      // localStorage 读不到（隐私模式等）就当没关过：显示引导比不显示好
      setVisible(true)
    }
  }, [id])

  if (!visible) return null

  const dismiss = () => {
    try {
      localStorage.setItem(KEY_PREFIX + id, '1')
    } catch {
      /* 存不了就仅本次会话隐藏 */
    }
    setVisible(false)
  }

  return (
    <div className="page-hint" data-hint={id}>
      <Icon name={icon} size={14} />
      <div className="page-hint__text">{children}</div>
      {action ? (
        <button
          type="button"
          className="page-hint__action"
          onClick={() => {
            dismiss()
            action.onClick?.()
          }}
        >
          {action.label}
          <Icon name="chevronRight" size={11} />
        </button>
      ) : null}
      <button type="button" className="page-hint__close" onClick={dismiss} title="知道了，不再显示">
        <Icon name="x" size={12} />
      </button>
    </div>
  )
}
