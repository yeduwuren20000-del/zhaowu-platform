import fs from 'node:fs'
import path from 'node:path'
import { portScanner } from './portScanner.js'
import { processInspector } from './processInspector.js'
import { detectProject, isSafeDirectory } from './projectDetector.js'
import { inspectProjectDir } from './projectInspect.js'
import { projectsRepo } from '../store/projectsRepo.js'

/**
 * 「填个前端地址就能用」的识别层（只读）。
 *
 * 用户只想知道"我写的网页怎么从工作台拉起来"，不想背三件事：
 *   1) 项目目录在哪 —— 地址正在被谁监听？那个进程的命令行/父链里就有目录；
 *   2) 端口是多少   —— 优先用地址里的端口（这是用户眼前的真相），
 *                      其次读 vite/next/.env/scripts 里声明的端口，
 *                      最后才用框架默认值（vite 5173 / next 3000 …）；
 *   3) 启动命令是什么 —— 复用 projectInspect 的脚本推断。
 *
 * 全流程只读：查端口表、查进程表、读白名单配置文件；**不执行任何脚本**。
 */

/** Windows 路径不会当网址解析（D:\app 里也有冒号） */
const WINDOWS_PATH = /^[a-zA-Z]:[\\/]/
const URL_WITH_SCHEME = /^https?:\/\//i

/** 本地/内网地址才值得去反查进程；公网地址反查不到也不需要 */
const URL_HOST_HINT = /^(?:localhost|127\.0\.0\.1|0\.0\.0\.0|\[::1\]|[\w.-]+\.local)(?::\d{1,5})?(?:[/?#]|$)/i

export function looksLikeUrl(text) {
  const value = String(text || '').trim()
  if (!value || WINDOWS_PATH.test(value)) return false
  if (URL_WITH_SCHEME.test(value)) return true
  return URL_HOST_HINT.test(value)
}

/** 解析用户填的地址；不是地址就返回 null */
export function parseFrontendUrl(raw) {
  const text = String(raw || '').trim()
  if (!looksLikeUrl(text)) return null
  const withScheme = URL_WITH_SCHEME.test(text) ? text : `http://${text}`
  let parsed
  try {
    parsed = new URL(withScheme)
  } catch {
    return null
  }
  const explicitPort = Boolean(parsed.port)
  const port = explicitPort ? Number(parsed.port) : parsed.protocol === 'https:' ? 443 : 80
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  return {
    url: parsed.toString().replace(/\/$/, ''),
    host: parsed.hostname,
    port,
    explicitPort,
    path: parsed.pathname || '/',
  }
}

/** 把地址里的端口换成另一个端口（保留 host 与路径） */
export function urlWithPort(url, port) {
  const fallback = `http://localhost:${port}`
  try {
    const parsed = new URL(String(url))
    parsed.port = String(port)
    return parsed.toString().replace(/\/$/, '')
  } catch {
    return fallback
  }
}

/**
 * 地址里的端口 -> 实际要用的端口（自动匹配）。
 *
 * 用户填的 5173 是「我想要它」，不是「它现在一定空闲」，所以识别时就要匹配：
 *   空闲      -> 就它
 *   被陌生进程占 -> 顺延到最近的空闲端口，并说清是谁占了
 *   能反查到目录 -> 说明服务正跑在这，就是你想要的那个，不动它
 */
async function matchPort({ requested, keep, owner }) {
  const port = Number(requested)
  if (!Number.isInteger(port) || port < 1 || port > 65535) return null
  if (keep) {
    return {
      requested: port,
      port,
      status: 'in-use',
      owner: owner || null,
      message: `端口 ${port} 正被${owner?.processName ? ` ${owner.processName}（PID ${owner.pid}）` : '进程'}占用，反查到项目目录，按这个端口登记`,
    }
  }
  // 找下一个空闲端口：findFreePort 现在只扫一次全机监听表并复用 10s 缓存，不会逐端口重扫
  const free = await portScanner.findFreePort(port + 1, { limit: 100 })
  if (!free) {
    return {
      requested: port,
      port,
      status: 'blocked',
      owner: owner || null,
      message: `端口 ${port} 已被占用，且附近没找到空闲端口`,
    }
  }
  return {
    requested: port,
    port: free,
    status: 'shifted',
    owner: owner || null,
    message: `端口 ${port} 已被${owner?.processName ? ` ${owner.processName}（PID ${owner.pid}）` : '其它进程'}占用，已自动匹配到空闲端口 ${free}`,
  }
}

/** 读小文件（只读、限长，避免把大文件整个吞进内存） */
function readSmall(file, maxBytes = 65536) {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > maxBytes) return null
    return fs.readFileSync(file, 'utf8')
  } catch {
    return null
  }
}

/** 声明端口的配置文件：只读这些，不做目录递归 */
const PORT_CONFIG_FILES = [
  'vite.config.ts', 'vite.config.js', 'vite.config.mjs', 'vite.config.mts', 'vite.config.cjs',
  'next.config.ts', 'next.config.js', 'next.config.mjs',
  'nuxt.config.ts', 'nuxt.config.js',
  'vue.config.ts', 'vue.config.js',
  'astro.config.ts', 'astro.config.mjs', 'astro.config.js',
  'svelte.config.js',
  'webpack.config.js', 'webpack.config.ts', 'webpack.dev.js', 'webpack.dev.config.js',
  'angular.json',
  '.env', '.env.local', '.env.development', '.env.development.local', '.env.production',
]

/** 框架默认端口（只有装了对应依赖才认，且优先级最低） */
const FRAMEWORK_DEFAULT_PORTS = [
  { dep: 'next', port: 3000, name: 'Next.js' },
  { dep: 'nuxt', port: 3000, name: 'Nuxt' },
  { dep: 'react-scripts', port: 3000, name: 'Create React App' },
  { dep: '@vue/cli-service', port: 8080, name: 'Vue CLI' },
  { dep: 'astro', port: 4321, name: 'Astro' },
  { dep: '@sveltejs/kit', port: 5173, name: 'SvelteKit' },
  { dep: 'vite', port: 5173, name: 'Vite' },
]

/** 启动脚本名（dev/start/serve）：它们的端口才是「拉起项目后要访问的端口」 */
const DEV_SCRIPT_NAME = /(^|:)(dev|develop|start|serve)\b/i

/**
 * 目录里「声明过的端口」，按可信度排序。
 * 可信度顺序（这是被真实场景逼出来的）：
 *   启动脚本里显式写的 --port  >  配置文件里的 port  >  .env 的 PORT  >
 *   其它脚本（preview/build 之类）>  框架默认值。
 * 例：vite.config 写 5301、`preview` 脚本写 --port 4173 时，拉起项目用的是 5301，
 * 4173 只在你手动跑 preview 时才对——不能让它排前面。
 */
export function detectDeclaredPorts(dir) {
  const resolved = path.resolve(String(dir || ''))
  if (!isSafeDirectory(resolved)) return []

  const found = []
  const push = (port, source, evidence, confidence) => {
    const value = Number(port)
    if (!Number.isInteger(value) || value < 1 || value > 65535) return
    found.push({ port: value, source, evidence: String(evidence || '').slice(0, 160), confidence })
  }

  // 1) package.json 的 scripts 里显式带 --port
  const pkgText = readSmall(path.join(resolved, 'package.json'))
  let packageJson = null
  if (pkgText) {
    try {
      packageJson = JSON.parse(pkgText)
    } catch {
      packageJson = null
    }
  }
  const scripts = packageJson?.scripts && typeof packageJson.scripts === 'object' ? packageJson.scripts : {}
  for (const [name, command] of Object.entries(scripts)) {
    if (typeof command !== 'string') continue
    const match = command.match(/--port[=\s]+(\d{2,5})/i) || command.match(/(?:^|\s)-p\s+(\d{2,5})/)
    if (match) push(match[1], `package.json 的 ${name} 脚本`, command, DEV_SCRIPT_NAME.test(name) ? 0.99 : 0.7)
  }

  // 2) 配置文件里写死的 port
  for (const name of PORT_CONFIG_FILES) {
    const text = readSmall(path.join(resolved, name))
    if (!text) continue
    if (name.startsWith('.env')) {
      // PORT=3000 / VITE_PORT=5173 / SERVER_PORT=8000
      const match = text.match(/^\s*(?:[A-Z0-9_]*PORT)\s*=\s*['"]?(\d{2,5})['"]?\s*$/m)
      if (match) push(match[1], `${name} 里的 PORT`, match[0].trim(), 0.9)
      continue
    }
    // port: 5173 / port = 8080（只认第一个，避免把无关数字当端口）
    const match = text.match(/\bport\s*[:=]\s*['"]?(\d{2,5})['"]?/)
    if (match) push(match[1], `${name} 里的 port`, match[0].trim(), 0.96)
  }

  // 3) 框架默认端口（仅当依赖真的存在）
  if (packageJson) {
    const deps = { ...(packageJson.dependencies || {}), ...(packageJson.devDependencies || {}) }
    for (const item of FRAMEWORK_DEFAULT_PORTS) {
      if (deps[item.dep]) push(item.port, `${item.name} 默认端口`, `依赖 ${item.dep}`, 0.6)
    }
  }

  // 同端口保留可信度最高的一条
  const best = new Map()
  for (const item of found) {
    const current = best.get(item.port)
    if (!current || item.confidence > current.confidence) best.set(item.port, item)
  }
  return [...best.values()].sort((a, b) => b.confidence - a.confidence)
}

/**
 * 地址 -> 正在监听的进程 -> 项目目录。
 * 这是「我只记得 localhost:5173，忘了文件在哪」的解法。
 */
export async function resolveUrlToProject(raw) {
  const parsed = parseFrontendUrl(raw)
  if (!parsed) {
    return { ok: false, error: `看不懂这个地址：${raw}。可以填 http://localhost:5173 这样的本机地址，或直接填项目目录。` }
  }

  const owners = await portScanner.getPortOwners(parsed.port, { force: true })
  if (owners.length === 0) {
    return {
      ok: true,
      url: parsed.url,
      host: parsed.host,
      port: parsed.port,
      listening: false,
      owners: [],
      projectDir: null,
      portPlan: {
        requested: parsed.port,
        port: parsed.port,
        status: 'free',
        owner: null,
        message: `端口 ${parsed.port} 当前空闲，已按地址匹配这个端口`,
      },
      notes: [`端口 ${parsed.port} 现在空闲：已自动匹配它，拉起后就能访问 ${parsed.url}。再填一下项目目录，可以连启动命令一起推断出来。`],
    }
  }

  const table = await processInspector.getProcessTable({ force: true })
  const items = []
  for (const owner of owners) {
    const proc = table.get(Number(owner.pid)) || null
    const chain = processInspector.buildParentChain(owner.pid, table)
    const candidates = processInspector.inferCandidateDirs(proc || { commandLine: '', exePath: '' }, chain)
    const project = detectProject(candidates)
    items.push({
      pid: owner.pid,
      processName: proc?.name || owner.processName || '',
      commandLine: proc?.commandLine || '',
      exePath: proc?.exePath || '',
      projectDir: project.root || null,
      projectDirSource: project.source || null,
      markers: project.markers || [],
      stack: project.stack || null,
      commandHints: candidates.map((item) => item.dir).slice(0, 3),
    })
  }

  const best = items.find((item) => item.projectDir) || items[0]
  const notes = []
  if (best.projectDir) {
    notes.push(`端口 ${parsed.port} 正由 ${best.processName || '未知进程'}（PID ${best.pid}）监听，按${best.projectDirSource || '命令行'}反查到目录：${best.projectDir}`)
  } else {
    notes.push(`端口 ${parsed.port} 被 ${best.processName || '未知进程'}（PID ${best.pid}）占用，但命令行里没有可用的目录线索，请手动填写项目目录。`)
  }

  // 端口匹配：反查到目录 = 服务正跑在这，就是你要的那个端口；
  // 反查不到 = 端口被无关进程占着，顺延到最近空闲端口（用户不用自己去改）
  const portPlan = await matchPort({
    requested: parsed.port,
    keep: Boolean(best.projectDir),
    owner: { pid: best.pid, processName: best.processName || '' },
  })
  if (portPlan?.status === 'shifted') notes.push(portPlan.message)
  else if (portPlan?.status === 'blocked') notes.push(portPlan.message)

  return {
    ok: true,
    url: parsed.url,
    host: parsed.host,
    port: parsed.port,
    listening: true,
    owners: items,
    projectDir: best.projectDir,
    projectDirSource: best.projectDirSource,
    markers: best.markers,
    stack: best.stack,
    portPlan,
    notes,
  }
}

/**
 * 端口被占时怎么把新端口告诉 dev server：
 *   - Vite / Next / Nuxt / Astro / Vue CLI / uvicorn / flask 走命令行 `--port`；
 *   - Create React App 不认命令行参数，只认 PORT 环境变量。
 * 返回 null 表示"这条命令换不了端口"，那就不要自动避让（否则会起在错端口还报成功）。
 */
export function portShiftHint({ command, deps = {} } = {}) {
  const value = String(command || '').trim()
  if (!value) return null
  const isDevServer =
    /^(npm|pnpm|yarn|bun)\s+(run\s+)?(dev|start|serve)/i.test(value) ||
    /\b(vite|next|nuxt|astro|serve|http-server|uvicorn|gunicorn|flask)\b/i.test(value)
  if (!isDevServer) return null
  if (deps['react-scripts'] && !deps.vite && !deps.next && !deps.nuxt) return { portEnv: 'PORT' }
  return { portArg: '--port {port}' }
}

/** 读 package.json 的依赖集合（合并 devDependencies） */
function readDependencies(dir) {
  const text = readSmall(path.join(dir, 'package.json'))
  if (!text) return {}
  try {
    const parsed = JSON.parse(text)
    return { ...(parsed.dependencies || {}), ...(parsed.devDependencies || {}) }
  } catch {
    return {}
  }
}

function normalizeDir(dir) {
  if (!dir) return ''
  return path.resolve(dir).replace(/[\\/]+$/, '').toLowerCase()
}

/** child 是否在 parent 目录树之内（相等不算）；Windows 用反斜杠，两种分隔符都要认 */
function isInside(child, parent) {
  const c = normalizeDir(child)
  const p = normalizeDir(parent)
  if (!c || !p) return false
  return c !== p && (c.startsWith(`${p}\\`) || c.startsWith(`${p}/`))
}

/**
 * 已登记项目里「包含这个目录」的最外层项目。
 * 作用：从 URL 反查到的是 server/ 这类子目录时，如果外层整个仓库已经登记过，
 * 就按记住的那条记录走（否则会凭空多出一个"server 项目"，启动命令也变成子包的）。
 */
function findRegisteringProject(dir, projects) {
  return [...projects]
    .filter((project) => project.dir && isInside(dir, project.dir))
    .sort((a, b) => normalizeDir(b.dir).length - normalizeDir(a.dir).length)[0] || null
}

/**
 * 综合识别：给目录、给地址，或两个都给。
 * 返回「建议填什么」+ 证据 + 是否已登记（记住过）。
 */
export async function inspectProjectSource({ dir, url } = {}) {
  let rawDir = String(dir || '').trim()
  let rawUrl = String(url || '').trim()
  // 两个输入框都接受「地址 或 目录」：用户不必记住该往哪一格填
  if (rawDir && !rawUrl && looksLikeUrl(rawDir)) {
    rawUrl = rawDir
    rawDir = ''
  }
  if (rawUrl && !rawDir && WINDOWS_PATH.test(rawUrl)) {
    rawDir = rawUrl
    rawUrl = ''
  }
  const notes = []
  let live = null
  let resolvedDir = rawDir
  const projects = await projectsRepo.list()

  if (rawUrl) {
    live = await resolveUrlToProject(rawUrl)
    if (live.ok === false) return { ok: false, error: live.error }
    notes.push(...(live.notes || []))
    if (!resolvedDir && live.projectDir) {
      // 反查到的可能是子目录（server/、web/）：外层仓库若已登记过，就以记住的那条为准
      const owner = findRegisteringProject(live.projectDir, projects)
      if (owner) {
        resolvedDir = owner.dir
        notes.push(`反查到的目录在已登记项目「${owner.name}」之内，按记住的项目目录处理：${owner.dir}`)
      } else {
        resolvedDir = live.projectDir
      }
    }
  }

  if (!resolvedDir) {
    // 目录没拿到，但端口已经匹配好了：先把它给用户，别让人白填一次
    const plannedPort = live?.portPlan?.port ?? live?.port ?? null
    const plannedUrl = plannedPort
      ? live?.url
        ? urlWithPort(live.url, plannedPort)
        : `http://localhost:${plannedPort}`
      : live?.url || ''
    return {
      ok: true,
      fields: plannedPort ? { port: plannedPort, url: plannedUrl } : {},
      candidates: { startCommand: [] },
      ports: [],
      live,
      portPlan: live?.portPlan ?? null,
      notes: [...notes, '端口已经匹配好了；再填一下项目目录，就能连启动命令一起推断出来。'],
      matched: [],
      knownProject: null,
    }
  }

  const base = inspectProjectDir(resolvedDir)
  if (base.ok === false) {
    return { ok: false, error: base.error, live, notes }
  }
  notes.push(...(base.notes || []))

  const declared = detectDeclaredPorts(resolvedDir)
  const fields = { ...(base.fields || {}) }
  const dirValue = path.resolve(resolvedDir)
  fields.dir = dirValue

  // 端口优先级：正在监听的真实端口 > 目录里写死的 > 地址里填的（含自动匹配结果）。
  // 注意「顺延」出来的端口不能压过项目配置：项目真跑起来用的是配置里的端口，
  // 只有项目自己没声明端口时，顺延的那个才是它该去的端口。
  if (live?.listening && live.portPlan?.status === 'in-use') {
    fields.port = live.portPlan.port
    if (declared.length > 0 && Number(declared[0].port) !== Number(fields.port)) {
      notes.push(`注意：项目配置里写的是 ${declared[0].port}，但地址用的是 ${fields.port}，以实际监听的 ${fields.port} 为准。`)
    }
  } else if (declared.length > 0) {
    fields.port = declared[0].port
    notes.push(`端口 ${declared[0].port} 来自${declared[0].source}（${declared[0].evidence}）`)
    if (live?.portPlan?.status === 'shifted') {
      notes.push(`地址里的 ${live.portPlan.requested} 被占用了，但项目配置写的是 ${fields.port}，按配置的来（启动时若被占会自动换端口）。`)
    } else if (live?.portPlan?.port && Number(live.portPlan.port) !== Number(fields.port)) {
      notes.push(`地址里填的是 ${live.portPlan.port}，但项目配置写的是 ${fields.port}，按配置的来。`)
    }
  } else if (live?.portPlan?.port) {
    fields.port = live.portPlan.port
  }

  if (fields.port) {
    fields.url = live?.url ? urlWithPort(live.url, fields.port) : `http://localhost:${fields.port}`
  }

  // 端口跑偏时能自动换端口：只有命令形态支持才给，避免瞎加参数把项目起坏
  const deps = readDependencies(dirValue)
  const shiftHint = portShiftHint({ command: fields.startCommand, deps })
  if (shiftHint?.portArg) {
    fields.portArg = shiftHint.portArg
    notes.push('已记录端口参数形态：端口被占时会自动换到空闲端口再拉起，不用改项目代码。')
  } else if (shiftHint?.portEnv) {
    fields.portEnv = shiftHint.portEnv
    notes.push(`这个项目的端口只能通过 ${shiftHint.portEnv} 环境变量覆盖：端口被占时会自动换端口再拉起。`)
  }

  if (base.candidates?.startCommand?.length) {
    // 候选命令各自带端口时，同步补上端口覆盖方式
    base.candidates.startCommand = base.candidates.startCommand.map((item) => ({
      ...item,
      ...(portShiftHint({ command: item.command, deps }) || {}),
    }))
  }

  // 「记住」：目录/端口/地址命中已登记项目就直说
  let knownProject = null
  const targetDir = normalizeDir(dirValue)
  const byDir = projects.find((project) => project.dir && normalizeDir(project.dir) === targetDir)
  const byPort = fields.port ? projects.find((project) => Number(project.port) === Number(fields.port)) : null
  const byUrl = fields.url ? projects.find((project) => project.url && project.url.replace(/\/$/, '') === fields.url.replace(/\/$/, '')) : null
  // 只按「同目录」和「端口/地址」匹配，不做包含匹配：
  // 用户明确指了子目录，就是想单独管这个子目录，不能悄悄替换成外层项目。
  const matched = byDir || byPort || byUrl
  if (matched) {
    knownProject = { id: matched.id, name: matched.name, matchedBy: byDir ? '目录' : byPort ? '端口' : '地址' }
    notes.push(`这个${knownProject.matchedBy}已经登记为项目「${matched.name}」，不用重复添加；直接去本地项目页点启动即可。`)
  }

  return {
    ok: true,
    fields,
    candidates: base.candidates || { startCommand: [] },
    ports: declared,
    live,
    portPlan: live?.portPlan ?? null,
    notes,
    matched: base.matched || [],
    knownProject,
  }
}

/** 读目录里是否真的是 compose 项目（供 type 归一化使用，轻量只读） */
export function hasComposeFile(dir) {
  if (!dir) return null
  for (const name of ['docker-compose.yaml', 'docker-compose.yml', 'compose.yaml', 'compose.yml']) {
    const file = path.join(dir, name)
    if (fs.existsSync(file)) return file
  }
  return null
}

export default { inspectProjectSource, resolveUrlToProject, detectDeclaredPorts, parseFrontendUrl, looksLikeUrl, urlWithPort }
