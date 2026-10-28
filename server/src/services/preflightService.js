import { mkdirSync, unlinkSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { DATA_DIR } from '../config.js'
import { runFileQuiet } from '../utils/exec.js'

/**
 * 环境体检：确认这台机器具备工作台各功能所需的外部依赖。
 *
 * 为什么值得做：新手报「启动失败 / 网盘解析用不了」，八成是某个命令没装或没进 PATH，
 * 但界面上只会给一句技术错误。这里直接把「缺什么、缺了会影响哪个功能、怎么装」摆出来。
 * 每项都用真实命令探测（不是读注册表/猜路径），失败即认为不可用。
 */

const CACHE_TTL_MS = 30000
let cache = null

/** 只取第一行并截断，避免把整段 help 文本塞进界面 */
function firstLine(text, max = 80) {
  const line = String(text || '').trim().split(/\r?\n/).find((item) => item.trim()) || ''
  return line.trim().slice(0, max)
}

export async function probeCommand(file, args, { timeout = 6000 } = {}) {
  const result = await runFileQuiet(file, args, { timeout })
  if (result.failed) {
    const raw = String(result.stderr || '')
    const notFound = /ENOENT|not recognized|不是内部或外部命令|系统找不到指定的文件/i.test(raw)
    return { ok: false, detail: notFound ? '未安装，或没有加进 PATH' : firstLine(raw, 120) }
  }
  return { ok: true, detail: firstLine(result.stdout || result.stderr) }
}

/** 数据目录可写：不能只 existsSync，要真的写一个文件再删掉 */
async function probeDataDir() {
  try {
    mkdirSync(DATA_DIR, { recursive: true })
    const probeFile = path.join(DATA_DIR, `.preflight-${process.pid}.tmp`)
    writeFileSync(probeFile, 'ok')
    unlinkSync(probeFile)
    return { ok: true, detail: DATA_DIR }
  } catch (error) {
    return { ok: false, detail: `不可写：${error?.code || error?.message || '未知原因'}（${DATA_DIR}）` }
  }
}

const isWindows = process.platform === 'win32'

/**
 * 检查项定义。
 * required=true 的项缺了会让明确的功能不可用，界面上要红色告警；
 * required=false 只是锦上添花（Docker / Git），缺了用灰色提示即可。
 */
const CHECKS = [
  {
    id: 'node',
    label: 'Node.js',
    required: true,
    why: '工作台本体与项目启动都跑在 Node 上',
    fix: { text: '安装 Node.js 20 LTS', command: isWindows ? 'winget install OpenJS.NodeJS.LTS' : 'nvm install 20' },
    run: async () => ({ ok: true, detail: process.version }),
  },
  {
    id: 'python',
    label: 'Python',
    required: true,
    why: '「网盘直链」功能靠 Python 调用各网盘接口',
    fix: {
      text: '安装 Python 3.10+（安装时勾选 Add to PATH）',
      command: isWindows ? 'winget install Python.Python.3.12' : 'brew install python@3.12',
    },
    run: async () => {
      // Windows 上还有 py 启动器，两者有一个能用就算就绪
      const direct = await probeCommand('python', ['--version'])
      if (direct.ok) return direct
      const launcher = await probeCommand('py', ['--version'])
      if (launcher.ok) return { ok: true, detail: `${launcher.detail}（通过 py 启动器）` }
      return direct
    },
  },
  {
    id: 'powershell',
    label: 'PowerShell',
    required: isWindows,
    why: '端口扫描、WSL 与进程管理都通过 PowerShell 采集',
    fix: { text: 'Windows 自带；若缺失请修复系统组件', command: 'winget install Microsoft.PowerShell' },
    run: async () => {
      if (!isWindows) return { ok: true, detail: '当前系统不需要' }
      return probeCommand('powershell.exe', [
        '-NoProfile',
        '-NonInteractive',
        '-Command',
        '$PSVersionTable.PSVersion.ToString()',
      ])
    },
  },
  {
    id: 'git',
    label: 'Git',
    required: false,
    why: '项目里查看提交记录、拉取代码时用得到',
    fix: { text: '安装 Git', command: isWindows ? 'winget install Git.Git' : 'brew install git' },
    run: async () => probeCommand('git', ['--version']),
  },
  {
    id: 'docker',
    label: 'Docker',
    required: false,
    why: '只在用容器时会用到；没装不影响其它功能',
    fix: {
      text: '安装 Docker Desktop（体积较大，按需）',
      command: isWindows ? 'winget install Docker.DockerDesktop' : 'brew install --cask docker',
    },
    run: async () => probeCommand('docker', ['--version'], { timeout: 8000 }),
  },
  {
    id: 'dataDir',
    label: '数据目录可写',
    required: true,
    why: '项目清单、凭据库、日志都写在这里；不可写会导致启动/保存失败',
    fix: {
      text: '把工作台放到有写权限的目录，或调整该目录的安全设置',
      command: `icacls "${DATA_DIR}" /grant "%USERNAME%:(OI)(CI)M"`,
    },
    run: probeDataDir,
  },
]

export async function runPreflight({ force = false } = {}) {
  if (!force && cache && Date.now() - cache.at < CACHE_TTL_MS) return cache.data

  const items = await Promise.all(
    CHECKS.map(async (check) => {
      let result
      try {
        result = await check.run()
      } catch (error) {
        result = { ok: false, detail: String(error?.message || error) }
      }
      return {
        id: check.id,
        label: check.label,
        required: check.required,
        why: check.why,
        ok: Boolean(result.ok),
        detail: result.detail || '',
        fix: check.fix || null,
      }
    }),
  )

  const missing = items.filter((item) => !item.ok)
  const data = {
    checkedAt: new Date().toISOString(),
    platform: process.platform,
    nodeVersion: process.version,
    items,
    summary: {
      total: items.length,
      okCount: items.length - missing.length,
      missing: missing.map((item) => item.id),
      requiredMissing: missing.filter((item) => item.required).map((item) => item.id),
    },
  }

  cache = { at: Date.now(), data }
  return data
}
