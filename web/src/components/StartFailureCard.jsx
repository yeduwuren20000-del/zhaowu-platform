import { useState } from 'react'
import { Icon } from './Icons.jsx'
import { Button } from './ui.jsx'
import { copyText } from '../utils/clipboard.js'

/**
 * 启动失败横幅（挂在项目卡片里，启动失败后常驻，直到下次启动成功或手动关掉）：
 *   标题说人话 → 证据（日志里到底哪一行触发了判断）→ 建议动作（可复制命令 / 可跳转页面）→ 日志尾部
 *
 * 设计要点：
 *   - 不用 toast 承载：toast 几秒就消失，新手来不及读；失败原因要停在原地看着；
 *   - 每条建议都可以带一个动作：copy = 复制命令让用户去终端粘贴，navigate = 跳到能解决问题的页面；
 *   - 日志尾部默认折叠——想看的人展开，不想看的人不被原始报错吓到。
 */
export function StartFailureCard({ failure, onNavigate, onDismiss }) {
  const [showLog, setShowLog] = useState(false)
  const [copied, setCopied] = useState('')
  if (!failure) return null

  const advice = Array.isArray(failure.advice) ? failure.advice : []
  const logTail = Array.isArray(failure.logTail) ? failure.logTail : []

  return (
    <div className="pfail" role="alert">
      <div className="pfail__head">
        <Icon name="alert" size={14} />
        <span className="pfail__title">{failure.title || '启动失败'}</span>
        {onDismiss ? (
          <button type="button" className="pfail__close" title="知道了，收起" aria-label="收起失败提示" onClick={onDismiss}>
            <Icon name="x" size={12} />
          </button>
        ) : null}
      </div>

      {failure.summary ? <p className="pfail__summary">{failure.summary}</p> : null}

      {failure.evidence ? (
        <p className="pfail__evidence" title="诊断依据：日志里实际出现的这一行">
          <span className="pfail__evidence-label">日志里说</span>
          <code>{failure.evidence}</code>
        </p>
      ) : null}

      {advice.length > 0 ? (
        <ul className="pfail__advice">
          {advice.map((item, index) => (
            <li key={`${item.text}-${index}`}>
              <span className="pfail__advice-text">{item.text}</span>
              {item.action?.kind === 'copy' && item.action.value ? (
                <Button
                  size="sm"
                  icon="copy"
                  onClick={async () => {
                    const ok = await copyText(item.action.value)
                    setCopied(ok ? `已复制：${item.action.value}` : '复制失败，请手动选择文本复制')
                  }}
                >
                  复制命令
                </Button>
              ) : null}
              {item.action?.kind === 'navigate' ? (
                <Button size="sm" icon="arrowUpRight" onClick={() => onNavigate?.(item.action)}>
                  {item.action.to === '/logs' ? '看日志' : item.action.to === '/ports' ? '看端口占用' : '去处理'}
                </Button>
              ) : null}
            </li>
          ))}
        </ul>
      ) : null}
      <p className="pfail__copied" aria-live="polite">
        {copied}
      </p>

      {logTail.length > 0 ? (
        <div className="pfail__log">
          <button type="button" className="pfail__log-toggle" onClick={() => setShowLog((prev) => !prev)}>
            <Icon name={showLog ? 'chevronDown' : 'chevronRight'} size={11} />
            {showLog ? '收起日志尾部' : `展开日志尾部（${logTail.length} 行）`}
          </button>
          {showLog ? (
            <pre className="pfail__log-body">
              {logTail.join('\n')}
            </pre>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}
