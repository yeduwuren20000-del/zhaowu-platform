const BASE = '/api'

async function request(path, { method = 'GET', body } = {}) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    headers: body === undefined ? undefined : { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  })

  let payload = null
  try {
    payload = await response.json()
  } catch {
    payload = null
  }

  if (!response.ok || (payload && payload.ok === false)) {
    const message = payload?.error?.message || `请求失败（HTTP ${response.status}）`
    const error = new Error(message)
    // 挂状态码：前端要靠它区分「连不上」和「服务端 500」，给不同的下一步指引
    error.status = response.status
    error.details = payload?.error || null
    throw error
  }
  return payload?.data
}

export const api = {
  health: () => request('/health'),

  dashboard: (force = true) => request(`/dashboard${force ? '?force=1' : ''}`),
  probeServers: (force = false) => request('/dashboard/probe-servers', { method: 'POST', body: { force } }),

  projects: () => request('/projects?force=1'),
  // 项目识别（只读）：填前端地址会反查监听进程得到目录与端口，填目录会读配置推断启动命令
  detectProject: ({ dir, url } = {}) => request('/projects/detect', { method: 'POST', body: { dir, url } }),
  createProject: (data) => request('/projects', { method: 'POST', body: data }),
  updateProject: (id, data) => request(`/projects/${id}`, { method: 'PUT', body: data }),
  deleteProject: (id) => request(`/projects/${id}`, { method: 'DELETE' }),
  startProject: (id) => request(`/projects/${id}/start`, { method: 'POST' }),
  stopProject: (id) => request(`/projects/${id}/stop`, { method: 'POST' }),
  restartProject: (id) => request(`/projects/${id}/restart`, { method: 'POST' }),
  openProjectDir: (id) => request(`/projects/${id}/open-dir`, { method: 'POST' }),
  // clientOpen=true：只取回最终地址，由前端自己开窗口（快，无 cmd.exe 启动开销）
  openProjectUrl: (id, { clientOpen = true } = {}) => request(`/projects/${id}/open-url`, { method: 'POST', body: { clientOpen } }),
  copyProject: (id, what = 'path') => request(`/projects/${id}/copy`, { method: 'POST', body: { what } }),
  projectLog: (id, lines = 200) => request(`/projects/${id}/log?lines=${lines}`),
  clearProjectLog: (id) => request(`/projects/${id}/log`, { method: 'DELETE' }),

  servers: () => request('/servers'),
  // 粘贴 ssh 命令 / 连接串 / .ssh/config 片段，自动拆成表单字段
  serverQuickFill: (text) => request('/servers/quick-fill', { method: 'POST', body: { text } }),
  createServer: (data) => request('/servers', { method: 'POST', body: data }),
  updateServer: (id, data) => request(`/servers/${id}`, { method: 'PUT', body: data }),
  deleteServer: (id) => request(`/servers/${id}`, { method: 'DELETE' }),
  probeServer: (id) => request(`/servers/${id}/probe`, { method: 'POST' }),
  probeAllServers: (force = true) => request(`/servers/probe${force ? '?force=1' : ''}`, { method: 'POST', body: { force } }),

  // ---- 第二阶段：SSH 只读监控 ----
  sshProbeServer: (id, force = true) => request(`/servers/${id}/probe-ssh`, { method: 'POST', body: { force } }),
  sshProbeAll: (force = true, staleMs = 60000) => request('/servers/probe-ssh', { method: 'POST', body: { force, staleMs } }),
  serverPorts: (id, live = false) => request(`/servers/${id}/ports${live ? '?live=1' : ''}`),
  serverDocker: (id, live = false) => request(`/servers/${id}/docker${live ? '?live=1' : ''}`),
  serverLog: (id, path, lines = 200) =>
    request(`/servers/${id}/log?lines=${lines}${path ? `&path=${encodeURIComponent(path)}` : ''}`),
  serverLogCheck: (id) => request(`/servers/${id}/log-check`, { method: 'POST' }),

  // ---- 第七阶段·第二轮：SSH 自动刷新 ----
  autoMonitor: () => request('/servers/auto-monitor'),
  autoMonitorStart: (intervalMs) => request('/servers/auto-monitor/start', { method: 'POST', body: { intervalMs } }),
  autoMonitorStop: () => request('/servers/auto-monitor/stop', { method: 'POST', body: {} }),
  autoMonitorInterval: (intervalMs) => request('/servers/auto-monitor/interval', { method: 'POST', body: { intervalMs } }),
  autoMonitorRun: () => request('/servers/auto-monitor/run', { method: 'POST', body: {} }),
  serverHistory: (id, window = '24h') => request(`/servers/${id}/history?window=${encodeURIComponent(window)}`),

  createServerApp: (serverId, data) => request(`/servers/${serverId}/apps`, { method: 'POST', body: data }),
  updateServerApp: (serverId, appId, data) => request(`/servers/${serverId}/apps/${appId}`, { method: 'PUT', body: data }),
  deleteServerApp: (serverId, appId) => request(`/servers/${serverId}/apps/${appId}`, { method: 'DELETE' }),
  probeServerApp: (serverId, appId) => request(`/servers/${serverId}/apps/${appId}/probe`, { method: 'POST' }),

  ports: (force = true) => request(`/ports${force ? '?force=1' : ''}`),
  scanPort: (port) => request(`/ports/scan?port=${encodeURIComponent(port)}`),

  logs: (lines = 100) => request(`/logs?lines=${lines}`),
  clearLogs: () => request('/logs', { method: 'DELETE' }),

  search: (query) => request(`/search?q=${encodeURIComponent(query)}`),

  settings: () => request('/settings'),
  reseed: () => request('/settings/reseed', { method: 'POST' }),
  resetRuntime: () => request('/settings/reset-runtime', { method: 'POST' }),
  openDataDir: () => request('/settings/open-data-dir', { method: 'POST' }),

  // ---- 凭据库（主密码加密；主密码不落盘，只在解锁期间驻留内存）----
  vaultStatus: () => request('/vault/status'),
  vaultUnlock: (password, mode) => request('/vault/unlock', { method: 'POST', body: { password, mode } }),
  vaultRecover: (password) => request('/vault/recover', { method: 'POST', body: { password } }),
  vaultSetRecoveryMode: (enable, password) => request('/vault/recovery-mode', { method: 'POST', body: { enable, password } }),
  vaultLock: () => request('/vault/lock', { method: 'POST', body: {} }),
  vaultChangePassword: (oldPassword, newPassword) =>
    request('/vault/change-password', { method: 'POST', body: { oldPassword, newPassword } }),
  vaultEntries: () => request('/vault/entries'),
  vaultSaveEntry: (entry) => request('/vault/entries', { method: 'POST', body: entry }),
  vaultDeleteEntry: (id) => request(`/vault/entries/${encodeURIComponent(id)}`, { method: 'DELETE' }),

  // ---- 本地 Docker（容器列表 / 启停 / 日志；Dify 就跑在这里面）----
  docker: () => request('/docker'),
  // 引擎本身没起时的「一键拉起」：start 立刻返回，进度靠轮询 dockerDaemon
  dockerDaemon: () => request('/docker/daemon'),
  dockerDaemonStart: () => request('/docker/daemon/start', { method: 'POST' }),
  dockerAction: (id, action) => request(`/docker/containers/${encodeURIComponent(id)}/${action}`, { method: 'POST' }),
  dockerLogs: (id, lines = 100) => request(`/docker/containers/${encodeURIComponent(id)}/logs?lines=${lines}`),

  // ---- 文档转换（本地自托管 Stirling-PDF，GitHub 90k★）----
  converter: () => request('/converter'),
  converterStart: () => request('/converter/start', { method: 'POST' }),
  converterStop: () => request('/converter/stop', { method: 'POST' }),
  converterConvert: (payload) => {
    // 不走通用 request（它期望 JSON 里的 data 包装）；这里直接拿二进制流
    return fetch('/api/converter/convert', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(async (response) => {
      if (!response.ok) {
        let message = `转换失败（HTTP ${response.status}）`
        try {
          const payload = await response.json()
          message = payload?.error?.message || message
        } catch {
          /* 非 JSON 错误体 */
        }
        const error = new Error(message)
        error.status = response.status
        throw error
      }
      const blob = await response.blob()
      const cd = response.headers.get('Content-Disposition') || ''
      const match = cd.match(/filename="?([^";]+)"?/)
      return { blob, fileName: match ? match[1] : 'converted.bin' }
    })
  },
  converterMerge: (payload) => {
    // 多文件合并：同样直接拿二进制流（返回 merged.pdf）
    return fetch('/api/converter/merge', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    }).then(async (response) => {
      if (!response.ok) {
        let message = `合并失败（HTTP ${response.status}）`
        try {
          const payload = await response.json()
          message = payload?.error?.message || message
        } catch {
          /* 非 JSON 错误体 */
        }
        const error = new Error(message)
        error.status = response.status
        throw error
      }
      const blob = await response.blob()
      const cd = response.headers.get('Content-Disposition') || ''
      const match = cd.match(/filename="?([^";]+)"?/)
      return { blob, fileName: match ? match[1] : 'merged.pdf' }
    })
  },

  // ---- 服务监控（本地自托管 Uptime Kuma，GitHub 86K★）----
  uptime: () => request('/uptime'),
  uptimeStart: () => request('/uptime/start', { method: 'POST' }),
  uptimeStop: () => request('/uptime/stop', { method: 'POST' }),

  // ---- WSL（独立网络命名空间，Windows 侧查不到，必须进发行版去问）----
  wslAvailable: () => request('/wsl/available'),
  wslDistros: () => request('/wsl/distros'),
  wslCollect: (includeProcesses = false) => request(`/wsl/collect?processes=${includeProcesses ? '1' : '0'}`),

  // ---- 网盘直链解析（后端调 tools/panlink 的 Python 子进程）----
  pans: () => request('/pans'),
  pansOptions: () => request('/pans/options'),
  resolvePan: (payload) => request('/pans/resolve', { method: 'POST', body: payload }),
  // 三个出口：复制（纯前端）/ 推送 aria2 / 下载到本机（后台任务）
  aria2Test: (payload) => request('/pans/aria2/test', { method: 'POST', body: payload }),
  aria2Push: (payload) => request('/pans/aria2', { method: 'POST', body: payload }),
  startPanDownload: (payload) => request('/pans/download', { method: 'POST', body: payload }),
  panDownload: (id) => request(`/pans/downloads/${encodeURIComponent(id)}`),
  panDownloads: (limit = 10) => request(`/pans/downloads?limit=${limit}`),
  cancelPanDownload: (id) => request(`/pans/downloads/${encodeURIComponent(id)}/cancel`, { method: 'POST' }),
  openPanDir: (dir) => request('/pans/open-dir', { method: 'POST', body: { dir } }),
  preflight: (refresh = false) => request(`/preflight${refresh ? '?refresh=1' : ''}`),

  // ---- 本地影院（mediaserver：海报墙 + 播放 + AI 修复 + 聚合搜索）----
  media: () => request('/media'),
  mediaStart: () => request('/media/start', { method: 'POST' }),
  mediaStop: () => request('/media/stop', { method: 'POST' }),
  mediaLog: (lines = 100) => request(`/media/log?lines=${lines}`),
  openMediaDir: () => request('/media/open-dir', { method: 'POST', body: {} }),

  // ---- 第四阶段：本地服务自动发现 ----
  discoveryScan: (includeAi = false) => request('/discovery/scan', { method: 'POST', body: { includeAi } }),
  discoveryLatest: () => request('/discovery/latest'),
  discoveryRegister: (fingerprint, overrides = {}) => request('/discovery/register', { method: 'POST', body: { fingerprint, overrides } }),
  discoveryIgnore: (fingerprints, note = '') => request('/discovery/ignore', { method: 'POST', body: { fingerprints, note } }),
  discoveryRestore: (fingerprints) => request('/discovery/restore', { method: 'POST', body: { fingerprints } }),
  discoveryAcknowledge: (fingerprints) => request('/discovery/acknowledge', { method: 'POST', body: { fingerprints } }),
  discoveryIdentify: (fingerprint) => request('/discovery/identify', { method: 'POST', body: { fingerprint } }),

  // ---- 第五阶段：项目分组（按目录聚合多进程/多端口） ----
  discoveryGroups: () => request('/discovery/groups'),
  discoveryRegisterGroup: (groupId, overrides = {}, primaryFingerprint = null) =>
    request('/discovery/register-group', { method: 'POST', body: { groupId, overrides, primaryFingerprint } }),
  discoveryRegisterGroups: (groupIds, overrides = {}) =>
    request('/discovery/register-groups', { method: 'POST', body: { groupIds, overrides } }),
  discoveryAssociate: (fingerprint, projectId, overrides = {}) =>
    request('/discovery/associate', { method: 'POST', body: { fingerprint, projectId, overrides } }),
  discoveryDissociate: (projectId, serviceId) => request('/discovery/dissociate', { method: 'POST', body: { projectId, serviceId } }),
  discoveryProjectLink: (projectId, serverId, options = {}) =>
    request('/discovery/project-link', { method: 'POST', body: { projectId, serverId, ...options } }),

  logStreamUrl: (source) => `${BASE}/logs/stream?source=${encodeURIComponent(source)}&lines=300`,

  // ---- 第六阶段：服务生命周期时间线 ----
  events: ({ projectId = null, serverId = null, serviceId = null, type = null, limit = 100 } = {}) => {
    const params = new URLSearchParams()
    if (projectId) params.set('projectId', projectId)
    if (serverId) params.set('serverId', serverId)
    if (serviceId) params.set('serviceId', serviceId)
    if (type) params.set('type', type)
    if (limit) params.set('limit', String(limit))
    const query = params.toString()
    return request(`/events${query ? `?${query}` : ''}`)
  },
  eventTypes: () => request('/events/types'),
  clearEvents: () => request('/events', { method: 'DELETE' }),
}
