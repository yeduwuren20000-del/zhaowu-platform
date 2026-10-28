import { createHash } from 'node:crypto'

/**
 * 服务分类（第一层：确定性规则）
 *
 * 输入全部是**系统真实采集**到的事实（端口、监听地址、PID、进程名、exe、命令行、父进程链、项目元数据）；
 * 输出是"建议值"（名称、类型、启动命令、访问地址、置信度、过滤原因），不修改任何事实字段。
 */

/** 系统进程 / 非开发进程：默认折叠，不推荐为项目 */
export const SYSTEM_PROCESSES = new Set([
  'system', 'idle', 'registry', 'smss', 'csrss', 'wininit', 'winlogon', 'services', 'lsass', 'lsaiso', 'svchost',
  'fontdrvhost', 'dwm', 'spoolsv', 'taskhostw', 'sihost', 'ctfmon', 'searchindexer', 'searchhost', 'searchapp',
  'searchprotocolhost', 'securityhealthservice', 'securityhealthsystray', 'audiodg', 'runtimebroker', 'wmiprvse',
  'conhost', 'dllhost', 'wudfhost', 'msmpeng', 'nissrv', 'sgrmbroker', 'memcompression', 'textinputhost',
  'startmenuexperiencehost', 'shellexperiencehost', 'widgets', 'widgetservice', 'applicationframehost', 'lockapp',
  'explorer', 'useroobebroker', 'systemsettings', 'sppsvc', 'trustedinstaller', 'tiworker', 'msiexec', 'vssvc',
  'wlanext', 'backgroundtaskhost', 'smartscreen', 'taskmgr', 'perfmon', 'mmc', 'rdpclip', 'sihost', 'jhi_service',
  'igfxem', 'rundll32', 'regsvr32', 'werfault', 'wermgr', 'compress', 'crashpad_handler', 'spoolsv',
  // Windows 服务 / 虚拟化 / 安全组件
  'vmms', 'vmcompute', 'hns', 'wslservice', 'lxssmanager', 'vmwp', 'dashost', 'windefend', 'nissrv', 'sense',
  'mssense', 'mpdefendercore', 'wmiprvse', 'wmiapsrv', 'dps', 'diagsvc', 'eventlog', 'schedule', 'usosvc',
  'trustedinstaller', 'moshost', 'wscsvc', 'plash', 'sysmain', 'bits', 'cryptsvc', 'dcomlaunch', 'lanmanserver',
  'spooler', 'wuauserv', 'appinfo', 'brokerinfrastructure', 'staterepository', 'tokenbroker', 'wpdbusenum',
])

/** 编辑器 / 开发工具进程：会监听调试端口，但不应被当成"待登记的项目服务" */
export const EDITOR_PROCESSES = new Set([
  'code', 'code - insiders', 'cursor', 'windsurf', 'devenv', 'idea64', 'pycharm64', 'webstorm64', 'goland64',
  'clion64', 'rider64', 'phpstorm64', 'datagrip64', 'sublime_text', 'notepad++', 'atom', 'zed', 'fleet',
  'deepseek harness', 'editor_sdk', 'vscode', 'trae', 'trae cn',
])

/** 与开发无关的常见装机软件（默认折叠，但不算"系统"） */
export const NON_DEV_HINTS = [
  'qq', 'qqlive', 'wechat', 'weixin', 'dingtalk', 'wemeet', 'tencent', 'thunder', 'xunlei', 'baidu', 'kugou',
  'netease', 'cloudmusic', 'iqiyi', 'youku', 'douyin', 'bilibili', 'steam', 'wallpaper', 'wemeetapp',
  'onedrive', 'dropbox', 'googledrive', 'adobe', 'photoshop', 'wps', 'officeclicktorun', 'searchindexer',
  // 代理 / 远程控制 / 投屏 / 模拟器工具
  'mihomo', 'clash', 'v2ray', 'xray', 'sing-box', 'shadowsocks', 'trojan', 'netch', 'proxifier', 'surge',
  'todesk', 'sunlogin', 'rustdesk', 'anydesk', 'teamviewer', 'gameviewer', 'workbuddy', 'androwssvr',
  'ldplayer', 'dnplayer', 'bluestacks', 'nox', 'mumu', 'quicktime', 'obs', 'vmware', 'virtualbox', 'parallels',
]

/**
 * 未识别常驻程序的名字后缀：属于这一类、又没有项目目录特征时，折叠到"其他"分组，
 * 避免把一堆装机软件/工具塞进"待登记"列表（用户仍可展开查看或手动登记）。
 */
const RESIDENT_SUFFIXES = ['svr', 'service', 'agent', 'daemon', 'helper', 'tray', 'guard', 'launcher', 'updater', 'sync', 'server']

/** 常见系统保留端口（不作为项目推荐） */
export const SYSTEM_PORTS = new Set([
  135, 137, 138, 139, 445, 1900, 2869, 3702, 5040, 5353, 5355, 7680, 5357, 5000 + 0,
])

/** RPC 动态端口范围（Windows 默认 49152-65535） */
const DYNAMIC_RPC_START = 49152

/** 开发类进程名（这些名字出现时不要因为路径在 Program Files 就被当系统进程） */
const DEV_PROCESS_NAMES = new Set([
  'node', 'nodejs', 'npm', 'npx', 'yarn', 'pnpm', 'bun', 'deno', 'python', 'pythonw', 'python3', 'py',
  'java', 'javaw', 'dotnet', 'php', 'ruby', 'cargo', 'go', 'rustc', 'gradle', 'mvn', 'docker', 'docker-proxy',
  'com.docker.backend', 'vpnkit', 'wslrelay', 'mysqld', 'redis-server', 'postgres', 'mongod', 'ollama',
  'nginx', 'httpd', 'uvicorn', 'gunicorn', 'flask', 'celery', 'jupyter', 'streamlit', 'vite',
])

const DEVPORT_HINTS = {
  3000: { type: 'Node / Next.js 开发服务', tone: 'dev' },
  3001: { type: 'Node 开发服务', tone: 'dev' },
  4173: { type: 'Vite 预览服务', tone: 'dev' },
  4200: { type: 'Angular 开发服务', tone: 'dev' },
  5000: { type: '.NET / Flask 服务', tone: 'dev' },
  5173: { type: 'Vite 开发服务器', tone: 'dev' },
  5174: { type: 'Vite 开发服务器', tone: 'dev' },
  8000: { type: 'FastAPI / Django 服务', tone: 'dev' },
  8001: { type: 'Python HTTP 服务', tone: 'dev' },
  8080: { type: 'HTTP 服务（8080）', tone: 'dev' },
  8443: { type: 'HTTPS 服务（8443）', tone: 'dev' },
  8888: { type: 'HTTP 服务（8888）', tone: 'dev' },
  11434: { type: 'Ollama API', tone: 'ai' },
  3306: { type: 'MySQL', tone: 'db' },
  5432: { type: 'PostgreSQL', tone: 'db' },
  6379: { type: 'Redis', tone: 'db' },
  27017: { type: 'MongoDB', tone: 'db' },
  1433: { type: 'SQL Server', tone: 'db' },
  9200: { type: 'Elasticsearch', tone: 'db' },
  11211: { type: 'Memcached', tone: 'db' },
  80: { type: 'HTTP 服务器', tone: 'web' },
  443: { type: 'HTTPS 服务器', tone: 'web' },
}

function text(value) {
  return String(value || '').toLowerCase()
}

function has(text_, ...keywords) {
  return keywords.some((keyword) => text_.includes(keyword))
}

function exeBaseName(exePath) {
  if (!exePath) return ''
  const parts = String(exePath).split(/[\\/]/)
  return (parts[parts.length - 1] || '').replace(/\.exe$/i, '').toLowerCase()
}

/** 稳定指纹：与 PID 无关，用于"已忽略"记录与"新发现"比对 */
export function buildFingerprint({ processName, exePath, projectDir, port }) {
  const payload = [text(processName).replace(/\.exe$/, ''), text(exePath), text(projectDir), port ?? ''].join('|')
  return createHash('sha1').update(payload).digest('hex').slice(0, 16)
}

function pickStartCommand(ctx) {
  const scripts = ctx.project?.stack?.scripts || []
  const deps = ctx.dependencies || []
  const kinds = ctx.project?.stack?.kinds || []

  if (scripts.length > 0) {
    if (scripts.includes('dev')) return { command: 'npm run dev', source: 'package.json scripts.dev' }
    if (scripts.includes('start')) return { command: 'npm run start', source: 'package.json scripts.start' }
    if (scripts.includes('serve')) return { command: 'npm run serve', source: 'package.json scripts.serve' }
    return { command: `npm run ${scripts[0]}`, source: `package.json scripts.${scripts[0]}` }
  }
  if (deps.includes('vite') || kinds.includes('node')) return { command: 'npm run dev', source: 'Node 项目惯例' }
  if ((ctx.markers || []).includes('manage.py') || has(text(ctx.commandLine), 'manage.py')) {
    return { command: `python manage.py runserver ${ctx.port}`, source: 'Django 惯例' }
  }
  if (kinds.includes('python')) {
    if (deps.includes('fastapi') || has(text(ctx.commandLine), 'uvicorn')) return { command: `python -m uvicorn main:app --reload --port ${ctx.port}`, source: 'FastAPI 惯例' }
    if (deps.includes('flask')) return { command: `python -m flask run --port ${ctx.port}`, source: 'Flask 惯例' }
    return { command: 'python main.py', source: 'Python 惯例' }
  }
  if (kinds.includes('jvm')) return { command: 'mvn spring-boot:run', source: 'Spring Boot 惯例' }
  if (kinds.includes('rust')) return { command: 'cargo run', source: 'Rust 惯例' }
  if (kinds.includes('go')) return { command: 'go run .', source: 'Go 惯例' }
  if (kinds.includes('docker-compose')) return { command: 'docker compose up -d', source: 'docker-compose.yml' }
  return null
}

/**
 * 核心分类函数。
 * @returns {{serviceName:string, type:string, category:string, confidence:number, source:'rule',
 *   reasons:string[], filtered:boolean, filterReason:string|null, devRelevant:boolean,
 *   suggestedStartCommand:string|null, startCommandSource:string|null, suggestedUrl:string|null, aiEligible:boolean}}
 */
export function classifyService(ctx) {
  const port = ctx.port ?? null
  const processName = text(ctx.processName).replace(/\.exe$/, '')
  const exePath = text(ctx.exePath)
  const commandLine = text(ctx.commandLine)
  const chainText = (ctx.chain || []).map((item) => `${text(item.name)} ${text(item.commandLine)}`).join(' ')
  const project = ctx.project || null
  const deps = project?.stack?.dependencies || []
  const kinds = project?.stack?.kinds || []
  const markers = project?.markers || []
  const reasons = []
  let type = null
  let category = 'other'
  let confidence = 0.3
  let evidence = 0

  const note = (reason, weight = 0.15) => {
    reasons.push(reason)
    evidence += weight
  }

  const processHint = `${processName} ${exePath} ${commandLine} ${chainText}`

  // ---- 1) 容器端口发布 ----
  if (has(processName, 'docker-proxy', 'com.docker.backend', 'vpnkit', 'wslrelay') || has(exePath, '\\docker\\')) {
    type = 'Docker 容器端口（宿主机代理）'
    category = 'container'
    note('监听进程是 Docker 的端口代理', 0.45)
    confidence = 0.92
  }

  // ---- 2) 数据库 / 中间件 ----
  if (!type) {
    const databases = [
      { names: ['mysqld', 'mariadbd'], type: 'MySQL / MariaDB', category: 'database', ports: [3306, 3307] },
      { names: ['redis-server', 'memurai'], type: 'Redis', category: 'database', ports: [6379] },
      { names: ['postgres', 'pg_ctl'], type: 'PostgreSQL', category: 'database', ports: [5432] },
      { names: ['mongod'], type: 'MongoDB', category: 'database', ports: [27017] },
      { names: ['sqlservr'], type: 'SQL Server', category: 'database', ports: [1433] },
      { names: ['elasticsearch', 'java'], type: 'Elasticsearch', category: 'database', ports: [9200], only: 'elasticsearch' },
      { names: ['memcached'], type: 'Memcached', category: 'database', ports: [11211] },
      { names: ['clickhouse'], type: 'ClickHouse', category: 'database', ports: [8123, 9000] },
    ]
    for (const db of databases) {
      if (!db.names.includes(processName)) continue
      if (db.only && !has(processHint, db.only)) continue
      type = db.type
      category = db.category
      note(`进程名 ${ctx.processName} 匹配 ${db.type}`, 0.5)
      if (port && db.ports.includes(port)) note(`端口 ${port} 是 ${db.type} 默认端口`, 0.2)
      confidence = port && db.ports.includes(port) ? 0.97 : 0.8
      break
    }
  }

  // ---- 3) 反向代理 / Web 服务器 ----
  if (!type) {
    if (processName === 'nginx') {
      type = 'Nginx'
      category = 'web-server'
      note('进程名 nginx', 0.5)
      confidence = 0.95
    } else if (['httpd', 'apache'].includes(processName)) {
      type = 'Apache HTTP Server'
      category = 'web-server'
      note('进程名 httpd/apache', 0.5)
      confidence = 0.92
    } else if (['w3wp', 'iisexpress'].includes(processName)) {
      type = 'IIS'
      category = 'web-server'
      note('进程名 ' + processName, 0.5)
      confidence = 0.9
    }
  }

  // ---- 4) AI / 模型服务 ----
  if (!type && has(processName, 'ollama')) {
    type = 'Ollama'
    category = 'ai-service'
    note('进程名 ollama', 0.5)
    if (port === 11434) note('端口 11434 是 Ollama 默认端口', 0.2)
    confidence = port === 11434 ? 0.97 : 0.85
  }
  if (!type && has(processHint, 'vllm', 'llama.cpp', 'llama-server', 'text-generation-webui', 'lm studio', 'localai')) {
    type = '本地大模型服务'
    category = 'ai-service'
    note('命令行包含本地模型服务关键字', 0.4)
    confidence = 0.8
  }

  // ---- 5) Node / 前端 / 后端框架 ----
  if (!type && (['node', 'nodejs', 'bun', 'deno'].includes(processName) || has(exePath, 'node.exe', '\\node\\'))) {
    const withDep = (dependency) => deps.includes(dependency) || has(commandLine, dependency)
    if (withDep('vite') || markers.includes('vite.config.js') || markers.includes('vite.config.ts')) {
      type = 'Vite 开发服务器'
      note('依赖或配置命中 vite', 0.4)
      confidence = 0.92
    } else if (withDep('next') || markers.some((marker) => marker.startsWith('next.config'))) {
      type = 'Next.js'
      note('依赖或配置命中 next', 0.4)
      confidence = 0.92
    } else if (withDep('react-scripts')) {
      type = 'React（Create React App）'
      note('依赖命中 react-scripts', 0.4)
      confidence = 0.9
    } else if (withDep('@vue/cli-service') || has(commandLine, 'vue-cli-service')) {
      type = 'Vue CLI'
      note('依赖命中 @vue/cli-service', 0.4)
      confidence = 0.9
    } else if (withDep('nuxt') || markers.some((marker) => marker.startsWith('nuxt.config'))) {
      type = 'Nuxt'
      note('依赖或配置命中 nuxt', 0.4)
      confidence = 0.9
    } else if (withDep('astro')) {
      type = 'Astro'
      note('依赖命中 astro', 0.4)
      confidence = 0.88
    } else if (withDep('express') || withDep('koa') || withDep('fastify') || withDep('@nestjs/core')) {
      const framework = withDep('@nestjs/core') ? 'NestJS' : withDep('fastify') ? 'Fastify' : withDep('koa') ? 'Koa' : 'Express'
      type = `Node 服务（${framework}）`
      note(`依赖命中 ${framework}`, 0.4)
      confidence = 0.88
    } else if (markers.includes('package.json')) {
      type = 'Node 服务'
      category = 'dev-server'
      note('项目里有 package.json，进程是 node', 0.35)
      confidence = 0.7
    } else {
      type = 'Node 进程'
      note('进程名 node，但未识别出具体框架', 0.25)
      confidence = 0.5
    }
    if (type && !category.startsWith('database')) category = 'dev-server'
  }

  // ---- 6) Python 生态 ----
  if (!type && ['python', 'pythonw', 'python3', 'py'].includes(processName)) {
    const projectDeps = `${deps.join(' ')} ${commandLine} ${chainText}`
    if (has(projectDeps, 'fastapi', 'uvicorn')) {
      type = 'FastAPI'
      note('命令行/依赖命中 fastapi 或 uvicorn', 0.4)
      confidence = 0.92
    } else if (has(projectDeps, 'flask')) {
      type = 'Flask'
      note('命令行/依赖命中 flask', 0.4)
      confidence = 0.9
    } else if (has(projectDeps, 'manage.py', 'django', 'runserver')) {
      type = 'Django'
      note('命令行/依赖命中 django / manage.py', 0.4)
      confidence = 0.9
    } else if (has(projectDeps, 'streamlit')) {
      type = 'Streamlit'
      note('命令行命中 streamlit', 0.4)
      confidence = 0.88
    } else if (has(projectDeps, 'jupyter', 'notebook')) {
      type = 'Jupyter'
      note('命令行命中 jupyter', 0.4)
      confidence = 0.85
    } else if (markers.includes('pyproject.toml') || markers.includes('requirements.txt')) {
      type = 'Python 服务'
      note('项目里有 Python 依赖清单', 0.35)
      confidence = 0.7
    } else {
      type = 'Python 进程'
      note('进程名 python，但未识别出框架', 0.25)
      confidence = 0.5
    }
    category = 'dev-server'
  }

  // ---- 7) JVM / 其他语言 ----
  if (!type && ['java', 'javaw'].includes(processName)) {
    if (has(`${exePath} ${commandLine}`, 'spring', 'spring-boot')) {
      type = 'Spring Boot'
      note('命令行命中 spring', 0.45)
      confidence = 0.9
    } else {
      type = 'Java 服务'
      note('进程名 java，但未识别出框架', 0.3)
      confidence = 0.55
    }
    category = 'dev-server'
  }
  if (!type && processName === 'dotnet') {
    type = '.NET（Kestrel）'
    category = 'dev-server'
    note('进程名 dotnet', 0.4)
    confidence = 0.8
  }
  if (!type && ['cargo', 'rustc'].includes(processName)) {
    type = 'Rust 服务'
    category = 'dev-server'
    note('进程名 ' + processName, 0.35)
    confidence = 0.7
  }
  if (!type && ['php', 'php-cgi'].includes(processName)) {
    type = 'PHP 服务'
    category = 'dev-server'
    note('进程名 php', 0.35)
    confidence = 0.7
  }
  if (!type && ['ruby', 'puma'].includes(processName)) {
    type = has(commandLine, 'rails', 'puma') ? 'Ruby on Rails' : 'Ruby 服务'
    category = 'dev-server'
    note('进程名 ' + processName, 0.35)
    confidence = 0.72
  }
  if (!type && has(processName, 'electron')) {
    type = 'Electron 应用'
    category = 'other'
    note('进程名 electron', 0.3)
    confidence = 0.6
  }

  // ---- 8) 端口惯例兜底 ----
  if (!type && port && DEVPORT_HINTS[port]) {
    type = DEVPORT_HINTS[port].type
    note(`端口 ${port} 是常见开发/服务端口`, 0.15)
    confidence = 0.45
    category = DEVPORT_HINTS[port].tone === 'db' ? 'database' : DEVPORT_HINTS[port].tone === 'ai' ? 'ai-service' : 'dev-server'
  }

  // ---- 9) 完全未知 ----
  if (!type) {
    type = '未知监听服务'
    confidence = 0.3
    category = 'other'
  }

  // ---- 项目/命令行为类型加权重 ----
  if (project?.root) note(`推断出项目目录 ${project.root}`, 0.15)
  if (commandLine) note('读取到完整命令行', 0.05)

  confidence = Math.max(0.2, Math.min(0.98, Math.round((confidence + Math.min(0.1, evidence * 0.1)) * 100) / 100))

  // ---- 过滤判定 ----
  const devProcess = DEV_PROCESS_NAMES.has(processName)
  const looksLikeInstalledSoftware = has(exePath, '\\program files', '\\program files (x86)', '\\windows\\') && !devProcess
  // 只看进程名与 exe 路径：命令行里出现关键字（例如项目路径含 obs）不该导致误过滤
  const nonDevApp = NON_DEV_HINTS.some((hint) => has(`${processName} ${exePath} ${exeBaseName(exePath)}`, hint))
  const dynamicRpc = port !== null && port >= DYNAMIC_RPC_START && !devProcess
  const systemPort = port !== null && SYSTEM_PORTS.has(port) && !devProcess

  let filtered = false
  let filterReason = null
  if (SYSTEM_PROCESSES.has(processName)) {
    filtered = true
    filterReason = 'Windows 系统进程，不会自动推荐为项目'
  } else if (EDITOR_PROCESSES.has(processName)) {
    filtered = true
    filterReason = '编辑器 / 开发工具进程（监听的是调试或语言服务端口）'
  } else if (devProcess || project?.root) {
    // 数据库 / 运行时（MySQL、Redis、PHP…）也走这里：系统明确认得出它们是什么，
    // 但**展示与否交给用户判断**，不替用户决定不登记（有项目目录时更应放行）。
    filtered = false
  } else if (nonDevApp) {
    filtered = true
    filterReason = '非开发相关的装机软件'
  } else if (dynamicRpc) {
    filtered = true
    filterReason = 'Windows 动态 RPC 端口（49152+）'
  } else if (systemPort) {
    filtered = true
    filterReason = '系统保留端口'
  } else if (looksLikeInstalledSoftware) {
    filtered = true
    filterReason = '安装在系统目录下的服务，且没有项目目录特征'
  } else if (category === 'other' && type === '未知监听服务' && RESIDENT_SUFFIXES.some((suffix) => processName.endsWith(suffix))) {
    filtered = true
    filterReason = '未识别的常驻程序（已折叠，可展开查看或手动登记）'
  }

  const isHttpLike = ![3306, 5432, 6379, 27017, 1433, 9200, 11211, 8123].includes(port) && category !== 'database'
  const suggestedUrl = port && isHttpLike ? `http://localhost:${port}` : null
  const startCommand = filtered ? null : pickStartCommand({ ...ctx, dependencies: deps, markers })

  const suggestedName =
    project?.stack?.packageName ||
    (project?.root ? project.root.split(/[\\/]/).filter(Boolean).pop() : null) ||
    `${ctx.processName || type}${port ? ` :${port}` : ''}`

  const aiEligible =
    !filtered &&
    (type === '未知监听服务' || type === 'Node 进程' || type === 'Python 进程' || type === 'Java 服务' || confidence < 0.7)

  return {
    fingerprint: buildFingerprint({ processName: ctx.processName, exePath: ctx.exePath, projectDir: project?.root, port }),
    serviceName: suggestedName,
    type,
    category,
    confidence,
    source: 'rule',
    reasons,
    filtered,
    filterReason,
    devRelevant: !filtered,
    suggestedStartCommand: startCommand?.command || null,
    startCommandSource: startCommand?.source || null,
    suggestedUrl,
    aiEligible,
  }
}

export { DEVPORT_HINTS, DEV_PROCESS_NAMES }
