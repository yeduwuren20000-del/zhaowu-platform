import path from 'node:path'
import fs from 'node:fs'
import { portScanner } from './portScanner.js'
import { processInspector } from './processInspector.js'
import { detectProject } from './projectDetector.js'
import { classifyService } from './serviceClassifier.js'
import { buildProjectGroups } from './projectGrouping.js'
import { aggregateProjectResources } from './projectResource.js'
import { aiConfig, identifyCandidates } from './aiIdentifier.js'
import { projectsRepo } from '../store/projectsRepo.js'
import { serversRepo } from '../store/serversRepo.js'
import { discoveryRepo } from '../store/discoveryRepo.js'
import { logRepo } from '../store/logRepo.js'
import { observeDiscoveryScan } from './eventService.js'
import { badRequest, HttpError, notFound } from '../utils/http.js'
import { nowIso } from '../utils/ids.js'

/**
 * 本地服务自动发现（只读）：
 *   真实监听端口 -> 进程事实 -> 项目元数据 -> 规则分类 -> （可选）AI 建议 -> 与已登记项目/忽略列表比对
 *
 * 全流程只读：只调用 PowerShell 查询类命令、只读白名单项目文件；
 * **绝不执行**目标项目里的任何脚本（不 npm install / 不运行 package.json scripts）。
 */

const MAX_CANDIDATES_STORED = 200

/** 与项目分组保持一致的口径（聚合模块里也有一份，供纯函数测试使用） */
function normalizeDir(dir) {
  if (!dir) return ''
  return path.resolve(dir).replace(/[\\/]+$/, '').toLowerCase()
}

/**
 * 与已登记项目匹配：
 *   - 端口命中项目已登记的端口（主端口或子服务端口）→ 视为"已登记"；
 *   - 只是落在项目目录下、端口没登记过 → 归到该项目下但保持"未登记"（即"发现新的子服务"）。
 * 这样"同目录新端口"不会被误标成已登记，用户忽略后也不会被自动"洗白"。
 */
function matchRegisteredProject(service, projects) {
  const port = Number(service.port)
  const byPort = projects.find((project) => project.port && Number(project.port) === port)
  if (byPort) return { project: byPort, matchedBy: '端口', declared: true }
  const withService = projects.find((project) => (project.services || []).some((item) => Number(item.port) === port))
  if (withService) return { project: withService, matchedBy: '子服务端口', declared: true }
  if (service.projectDir) {
    const target = normalizeDir(service.projectDir)
    const byDir = projects.find((project) => project.dir && normalizeDir(project.dir) === target)
    if (byDir) return { project: byDir, matchedBy: '项目目录', declared: false }
  }
  return { project: null, matchedBy: null, declared: false }
}

/**
 * 兜底：命令里用的是相对路径（例如 `node server/src/index.js`），Windows 拿不到进程工作目录，
 * 于是拿已登记项目的目录去试——文件确实在某个项目目录下，就把该项目目录当作推断结果。
 * 只做文件存在性判断，不执行任何东西。
 */
function resolveDirByRelativePaths(candidate, projects) {
  if (candidate.projectDir || !candidate.commandLine) return null
  const tokens = processInspector.tokenizeCommandLine(candidate.commandLine)
  const relatives = tokens.filter(
    (token) =>
      !/^[a-zA-Z]:[\\/]/.test(token) &&
      !token.startsWith('-') &&
      (token.includes('/') || token.includes('\\')) &&
      /\.(js|mjs|cjs|ts|tsx|jsx|py|json|toml|jar|go|rs|php|rb)$/i.test(token),
  )
  if (relatives.length === 0) return null
  for (const project of projects) {
    if (!project.dir) continue
    for (const relative of relatives) {
      try {
        if (fs.existsSync(path.join(project.dir, relative))) {
          return { dir: project.dir, source: `命令行相对路径 ${relative} 命中已登记项目目录` }
        }
      } catch {
        /* 忽略不可访问的路径 */
      }
    }
  }
  return null
}

/** 组装一个候选服务（事实字段全部来自系统采集） */
function buildCandidate({ listener, process: proc, chain, project, classification }) {
  return {
    // ---- 事实字段（来自系统，AI 与前端都不能改写） ----
    fingerprint: classification.fingerprint,
    pid: listener.pid,
    port: listener.port,
    address: listener.address || '',
    protocol: 'tcp',
    processName: proc?.name || listener.processName || '',
    exePath: proc?.exePath || '',
    commandLine: proc?.commandLine || '',
    startedAt: proc?.startedAt || null,
    chain: (chain || []).map((item) => ({ pid: item.pid, name: item.name, exePath: item.exePath, commandLine: item.commandLine })),
    parentName: chain?.[1]?.name || '',
    // ---- 推断字段（来自有限深度探测，标注来源） ----
    projectDir: project?.root || null,
    projectDirSource: project?.source || null,
    projectMarkers: project?.markers || [],
    project: project
      ? {
          root: project.root,
          markers: project.markers,
          hasDockerfile: project.hasDockerfile,
          stack: project.stack,
        }
      : null,
    // ---- 规则层结论 ----
    serviceName: classification.serviceName,
    type: classification.type,
    category: classification.category,
    confidence: classification.confidence,
    reasons: classification.reasons,
    source: 'rule',
    filtered: classification.filtered,
    filterReason: classification.filterReason,
    devRelevant: classification.devRelevant,
    suggestedStartCommand: classification.suggestedStartCommand,
    startCommandSource: classification.startCommandSource,
    suggestedUrl: classification.suggestedUrl,
    aiEligible: classification.aiEligible,
    ai: null,
    // ---- 与工作台现有数据的关系 ----
    registeredProjectId: null,
    registeredProjectName: null,
    matchedBy: null,
    registrationState: 'unregistered', // unregistered | registered | ignored
  }
}

/** 执行一次扫描（不写 AI 结果到项目数据，只更新发现记录） */
export async function scanLocalServices({ includeAi = false, force = true, aiClient = undefined } = {}) {
  const startedAt = Date.now()
  const [listeners, processTable, projects, ignored] = await Promise.all([
    portScanner.scan({ force }),
    processInspector.getProcessTable({ force }),
    projectsRepo.list(),
    discoveryRepo.listIgnored(),
  ])
  const ignoredSet = new Set(ignored.map((item) => item.fingerprint))

  // 一个进程可能监听多个端口：先按 PID 归组，项目探测只做一次
  const byPid = new Map()
  for (const listener of listeners) {
    const key = Number(listener.pid)
    if (!byPid.has(key)) byPid.set(key, [])
    byPid.get(key).push(listener)
  }

  const candidates = []
  for (const [pid, ports] of byPid) {
    const proc = processTable.get(pid) || null
    const chain = processInspector.buildParentChain(pid, processTable)
    const dirCandidates = processInspector.inferCandidateDirs(
      proc || { commandLine: '', exePath: '' },
      chain,
    )
    const project = detectProject(dirCandidates)

    for (const listener of ports) {
      const classification = classifyService({
        port: listener.port,
        address: listener.address,
        pid,
        processName: proc?.name || listener.processName || '',
        exePath: proc?.exePath || '',
        commandLine: proc?.commandLine || '',
        chain,
        project,
      })
      const candidate = buildCandidate({ listener, process: proc, chain, project, classification })

      const { project: matched, matchedBy, declared } = matchRegisteredProject(candidate, projects)
      const ignoredHere = ignoredSet.has(candidate.fingerprint)
      if (matched && declared) {
        candidate.registeredProjectId = matched.id
        candidate.registeredProjectName = matched.name
        candidate.matchedBy = matchedBy
        candidate.registrationState = 'registered'
        candidate.filtered = false
        candidate.filterReason = null
        candidate.confidence = Math.max(candidate.confidence, 0.95)
        candidate.reasons = [...candidate.reasons, `已登记为项目「${matched.name}」（按${matchedBy}匹配）`]
      } else {
        // 相对路径兜底：能挂到已登记项目目录就补上目录
        const byRelative = resolveDirByRelativePaths(candidate, projects)
        if (byRelative) {
          candidate.projectDir = byRelative.dir
          candidate.projectDirSource = byRelative.source
          candidate.reasons = [...candidate.reasons, byRelative.source]
        }
        if (matched) {
          // 同目录但端口没登记过 → 保持未登记（分组里会标记为"发现新的子服务"），但标明归属
          candidate.registeredProjectId = null
          candidate.registeredProjectName = null
          candidate.sameDirectoryProjectId = matched.id
          candidate.sameDirectoryProjectName = matched.name
          candidate.matchedBy = matchedBy
          candidate.registrationState = ignoredHere ? 'ignored' : 'unregistered'
          candidate.reasons = [...candidate.reasons, `位于已登记项目「${matched.name}」的目录下，但该端口没有登记`]
        }
      }
      if (candidate.registrationState === 'unregistered' && ignoredSet.has(candidate.fingerprint)) {
        candidate.registrationState = 'ignored'
      }
      candidates.push(candidate)
    }
  }

  // AI 层：只处理规则判不准、且没被过滤/已忽略/已登记的候选
  let aiNote = null
  let aiSummary = null
  const config = aiConfig()
  const aiTargets = candidates.filter(
    (item) => item.aiEligible && item.registrationState === 'unregistered' && !item.filtered,
  )
  if (includeAi) {
    if (!config.available) {
      aiNote = config.reason
    } else if (aiTargets.length === 0) {
      aiNote = '没有需要 AI 辅助判断的候选（规则层已经给出明确结论）'
    } else {
      const outcome = await identifyCandidates(aiTargets, { config, client: aiClient })
      let applied = 0
      const failures = []
      for (const candidate of candidates) {
        const result = outcome.results?.get(candidate.fingerprint)
        if (!result) continue
        if (result.error) {
          failures.push(result.error)
          continue
        }
        if (result.merged) {
          // 再次确认事实字段没有被改写
          for (const field of ['pid', 'port', 'address', 'processName', 'exePath', 'commandLine', 'projectDir', 'fingerprint']) {
            if (result.merged.candidate[field] !== candidate[field]) {
              throw new HttpError(500, `AI 结果试图改写事实字段 ${field}，已拒绝`)
            }
          }
          candidate.ai = result.merged.candidate.ai
          candidate.source = 'rule+ai'
          applied += 1
          await discoveryRepo.setAiCache(candidate.fingerprint, { at: nowIso(), ai: candidate.ai })
        }
      }
      aiSummary = { available: true, model: outcome.model, requested: outcome.used, applied, failed: failures.length, skipped: outcome.skipped || 0 }
      aiNote = failures.length > 0 ? `AI 识别部分失败：${failures[0]}` : null
    }
  } else if (config.available && aiTargets.length > 0) {
    aiNote = `有 ${aiTargets.length} 个候选可交给 AI 辅助识别（勾选"启用 AI"后执行）`
  } else if (!config.available) {
    aiNote = config.reason
  }

  candidates.sort((a, b) => {
    if (a.filtered !== b.filtered) return a.filtered ? 1 : -1
    return (b.confidence || 0) - (a.confidence || 0) || (a.port ?? 0) - (b.port ?? 0)
  })

  const recommended = candidates.filter((item) => !item.filtered && item.registrationState === 'unregistered')
  const filtered = candidates.filter((item) => item.filtered)
  const ignoredServices = candidates.filter((item) => item.registrationState === 'ignored')
  const registered = candidates.filter((item) => item.registrationState === 'registered')

  const summary = {
    listeningCount: listeners.length,
    processCount: byPid.size,
    total: candidates.length,
    recommended: recommended.length,
    registered: registered.length,
    ignored: ignoredServices.length,
    filtered: filtered.length,
    withProject: candidates.filter((item) => item.projectDir).length,
    aiApplied: candidates.filter((item) => item.ai).length,
  }

  const previous = await discoveryRepo.getLastScan()
  const acknowledged = new Set((await discoveryRepo.read()).acknowledged)
  const newCandidates = recommended.filter((item) => !acknowledged.has(item.fingerprint))
  const knownFingerprints = new Set((previous?.candidates || []).map((item) => item.fingerprint))
  const firstSeen = recommended.filter((item) => !knownFingerprints.has(item.fingerprint))

  const scan = {
    at: nowIso(),
    durationMs: Date.now() - startedAt,
    summary,
    aiNote,
    aiSummary,
    candidates: candidates.filter((item) => !item.filtered).slice(0, MAX_CANDIDATES_STORED),
    filtered: filtered.slice(0, MAX_CANDIDATES_STORED),
    ignored: ignoredServices.slice(0, MAX_CANDIDATES_STORED),
    newCandidates: newCandidates.map((item) => ({ fingerprint: item.fingerprint, serviceName: item.serviceName, port: item.port, processName: item.processName })),
    firstSeen: firstSeen.map((item) => ({ fingerprint: item.fingerprint, serviceName: item.serviceName, port: item.port })),
  }
  await discoveryRepo.saveScan(scan)

  // 第六阶段：新发现的监听服务进入事件时间线（首次扫描只记一条汇总，不逐条刷）
  await observeDiscoveryScan(scan, { firstScan: !previous })

  // 第五阶段：按项目目录聚合成项目组（多进程/多端口 -> 一个项目）
  const grouping = buildProjectGroups({ candidates, projects })

  if (recommended.length > 0 || firstSeen.length > 0) {
    await logRepo.append({
      level: firstSeen.length > 0 ? 'info' : 'success',
      source: '自动发现',
      message:
        `扫描到 ${listeners.length} 个监听端口、${candidates.length} 条服务、聚合出 ${grouping.summary.directoryGroups} 个项目目录分组；` +
        `推荐登记 ${recommended.length} 个（其中新发现 ${firstSeen.length} 个）、已登记 ${registered.length} 个、已忽略 ${ignoredServices.length} 个、过滤 ${filtered.length} 个`,
    })
  }

  return {
    ...scan,
    recommended,
    filteredServices: filtered,
    ignoredServices,
    registeredServices: registered,
    groups: grouping.groups,
    looseGroups: grouping.loose,
    systemServices: grouping.system,
    groupSummary: grouping.summary,
  }
}

/**
 * 基于最近一次扫描结果 + 已登记项目构建「项目分组」视图（不重新扫描）。
 * 自动发现页与本地项目页共用同一口径。
 */
export async function getProjectGroups({ withResources = true } = {}) {
  const [scan, projects] = await Promise.all([discoveryRepo.getLastScan(), projectsRepo.list()])
  const candidates = [...(scan?.candidates || []), ...(scan?.filtered || []), ...(scan?.ignored || [])]
  const grouping = buildProjectGroups({ candidates, projects })

  // 附上项目记录本身（端口 / 子服务 / 远程关联），供资源归集与 UI 使用
  const projectById = new Map(projects.map((project) => [project.id, project]))
  for (const group of [...grouping.groups, ...grouping.loose]) {
    group.project = group.registeredProjectId ? projectById.get(group.registeredProjectId) || null : null
  }

  // 第七阶段：把 SSH / Docker 已有采集结果按项目组归集（只归集，不发起新采集）
  if (withResources) {
    const servers = await serversRepo.list()
    const resources = aggregateProjectResources({ groups: grouping.groups, servers })
    const byGroupId = new Map(resources.items.map((item) => [item.groupId, item]))
    for (const group of grouping.groups) {
      group.resources = byGroupId.get(group.id) || null
    }
    grouping.resources = { summary: resources.summary, items: resources.items }
  }

  return { scanAt: scan?.at || null, aiNote: scan?.aiNote || null, projects, ...grouping }
}

/** 最近一次扫描状态（首页提醒用） */
export async function getDiscoveryState() {
  const [scan, ignored, data] = await Promise.all([discoveryRepo.getLastScan(), discoveryRepo.listIgnored(), discoveryRepo.read()])
  const acknowledged = new Set(data.acknowledged || [])
  const pending = (scan?.newCandidates || []).filter((item) => !acknowledged.has(item.fingerprint))
  return {
    lastScanAt: scan?.at || null,
    durationMs: scan?.durationMs ?? null,
    summary: scan?.summary || null,
    aiNote: scan?.aiNote || null,
    newCandidates: pending,
    newCount: pending.length,
    ignoredCount: ignored.length,
    registeredCount: scan?.summary?.registered ?? 0,
    recommendedCount: scan?.summary?.recommended ?? 0,
  }
}

/** 从最近一次扫描结果里取候选（登记的事实来源） */
async function findCandidate(fingerprint) {
  const scan = await discoveryRepo.getLastScan()
  const pools = [scan?.candidates || [], scan?.filtered || [], scan?.ignored || []]
  for (const pool of pools) {
    const found = pool.find((item) => item.fingerprint === fingerprint)
    if (found) return found
  }
  return null
}

/**
 * 登记前的「重复覆盖」守卫。
 *
 * 起因（真实场景）：整仓项目 `DevServerManager` 已经声明了端口 5180，
 * 自动发现又看到子目录 `web/` 在监听 5180，于是建了第二个项目 `dev-server-manager-web`。
 * 两者不是"抢端口"，而是**同一个服务被登记了两次**，此后每次扫描都提示一次冲突，
 * 删掉还会再长出来。
 *
 * 规则：**候选目录落在某个已登记项目的目录树之内，且该项目的主端口（或子服务端口）
 * 与候选端口相同** → 判定为"已被覆盖"，拒绝新建并说明被谁覆盖。
 * 这样同一个服务只会挂在最外层那个项目下，符合"一个项目管全部"的直觉。
 */
async function findCoveringProject({ dir, port }) {
  const normalizedDir = dir ? normalizeDir(dir) : ''
  if (!normalizedDir || !port) return null
  const projects = await projectsRepo.list()
  for (const project of projects) {
    const projectDir = normalizeDir(project.dir || '')
    if (!projectDir) continue
    // 候选目录必须在项目目录之内（严格包含，不能相等 —— 相等时目录相同，属于另一种情况）。
    // Windows 路径是反斜杠，只判 `${dir}/` 会让这条守卫在 Windows 上永远不生效。
    if (normalizedDir === projectDir) continue
    if (!normalizedDir.startsWith(`${projectDir}\\`) && !normalizedDir.startsWith(`${projectDir}/`)) continue
    // 项目主端口命中
    const declared = [project.port, ...(project.services || []).map((s) => s.port)].filter(Boolean).map(Number)
    if (declared.includes(Number(port))) return project
  }
  return null
}

/**
 * 登记候选为项目：
 *   - 事实字段（端口/PID/进程/命令行/推断目录）取自**服务端保存的扫描结果**，不信任请求体；
 *   - 只允许用户覆盖展示类字段（名称、类型、启动命令、访问地址、备注、目录、端口）。
 */
export async function registerCandidate({ fingerprint, overrides = {} } = {}) {
  if (!fingerprint) throw badRequest('缺少 fingerprint')
  const candidate = await findCandidate(fingerprint)
  if (!candidate) throw notFound('扫描结果里没有这个候选，请重新扫描')
  if (candidate.registeredProjectId) throw badRequest(`该服务已经登记为项目「${candidate.registeredProjectName}」`)

  const port = overrides.port === undefined || overrides.port === null || overrides.port === '' ? candidate.port : Number(overrides.port)
  const dir = String(overrides.dir || candidate.projectDir || '').trim()
  // 重复覆盖守卫：已被某个外层项目声明过就不再建新项目
  const covering = await findCoveringProject({ dir, port })
  if (covering) {
    throw badRequest(
      `端口 ${port} 已由项目「${covering.name}」声明，且它的目录包含 ${dir} —— ` +
        `这属于同一个服务被登记了两次，请直接把它加到「${covering.name}」的子服务里，不要新建项目`,
    )
  }

  const payload = {
    name: String(overrides.name || candidate.ai?.serviceName || candidate.serviceName || `服务 ${candidate.port}`).slice(0, 120),
    type: String(overrides.type || candidate.ai?.type || candidate.type || '自动发现').slice(0, 60),
    dir: String(overrides.dir || candidate.projectDir || '').slice(0, 400),
    startCommand: String(overrides.startCommand || candidate.ai?.suggestedStartCommand || candidate.suggestedStartCommand || '').slice(0, 400),
    stopCommand: String(overrides.stopCommand || '').slice(0, 400),
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : null,
    url: String(overrides.url || (port ? `http://localhost:${port}` : '')).slice(0, 400),
    remark: String(
      overrides.remark ||
        `自动发现登记：${candidate.source === 'rule+ai' ? '规则 + AI 建议' : '规则识别'}${candidate.reasons?.length ? `（${candidate.reasons.join('；')}）` : ''}`,
    ).slice(0, 500),
  }
  if (!payload.name) throw badRequest('服务名称不能为空')

  const created = await projectsRepo.create(payload)
  await discoveryRepo.acknowledge([fingerprint])
  await logRepo.append({
    level: 'success',
    source: '自动发现',
    message: `已登记项目「${created.name}」（端口 ${created.port ?? '未记录'}，PID ${candidate.pid}，来源：${candidate.source}）`,
  })

  // 更新最近一次扫描里的登记状态，避免前端需要重新扫描
  const scan = await discoveryRepo.getLastScan()
  if (scan?.candidates) {
    const target = scan.candidates.find((item) => item.fingerprint === fingerprint)
    if (target) {
      target.registrationState = 'registered'
      target.registeredProjectId = created.id
      target.registeredProjectName = created.name
    }
    scan.summary = { ...(scan.summary || {}), recommended: Math.max(0, (scan.summary?.recommended || 1) - 1), registered: (scan.summary?.registered || 0) + 1 }
    await discoveryRepo.saveScan(scan)
  }

  return { project: created, candidate }
}

/** 把候选的**事实字段**转成项目子服务条目（用户只能改展示字段） */
function toServiceRecord(candidate, overrides = {}, extra = {}) {
  return {
    name: String(overrides.name || candidate?.ai?.serviceName || candidate?.serviceName || overrides.type || '子服务').slice(0, 120),
    kind: String(overrides.kind || candidate?.category || 'service').slice(0, 40),
    type: String(overrides.type || candidate?.ai?.type || candidate?.type || '').slice(0, 60),
    note: String(overrides.note || '').slice(0, 300),
    url: String(overrides.url || candidate?.suggestedUrl || (candidate?.port ? `http://localhost:${candidate.port}` : '')).slice(0, 400),
    // ---- 事实字段：全部来自扫描结果 ----
    port: candidate?.port ?? null,
    pid: candidate?.pid ?? null,
    address: candidate?.address || '',
    processName: candidate?.processName || '',
    exePath: candidate?.exePath || '',
    commandLine: candidate?.commandLine || '',
    startedAt: candidate?.startedAt || null,
    fingerprint: candidate?.fingerprint || null,
    source: candidate?.source || 'rule',
    ...extra,
  }
}

/** 更新最近一次扫描里某个候选的登记状态 */
async function markScannedCandidate(fingerprint, patch) {
  const scan = await discoveryRepo.getLastScan()
  if (!scan) return
  let touched = false
  for (const pool of [scan.candidates, scan.filtered, scan.ignored]) {
    const target = (pool || []).find((item) => item.fingerprint === fingerprint)
    if (target) {
      Object.assign(target, patch)
      touched = true
    }
  }
  if (touched) await discoveryRepo.saveScan(scan)
}

/**
 * 登记一个项目组（核心实现）：**只创建一个项目**，同目录的其它监听服务作为它的子服务登记。
 * 事实字段全部取自扫描结果，不信任请求体。
 */
async function registerGroupFromGroup(group, { primaryFingerprint = null, overrides = {} } = {}) {
  if (group.registeredProjectId) throw badRequest(`这个目录已经登记为项目「${group.registeredProjectName}」`)

  const liveServices = group.services.filter((service) => service.live && !service.ignored)
  if (liveServices.length === 0) throw badRequest('这个项目组当前没有可登记的服务')
  const primary = liveServices.find((service) => service.key === primaryFingerprint) || liveServices[0]
  const primaryCandidate = primary.candidate || (await findCandidate(primary.key))
  if (!primaryCandidate) throw notFound('扫描结果里没有这个候选，请重新扫描')

  const port = overrides.port === undefined || overrides.port === null || overrides.port === '' ? primary.port : Number(overrides.port)
  const payload = {
    name: String(overrides.name || group.name || primary.serviceName || `项目 ${port}`).slice(0, 120),
    type: String(overrides.type || primary.type || group.stack?.kinds?.join('/') || '自动发现').slice(0, 60),
    dir: String(overrides.dir || group.projectDir || '').slice(0, 400),
    startCommand: String(overrides.startCommand || primary.suggestedStartCommand || '').slice(0, 400),
    stopCommand: String(overrides.stopCommand || '').slice(0, 400),
    port: Number.isInteger(port) && port > 0 && port < 65536 ? port : null,
    url: String(overrides.url || (port ? `http://localhost:${port}` : '')).slice(0, 400),
    remark: String(
      overrides.remark ||
        `自动发现登记的项目组：${group.projectDir || '未识别目录'}（同目录 ${liveServices.length} 个监听服务，端口 ${group.summary.portList.join('、')}）`,
    ).slice(0, 500),
  }
  if (!payload.name) throw badRequest('项目名称不能为空')

  const created = await projectsRepo.create(payload)
  const others = liveServices.filter((service) => service.key !== primary.key)
  const associated = []
  for (const service of others) {
    const candidate = service.candidate || (await findCandidate(service.key))
    if (!candidate) continue
    const record = await projectsRepo.addService(created.id, toServiceRecord(candidate, { kind: service.category }))
    associated.push(record)
    await markScannedCandidate(service.key, {
      registrationState: 'registered',
      registeredProjectId: created.id,
      registeredProjectName: created.name,
      isNewSubService: false,
    })
    await discoveryRepo.acknowledge([service.key])
  }
  await discoveryRepo.acknowledge([primary.key])
  await markScannedCandidate(primary.key, {
    registrationState: 'registered',
    registeredProjectId: created.id,
    registeredProjectName: created.name,
  })

  await logRepo.append({
    level: 'success',
    source: '自动发现',
    message: `已按目录登记项目「${created.name}」：主服务端口 ${created.port ?? '未记录'}（PID ${primaryCandidate.pid}），同时登记 ${associated.length} 个子服务`,
  })

  const project = await projectsRepo.get(created.id)
  return { project, primary: primaryCandidate, associated }
}

/**
 * 登记一个项目组。
 */
export async function registerGroup({ groupId, primaryFingerprint, overrides = {} } = {}) {
  if (!groupId) throw badRequest('缺少 groupId')
  const { groups } = await getProjectGroups({ withResources: false })
  const group = groups.find((item) => item.id === groupId)
  if (!group) throw notFound('没有找到这个项目组，请重新扫描')
  return registerGroupFromGroup(group, { primaryFingerprint, overrides })
}

/**
 * 一键批量登记多个项目组：每组只创建一个项目，其余服务成为子服务。
 *   - 已登记的组、没有可登记服务的组会跳过并给出原因（不中断整批）；
 *   - 事实字段仍全部取自扫描结果。
 */
export async function registerGroups({ groupIds = [], overrides = {} } = {}) {
  const list = [...new Set((Array.isArray(groupIds) ? groupIds : [groupIds]).filter(Boolean))]
  if (list.length === 0) throw badRequest('缺少 groupId')

  const { groups } = await getProjectGroups({ withResources: false })
  const groupById = new Map(groups.map((group) => [group.id, group]))

  const results = []
  let created = 0
  let skipped = 0
  let failed = 0

  for (const groupId of list) {
    const group = groupById.get(groupId)
    if (!group) {
      failed += 1
      results.push({ groupId, ok: false, reason: 'group-not-found', error: '没有找到这个项目组，请重新扫描' })
      continue
    }
    if (group.registeredProjectId) {
      skipped += 1
      results.push({ groupId, ok: false, reason: 'already-registered', name: group.name, error: `已经登记为项目「${group.registeredProjectName}」` })
      continue
    }
    if (!group.services.some((service) => service.live && !service.ignored)) {
      skipped += 1
      results.push({ groupId, ok: false, reason: 'no-live-services', name: group.name, error: '该组当前没有可登记的服务' })
      continue
    }
    try {
      const { project, associated } = await registerGroupFromGroup(group, { overrides })
      created += 1
      results.push({ groupId, ok: true, name: project.name, projectId: project.id, subServices: associated.length })
    } catch (error) {
      failed += 1
      results.push({ groupId, ok: false, reason: 'error', name: group.name, error: error.message })
    }
  }

  await logRepo.append({
    level: created > 0 ? 'success' : 'info',
    source: '自动发现',
    message: `批量登记完成：成功 ${created} 组、跳过 ${skipped} 组、失败 ${failed} 组（共 ${list.length} 组）`,
  })

  return { results, created, skipped, failed }
}

/** 把扫描到的候选关联为已登记项目的子服务（"发现新的子服务" -> 关联） */
export async function associateCandidate({ fingerprint, projectId, overrides = {} } = {}) {
  if (!fingerprint) throw badRequest('缺少 fingerprint')
  if (!projectId) throw badRequest('缺少 projectId')

  const [candidate, project] = await Promise.all([findCandidate(fingerprint), projectsRepo.find(projectId)])
  if (!candidate) throw notFound('扫描结果里没有这个候选，请重新扫描')
  if (!project) throw notFound('项目不存在')

  const existing = (project.services || []).find(
    (service) => service.fingerprint === fingerprint || (service.port && Number(service.port) === Number(candidate.port)),
  )
  if (existing) {
    return { project, service: existing, alreadyAssociated: true }
  }

  const service = await projectsRepo.addService(project.id, toServiceRecord(candidate, overrides))
  await discoveryRepo.acknowledge([fingerprint])
  await markScannedCandidate(fingerprint, {
    registrationState: 'registered',
    registeredProjectId: project.id,
    registeredProjectName: project.name,
    isNewSubService: false,
  })
  await logRepo.append({
    level: 'success',
    source: '自动发现',
    message: `已把 ${candidate.processName}:${candidate.port} 关联为项目「${project.name}」的子服务（PID ${candidate.pid}）`,
  })
  const updated = await projectsRepo.get(project.id)
  return { project: updated, service, alreadyAssociated: false }
}

/** 解除子服务关联（只删关联记录，不影响真实进程） */
export async function dissociateService({ projectId, serviceId } = {}) {
  if (!projectId || !serviceId) throw badRequest('缺少 projectId 或 serviceId')
  const removed = await projectsRepo.removeService(projectId, serviceId)
  await logRepo.append({ level: 'warn', source: '自动发现', message: `已解除子服务关联：${removed.name || removed.port}` })
  const project = await projectsRepo.get(projectId)
  return { project, removed }
}

/**
 * 第七阶段：登记 / 取消「项目 ↔ 远程服务器」的显式关联。
 *
 * 自动关联只看端口（跨机器可比的事实）；端口对不上、又确实相关联时，
 * 由用户在这里显式登记 —— 这是记录下来的事实，不是按名称猜。
 */
export async function setProjectRemoteLink({ projectId, serverId, appId = null, containerName = null, remove = false, note = '' } = {}) {
  if (!projectId) throw badRequest('缺少 projectId')
  if (!serverId) throw badRequest('缺少 serverId')
  const project = await projectsRepo.find(projectId)
  if (!project) throw notFound(`项目不存在：${projectId}`)

  const server = await serversRepo.get(serverId)
  if (!server) throw notFound(`服务器不存在：${serverId}`)

  const current = Array.isArray(project.remoteLinks) ? project.remoteLinks : []
  const sameTarget = (link) =>
    link.serverId === serverId &&
    (link.appId || null) === (appId || null) &&
    String(link.containerName || '').toLowerCase() === String(containerName || '').toLowerCase()

  let next
  if (remove) {
    next = current.filter((link) => !sameTarget(link))
  } else {
    if (current.some(sameTarget)) {
      return { project, changed: false, links: current }
    }
    next = [
      ...current,
      {
        serverId,
        appId: appId || null,
        containerName: containerName || null,
        note: String(note || '').slice(0, 200),
        createdAt: nowIso(),
      },
    ]
  }

  await projectsRepo.update(projectId, { remoteLinks: next })
  await logRepo.append({
    level: remove ? 'warn' : 'success',
    source: '资源归集',
    message: remove
      ? `已取消项目「${project.name}」与服务器「${server.name}」的关联`
      : `已登记项目「${project.name}」与服务器「${server.name}」的关联${containerName ? `（容器 ${containerName}）` : ''}`,
  })

  const updated = await projectsRepo.get(projectId)
  return { project: updated, changed: true, links: updated.remoteLinks || [] }
}

export async function ignoreCandidates({ fingerprints = [], note = '' } = {}) {
  const list = (Array.isArray(fingerprints) ? fingerprints : [fingerprints]).filter(Boolean)
  if (list.length === 0) throw badRequest('缺少 fingerprint')
  const entries = []
  for (const fingerprint of list) {
    const candidate = await findCandidate(fingerprint)
    entries.push({ fingerprint, label: candidate ? `${candidate.serviceName}:${candidate.port}` : '', note })
  }
  const ignored = await discoveryRepo.ignore(entries)
  await logRepo.append({ level: 'info', source: '自动发现', message: `已忽略 ${entries.length} 个服务（后续扫描不再提示）` })
  return { ignored }
}

export async function restoreCandidates({ fingerprints = [] } = {}) {
  const list = (Array.isArray(fingerprints) ? fingerprints : [fingerprints]).filter(Boolean)
  if (list.length === 0) throw badRequest('缺少 fingerprint')
  const ignored = await discoveryRepo.restore(list)
  await logRepo.append({ level: 'info', source: '自动发现', message: `已恢复 ${list.length} 个被忽略的服务` })
  return { ignored }
}

export async function acknowledgeCandidates({ fingerprints = [] } = {}) {
  const list = (Array.isArray(fingerprints) ? fingerprints : [fingerprints]).filter(Boolean)
  const acknowledged = await discoveryRepo.acknowledge(list)
  return { acknowledged }
}

/** 对单个候选按需调用 AI（不影响其他候选，也不写项目数据） */
export async function identifyCandidateByFingerprint(fingerprint, { aiClient } = {}) {
  const candidate = await findCandidate(fingerprint)
  if (!candidate) throw notFound('扫描结果里没有这个候选，请重新扫描')
  const cached = await discoveryRepo.getAiCache(fingerprint)
  if (cached?.ai) return { candidate: { ...candidate, ai: cached.ai, source: 'rule+ai' }, cached: true, note: null }

  const config = aiConfig()
  if (!config.available) return { candidate, cached: false, note: config.reason }

  const { identifyService } = await import('./aiIdentifier.js')
  const outcome = await identifyService(candidate, { client: aiClient, config })
  if (outcome.error || !outcome.merged) {
    return { candidate, cached: false, note: outcome.error || 'AI 未返回可用结果' }
  }
  for (const field of ['pid', 'port', 'address', 'processName', 'exePath', 'commandLine', 'projectDir', 'fingerprint']) {
    if (outcome.merged.candidate[field] !== candidate[field]) {
      throw new HttpError(500, `AI 结果试图改写事实字段 ${field}，已拒绝`)
    }
  }
  const merged = { ...candidate, ai: outcome.merged.candidate.ai, source: 'rule+ai' }
  await discoveryRepo.setAiCache(fingerprint, { at: nowIso(), ai: merged.ai })
  return { candidate: merged, cached: false, note: null }
}
