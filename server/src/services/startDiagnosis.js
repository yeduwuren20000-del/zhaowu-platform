import fs from 'node:fs'

/**
 * 启动失败诊断（把日志尾巴翻译成「人话 + 下一步」）
 *
 * 背景：新手点「启动」最常见的后续就是失败，而失败证据全在项目日志里——
 * 一堆 Node / Python / npm 的原始报错对新手不可读。这个服务做且只做一件事：
 * 拿 verifyStartup 采集到的日志尾部做**确定性匹配**，输出：
 *   { cause, title, summary, advice[], evidence, logTail }
 *
 * 纪律：
 *   - 只认日志里真实出现的证据（evidence 就是命中那一行），匹配不到走兜底，
 *     不猜、不编造原因；
 *   - advice 每条都可选带 action（copy = 复制一条命令，navigate = 跳到某个页面），
 *     前端负责渲染，服务端不关心 UI；
 *   - 纯函数 + 只读文件探测（lockfile 推断安装命令），不执行任何项目代码。
 */

/** 安装命令推断：看目录里真实存在的 lockfile，没有就按 npm 猜（并明说只是默认值） */
export function guessInstallCommand(dir) {
  if (!dir) return { command: 'npm install', basis: '默认按 npm 处理' }
  const candidates = [
    ['pnpm-lock.yaml', 'pnpm install', '检测到 pnpm-lock.yaml'],
    ['yarn.lock', 'yarn', '检测到 yarn.lock'],
    ['bun.lockb', 'bun install', '检测到 bun.lockb'],
    ['package-lock.json', 'npm install', '检测到 package-lock.json'],
    ['requirements.txt', 'pip install -r requirements.txt', '检测到 requirements.txt'],
    ['pyproject.toml', 'pip install -e .', '检测到 pyproject.toml'],
  ]
  for (const [file, command, basis] of candidates) {
    try {
      if (fs.existsSync(`${dir.replace(/[\\/]+$/, '')}/${file}`)) return { command, basis }
    } catch {
      /* 目录不存在等情况：继续试下一个 */
    }
  }
  return { command: 'npm install', basis: '没找到 lockfile，按 npm 默认处理' }
}

/** 日志文本 -> 小写合并串，供各匹配器用 */
function flatten(log) {
  return (Array.isArray(log) ? log : []).join('\n').toLowerCase()
}

/** 找到第一个命中行，作为 evidence 回显给用户看 */
function evidenceLine(log, pattern) {
  const lines = Array.isArray(log) ? log : []
  const hit = lines.find((line) => pattern.test(line))
  return hit ? String(hit).trim().slice(0, 160) : null
}

/**
 * 匹配器表：顺序即优先级（前面的更具体）。
 * 每个匹配器拿到 { project, text, log, portOwners, install }，返回诊断对象或 null。
 */
const MATCHERS = [
  // ① 依赖没装：Node 找不到模块 / Python 找不到模块 / npm 脚本里的 bin 找不到
  //    判定分两层：直接证据（模块找不到）够就赢；否则要求「npm 确实把脚本跑起来了」
  //    （日志里有 npm 的脚本回显 "> pkg@1.0.0 dev" 或生命周期错误）+ 某个 bin 找不到——
  //    这种情况下找不到的必然是项目依赖，而不是用户把命令写错了。
  {
    cause: 'deps-missing',
    test: (text) =>
      /cannot find module|err_module_not_found|modulenotfounderror|no module named|找不到模块/i.test(text) ||
      (/command not found|不是内部或外部命令|is not recognized/i.test(text) &&
        (/^>\s/m.test(text) || /npm err! code elifecycle|npm err! errno/i.test(text))),
    // evidence 专用：命中行取模块找不到 / bin 找不到那条
    pattern: /cannot find module|err_module_not_found|modulenotfounderror|no module named|找不到模块|command not found|不是内部或外部命令|is not recognized/i,
    build: ({ project, log, install, pattern }) => ({
      cause: 'deps-missing',
      title: '依赖还没安装',
      summary: `项目代码在，但它需要的第三方包不在。${install.basis}。`,
      advice: [
        { text: '在项目目录里安装依赖，然后再点启动', action: { kind: 'copy', value: install.command } },
        { text: '安装就是普通的下载过程，等它跑完再启动，不要中断' },
      ],
      evidence: evidenceLine(log, pattern),
      logTail: (log || []).slice(-4),
    }),
  },
  // ② npm 脚本名不存在（package.json 里没这条 script）
  {
    cause: 'script-missing',
    pattern: /missing script|npm err! missing script/,
    build: ({ project, log, pattern }) => {
      const line = (log || []).find((l) => /missing script/i.test(l)) || ''
      const script = (line.match(/missing script:\s*["']?([\w.:@/-]+)/i) || [])[1]
      return {
        cause: 'script-missing',
        title: '启动命令里的脚本名不存在',
        summary: script
          ? `这个项目的 package.json 里没有叫做「${script}」的脚本。`
          : '启动命令里的脚本名，在 package.json 里找不到。',
        advice: [
          { text: '编辑这个项目，用「识别目录」重新读取正确的启动命令', action: { kind: 'navigate', to: '/projects', state: { edit: project?.id } } },
          { text: '也可以在项目目录执行 npm run 看看有哪些脚本可用' },
        ],
        evidence: evidenceLine(log, pattern),
        logTail: (log || []).slice(-4),
      }
    },
  },
  // ③ 端口被占用（服务自己报了 EADDRINUSE）
  {
    cause: 'port-in-use',
    pattern: /eaddrinuse|address already in use|端口.*被占用|bind .*:.*failed/i,
    build: ({ project, log, portOwners, pattern }) => {
      const advice = []
      const owner = (portOwners || [])[0]
      if (owner) {
        advice.push({
          text: `端口 ${project?.port ?? ''} 正被 PID ${owner.pid}（${owner.processName || '未知进程'}）占用，去端口页看清楚再决定`,
          action: { kind: 'navigate', to: '/ports' },
        })
      } else {
        advice.push({ text: '去端口页看看谁占用了这个端口', action: { kind: 'navigate', to: '/ports' } })
      }
      advice.push({ text: '或者编辑项目，把端口换成一个没人用的' })
      return {
        cause: 'port-in-use',
        title: '端口被别的程序占用',
        summary: `端口 ${project?.port ?? ''} 已经有程序在监听，这个项目起不来。`,
        advice,
        evidence: evidenceLine(log, pattern),
        logTail: (log || []).slice(-4),
      }
    },
  },
  // ④ Python 抛了异常（Traceback）
  {
    cause: 'python-error',
    pattern: /traceback \(most recent call last\)/,
    build: ({ project, log, install, text, pattern }) => ({
      cause: 'python-error',
      title: 'Python 程序抛出了异常',
      summary: '启动命令本身跑起来了，但代码执行到一半报错退出。',
      advice: [
        { text: '看日志最后一行的错误类型，那才是原因', action: { kind: 'navigate', to: '/logs', state: { source: `project:${project?.id ?? ''}` } } },
        /no module named/i.test(text)
          ? { text: '日志提示缺模块，先装依赖再启动', action: { kind: 'copy', value: install.command } }
          : { text: '如果日志提示缺模块，就是依赖没装', action: { kind: 'copy', value: install.command } },
      ],
      evidence: evidenceLine(log, pattern),
      logTail: (log || []).slice(-4),
    }),
  },
  // ⑤ 权限不足
  {
    cause: 'permission',
    pattern: /eacces|permission denied|拒绝访问|access is denied/i,
    build: ({ project, log, pattern }) => ({
      cause: 'permission',
      title: '权限不够',
      summary: '程序想访问的文件或端口没有权限。',
      advice: [
        { text: '试试用管理员身份运行工作台（右键 start.bat → 以管理员身份运行）' },
        { text: '也可以检查项目目录是不是被安全软件锁住了' },
      ],
      evidence: evidenceLine(log, pattern),
      logTail: (log || []).slice(-4),
    }),
  },
  // ⑥ 缺环境变量
  {
    cause: 'env-missing',
    pattern: /environment variable|环境变量|is not defined|process\.env\.\w+/i,
    build: ({ project, log, pattern }) => ({
      cause: 'env-missing',
      title: '缺少环境变量',
      summary: '程序启动时要读某些配置项，但这些配置没有提供。',
      advice: [
        { text: '在项目目录建一个 .env 文件，把日志里报错提到的变量补上' },
        { text: '看看项目里有没有 .env.example 之类的模板', action: { kind: 'copy', value: project?.dir ? `${project.dir}\\.env.example` : '.env.example' } },
      ],
      evidence: evidenceLine(log, pattern),
      logTail: (log || []).slice(-4),
    }),
  },
  // ⑦ 命令本身找不到（拼写错 / 工具没装）
  {
    cause: 'command-not-found',
    pattern: /不是内部或外部命令|is not recognized as an internal or external command|command not found|enoent|no such file or directory/i,
    build: ({ project, log, pattern }) => ({
      cause: 'command-not-found',
      title: '启动命令执行不了',
      summary: '系统找不到这条命令对应的程序——可能是拼写不一致，或者这个工具还没装。',
      advice: [
        { text: '检查启动命令拼写，尤其是 npm run xxx 里的脚本名', action: { kind: 'navigate', to: '/projects', state: { edit: project?.id } } },
        { text: '用「识别目录」重新读取项目的真实启动命令', action: { kind: 'navigate', to: '/projects', state: { edit: project?.id } } },
        { text: '如果是工具没装，去总览的环境体检看看缺什么', action: { kind: 'navigate', to: '/dashboard' } },
      ],
      evidence: evidenceLine(log, pattern),
      logTail: (log || []).slice(-4),
    }),
  },
]

/** 兜底：进程秒退但日志没给出任何可匹配的线索 */
function buildFallback({ project, log, running, portReady }) {
  if (running && !portReady) {
    return {
      cause: 'slow-start',
      title: '端口还没监听',
      summary: '进程已经在跑，但端口还没起来——大型项目第一次编译可能要一会儿。',
      advice: [
        { text: '再等等，或点「查看日志」看它进行到哪了', action: { kind: 'navigate', to: '/logs', state: { source: `project:${project?.id ?? ''}` } } },
      ],
      evidence: null,
      logTail: (log || []).slice(-4),
    }
  }
  return {
    cause: 'exited-silently',
    title: '启动后立刻退出，日志里没有明确原因',
    summary: '命令被执行了，但进程马上结束，日志也没留下可识别的报错。',
    advice: [
      { text: '打开完整日志看看最后几行', action: { kind: 'navigate', to: '/logs', state: { source: `project:${project?.id ?? ''}` } } },
      { text: '在项目目录里手动跑一遍这条命令，最能复现问题', action: { kind: 'copy', value: project?.startCommand || '' } },
      { text: '也可以用「识别目录」确认命令是否填对', action: { kind: 'navigate', to: '/projects', state: { edit: project?.id } } },
    ],
    evidence: null,
    logTail: (log || []).slice(-4),
  }
}

/**
 * 诊断一次启动结果。
 * @param {object} input
 * @param {object} input.project   项目记录（id / dir / port / startCommand）
 * @param {object} input.verify    verifyStartup 的返回（running / portReady / log）
 * @param {Array}  input.portOwners 启动失败时重扫到的端口占用者（可能为空）
 * @returns {object} 诊断对象；启动成功（running && portReady）返回 null
 */
export function diagnoseStartFailure({ project, verify, portOwners = [] }) {
  if (verify?.running && verify?.portReady) return null

  const log = verify?.log || []
  const text = flatten(log)
  const install = guessInstallCommand(project?.dir)
  const ctx = {
    project,
    log,
    text,
    portOwners,
    install,
    running: Boolean(verify?.running),
    portReady: Boolean(verify?.portReady),
  }

  for (const matcher of MATCHERS) {
    const hit = matcher.test ? matcher.test(text) : matcher.pattern.test(text)
    if (hit) {
      const diagnosis = matcher.build({ ...ctx, pattern: matcher.pattern })
      // evidence 兜底：匹配器没找到具体行时，用最后一行日志顶着，别返回 null 让前端难做
      if (!diagnosis.evidence && log.length > 0) {
        diagnosis.evidence = String(log[log.length - 1]).trim().slice(0, 160)
      }
      return diagnosis
    }
  }
  return buildFallback(ctx)
}
