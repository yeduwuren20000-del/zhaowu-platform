import { Modal } from './ui.jsx'
import { Icon } from './Icons.jsx'

/**
 * 使用说明：每个页面一句话说清「解决什么问题」。
 * 放在侧栏底部随时可看 —— 新手不敢乱点的原因多半是"不知道这页是干嘛的"。
 */
const PAGES = [
  { icon: 'dashboard', name: '总览', desc: '一眼看现在：哪些在跑、有没有异常、缺什么依赖、最近发生过什么' },
  { icon: 'folder', name: '本地项目', desc: '登记本机项目后一键启停；启动失败会给出原因和下一步，不用先看懂日志' },
  { icon: 'server', name: '服务器', desc: '添加 SSH 服务器，只读采集 CPU / 内存 / 端口 / 容器' },
  { icon: 'layers', name: 'Docker', desc: '本机容器一览：状态、端口映射、启停与查看日志' },
  { icon: 'ports', name: '服务端口', desc: '谁占了哪个端口、有没有冲突，可一键重新探测' },
  { icon: 'box', name: 'WSL', desc: '看 WSL 发行版的状态与占用，可采集进程列表' },
  { icon: 'link', name: '网盘直链', desc: '粘贴网盘分享链接，取回可直接下载的直链' },
  { icon: 'play', name: '本地影院', desc: '海报墙点开即播、AI 逐帧修复、聚合搜索、下载入库，全部只在本机' },
  { icon: 'shield', name: '凭据库', desc: '密码 / 私钥 / Token 存在本机，默认打码、点开才显示' },
  { icon: 'terminal', name: '日志', desc: '项目与服务的日志集中在这，支持实时跟随' },
  { icon: 'clock', name: '时间线', desc: '事件记录：项目什么时候启动过、停过、报过错' },
  { icon: 'settings', name: '设置', desc: '主题、自动发现、自动监控等偏好都在这' },
]

export function HelpModal({ open, onClose }) {
  return (
    <Modal open={open} title="使用说明" onClose={onClose} size="md">
      <div className="help-list">
        {PAGES.map((page) => (
          <div key={page.name} className="help-list__item">
            <span className="help-list__icon">
              <Icon name={page.icon} size={14} />
            </span>
            <div>
              <div className="help-list__name">{page.name}</div>
              <div className="help-list__desc">{page.desc}</div>
            </div>
          </div>
        ))}
      </div>
      <div className="help-list__foot">
        新手只需两步：在「本地项目」登记并启动，回「总览」看有没有异常。左侧导航按常用 / 工具 / 记录分组，全部摊开，不用翻二级菜单。
      </div>
    </Modal>
  )
}
