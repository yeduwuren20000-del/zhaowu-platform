import fs from 'node:fs'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { LOG_DIR, START_VERIFY_TIMEOUT_MS, STOP_VERIFY_TIMEOUT_MS } from '../config.js'
import { ensureDir, pathExistsSync } from '../utils/fsx.js'
import { runFileQuiet, runPowerShell, spawnDetached, isWindows } from '../utils/exec.js'
import { badRequest, HttpError } from '../utils/http.js'
import { processInfo } from './processInfo.js'
import { processInspector } from './processInspector.js'
import { portScanner } from './portScanner.js'
import { logRepo } from '../store/logRepo.js'
import { projectsRepo } from '../store/projectsRepo.js'
import { runtimeRepo } from '../store/runtimeRepo.js'
import { EVENT_TYPES, markProjectState, recordProjectAction } from './eventService.js'
import { diagnoseStartFailure } from './startDiagnosis.js'

/** 独立的项目启动器（负责把项目输出写进日志文件） */
const LAUNCHER_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), 'projectLauncher.mjs')

/**
 * 进程管理：启动 / 停止 / 重启 本地项目。
 * 启动：脱离工作台进程独立存活，stdout+stderr 重定向到 data/logs/<projectId>.log
 * 停止：优先结束记录的 PID 及其子进程树，兜底结束占用该项目端口的所有进程
 */

/** 永远不动自己和父进程 */
const SELF_PIDS = new Set([process.pid, process.ppid].filter(Boolean).map(Number))

/**
 * Docker 托管型判定：启动器发射完容器就退出（docker start / compose up -d），
 * 端口占用者是 Docker 引擎/容器进程。这类项目有三条特殊规则：
 *   ① 进程退出≠失败（verifyStartup 要继续等端口就绪）；
 *   ② 停止不能 taskkill 端口占用者——会打到 Docker 引擎本身，只能靠 stopCommand；
 *   ③ 端口被占且占用者是本项目容器时算「认领」，不算冲突。
 * 类型名是人写的（"compose" / "Docker Compose" / "docker" / "Docker 容器"），
 * 只按精确值比会把自动识别登记的项目排除在外，行为就全错了；因此再兜一层
 * stopCommand 形态判断（docker compose down / docker stop <name>）。
 */
function isDockerManagedProject(project) {
  const type = String(project?.type || '').toLowerCase()
  if (type.includes('compose') || type.includes('docker')) return true
  return Boolean(project?.stopCommand && /docker\s+(compose\s+down|stop|rm|kill)\b/i.test(project.stopCommand))
}

/** 从 "docker start <name>" 形态的启动命令里解析容器名 */
function parseContainerName(command) {
  const match = String(command || '').match(/docker\s+(?:start|stop|restart)\s+([A-Za-z0-9_.-]+)/i)
  return match ? match[1] : null
}

/** 从 docker ps 的 Ports 字符串里取发布到宿主端的端口："0.0.0.0:8790->8080/tcp" → 8790 */
function publishedPortOf(rawPorts) {
  const match = String(rawPorts || '').match(/:(\d+)->/)
  return match ? Number(match[1]) : null
}

/**
 * 把避让后的端口写进启动命令：
 *   npm run dev  ->  npm run dev -- --port 8080   （npm 必须用 -- 分隔，否则参数被 npm 吃掉）
 *   vite         ->  vite --port 8080
 * 命令里已经带端口参数时直接替换，避免出现两个 --port。
 */
function commandWithPort(command, port, portArg = '--port {port}') {
  const value = String(command || '').trim()
  if (!value) return value
  const arg = String(portArg || '--port {port}').replace(/\{port\}/g, String(port))
  if (/--port[=\s]+\d{2,5}/i.test(value)) return value.replace(/--port[=\s]+\d{2,5}/i, arg)
  if (/(^|\s)-p\s+\d{2,5}/.test(value)) return value.replace(/(^|\s)-p\s+\d{2,5}/, `$1${arg}`)
  if (/^(npm|pnpm|yarn|bun)\b/i.test(value)) return `${value} -- ${arg}`
  return `${value} ${arg}`
}

function assertStoppable(pid, name) {
  const numeric = Number(pid)
  if (!Number.isInteger(numeric) || numeric <= 0) return '无效 PID'
  if (SELF_PIDS.has(numeric)) return `PID ${numeric} 是工作台自身进程，已跳过`
  if (processInfo.isProtectedProcessName(name)) return `PID ${numeric}(${name || '未知'}) 是系统进程，已跳过`
  return null
}

async function killTree(pid) {
  if (!isWindows()) {
    try {
      process.kill(Number(pid), 'SIGTERM')
      return true
    } catch {
      return false
    }
  }
  const result = await runFileQuiet('taskkill', ['/PID', String(Number(pid)), '/T', '/F'], { timeout: 20000 })
  return !result.failed
}

/** 启动项目进程，返回 { pid, logFile, launcherPid }；env 为端口避让等场景注入的额外环境变量 */
export async function spawnProject(project, env = null) {
  if (!project.dir) throw badRequest('项目未配置目录，无法启动')
  if (!pathExistsSync(project.dir)) throw badRequest(`项目目录不存在：${project.dir}`)
  if (!project.startCommand) throw badRequest('项目未配置启动命令')

  await ensureDir(LOG_DIR)
  const logFile = logRepo.projectFile(project.id)
  const header = `\n===== ${new Date().toISOString()} 启动 =====\n$ ${project.startCommand}\n目录：${project.dir}\n`
  if (env) fs.appendFileSync(logFile, `${header}环境变量覆盖：${Object.entries(env).map(([k, v]) => `${k}=${v}`).join(' ')}\n`, 'utf8')
  else fs.appendFileSync(logFile, header, 'utf8')

  // 通过启动器以 detached 方式跑命令：
  //   启动器独立进程组（工作台退出/ Ctrl+C 不影响项目），
  //   它在内部用文件句柄捕获项目输出（Windows 下 detached + shell 直接 spawn 会丢日志）。
  const launcherArgs = env
    ? [LAUNCHER_PATH, project.startCommand, project.dir, logFile, JSON.stringify(env)]
    : [LAUNCHER_PATH, project.startCommand, project.dir, logFile]
  const launcher = spawn(process.execPath, launcherArgs, {
    detached: true,
    windowsHide: true,
    stdio: 'ignore',
  })
  launcher.unref()
  return { pid: launcher.pid, launcherPid: launcher.pid, logFile }
}

/**
 * Docker 托管型认领：端口占用者是不是本项目自己的容器。
 * 场景：工作台退出时 Dify / Stirling 容器还在跑，再进来时端口被占——那不是
 * "冲突"，是"我自己的东西忘了登记"。两种形态：
 *   ① 单容器（项目登记了 containerName，或启动命令是 docker start <name>）：
 *      docker ps 核对容器是否在跑、发布端口是否命中；
 *   ② compose 栈（项目目录有 compose 文件）：docker compose ps 核对。
 * 有容器发布着这个端口就算数。
 */
async function dockerOwnedByProject(project, port) {
  if (!port) return null
  const single = project?.containerName || parseContainerName(project?.startCommand)
  if (single) {
    const out = await runFileQuiet('docker', ['ps', '--filter', `name=^${single}$`, '--format', '{{json .}}'], {
      timeout: 15000,
    })
    for (const line of String(out.stdout || '').split('\n')) {
      const trimmed = line.trim()
      if (!trimmed) continue
      let raw = null
      try {
        raw = JSON.parse(trimmed)
      } catch {
        continue
      }
      if (publishedPortOf(raw.Ports) === Number(port)) return { name: raw.Names || single }
    }
    return null
  }
  const composeFile = ['docker-compose.yaml', 'docker-compose.yml']
    .map((name) => path.join(project.dir, name))
    .find((file) => fs.existsSync(file))
  if (!composeFile) return null
  const out = await runFileQuiet('docker', ['compose', '-f', composeFile, 'ps', '--format', '{{json .}}'], { timeout: 15000 })
  for (const line of String(out.stdout || '').split('\n')) {
    const trimmed = line.trim()
    if (!trimmed) continue
    let raw = null
    try {
      raw = JSON.parse(trimmed)
    } catch {
      continue
    }
    const publishers = raw.Publishers || raw.Ports || []
    const hit = publishers.some((p) => Number(p.PublishedPort) === Number(port))
    if (hit) return { name: raw.Name || raw.Service || 'compose 容器' }
  }
  return null
}

/** 启动 + 回查端口，给出可读结果 */
export async function startProject(project) {
  portScanner.invalidate()
  const existingOwners = await portScanner.getPortOwners(project.port, { force: true })
  const runtime = await runtimeRepo.get(project.id)

  // Docker 托管型认领：端口被占、且占用者就是本项目自己的容器时，
  // 直接登记为「已在运行」——既不误报冲突，也不避让再起一套。
  if (isDockerManagedProject(project) && !runtime?.pid && existingOwners.length > 0) {
    const own = await dockerOwnedByProject(project, project.port)
    if (own) {
      await runtimeRepo.set(project.id, {
        pid: null,
        port: project.port,
        startedAt: new Date().toISOString(),
        command: '(adopted)',
        logFile: logRepo.projectFile(project.id),
      })
      await logRepo.append({
        level: 'info',
        source: project.name,
        message: `检测到本项目容器已在监听端口 ${project.port}（${own.name}），认领为运行中（未重复启动）`,
      })
      await recordProjectAction(project, {
        type: EVENT_TYPES.STARTED,
        message: `项目「${project.name}」已在运行：认领现有容器 ${own.name}（端口 ${project.port}）`,
        facts: { port: project.port, adopted: true },
        state: { status: 'running', port: project.port, pid: null },
      })
      return {
        adopted: true,
        pid: null,
        logFile: logRepo.projectFile(project.id),
        portWarning: null,
        actualPort: project.port,
        running: true,
        portReady: true,
        message: `已在运行（认领容器 ${own.name}，端口 ${project.port}）`,
        log: [],
      }
    }
  }

  const foreign = existingOwners.find((owner) => !runtime?.pid || owner.pid !== runtime.pid)

  // 端口自动避让：主端口被外部进程占用时，换到最近的空闲端口。
  // 两条注入通道，按项目实际支持的方式选：
  //   portEnv —— 项目从环境变量读端口（Dify 的 EXPOSE_NGINX_PORT、CRA 的 PORT）；
  //   portArg —— dev server 从命令行读端口（vite/next/uvicorn 的 --port）。
  // 两条都没有的项目（端口写死在代码里）避让不了，只给警告（见 portWarning）。
  let effective = project
  let env = null
  let shift = null
  if (foreign && project.port && (project.portEnv || project.portArg)) {
    const free = await portScanner.findFreePort(project.port + 1)
    if (free && free !== project.port) {
      effective = { ...project, port: free }
      if (project.portEnv) env = { [project.portEnv]: String(free) }
      else effective.startCommand = commandWithPort(project.startCommand, free, project.portArg)
      shift = { from: project.port, to: free, owner: foreign }
    }
  }

  const { pid, logFile } = await spawnProject(effective, env)
  await runtimeRepo.set(project.id, {
    pid,
    port: effective.port,
    startedAt: new Date().toISOString(),
    command: project.startCommand,
    logFile,
  })
  await logRepo.append({
    level: 'info',
    source: project.name,
    message: shift
      ? `端口 ${shift.from} 被 PID ${shift.owner.pid}(${shift.owner.processName || '未知'}) 占用，已自动改用 ${shift.to}（${project.portEnv}=${shift.to}）`
      : `启动命令已执行（PID ${pid}）：${project.startCommand}`,
  })

  const verified = await verifyStartup(effective, pid, project)
  // 学到的实际端口（项目自己换端口）要以它为准：事件、返回值、地址都用同一个端口
  if (verified.actualPort && Number(verified.actualPort) !== Number(effective.port)) {
    effective = { ...effective, port: verified.actualPort }
  }
  if (!verified.running || !verified.portReady) {
    // 失败 / 未就绪：查端口占用者让诊断能直接说「谁占了端口、PID 多少」。
    // 不 force：verifyStartup 的轮询刚扫过（缓存 <1s），复用即可——force 一次全端口扫描
    // 要给每次失败启动白等好几秒，而诊断只需要一个足够新的占用者快照。
    const owners = effective.port ? await portScanner.getPortOwners(effective.port) : []
    verified.diagnosis = diagnoseStartFailure({ project: effective, verify: verified, portOwners: owners })
  }
  await recordStartEvent(effective, pid, verified, shift)
  return {
    pid,
    logFile,
    portWarning: shift
      ? `端口 ${shift.from} 被 PID ${shift.owner.pid}(${shift.owner.processName || '未知'}) 占用，已自动改用 ${shift.to}`
      : foreign
        ? `端口 ${project.port} 启动前已被 PID ${foreign.pid}(${foreign.processName || '未知'}) 占用`
        : null,
    actualPort: effective.port,
    ...verified,
  }
}

/** 启动结果直接进事件时间线（端口就绪=started，进程秒退=crashed） */
async function recordStartEvent(project, pid, verified, shift = null) {
  const portNote = shift ? `（配置端口 ${shift.from} 被占，已避让到 ${project.port}）` : ''
  if (verified.portReady) {
    await recordProjectAction(project, {
      type: EVENT_TYPES.STARTED,
      message: `项目「${project.name}」启动成功：端口 ${project.port} 已监听（PID ${pid}）${portNote}`,
      facts: { port: project.port, pid, command: project.startCommand },
      state: { status: 'running', port: project.port, pid },
    })
    return
  }
  if (!verified.running) {
    const diagnosis = verified.diagnosis
    const advice = diagnosis?.advice?.[0]?.text
    await recordProjectAction(project, {
      type: EVENT_TYPES.CRASHED,
      level: 'error',
      message: `项目「${project.name}」启动失败：进程拉起后立即退出，端口 ${project.port ?? '未记录'} 没有监听（PID ${pid}）`,
      detail: diagnosis
        ? [`诊断：${diagnosis.title}`, advice ? `建议：${advice}` : null, (verified.log || []).slice(-2).join(' / ')]
            .filter(Boolean)
            .join(' / ') || null
        : (verified.log || []).slice(-3).join(' / ') || null,
      facts: { port: null, pid, command: project.startCommand, diagnosis: diagnosis?.cause ?? null },
      state: { status: 'stopped', port: null, pid: null },
    })
    return
  }
  if (!project.port && verified.running) {
    await recordProjectAction(project, {
      type: EVENT_TYPES.STARTED,
      message: `项目「${project.name}」进程已启动（PID ${pid}，未记录端口，无法校验监听）`,
      facts: { pid, command: project.startCommand },
      state: { status: 'running', port: null, pid },
    })
    return
  }
  // 进程在跑但端口还没监听（编译中）：只对齐状态指纹，等真的监听时由观察记 started
  await markProjectState(project, { status: 'starting', port: null, pid })
}

/**
 * 学习实际端口：dev server 自己换端口（Vite 发现 5173 被占会顺延到 5174）时，
 * 配置里写的旧端口永远等不到——从进程树里找出真正在听的端口，认它。
 * 只在"进程还活着但端口迟迟不出现"的兜底路径调用，不影响正常启动速度。
 */
async function learnListeningPort(rootPid, { near = null } = {}) {
  if (!rootPid) return null
  const [table, entries] = await Promise.all([
    processInspector.getProcessTable({ force: true }),
    portScanner.scan({ force: true }),
  ])
  const ports = []
  for (const entry of entries) {
    const chain = processInspector.buildParentChain(entry.pid, table, 10)
    if (chain.some((item) => Number(item.pid) === Number(rootPid))) ports.push(entry.port)
  }
  if (ports.length === 0) return null
  const target = Number(near) || ports[0]
  // 离配置端口最近的优先（dev server 通常是顺序顺延）
  ports.sort((a, b) => Math.abs(a - target) - Math.abs(b - target))
  return ports[0]
}

/**
 * 等待端口就绪；若进程提前退出，直接返回失败原因与日志尾部。
 * project 用「生效配置」（端口可能已避让）；original 是用户的原始配置——
 * Docker 托管型（docker compose up -d / docker start <容器>）的启动器发射完
 * 容器就退出，进程退出≠失败，要继续等端口就绪，否则 Dify 这类项目永远被
 * 误判成 crashed。
 */
async function verifyStartup(project, pid, original = project) {
  const detached = isDockerManagedProject(original) || original.detachedStart === true
  if (!project.port) {
    await new Promise((resolve) => setTimeout(resolve, 1200))
    const alive = processInfo.isPidAlive(pid)
    return {
      running: alive,
      portReady: false,
      message: alive ? '进程已启动（未配置端口，无法校验）' : '进程启动后立即退出，请查看日志',
      log: alive ? [] : await logRepo.readProjectLog(project.id, 20),
    }
  }
  const deadline = Date.now() + START_VERIFY_TIMEOUT_MS
  for (;;) {
    portScanner.invalidate()
    if (await portScanner.isPortListening(project.port)) {
      await logRepo.append({ level: 'success', source: project.name, message: `端口 ${project.port} 已监听，启动成功` })
      return { running: true, portReady: true, message: `端口 ${project.port} 已就绪`, log: [] }
    }
    if (!processInfo.isPidAlive(pid)) {
      // compose 型：启动器退出是正常的（容器已交给 Docker），继续等端口直到超时
      if (detached && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 700))
        continue
      }
      const tail = await logRepo.readProjectLog(project.id, 20)
      await logRepo.append({ level: 'error', source: project.name, message: '启动命令已退出，端口未监听' })
      return { running: false, portReady: false, message: '启动命令执行后立即退出，请检查启动命令与日志', log: tail }
    }
    if (Date.now() >= deadline) {
      // 兜底：进程还在，但配置端口一直没出现——可能它自己换了端口（Vite 顺延）。
      // 先认实际监听的端口，再决定是不是真的"没起来"。
      const learned = await learnListeningPort(pid, { near: project.port })
      if (learned && Number(learned) !== Number(project.port)) {
        const runtime = await runtimeRepo.get(project.id)
        if (runtime) await runtimeRepo.set(project.id, { ...runtime, port: learned })
        await logRepo.append({
          level: 'info',
          source: project.name,
          message: `等待 ${project.port} 超时，但发现本项目实际在监听 ${learned}，已按实际端口记录`,
        })
        return {
          running: true,
          portReady: true,
          actualPort: learned,
          learnedPort: true,
          message: `端口 ${learned} 已就绪（项目自己换了端口，配置里是 ${project.port}）`,
          log: [],
        }
      }
      const tail = await logRepo.readProjectLog(project.id, 20)
      await logRepo.append({
        level: 'warn',
        source: project.name,
        message: `等待 ${project.port} 端口监听超时，进程仍在运行`,
      })
      return { running: true, portReady: false, message: `进程在运行，但 ${project.port} 端口尚未监听（可能仍在编译）`, log: tail }
    }
    await new Promise((resolve) => setTimeout(resolve, 700))
  }
}

/** 停止项目：结束进程树 + 兜底释放端口 */
export async function stopProject(project) {
  const runtime = await runtimeRepo.get(project.id)
  // 端口以运行态记录的实际端口为准：自动避让后项目听的不是配置端口（80→8080），
  // 按配置端口扫会找不到人，端口释放校验也会假成功。
  const port = runtime?.port ?? project.port
  const owners = await portScanner.getPortOwners(port, { force: true })
  const targets = new Map()
  if (runtime?.pid) targets.set(Number(runtime.pid), '记录的进程')
  // Docker 托管型项目（docker compose / docker start）：端口占用者是 Docker
  // 容器/引擎进程，taskkill 会打到 Docker 引擎本身——只能靠 stopCommand 停
  if (!isDockerManagedProject(project)) {
    for (const owner of owners) targets.set(Number(owner.pid), `占用端口 ${port} 的进程`)
  }

  const skipped = []
  const killed = []

  if (project.stopCommand) {
    await logRepo.append({ level: 'info', source: project.name, message: `执行停止命令：${project.stopCommand}` })
    spawnDetached(project.stopCommand, { cwd: pathExistsSync(project.dir) ? project.dir : undefined })
  }

  for (const [pid, reason] of targets) {
    const name = await processInfo.getProcessName(pid)
    const blocked = assertStoppable(pid, name)
    if (blocked) {
      skipped.push({ pid, name, reason: blocked })
      continue
    }
    const ok = await killTree(pid)
    if (ok) killed.push({ pid, name, reason })
    else skipped.push({ pid, name, reason: '结束进程失败（可能已退出）' })
  }

  const released = port
    ? await portScanner.waitForPort(port, { want: false, timeoutMs: STOP_VERIFY_TIMEOUT_MS })
    : true
  await runtimeRepo.clear(project.id)
  portScanner.invalidate()

  await logRepo.append({
    level: released ? 'success' : 'warn',
    source: project.name,
    message: released
      ? `已停止（结束进程：${killed.map((item) => item.pid).join(', ') || '无'}）`
      : `已发出停止指令，但端口 ${port} 仍被占用`,
  })
  await recordProjectAction(project, {
    type: EVENT_TYPES.STOPPED,
    level: released ? 'info' : 'warn',
    message: released
      ? `项目「${project.name}」已停止：结束进程 ${killed.map((item) => item.pid).join('、') || '无'}${port ? `，端口 ${port} 已释放` : ''}`
      : `项目「${project.name}」已发出停止指令，但端口 ${port} 仍被占用`,
    detail: skipped.length ? `未结束：${skipped.map((item) => `${item.pid}(${item.reason})`).join('、')}` : null,
    facts: { port: port ?? null, pid: runtime?.pid ?? null, command: project.startCommand },
    state: { status: 'stopped', port: null, pid: null },
  })

  return { killed, skipped, portReleased: released }
}

/**
 * 删除项目：在跑的先停再删；本项目进程杀不掉就拒绝删除。
 *
 * 为什么后端也要设防：前端虽已「先停再删」+ 确认框动态警告，但 API 直调、
 * 以后的 CLI / 脚本都不经过前端——直接 remove 会留下孤儿进程占着端口，
 * 新手还以为删干净了。宁可拒绝删除让人手动处理，也不能假删除。
 */
export async function deleteProject(project) {
  const runtime = await runtimeRepo.get(project.id)
  let stopped = null
  if (runtime?.pid) {
    stopped = await stopProject(project)
    // 「结束进程失败（可能已退出）」不是阻碍——进程本来就没了（compose 启动器
    // 发射完容器就退），真正的阻碍是 assertStoppable 那类主动跳过。
    const blocked = stopped.skipped.filter(
      (item) => Number(item.pid) === Number(runtime.pid) && item.reason !== '结束进程失败（可能已退出）',
    )
    if (blocked.length > 0) {
      throw new HttpError(409, `项目进程 PID ${runtime.pid} 未能结束（${blocked[0].reason}），已取消删除；请先手动停止后再试`)
    }
  }
  const removed = await projectsRepo.remove(project.id)
  await runtimeRepo.clear(project.id)
  await logRepo.append({
    level: 'warn',
    source: removed.name,
    message: stopped ? '项目记录已删除（已先结束其进程）' : '项目记录已删除（未在运行）',
  })
  return { removed, wasRunning: Boolean(stopped), stopped }
}

/** 重启 = 停止 -> 等端口释放 -> 启动 */
export async function restartProject(project) {
  const runtime = await runtimeRepo.get(project.id)
  const port = runtime?.port ?? project.port
  const stopped = await stopProject(project)
  if (port && !stopped.portReleased) {
    const owners = await portScanner.getPortOwners(port, { force: true })
    throw new HttpError(409, `端口 ${port} 仍被 PID ${owners.map((o) => o.pid).join(',')} 占用，已取消重启`)
  }
  const started = await startProject(project)
  return { stopped, started }
}

/** 打开资源管理器 */
export async function openDirectory(dir) {
  if (!dir) throw badRequest('未配置目录')
  if (!pathExistsSync(dir)) throw badRequest(`目录不存在：${dir}`)
  if (isWindows()) await runFileQuiet('explorer.exe', [dir], { timeout: 8000 })
  return { opened: dir }
}

/** 用默认浏览器打开地址 */
export async function openUrl(url) {
  if (!url) throw badRequest('未配置访问地址')
  if (!isWindows()) throw badRequest('打开浏览器仅支持 Windows')
  await runFileQuiet('cmd', ['/c', 'start', '', url], { timeout: 8000 })
  return { opened: url }
}

/** 复制文本到剪贴板（Windows 原生 Set-Clipboard） */
export async function copyToClipboard(text) {
  if (!isWindows()) throw badRequest('仅支持 Windows')
  const literal = `'${String(text).replace(/'/g, "''")}'`
  try {
    await runPowerShell(`Set-Clipboard -Value ${literal}`, { timeout: 8000 })
  } catch (error) {
    throw new HttpError(500, `写入剪贴板失败：${error.message}`)
  }
  return { copied: String(text) }
}
