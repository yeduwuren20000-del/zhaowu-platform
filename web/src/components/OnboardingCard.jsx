import { useEffect, useState } from 'react'
import { Icon } from './Icons.jsx'
import { Button } from './ui.jsx'

const DISMISS_KEY = 'dsm.onboarding.dismissed.v1'

/**
 * 首次使用引导：只在「还没有项目」或「有项目但一个都没在跑」时出现。
 *
 * 为什么不用弹层：主动弹窗会打断正在看数据的人；放一张页首卡片，做完自动消失，
 * 对老用户零打扰。步骤完成状态直接从数据推导，不做本地"我完成了"的假打卡。
 */
export function OnboardingCard({ projects = [], onGo }) {
  const [dismissed, setDismissed] = useState(true)

  useEffect(() => {
    try {
      setDismissed(localStorage.getItem(DISMISS_KEY) === '1')
    } catch {
      /* localStorage 读不到（隐私模式等）就当没关过，显示引导也无妨 */
    }
  }, [])

  const hasProject = projects.length > 0
  const hasRunning = projects.some((p) => p.status === 'running' || p.status === 'starting')

  if (dismissed || (hasProject && hasRunning)) return null

  const dismiss = () => {
    try {
      localStorage.setItem(DISMISS_KEY, '1')
    } catch {
      /* 存不了就只在本次会话隐藏 */
    }
    setDismissed(true)
  }

  const steps = [
    {
      done: hasProject,
      title: '登记一个本地项目',
      desc: '选目录、填启动命令；只是想管端口的话，命令可以留空',
      action: '去登记',
      go: () => onGo('/projects', { create: true }),
    },
    {
      done: hasRunning,
      title: '启动它',
      desc: '启动后自动看到端口占用，日志实时可查',
      action: '去启动',
      go: () => onGo('/projects'),
    },
    {
      done: false,
      title: '出问题先看端口',
      desc: '服务起不来 / 端口被占，这里会指出是谁占的',
      action: '看端口',
      go: () => onGo('/ports'),
    },
  ]

  return (
    <section className="card onboard">
      <header className="onboard__head">
        <div>
          <div className="onboard__title">第一次用？三步上手</div>
          <div className="onboard__sub">日常管理就这些：左边「本地项目」管启停，这里看有没有异常</div>
        </div>
        <button type="button" className="onboard__dismiss" onClick={dismiss}>
          不再显示
        </button>
      </header>
      <ol className="onboard__steps">
        {steps.map((step, index) => (
          <li key={step.title} className={`onboard__step ${step.done ? 'is-done' : ''}`}>
            <span className="onboard__mark">{step.done ? <Icon name="check" size={12} /> : index + 1}</span>
            <div className="onboard__text">
              <div className="onboard__step-title">{step.title}</div>
              <div className="onboard__step-desc">{step.desc}</div>
            </div>
            {!step.done && step.go ? (
              <Button size="sm" variant="primary" icon="arrowUpRight" onClick={step.go}>
                {step.action}
              </Button>
            ) : null}
          </li>
        ))}
      </ol>
      <div className="onboard__foot">
        左侧导航是全部入口：常用 / 工具 / 记录三组都摊开着（端口、WSL、网盘直链、凭据库、日志、时间线、设置都在），不用再去翻二级菜单。
      </div>
    </section>
  )
}
