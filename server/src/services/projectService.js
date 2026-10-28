import { projectsRepo } from '../store/projectsRepo.js'
import { runtimeRepo } from '../store/runtimeRepo.js'
import { pathExistsSync } from '../utils/fsx.js'
import { runFile } from '../utils/exec.js'
import { processInfo } from './processInfo.js'
import { portScanner } from './portScanner.js'

/**
 * 项目视图 = 数据库记录 + 真实端口监听状态 + 真实进程信息。
 * status:
 *   running  端口在监听且归属与该项目的进程一致（Docker 托管型：端口由本项目容器发布）
 *   starting 追踪的进程还活着，但端口尚未监听（编译中）
 *   conflict 端口被"别的进程"占用
 *   stopped  端口没有监听
 */

/** 跑一次 docker ps，收集「运行中容器名 → 它发布的宿主端口集合」。Docker 不在时返回空 Map。 */
async function collectRunningContainers() {
  const map = new Map()
  try {
    const { stdout } = await runFile('docker', ['ps', '--format', '{{json .}}'], { timeout: 15000 })
    for (const line of String(stdout || '').trim().split('\n')) {
      if (!line.trim()) continue
      let raw = null
      try {
        raw = JSON.parse(line)
      } catch {
        continue
      }
      const ports = new Set()
      for (const m of String(raw.Ports || '').matchAll(/:(\d+)->/g)) ports.add(Number(m[1]))
      // 注意字段名是 Names（复数）：docker 新版 --format '{{json .}}' 用的是 .Names
      if (raw.Names) map.set(raw.Names, ports)
    }
  } catch {
    /* Docker 没装 / 没启动：没有容器信息，退回纯端口判定 */
  }
  return map
}

function uptimeMs(startedAt) {
  if (!startedAt) return null
  const started = Date.parse(startedAt)
  if (Number.isNaN(started)) return null
  return Math.max(0, Date.now() - started)
}

/**
 * 项目下的子服务视图（第五阶段）：每个子服务保留自己的事实字段，
 * 并用真实监听表判断它当前是否在运行。
 */
function buildServiceViews(project, { portIndex, stats }) {
  const services = Array.isArray(project.services) ? project.services : []
  return services.map((service) => {
    const owner = service.port ? portIndex.get(Number(service.port)) || null : null
    const stat = owner?.pid ? stats.get(Number(owner.pid)) || null : null
    return {
      ...service,
      live: Boolean(owner),
      status: owner ? 'running' : 'stopped',
      statusText: owner ? '运行中' : '已停止',
      livePid: owner?.pid ?? null,
      liveProcessName: owner?.processName || '',
      liveAddress: owner?.address || '',
      memory: stat?.memory ?? null,
      startedAt: stat?.startedAt || service.startedAt || null,
      uptimeMs: uptimeMs(stat?.startedAt || service.startedAt),
    }
  })
}

function buildView(project, { portIndex, runtimes, stats, ancestry, dockerContainers = new Map() }) {
  const runtime = runtimes[project.id] || null
  const runtimeAlive = runtime?.pid ? processInfo.isPidAlive(runtime.pid) : false
  const owner = project.port ? portIndex.get(Number(project.port)) || null : null
  const effectivePid = owner?.pid || runtime?.pid || null
  const processStat = effectivePid ? stats.get(Number(effectivePid)) || null : null
  // 端口归属判断：PID 相等，或者监听进程是启动命令的子进程（shell -> node）。
  // compose 认领例外：runtime 没有 pid（启动器发射完容器就退了），但只要认领记录
  // 的端口与项目端口一致，就认定这个占用者是本项目的容器（Dify 场景）。
  let ownerIsOurs = Boolean(
    owner &&
      runtime &&
      (runtime.pid
        ? Number(owner.pid) === Number(runtime.pid) ||
          (ancestry.get(Number(owner.pid)) || new Set()).has(Number(runtime.pid))
        : runtime.port !== undefined && Number(runtime.port) === Number(project.port)),
  )
  // Docker 托管型（登记了容器名）：容器在跑且发布着项目端口 → 占用者就是本项目，
  // 哪怕没有 runtime 记录——容器可能是从「文档转换」页等别的入口启动的，
  // 项目页这边完全不知情，不能因此报「端口被占用」。
  const containerIsOurs = Boolean(
    owner &&
      project.containerName &&
      project.port &&
      (dockerContainers.get(project.containerName) || new Set()).has(Number(project.port)),
  )
  if (containerIsOurs) ownerIsOurs = true

  let status = 'stopped'
  let statusText = '已停止'
  let conflict = null

  if (owner) {
    if (ownerIsOurs) {
      status = 'running'
      statusText = containerIsOurs ? '运行中（容器）' : '运行中'
    } else if (runtimeAlive) {
      status = 'conflict'
      statusText = '端口冲突'
      conflict = {
        type: 'foreign',
        message: `端口 ${project.port} 被 PID ${owner.pid}(${owner.processName || '未知进程'}) 占用`,
      }
    } else {
      status = 'conflict'
      statusText = '端口被占用'
      conflict = {
        type: 'foreign',
        message: `端口 ${project.port} 被 PID ${owner.pid}(${owner.processName || '未知进程'}) 占用，项目本身未运行`,
      }
    }
  } else if (project.port && runtimeAlive) {
    status = 'starting'
    statusText = '启动中'
  } else if (!project.port && runtimeAlive) {
    status = 'running'
    statusText = '运行中（未记录端口）'
  }

  return {
    ...project,
    dirExists: pathExistsSync(project.dir),
    status,
    statusText,
    conflict,
    services: buildServiceViews(project, { portIndex, stats }),
    serviceCount: (project.services || []).length,
    liveServiceCount: (project.services || []).filter((service) => service.port && portIndex.has(Number(service.port))).length,
    runtime: runtime
      ? {
          pid: runtime.pid,
          startedAt: runtime.startedAt,
          command: runtime.command,
          logFile: runtime.logFile,
          alive: runtimeAlive,
          uptimeMs: uptimeMs(runtime.startedAt),
        }
      : null,
    live: owner
      ? {
          port: Number(owner.port),
          pid: Number(owner.pid),
          processName: owner.processName || '',
          address: owner.address || '',
          memory: processStat?.memory ?? null,
          startedAt: processStat?.startedAt || null,
          uptimeMs: uptimeMs(processStat?.startedAt),
        }
      : null,
    pid: effectivePid,
    memory: processStat?.memory ?? null,
    processName: owner?.processName || processStat?.name || '',
    startedAt: processStat?.startedAt || runtime?.startedAt || null,
    uptimeMs: uptimeMs(processStat?.startedAt || runtime?.startedAt),
  }
}

/**
 * 目录归一化，用于判断"是不是父子关系"。
 * 与 projectGrouping.normalizeDir 保持一致：统一反斜杠、去尾斜杠、转小写、盘符大写。
 */
function normalizeProjectDir(dir) {
  if (!dir) return ''
  let value = String(dir).trim().replace(/\//g, '\\').replace(/\\+$/, '')
  if (/^[a-zA-Z]:/.test(value)) value = `${value[0].toUpperCase()}${value.slice(1)}`
  return value.toLowerCase()
}

/** childDir 是否**严格**在 parentDir 之内（不含相等） */
function isStrictlyInsideDir(childDir, parentDir) {
  const child = normalizeProjectDir(childDir)
  const parent = normalizeProjectDir(parentDir)
  if (!child || !parent) return false
  return child.startsWith(`${parent}\\`)
}

/**
 * 同一端口被多个项目声明时，先判断是不是"重复登记"而不是真的冲突。
 *
 * 典型场景（实测）：整仓项目 DevServerManager 与它的子目录项目 dev-server-manager-web
 * 都声明了 5180 —— 但 5180 本来就是 web 的端口，两者不是"抢"，而是**同一个服务登记了两次**。
 *
 * 注意只认**严格父子**关系，目录完全相同不算：
 * 两个项目用同一份代码、同一个端口，那是"同代码起了两个实例"的真冲突，必须如实报出来
 * （events-e2e 就锁着这个行为）。目录相同更可能是重复登记的另一种形态，
 * 但风险在于会掩盖真实的端口抢占，所以不合并。
 */
function classifyDuplicate(list) {
  const byDir = list
    .map((view) => ({ view, dir: normalizeProjectDir(view.dir) }))
    .filter((item) => item.dir)
  for (const parent of byDir) {
    for (const child of byDir) {
      if (parent.view.id === child.view.id) continue
      if (!isStrictlyInsideDir(child.dir, parent.dir)) continue
      const parentNames = [...new Set(list.map((item) => item.name))].sort()
      return {
        type: 'duplicate-registration',
        parent: parent.view.name,
        child: child.view.name,
        message:
          `端口 ${parent.view.port} 同时被 ${parentNames.length} 个项目声明，其中 ` +
          `「${child.view.name}」的目录在「${parent.view.name}」之内 —— ` +
          `这更像是同一个服务被登记了两次，而不是真的端口冲突`,
      }
    }
  }
  return null
}

function markDuplicatePorts(views) {
  const byPort = new Map()
  for (const view of views) {
    if (!view.port) continue
    const list = byPort.get(Number(view.port)) || []
    list.push(view)
    byPort.set(Number(view.port), list)
  }
  for (const [port, list] of byPort) {
    if (list.length < 2) continue
    // 同一条冲突的文案对所有相关项目必须一致：名字去重 + 排序，
    // 否则会因遍历顺序不同出现「A、B」和「B、A」两份看起来不同的冲突。
    const names = [...new Set(list.map((view) => view.name))].sort()
    const duplicate = classifyDuplicate(list)
    const message = duplicate
      ? duplicate.message
      : `端口 ${port} 同时被 ${names.length} 个项目声明：${names.join('、')}`
    const type = duplicate ? duplicate.type : 'duplicate'
    for (const view of list) {
      view.conflict = { type, message, duplicateRegistration: Boolean(duplicate) }
      if (view.status !== 'running') {
        // 重复登记不是"出故障"，别把它标成冲突红点：用"疑似重复登记"的中性说法
        view.status = duplicate ? 'possible-duplicate' : 'conflict'
        view.statusText = duplicate ? '疑似重复登记' : '端口重复声明'
      }
    }
  }
  return views
}

export async function buildProjectViews({ force = false } = {}) {
  const [projects, runtimes] = await Promise.all([projectsRepo.list(), runtimeRepo.all()])
  const portIndex = await portScanner.getPortIndex({ force })
  const pids = []
  const suspectOwners = new Set()
  for (const project of projects) {
    const runtime = runtimes[project.id]
    if (runtime?.pid) pids.push(runtime.pid)
    const owner = project.port ? portIndex.get(Number(project.port)) : null
    if (owner?.pid) {
      pids.push(owner.pid)
      // 监听进程与记录的 PID 不一致时，才需要沿着父进程链确认归属
      if (runtime?.pid && Number(owner.pid) !== Number(runtime.pid)) suspectOwners.add(Number(owner.pid))
    }
  }
  const [stats, ancestry] = await Promise.all([
    processInfo.getProcessStats(pids),
    resolveAncestry(suspectOwners),
  ])
  // 有登记容器名的 Docker 托管型项目时才跑 docker ps（一次拿全，避免每个项目各跑一遍）
  const needsDocker = projects.some((project) => project.containerName)
  const dockerContainers = needsDocker ? await collectRunningContainers() : new Map()
  const views = projects.map((project) => buildView(project, { portIndex, runtimes, stats, ancestry, dockerContainers }))
  return markDuplicatePorts(views)
}

/** 解析这些 PID 的父进程链（结果带回 buildView 用于归属判断） */
async function resolveAncestry(pids) {
  const map = new Map()
  await Promise.all(
    [...pids].map(async (pid) => {
      map.set(pid, new Set(await processInfo.getAncestorPids(pid)))
    }),
  )
  return map
}

export async function getProjectView(id) {
  const project = await projectsRepo.get(id)
  const views = await buildProjectViews({ force: true })
  return (
    views.find((view) => view.id === project.id) ||
    buildView(project, { portIndex: new Map(), runtimes: {}, stats: new Map(), ancestry: new Map(), dockerContainers: new Map() })
  )
}
