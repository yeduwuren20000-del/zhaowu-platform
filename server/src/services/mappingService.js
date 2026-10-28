import { serversRepo } from '../store/serversRepo.js'
import { buildProjectViews } from './projectService.js'

const APP_STATUS_TEXT = {
  running: '运行中',
  stopped: '已停止',
  unknown: '未验证',
}

/**
 * 全局端口映射：把「本地项目」和「服务器 APP」统一成一张表，
 * 回答"这个 8080/3000/11434 到底是什么"。
 */
export async function buildMappings({ force = false, projectViews = null, servers = null } = {}) {
  const [views, serverList] = await Promise.all([
    projectViews ? Promise.resolve(projectViews) : buildProjectViews({ force }),
    servers ? Promise.resolve(servers) : serversRepo.list(),
  ])

  const rows = []
  for (const view of views) {
    rows.push({
      key: `prj:${view.id}`,
      port: view.port ?? null,
      app: view.name,
      env: '本地',
      envKey: 'local',
      owner: view.name,
      ownerType: 'project',
      projectId: view.id,
      projectName: view.name,
      host: 'localhost',
      path: view.dir,
      url: view.url,
      status: view.status,
      statusText: view.statusText,
      pid: view.pid ?? null,
      processName: view.processName || '',
      memory: view.memory ?? null,
      type: view.type,
      conflict: view.conflict || null,
      isPrimary: true,
    })

    // 第五阶段：项目下的子服务（同目录的其它进程/端口）也各占一行
    for (const service of view.services || []) {
      rows.push({
        key: `svc:${view.id}:${service.id}`,
        port: service.port ?? null,
        app: service.name || `${view.name} 子服务`,
        env: '本地',
        envKey: 'local',
        owner: view.name,
        ownerType: 'project',
        projectId: view.id,
        projectName: view.name,
        serviceId: service.id,
        host: 'localhost',
        path: view.dir,
        url: service.url || (service.port ? `http://localhost:${service.port}` : ''),
        status: service.live ? 'running' : 'stopped',
        statusText: service.live ? '子服务运行中' : '子服务已停止',
        pid: service.livePid ?? null,
        processName: service.liveProcessName || service.processName || '',
        memory: service.memory ?? null,
        type: service.type || view.type,
        conflict: null,
        isSubService: true,
      })
    }
  }

  for (const server of serverList) {
    const auditItems = server.portAudit?.items || []
    const sshFresh = Boolean(server.ssh?.at && server.ssh.ok)
    const auditByApp = new Map(auditItems.filter((item) => item.appId).map((item) => [item.appId, item]))
    // 容器发布的宿主机端口（来自 Docker 只读采集）
    const dockerPorts = new Map()
    for (const container of server.docker?.containers || []) {
      for (const port of container.ports || []) {
        if (!port.published || !port.hostPort) continue
        if (!dockerPorts.has(port.hostPort)) {
          dockerPorts.set(port.hostPort, {
            containerName: container.name,
            containerId: container.id,
            image: container.image,
            state: container.state,
            health: container.health,
            containerPort: port.containerPort,
            proto: port.proto,
          })
        }
      }
    }

    for (const app of server.apps || []) {
      const audit = auditByApp.get(app.id) || null
      const auditState = audit?.state || null
      // SSH 采集成功时，以真实监听状态为准；否则保留人工登记的状态
      const status = sshFresh
        ? auditState === 'ok'
          ? 'running'
          : 'stopped'
        : app.status || 'unknown'
      const statusText = sshFresh
        ? auditState === 'ok'
          ? '已确认监听'
          : audit?.port
            ? '未监听'
            : APP_STATUS_TEXT[app.status] || '未验证'
        : APP_STATUS_TEXT[app.status] || '未验证'

      const container = app.port ? dockerPorts.get(Number(app.port)) || null : null
      // 容器发布的端口：以容器状态为准（容器在跑就说明 docker-proxy 已在宿主机监听）
      const finalStatus = container ? (container.state === 'running' ? 'running' : 'stopped') : status
      const finalStatusText = container
        ? container.state === 'running'
          ? '容器运行中'
          : `容器未运行（${container.state}）`
        : statusText

      rows.push({
        key: `app:${server.id}:${app.id}`,
        port: app.port ?? null,
        app: app.name,
        env: '服务器',
        envKey: 'server',
        owner: server.name,
        ownerType: 'server',
        serverId: server.id,
        appId: app.id,
        host: server.host,
        path: app.deployPath || '',
        url: app.url || '',
        status: finalStatus,
        statusText: finalStatusText,
        pid: audit?.listen?.pid ?? null,
        processName: audit?.listen?.process || '',
        memory: null,
        type: app.remark || '',
        conflict: null,
        serverOnline: Boolean(server.online),
        auditState,
        auditDetail: audit?.detail || null,
        sshChecked: sshFresh,
        // 端口来源：容器发布 / 宿主机进程 / 未知
        source: container ? 'docker' : audit?.listen ? 'host' : 'unknown',
        sourceDetail: container
          ? `Docker 容器 ${container.containerName}（${container.image} → ${container.containerPort}/${container.proto}）`
          : audit?.listen?.process
            ? `宿主机进程 ${audit.listen.process}${audit.listen.pid ? ` (PID ${audit.listen.pid})` : ''}`
            : '',
        container,
      })
    }

    // 远程在监听、但工作台没有登记的端口，一并列出，避免"不知道是什么"
    for (const item of auditItems.filter((entry) => entry.state === 'listeningNotRecorded')) {
      // 已经被某个容器发布的端口，会在下面以 Docker 行出现，这里跳过避免重复
      if (item.port && dockerPorts.has(Number(item.port))) continue
      rows.push({
        key: `ssh:${server.id}:${item.listen?.proto || 'tcp'}:${item.port}`,
        port: item.port ?? null,
        app: item.appName || '未知进程',
        env: '服务器',
        envKey: 'server',
        owner: server.name,
        ownerType: 'server',
        serverId: server.id,
        appId: null,
        host: server.host,
        path: '',
        url: '',
        status: 'unregistered',
        statusText: '监听中（未登记）',
        pid: item.listen?.pid ?? null,
        processName: item.listen?.process || '',
        memory: null,
        type: '',
        conflict: null,
        serverOnline: Boolean(server.online),
        auditState: 'listeningNotRecorded',
        auditDetail: item.detail,
        sshChecked: sshFresh,
        unregistered: true,
        source: item.listen?.process === 'docker-proxy' || item.listen?.process === 'docker' ? 'docker-proxy' : 'host',
        sourceDetail: item.listen?.process ? `宿主机进程 ${item.listen.process}` : '',
        container: null,
      })
    }

    // 容器发布了端口、工作台里也没有登记的，单独列出（信息比 ss 更全：镜像、容器名）
    for (const [hostPort, container] of dockerPorts) {
      const registered = (server.apps || []).some((app) => Number(app.port) === Number(hostPort))
      const alreadyListed = rows.some((row) => row.serverId === server.id && Number(row.port) === Number(hostPort))
      if (registered || alreadyListed) continue
      rows.push({
        key: `docker:${server.id}:${hostPort}`,
        port: hostPort,
        app: container.containerName,
        env: '服务器',
        envKey: 'server',
        owner: server.name,
        ownerType: 'server',
        serverId: server.id,
        appId: null,
        host: server.host,
        path: '',
        url: '',
        status: container.state === 'running' ? 'unregistered' : 'stopped',
        statusText: container.state === 'running' ? '容器监听中（未登记）' : '容器未运行（未登记）',
        pid: null,
        processName: 'docker',
        memory: null,
        type: '',
        conflict: null,
        serverOnline: Boolean(server.online),
        auditState: 'listeningNotRecorded',
        auditDetail: `Docker 容器 ${container.containerName} 发布了端口 ${hostPort}，工作台里没有登记`,
        sshChecked: sshFresh,
        unregistered: true,
        source: 'docker',
        sourceDetail: `Docker 容器 ${container.containerName}（${container.image} → ${container.containerPort}/${container.proto}）`,
        container,
      })
    }
  }

  rows.sort((a, b) => (a.port ?? 99999) - (b.port ?? 99999) || String(a.owner).localeCompare(String(b.owner)))

  const conflicts = []
  // 本地端口冲突：**每个端口只报一条**。
  // 早先是"每个项目各推一条自己的 conflict"，于是 N 个项目抢同一端口会得到 N 条消息，
  // 而且内容相同只是名字顺序相反（实测两个项目 → 「A、B」和「B、A」两条），
  // 首页待处理会因此多出一条，看起来像有两个不同的冲突。
  const localConflictPorts = new Map()
  for (const view of views) {
    if (!view.conflict || !view.port) continue
    const port = Number(view.port)
    if (!localConflictPorts.has(port)) localConflictPorts.set(port, [])
    localConflictPorts.get(port).push(view)
  }
  for (const [port, list] of localConflictPorts) {
    // 名字去重后按名称排序，保证同一个冲突每次渲染出来的文案完全一致
    const names = [...new Set(list.map((view) => view.name))].sort()
    // projectService 已经判定了冲突类型（真冲突 / 疑似重复登记）并写好了文案，这里直接沿用，
    // 不要自己重写 —— 否则会丢掉"父子目录其实是同一服务登记两次"这个判断。
    const first = list[0].conflict
    conflicts.push({
      scope: 'local',
      port,
      owner: names[0],
      type: first.type || 'duplicate',
      duplicateRegistration: Boolean(first.duplicateRegistration),
      message: first.message || `端口 ${port} 同时被 ${names.length} 个项目声明：${names.join('、')}`,
    })
  }
  const byHostPort = new Map()
  for (const row of rows) {
    if (row.envKey !== 'server' || !row.port) continue
    const key = `${row.host}:${row.port}`
    const list = byHostPort.get(key) || []
    list.push(row)
    byHostPort.set(key, list)
  }
  for (const [key, list] of byHostPort) {
    if (list.length < 2) continue
    conflicts.push({
      scope: 'server',
      port: list[0].port,
      owner: key,
      serverId: list[0].serverId || null,
      serverName: list[0].owner,
      type: 'duplicate',
      message: `${key} 上端口 ${list[0].port} 被多个应用声明：${list.map((row) => row.app).join('、')}`,
    })
  }

  const stats = {
    total: rows.length,
    local: rows.filter((row) => row.envKey === 'local').length,
    server: rows.filter((row) => row.envKey === 'server').length,
    running: rows.filter((row) => row.status === 'running').length,
    conflicts: conflicts.length,
    unregistered: rows.filter((row) => row.unregistered).length,
    docker: rows.filter((row) => row.source === 'docker').length,
    hostProcess: rows.filter((row) => row.source === 'host').length,
    audit: {
      ok: rows.filter((row) => row.auditState === 'ok').length,
      recordedNotListening: rows.filter((row) => row.auditState === 'recordedNotListening').length,
      listeningNotRecorded: rows.filter((row) => row.auditState === 'listeningNotRecorded').length,
    },
  }

  return { rows, conflicts, stats }
}
