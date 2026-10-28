/** 服务器列表行与详情页共用的取值口径 */

export const SERVER_TABS = [
  { value: 'overview', label: '概览' },
  { value: 'apps', label: '应用' },
  { value: 'docker', label: 'Docker' },
  { value: 'ports', label: '端口' },
  { value: 'logs', label: '日志' },
  { value: 'timeline', label: '时间线' },
]

/** 连接状态用短词；SSH / TCP 的差别留在采集详情里，不占状态位 */
export function monitorMeta(server) {
  const monitor = server.monitor || {}
  if (!monitor.at) return { status: 'unknown', text: '未检测' }
  return monitor.online ? { status: 'running', text: '在线' } : { status: 'conflict', text: '离线' }
}

export function sshTarget(server) {
  return `${server.username || server.user || 'root'}@${server.host}:${server.sshPort || 22}`
}
