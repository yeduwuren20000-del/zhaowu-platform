import fs from 'node:fs'
import path from 'node:path'
import { isSafeDirectory, probeDirectory } from './projectDetector.js'

/**
 * 项目目录识别（只读）：用户已经知道目录在哪，帮他把表单少填几项。
 *
 * 与 projectDetector 的分工：那个面向「从进程反推项目」，这个面向「用户主动指一个目录」。
 * 口径与「服务器快速填入」完全一致：
 *   - 只给建议（fields 只含识别到的非空值），由前端决定填不填，绝不覆盖用户已填内容；
 *   - 识别不出就明说（notes），不编造启动命令；
 *   - 不执行任何脚本、不安装依赖，只读白名单文件 + 列一层目录。
 */

/** 脚本名优先级：先 dev 再 start，其余按常见度排 */
const SCRIPT_PRIORITY = ['dev', 'develop', 'start', 'serve', 'run', 'start:dev', 'dev:server', 'app']

/** Python 常见入口文件名（按可能性排序） */
const PY_ENTRY_CANDIDATES = ['manage.py', 'main.py', 'app.py', 'server.py', 'run.py', 'wsgi.py', 'asgi.py']

/** 从一段命令文本里猜端口：--port 8000 / --port=8000 / -p 8080:8080 / PORT=3000 */
export function guessPortFromCommand(text) {
  if (!text) return null
  const patterns = [/--port[=\s]+(\d{2,5})/i, /\bPORT[=:](\d{2,5})/i, /-p\s+(\d{2,5}):(\d{2,5})/]
  for (const pattern of patterns) {
    const match = String(text).match(pattern)
    if (match) {
      const port = Number(match[1])
      if (port >= 1 && port <= 65535) return port
    }
  }
  return null
}

/** 技术栈推断：只依据真实读到的清单文件与依赖名，不猜 */
function inferType(summaries) {
  if (summaries.compose) return 'Docker Compose'
  if (summaries.packageJson) {
    const deps = summaries.packageJson.dependencies?.interesting || []
    if (deps.some((dep) => dep === 'electron' || dep === 'tauri')) return '桌面应用'
    if (deps.some((dep) => ['vite', 'next', 'nuxt', 'react-scripts', '@vue/cli-service', 'astro', 'svelte'].includes(dep))) return '前端'
    if (deps.some((dep) => ['express', 'koa', 'fastify', '@nestjs/core', 'hapi', 'socket.io', 'ws'].includes(dep))) return 'Node 服务'
    return 'Node.js'
  }
  if (summaries.pyproject || summaries.requirements || summaries.pipfile) return 'Python'
  if (summaries.rust) return 'Rust'
  if (summaries.go) return 'Go'
  if (summaries.jvm) return 'JVM'
  return null
}

/** 读 package.json 的 scripts 映射（名字 → 命令文本）；文件坏了就返回 null */
function readScripts(dir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'))
    if (!parsed?.scripts || typeof parsed.scripts !== 'object') return null
    const scripts = {}
    for (const [name, command] of Object.entries(parsed.scripts)) {
      if (typeof command === 'string' && command.trim()) scripts[name] = command.trim()
    }
    return Object.keys(scripts).length > 0 ? scripts : null
  } catch {
    return null
  }
}

/** 列一层目录里出现的 Python 入口文件（不递归） */
function findPythonEntries(dir) {
  try {
    return fs
      .readdirSync(dir, { withFileTypes: true })
      .filter((entry) => entry.isFile() && PY_ENTRY_CANDIDATES.includes(entry.name))
      .map((entry) => entry.name)
      .sort((a, b) => PY_ENTRY_CANDIDATES.indexOf(a) - PY_ENTRY_CANDIDATES.indexOf(b))
  } catch {
    return []
  }
}

/** Node 项目：从 scripts 里挑最像「启动服务」的那几个，按优先级给候选 */
function nodeCandidates(scripts) {
  if (!scripts) return []
  const ordered = []
  for (const name of SCRIPT_PRIORITY) {
    if (scripts[name]) ordered.push(name)
  }
  // 优先级名单之外的 dev:* / start:* 形态也收进来，排在显名之后
  for (const name of Object.keys(scripts)) {
    if (ordered.includes(name)) continue
    if (/^(dev|start|serve)/.test(name)) ordered.push(name)
  }
  return ordered.slice(0, 4).map((name) => ({
    command: `npm run ${name}`,
    port: guessPortFromCommand(scripts[name]),
    why: `package.json 里的 ${name} 脚本`,
    script: name,
  }))
}

/**
 * 识别一个目录，返回「建议填什么」。
 * 返回结构：{ ok, fields, candidates: { startCommand: [...] }, notes, matched }
 *   - fields：只含识别到的非空字段（前端只填空字段，不覆盖）
 *   - candidates.startCommand：可点击的候选启动命令（带端口猜测与理由）
 *   - notes：给人看的说明（识别到什么、哪里不确定）
 *   - matched：命中的项目文件清单（证明是"读到的"不是"猜的"）
 */
export function inspectProjectDir(dir) {
  const raw = String(dir || '').trim()
  if (!raw) return { ok: false, error: '请先填写项目目录' }
  const resolved = path.resolve(raw)
  if (!isSafeDirectory(resolved)) return { ok: false, error: `目录不存在或读不了：${resolved}` }

  const probed = probeDirectory(resolved)
  const summaries = probed.summaries || {}
  const matched = probed.markers || []

  if (matched.length === 0) {
    return {
      ok: true,
      fields: {},
      candidates: { startCommand: [] },
      matched,
      notes: ['这个目录下没有常见的项目文件（package.json / requirements.txt / docker-compose.yml 等）。如果项目在子目录里，把目录指到那一层再试。'],
    }
  }

  const notes = []
  const candidates = { startCommand: [] }
  const fields = {}

  // 名称：package.json 的 name 优先，否则用目录名
  const packageName = summaries.packageJson?.name
  if (packageName) fields.name = String(packageName).slice(0, 120)
  else fields.name = path.basename(resolved).slice(0, 120)

  const type = inferType(summaries)
  if (type) fields.type = type

  if (summaries.packageJson) {
    const scripts = readScripts(resolved)
    const list = nodeCandidates(scripts)
    candidates.startCommand.push(...list)
    if (list.length > 0) {
      fields.startCommand = list[0].command
      if (list[0].port) fields.port = list[0].port
      notes.push(`识别到 Node 项目，启动命令取自 package.json 的「${list[0].script}」脚本。`)
    } else {
      notes.push('识别到 Node 项目，但 package.json 里没有 dev / start 之类的脚本，启动命令请自己填。')
    }
    if (summaries.packageJson.packageManager && /pnpm|yarn/.test(summaries.packageJson.packageManager)) {
      const pm = summaries.packageJson.packageManager.split('@')[0]
      notes.push(`这个项目声明用 ${pm} 管理依赖，启动命令里的 npm run 可以相应换成 ${pm} run。`)
    }
  } else if (summaries.compose) {
    fields.startCommand = 'docker compose up -d'
    fields.stopCommand = 'docker compose down'
    if (summaries.compose.publishedPorts?.length) fields.port = summaries.compose.publishedPorts[0]
    candidates.startCommand.push({ command: 'docker compose up -d', port: fields.port || null, why: 'docker-compose 文件' })
    notes.push(`识别到 Docker Compose 项目（${summaries.compose.services.length} 个服务），按容器方式启停。`)
  } else if (summaries.pyproject || summaries.requirements || summaries.pipfile) {
    const entries = findPythonEntries(resolved)
    if (entries.length > 0) {
      const entry = entries[0]
      const isDjango = entry === 'manage.py'
      const command = isDjango ? 'python manage.py runserver' : `python ${entry}`
      fields.startCommand = command
      if (isDjango) fields.port = 8000
      candidates.startCommand.push(
        ...entries.map((name) => ({
          command: name === 'manage.py' ? 'python manage.py runserver' : `python ${name}`,
          port: name === 'manage.py' ? 8000 : null,
          why: `目录里的 ${name}`,
        })),
      )
      notes.push(`识别到 Python 项目，入口文件按目录里实际存在的 ${entries.join('、')} 给出，选了第一个。`)
    } else {
      notes.push('识别到 Python 项目，但目录里没看到常见入口文件（main.py / app.py / manage.py 等），启动命令请按你的实际入口填。')
    }
  } else if (summaries.rust) {
    fields.startCommand = 'cargo run'
    candidates.startCommand.push({ command: 'cargo run', port: null, why: 'Cargo.toml' })
    notes.push('识别到 Rust 项目。')
  } else if (summaries.go) {
    fields.startCommand = 'go run .'
    candidates.startCommand.push({ command: 'go run .', port: null, why: 'go.mod' })
    notes.push('识别到 Go 项目。')
  } else if (summaries.jvm) {
    notes.push('识别到 JVM 项目，启动命令与构建工具和版本有关，请自己填（如 mvn spring-boot:run）。')
  } else {
    notes.push('只看到了项目文件，但判断不出技术栈，启动命令请自己填。')
  }

  if (fields.port && !fields.url) fields.url = `http://localhost:${fields.port}`

  // 端口是从命令文本里"读"出来的，必须说清可能不准
  if (fields.port) {
    notes.push(`端口 ${fields.port} 是从启动命令 / 编排文件里读到的，实际以启动后服务监听的为准，起不来先去「服务端口」页看看。`)
  }

  return { ok: true, fields, candidates, notes, matched }
}

export default { inspectProjectDir, guessPortFromCommand }
