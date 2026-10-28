import path from 'node:path'

/**
 * 项目聚合（第五阶段）：把"同一个项目目录下的多个监听进程/端口"合成一个项目组。
 *
 * 聚合依据（只用事实，禁止按名称模糊合并）：
 *   1. projectDir 完全相同（归一化后比较）——最高优先级；
 *   2. projectDir 由项目标记文件判定的项目根目录（package.json / pyproject.toml / pom.xml …）；
 *   3. 没有 projectDir 的服务：按 **PID** 归组（同一进程的不同端口），不与任何目录组合并；
 *   4. 被过滤的系统/非开发进程不参与聚合，单独返回。
 *
 * 本模块只做展示与关联模型：**不修改** pid / port / address / exePath / commandLine / startedAt 等事实字段，
 * 所有服务对象都是原候选的浅拷贝 + 关联信息。
 */

export const GROUP_STATUS = {
  allRunning: { status: 'all-running', text: '全部运行', tone: 'green' },
  partialRunning: { status: 'partial-running', text: '部分运行', tone: 'amber' },
  allStopped: { status: 'all-stopped', text: '全部停止', tone: 'gray' },
  conflict: { status: 'conflict', text: '存在冲突', tone: 'red' },
}

/** 目录归一化：统一分隔符、去尾部斜杠、Windows 大小写不敏感 */
export function normalizeDir(dir) {
  if (!dir) return ''
  let value = String(dir).trim().replace(/\//g, '\\').replace(/\\+$/, '')
  if (/^[a-zA-Z]:/.test(value)) value = `${value[0].toUpperCase()}${value.slice(1)}`
  return value.toLowerCase()
}

/** 项目记录里已经登记的端口（主端口 + 子服务端口） */
export function declaredPortsOf(project) {
  const ports = new Set()
  if (project?.port) ports.add(Number(project.port))
  for (const service of project?.services || []) {
    if (service?.port) ports.add(Number(service.port))
  }
  return ports
}

function projectNameOf(group, projects) {
  const dir = group.projectDir
  if (!dir) return null
  const normalized = normalizeDir(dir)
  const matched = projects.find((project) => project.dir && normalizeDir(project.dir) === normalized)
  return matched?.name || null
}

/** 组装一个子服务条目（事实字段原样拷贝，不做任何改写） */
function toService(candidate, { registeredProject, group } = {}) {
  const declaredPorts = registeredProject ? declaredPortsOf(registeredProject) : new Set()
  const matchedDeclared = declaredPorts.has(Number(candidate.port))
  return {
    // ---- 关联信息 ----
    key: candidate.fingerprint,
    fingerprint: candidate.fingerprint,
    live: true,
    // ---- 识别结果（规则/AI 建议，可被覆盖） ----
    serviceName: candidate.ai?.serviceName || candidate.serviceName,
    type: candidate.ai?.type || candidate.type,
    category: candidate.category,
    confidence: candidate.ai?.confidence ?? candidate.confidence,
    source: candidate.source,
    reasons: candidate.reasons || [],
    ai: candidate.ai || null,
    suggestedStartCommand: candidate.ai?.suggestedStartCommand || candidate.suggestedStartCommand || null,
    suggestedUrl: candidate.suggestedUrl || null,
    // ---- 事实字段（原样保留） ----
    pid: candidate.pid,
    port: candidate.port,
    address: candidate.address,
    processName: candidate.processName,
    exePath: candidate.exePath,
    commandLine: candidate.commandLine,
    startedAt: candidate.startedAt,
    parentName: candidate.parentName,
    // ---- 与工作台的关系 ----
    registrationState: candidate.registrationState || 'unregistered',
    registeredProjectId: candidate.registeredProjectId || registeredProject?.id || null,
    registeredProjectName: candidate.registeredProjectName || registeredProject?.name || null,
    matchedBy: candidate.matchedBy || null,
    matchedDeclaredPort: matchedDeclared,
    // 已登记项目下的新端口：同目录、但项目记录里没有登记过
    isNewSubService: Boolean(registeredProject) && !matchedDeclared,
    ignored: candidate.registrationState === 'ignored',
    candidate,
  }
}

/**
 * 只有登记信息、当前没有监听的端口（项目记录里声明了但没在监听）。
 *
 * 但**不能只看项目目录**：扫描识别项目目录靠的是进程 cwd / 父进程链，
 * 有些服务（后台任务、独立启动的 API、cwd 在子目录的进程）识别不出目录，
 * 于是被丢进 loose 组，项目这边就被误判成"全都没在跑"。
 * 实测：本工作台 2299/8787 两个服务确实在监听，却因为识别不到目录而全显示"已停止"。
 *
 * 所以额外传入端口存活索引：**端口真的在监听，就显示运行中**，
 * 并尽量把进程信息补上（PID/进程名来自当时的真实监听表）。
 */
function toDeclaredOnlyService(project, entry, portIndex = null) {
  const port = entry.port ?? null
  const live = portIndex ? portIndex.get(Number(port)) : null
  const isLive = Boolean(live)
  return {
    key: `declared:${project.id}:${entry.port ?? entry.id ?? entry.name}`,
    fingerprint: null,
    live: isLive,
    serviceName: entry.name || `${project.name}:${entry.port ?? ''}`,
    type: entry.type || project.type || '已登记',
    category: isLive ? 'registered-live' : 'declared',
    confidence: 1,
    source: isLive ? 'project-record+live-port' : 'project-record',
    reasons: [isLive ? '来自项目记录；该端口当前确实在监听' : '来自项目记录，当前没有进程在监听'],
    ai: null,
    suggestedStartCommand: entry.startCommand || project.startCommand || null,
    suggestedUrl: entry.port ? `http://localhost:${entry.port}` : null,
    // 端口确实在监听时，把真实进程信息带出来（不再显示空 PID）
    pid: isLive ? live.pid : entry.pid || null,
    port,
    address: isLive ? live.address || '' : '',
    processName: isLive ? live.processName || '' : '',
    exePath: isLive ? live.exePath || '' : '',
    commandLine: isLive ? live.commandLine || '' : '',
    startedAt: isLive ? live.startedAt || null : entry.startedAt || null,
    parentName: '',
    registrationState: 'registered',
    registeredProjectId: project.id,
    registeredProjectName: project.name,
    matchedBy: isLive ? 'port-index' : null,
    matchedDeclaredPort: true,
    isNewSubService: false,
    ignored: false,
    declaredFrom: { projectId: project.id, projectName: project.name, serviceId: entry.id || null },
    candidate: null,
  }
}

function stackOf(group, projects) {
  const registered = projects.find((project) => project.dir && normalizeDir(project.dir) === normalizeDir(group.projectDir))
  const project = group.projectMeta || null
  return {
    kinds: project?.stack?.kinds || [],
    packageName: project?.stack?.packageName || registered?.name || null,
    scripts: project?.stack?.scripts || [],
    dependencies: project?.stack?.dependencies || [],
    markers: project?.markers || [],
    projectType: registered?.type || null,
  }
}

/** 组内冲突：同一端口被不同进程/地址重复监听 */
function detectPortOverlaps(services) {
  const byPort = new Map()
  for (const service of services) {
    if (!service.live || !service.port) continue
    const list = byPort.get(service.port) || []
    list.push(service)
    byPort.set(service.port, list)
  }
  const conflicts = []
  for (const [port, list] of byPort) {
    const identities = new Set(list.map((item) => `${item.pid}@${item.address || ''}`))
    if (identities.size > 1) {
      conflicts.push({
        port,
        type: 'port-overlap',
        message: `端口 ${port} 在同一个项目里有多个监听者：${list.map((item) => `${item.processName || '?'}(PID ${item.pid}) ${item.address || ''}`).join('、')}`,
      })
    }
  }
  return conflicts
}

/**
 * 已登记项目声明的端口被别的目录的服务占用 → 冲突。
 *
 * 注意：占用者落在**项目目录的子目录**（例如 monorepo 里的 web/、server/）时
 * 不能算冲突——那多半就是项目自己的服务（实测：Vite 前端跑在 DevServerManager\web，
 * 却被判成"被别的目录占用"）。只有落在项目目录之外才是真的外来占用。
 */
function isInsideProject(candidateDir, groupDir) {
  if (!candidateDir || !groupDir) return false
  const child = normalizeDir(candidateDir)
  // normalizeDir 已统一成反斜杠并转小写，这里只需处理分隔符边界
  return child === groupDir || child.startsWith(`${groupDir}\\`)
}

function foreignOwnerConflicts(registered, usable, groupDir) {
  const conflicts = []
  if (!registered?.port) return conflicts
  const normalizedGroupDir = normalizeDir(groupDir)
  if (!normalizedGroupDir) return conflicts
  const foreign = usable.find(
    (candidate) => Number(candidate.port) === Number(registered.port) && !isInsideProject(candidate.projectDir, normalizedGroupDir),
  )
  if (foreign) {
    conflicts.push({
      port: Number(registered.port),
      type: 'foreign-owner',
      message: `项目声明的端口 ${registered.port} 实际被 ${foreign.processName || '其他进程'}(PID ${foreign.pid}) 在 ${foreign.projectDir || '未知目录'} 监听`,
    })
  }
  return conflicts
}

function computeStatus({ services, conflicts }) {
  const live = services.filter((service) => service.live)
  const declaredOnly = services.filter((service) => !service.live)
  if (conflicts.length > 0) return { ...GROUP_STATUS.conflict, conflicts }
  if (live.length > 0 && declaredOnly.length === 0) return { ...GROUP_STATUS.allRunning, conflicts: [] }
  if (live.length > 0 && declaredOnly.length > 0) return { ...GROUP_STATUS.partialRunning, conflicts: [] }
  return { ...GROUP_STATUS.allStopped, conflicts: [] }
}

function summarize(group, services) {
  const live = services.filter((service) => service.live)
  const pids = new Set(live.map((service) => service.pid).filter(Boolean))
  const ports = [...new Set(services.map((service) => service.port).filter(Boolean))].sort((a, b) => a - b)
  const newSubServices = live.filter((service) => service.isNewSubService && !service.ignored)
  return {
    services: services.length,
    live: live.length,
    declaredOnly: services.length - live.length,
    ports: ports.length,
    portList: ports,
    processes: pids.size,
    processList: [...pids].map((pid) => {
      const items = live.filter((service) => service.pid === pid)
      return { pid, processName: items[0]?.processName || '', ports: items.map((service) => service.port).filter(Boolean) }
    }),
    newSubServices: newSubServices.length,
    ignored: services.filter((service) => service.ignored).length,
    types: [...new Set(live.map((service) => service.type).filter(Boolean))],
  }
}

/**
 * 聚合入口。
 * @param {object} input
 * @param {Array} input.candidates  自动发现候选（含 filtered / registrationState 等）
 * @param {Array} input.projects    已登记项目
 * @param {Array} [input.extraConflicts] 额外冲突（例如端口映射页面算出的冲突）
 */
export function buildProjectGroups({ candidates = [], projects = [], extraConflicts = [] } = {}) {
  const systemServices = candidates.filter((candidate) => candidate.filtered)
  const usable = candidates.filter((candidate) => !candidate.filtered)
  const ignoredCandidates = usable.filter((candidate) => candidate.registrationState === 'ignored')

  // 端口 -> 真实监听者。用于纠正"项目目录没识别出来"导致的误判：
  // 端口确实在监听就是运行中，与扫描有没有推断出目录无关。
  const portIndex = new Map()
  for (const candidate of usable) {
    if (!candidate.port) continue
    if (portIndex.has(Number(candidate.port))) continue
    portIndex.set(Number(candidate.port), candidate)
  }

  // ---- 1) 按归一化目录分桶 ----
  const dirBuckets = new Map()
  const looseBuckets = new Map()
  for (const candidate of usable) {
    const dir = normalizeDir(candidate.projectDir)
    if (dir) {
      if (!dirBuckets.has(dir)) dirBuckets.set(dir, { dir, raw: candidate.projectDir, candidates: [], projectMeta: candidate.project || null })
      const bucket = dirBuckets.get(dir)
      bucket.candidates.push(candidate)
      if (!bucket.projectMeta && candidate.project) bucket.projectMeta = candidate.project
    } else {
      // 没有项目目录：按 PID 归组（同一进程的多个端口），绝不与目录组合并
      const key = `pid:${candidate.pid}`
      if (!looseBuckets.has(key)) looseBuckets.set(key, [])
      looseBuckets.get(key).push(candidate)
    }
  }

  // ---- 2) 已登记项目：并入同目录组；目录没有任何监听时单独成组（全部停止）----
  const groups = []
  const usedProjectIds = new Set()
  for (const [dir, bucket] of dirBuckets) {
    const registered = projects.find((project) => project.dir && normalizeDir(project.dir) === dir) || null
    if (registered) usedProjectIds.add(registered.id)
    const services = bucket.candidates.map((candidate) => toService(candidate, { registeredProject: registered }))

    if (registered) {
      const declared = declaredPortsOf(registered)
      const livePorts = new Set(services.map((service) => Number(service.port)))
      if (registered.port && !livePorts.has(Number(registered.port))) {
        services.unshift(toDeclaredOnlyService(registered, { name: registered.name, port: registered.port, type: registered.type }, portIndex))
      }
      for (const entry of registered.services || []) {
        if (!entry.port || livePorts.has(Number(entry.port))) continue
        services.push(toDeclaredOnlyService(registered, entry, portIndex))
      }
      void declared
    }

    const conflicts = detectPortOverlaps(services)
    // 已登记项目的主端口被别的目录的服务占用 → 冲突
    conflicts.push(...foreignOwnerConflicts(registered, usable, dir))

    const summary = summarize({ dir }, services)
    const status = computeStatus({ services, conflicts })
    groups.push({
      id: `dir:${dir}`,
      kind: 'directory',
      key: dir,
      name: registered?.name || bucket.projectMeta?.stack?.packageName || path.basename(bucket.raw || dir) || dir,
      projectDir: bucket.raw || registered?.dir || null,
      dirSource: bucket.candidates[0]?.projectDirSource || null,
      projectMeta: bucket.projectMeta,
      stack: stackOf({ projectDir: bucket.raw, projectMeta: bucket.projectMeta }, projects),
      registeredProjectId: registered?.id || null,
      registeredProjectName: registered?.name || null,
      registrationState: registered ? 'registered' : 'unregistered',
      status: status.status,
      statusText: status.text,
      statusTone: status.tone,
      conflicts: [...conflicts, ...extraConflicts.filter((item) => item.port && summary.portList.includes(Number(item.port)))],
      services: services.sort((a, b) => (a.port ?? 0) - (b.port ?? 0)),
      summary,
      newSubServices: services.filter((service) => service.isNewSubService && !service.ignored),
    })
  }

  // ---- 3) 已登记项目但目录下当前没有任何监听 ----
  for (const project of projects) {
    if (usedProjectIds.has(project.id)) continue
    const services = []
    if (project.port) services.push(toDeclaredOnlyService(project, { name: project.name, port: project.port, type: project.type }, portIndex))
    for (const entry of project.services || []) services.push(toDeclaredOnlyService(project, entry, portIndex))
    if (services.length === 0) continue
    const summary = summarize({ dir: project.dir }, services)
    const conflicts = foreignOwnerConflicts(project, usable, normalizeDir(project.dir))
    const status = computeStatus({ services, conflicts })
    groups.push({
      id: project.dir ? `dir:${normalizeDir(project.dir)}` : `project:${project.id}`,
      kind: project.dir ? 'directory' : 'project',
      key: normalizeDir(project.dir) || `project:${project.id}`,
      name: project.name,
      projectDir: project.dir || null,
      dirSource: '项目记录',
      projectMeta: null,
      stack: stackOf({ projectDir: project.dir, projectMeta: null }, projects),
      registeredProjectId: project.id,
      registeredProjectName: project.name,
      registrationState: 'registered',
      status: status.status,
      statusText: status.text,
      statusTone: status.tone,
      conflicts,
      services,
      summary,
      newSubServices: [],
    })
  }

  // ---- 4) 无目录服务：按 PID 成组 ----
  // 已经归属某个已登记项目的端口（端口与项目记录对得上）不再重复出现在这里：
  // 实测 2299/8787 这类"目录没识别出来但确实是项目子服务"的进程，
  // 会既出现在项目分组里、又在 loose 里各列一遍，看着像同一个服务登记了两次。
  const registeredPorts = new Set()
  for (const project of projects) {
    if (project.port) registeredPorts.add(Number(project.port))
    for (const entry of project.services || []) {
      if (entry.port) registeredPorts.add(Number(entry.port))
    }
  }

  const loose = []
  for (const [key, items] of looseBuckets) {
    const onlyUnregistered = items.filter((candidate) => !registeredPorts.has(Number(candidate.port)))
    if (onlyUnregistered.length === 0) continue
    const services = onlyUnregistered.map((candidate) => toService(candidate))
    const summary = summarize({ dir: null }, services)
    const status = computeStatus({ services, conflicts: detectPortOverlaps(services) })
    loose.push({
      id: `loose:${key}`,
      kind: 'loose',
      key,
      name: services[0]?.serviceName || services[0]?.processName || '未识别目录的服务',
      projectDir: null,
      dirSource: null,
      projectMeta: null,
      stack: { kinds: [], packageName: null, scripts: [], dependencies: [], markers: [], projectType: null },
      registeredProjectId: null,
      registeredProjectName: null,
      registrationState: 'unregistered',
      status: status.status,
      statusText: status.text,
      statusTone: status.tone,
      conflicts: status.conflicts,
      services: services.sort((a, b) => (a.port ?? 0) - (b.port ?? 0)),
      summary,
      newSubServices: [],
    })
  }

  const sortGroups = (list) =>
    list.sort((a, b) => {
      if (a.registrationState !== b.registrationState) return a.registrationState === 'registered' ? -1 : 1
      if (b.summary.live !== a.summary.live) return b.summary.live - a.summary.live
      return String(a.name).localeCompare(String(b.name))
    })

  const directoryGroups = sortGroups(groups)
  const looseGroups = sortGroups(loose)

  return {
    groups: directoryGroups,
    loose: looseGroups,
    system: systemServices,
    ignoredServices: ignoredCandidates,
    summary: {
      groups: directoryGroups.length + looseGroups.length,
      directoryGroups: directoryGroups.length,
      looseGroups: looseGroups.length,
      registeredGroups: directoryGroups.filter((group) => group.registrationState === 'registered').length,
      unregisteredGroups: directoryGroups.filter((group) => group.registrationState !== 'registered').length,
      services: usable.length,
      liveServices: usable.length,
      ignoredServices: ignoredCandidates.length,
      systemServices: systemServices.length,
      newSubServices: directoryGroups.reduce((sum, group) => sum + group.newSubServices.length, 0),
      conflicts: [...directoryGroups, ...looseGroups].reduce((sum, group) => sum + group.conflicts.length, 0),
      ports: new Set(usable.map((candidate) => candidate.port).filter(Boolean)).size,
    },
  }
}
