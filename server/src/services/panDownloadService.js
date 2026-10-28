import { spawn as spawnChild } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PAN_PYTHON, PAN_TOOL_DIR } from './panService.js'
import { badRequest, HttpError, notFound } from '../utils/http.js'

/**
 * 「下载到本机」——把网盘直链落到本地磁盘，带进度、可取消、断点续传。
 *
 * 为什么不是浏览器直接下：直链是服务端解析出来的（有些还需要 Referer / Cookie
 * 请求头），浏览器发起会丢头、也写不到用户指定的目录；另外大文件下载本来就不该
 * 挂在一个 HTTP 请求上（请求一断就前功尽弃）。
 *
 * 所以走**后台任务**：起一个 pan.py 子进程下载，把它的 stdout/stderr 解析成
 * 结构化进度供前端轮询。真正的下载细节（Range 续传、失败重试、.part 原子改名）
 * 都在 pan.py 里，已由源项目的测试覆盖，这里只负责「起进程 / 报进度 / 能取消」。
 *
 * 三个刻意的设计：
 *   1. **进度来自产物而不是猜测**：完成数以 pan.py 自己的「下载完成: 成功 A / 跳过 B
 *      / 失败 C」为准，中途的 ✓ 只用于显示当前文件名；两者不一致时以汇总为准
 *      （用户看到"3/10"却已结束很莫名其妙）。
 *   2. **取消不删 .part**：取消后已下部分是有效资产，重跑同一条命令能接着下；
 *      删掉反而让用户白等一遍。
 *   3. **不做并发上限之外的排队展示**：超过并发数就排队，前端能看到 queued 状态，
 *      但队列不持久化——重启服务后旧任务一律当历史，不做"恢复下载"的假承诺。
 */

export const KEEP_JOBS = Math.max(5, Number(process.env.DSM_PAN_KEEP_JOBS || 20))
const MAX_CONCURRENT = Math.max(1, Number(process.env.DSM_PAN_MAX_JOBS || 2))
/** 长时间没有任何输出就判定卡死：网盘挂起时子进程会一直赖着不动 */
const INACTIVITY_MS = Math.max(60000, Number(process.env.DSM_PAN_INACTIVITY_MS || 600000))
const MAX_TRACKED_FILES = 500

const isWindows = process.platform === 'win32'

/**
 * 校验保存目录。
 * 只说"必须是绝对路径"不够——`C:\` 这种盘符根目录、系统目录都要挡掉：
 * 一键下载把一堆文件散在盘根或写进 Windows 目录，是比失败更糟的结果。
 */
export function validateDownloadDir(raw) {
  const text = String(raw ?? '').trim()
  if (!text) throw badRequest('缺少保存目录')
  if (text.length > 240) throw badRequest('保存目录太长（超过 240 字符）')
  if (/[\0\r\n]/.test(text)) throw badRequest('保存目录包含非法字符')
  if (/^[/\\]{2}/.test(text) && !isWindows) throw badRequest('保存目录不合法')

  // Windows 上 "/tmp/x" 是「当前盘根目录 + tmp」这种**相对盘符**的写法：
  // path.isAbsolute 会放行，但真实落到哪个盘取决于进程当前目录——
  // 实测界面显示 \tmp\x，文件却写进了 C:\tmp\x。这种"看起来对、实际在别处"
  // 的路径必须挡掉，要求写盘符或 UNC。
  if (isWindows) {
    const hasDrive = /^[a-zA-Z]:[\\/]/.test(text)
    const isUnc = /^\\\\[^\\/]+[\\/][^\\/]+/.test(text)
    if (!hasDrive && !isUnc) {
      throw badRequest(`保存目录缺少盘符：${text}（请写成 D:\\Downloads\\pan 这样的完整路径）`)
    }
  }

  const normalized = path.normalize(text)
  if (!path.isAbsolute(normalized)) {
    throw badRequest(`保存目录必须是完整路径（如 ${isWindows ? 'D:\\Downloads\\pan' : '/data/pan'}）`)
  }

  const root = path.parse(normalized).root
  const stripTail = (value) => value.replace(/[\\/]+$/, '')
  if (stripTail(normalized).toLowerCase() === stripTail(root).toLowerCase()) {
    throw badRequest('不要直接下载到盘符根目录，请指定一个子目录（如 D:\\Downloads\\pan）')
  }
  if (isWindows && /^[a-z]:[\\/]windows([\\/]|$)/i.test(normalized)) {
    throw badRequest('不要下载到 Windows 系统目录')
  }
  return normalized
}

/**
 * 归一化「只下这些文件」的入参。
 * 收字符串或数组，去空白、去重、丢空项；上限 2000 条（再大就是滥用）。
 * 不在这一层校验路径是否存在——分享内容是 pan.py 解析后才知道的，
 * 由它在匹配不到时警告（部分失配）或按用法错误退出（全失配）。
 */
export function normalizeOnly(raw) {
  const list = Array.isArray(raw) ? raw : (raw ? [raw] : [])
  const out = []
  for (const item of list) {
    const text = String(item ?? '').trim()
    if (!text || out.includes(text)) continue
    if (out.length >= 2000) break
    out.push(text)
  }
  return out
}

/** 真的写一个探针文件再删掉：Windows 上 access(W_OK) 并不可信 */
function assertWritable(dir) {
  fs.mkdirSync(dir, { recursive: true })
  const probe = path.join(dir, `.dsm-write-test-${process.pid}`)
  try {
    fs.writeFileSync(probe, 'ok')
  } catch (error) {
    throw badRequest(`目录不可写：${dir}（${error.message}）`)
  } finally {
    try {
      fs.unlinkSync(probe)
    } catch {
      /* 删不掉不影响判断，忽略 */
    }
  }
}

/**
 * 按行切分，同时把 \r 当分隔符（pan.py 的进度就是靠 \r 原地刷新的）。
 *
 * 注意尾巴：`\r  file 1/2 50%` 这种写入，最后一段**没有结束符**，会一直留在
 * 缓冲区里等下一次刷新——那意味着进度永远慢一拍。所以额外把 pending 暴露出来，
 * 进度行（正则要求结尾是百分号）可以直接吃 pending，半截数据不会误判。
 */
function makeLineSplitter(onLine) {
  let buffer = ''
  const push = (chunk) => {
    buffer += chunk
    const parts = buffer.split(/\r\n|\n|\r/)
    buffer = parts.pop() ?? ''
    for (const line of parts) onLine(line)
  }
  push.pending = () => buffer
  return push
}

function parseProgressLine(line) {
  // "  某文件.mkv  1048576/5242880  20.0%"（行首可能有空格）
  const match = /(\d+)\/(\d+)\s+([\d.]+)%\s*$/.exec(line.trim())
  if (!match) return null
  const done = Number(match[1])
  const total = Number(match[2])
  const percent = Number(match[3])
  const name = line.trim().slice(0, Math.max(0, match.index)).trim()
  if (!Number.isFinite(done) || !Number.isFinite(total) || total <= 0) return null
  return { bytesDone: done, bytesTotal: total, percent, current: name }
}

const SUMMARY_RE = /下载完成: 成功 (\d+) \/ 跳过 (\d+) \/ 失败 (\d+)（共 (\d+)）/
const START_RE = /开始下载到 .+?（(\d+) 个文件/
const OK_RE = /^\s+✓ (.+)$/
const SKIP_RE = /^\s+= (.+?)（已存在，跳过）\s*$/
const FAIL_RE = /^\s+✗ (.+?) : (.+)$/

export function createDownloadManager({
  spawnFn = spawnChild,
  python = PAN_PYTHON,
  toolDir = PAN_TOOL_DIR,
  maxConcurrent = MAX_CONCURRENT,
  keep = KEEP_JOBS,
  inactivityMs = INACTIVITY_MS,
} = {}) {
  /** @type {Map<string, any>} */
  const jobs = new Map()
  const queue = []

  function trimHistory() {
    if (jobs.size <= keep) return
    const idle = [...jobs.values()]
      .filter((job) => !['queued', 'running'].includes(job.status))
      .sort((a, b) => a.createdAt - b.createdAt)
    while (jobs.size > keep && idle.length > 0) {
      const victim = idle.shift()
      jobs.delete(victim.id)
    }
  }

  function countActive() {
    return [...jobs.values()].filter((job) => job.status === 'running').length
  }

  function publicJob(job) {
    return {
      id: job.id,
      status: job.status,
      url: job.url,
      pan: job.pan,
      title: job.title,
      dir: job.dir,
      total: job.total,
      done: job.done,
      skipped: job.skipped,
      failed: job.failed,
      percent: Number(job.percent.toFixed(1)),
      bytesDone: job.bytesDone,
      bytesTotal: job.bytesTotal,
      current: job.current,
      /** 选择性下载时前端选中的条目数（0 = 整条分享，兼容旧任务） */
      selected: job.only.length,
      files: job.files.slice(0, MAX_TRACKED_FILES),
      filesTruncated: job.files.length > MAX_TRACKED_FILES,
      error: job.error,
      log: job.log.slice(-12),
      createdAt: job.createdAt,
      startedAt: job.startedAt,
      endedAt: job.endedAt,
    }
  }

  function finish(job, status, error = '') {
    if (job.timer) clearTimeout(job.timer)
    job.timer = null
    job.status = status
    job.endedAt = Date.now()
    if (error) job.error = error
    if (status === 'done') job.percent = 100
    job.child = null
    pump()
  }

  function pushLog(job, line) {
    const text = String(line || '').trim()
    if (!text) return
    job.log.push(text)
    if (job.log.length > 40) job.log.shift()
  }

  function handleStdoutLine(job, line) {
    const summary = SUMMARY_RE.exec(line)
    if (summary) {
      job.done = Number(summary[1])
      job.skipped = Number(summary[2])
      job.failed = Number(summary[3])
      job.total = Number(summary[4])
      job.current = ''
      pushLog(job, line)
      return
    }
    const start = START_RE.exec(line)
    if (start) {
      job.total = Number(start[1])
      pushLog(job, line)
      return
    }
    const skip = SKIP_RE.exec(line)
    if (skip) {
      job.files.push({ path: skip[1], state: 'skipped' })
      job.current = skip[1]
      // 先按逐条累加，让「下载中」也能看到进度；收尾的汇总行会覆盖成权威值
      job.skipped += 1
      return
    }
    const fail = FAIL_RE.exec(line)
    if (fail) {
      job.files.push({ path: fail[1], state: 'failed', error: fail[2] })
      job.current = fail[1]
      job.failed += 1
      pushLog(job, `✗ ${fail[1]}：${fail[2]}`)
      return
    }
    const ok = OK_RE.exec(line)
    if (ok) {
      job.files.push({ path: ok[1], state: 'ok' })
      job.current = ok[1]
      job.done += 1
      return
    }
    // 收尾的 JSON：借它补标题 / 网盘名，解析失败不算错（JSON 只是锦上添花）
    if (/^\s*[{}"]/.test(line)) {
      job.jsonBuffer.push(line)
      return
    }
    pushLog(job, line)
  }

  function touch(job) {
    job.lastActivity = Date.now()
    if (job.timer) clearTimeout(job.timer)
    job.timer = setTimeout(() => {
      if (job.status !== 'running') return
      try {
        job.child?.kill('SIGKILL')
      } catch {
        /* 已经退了就无所谓 */
      }
      finish(job, 'error', `超过 ${Math.round(inactivityMs / 60000)} 分钟没有任何输出，已停止（重跑可续传）`)
    }, inactivityMs)
    if (job.timer.unref) job.timer.unref()
  }

  function run(job) {
    job.status = 'running'
    job.startedAt = Date.now()
    job.jsonBuffer = []
    touch(job)

    const args = ['pan.py', job.url, '--out', job.dir, '--jobs', String(job.jobs),
      '--threads', String(job.threads), '--json']
    if (job.pwd) args.push('--pwd', job.pwd)
    if (job.panName) args.push('--pan', job.panName)
    if (job.guest) args.push('--guest')
    if (job.noResume) args.push('--no-resume')
    if (job.overwrite) args.push('--overwrite')
    // 只下选中的文件：路径来自前一次的解析结果（含目录名，pan.py 会展开）。
    // 上限 2000 条：一条分享勾选再多也到不了这个量级，真到了说明调用方在滥用。
    for (const p of job.only) args.push('--only', p)

    // 凭据走环境变量：不进命令行（进程列表可见）
    const env = {
      ...process.env,
      PYTHONIOENCODING: 'utf-8',
      PYTHONUTF8: '1',
    }
    if (job.cookie) env.PAN_COOKIE = job.cookie
    if (job.token) env.PAN_TOKEN = job.token
    if (job.captchaCode) env.PAN_CAPTCHA_CODE = job.captchaCode

    let child
    try {
      child = spawnFn(python, args, { cwd: toolDir, windowsHide: true, env })
    } catch (error) {
      finish(job, 'error', `无法启动 Python（${python}）：${error.message}`)
      return
    }
    job.child = child

    const onStdout = makeLineSplitter((line) => {
      touch(job)
      handleStdoutLine(job, line)
    })
    const applyProgress = (line) => {
      const progress = parseProgressLine(line)
      if (!progress) return false
      job.bytesDone = progress.bytesDone
      job.bytesTotal = progress.bytesTotal
      job.percent = progress.percent
      if (progress.current) job.current = progress.current
      return true
    }
    const onStderr = makeLineSplitter((line) => {
      touch(job)
      if (applyProgress(line)) return
      if (/^\s*✗/.test(line) || /错误|失败|提示/.test(line)) pushLog(job, line)
    })

    child.stdout?.setEncoding?.('utf8')
    child.stderr?.setEncoding?.('utf8')
    child.stdout?.on('data', (chunk) => onStdout(String(chunk)))
    child.stderr?.on('data', (chunk) => {
      onStderr(String(chunk))
      // 进度行没有结束符时不会进 onLine，这里补一次（正则自带结尾百分号，半截不会误判）
      touch(job)
      applyProgress(onStderr.pending())
    })

    child.on?.('error', (error) => {
      if (job.status !== 'running') return
      finish(job, 'error', `无法启动 Python（${python}）：${error.message}。可设置环境变量 DSM_PYTHON 指定解释器`)
    })

    child.on?.('close', (code) => {
      if (job.status === 'cancelled') {
        finish(job, 'cancelled')
        return
      }
      if (job.status !== 'running') return
      // 目录/网盘信息藏在收尾 JSON 里，能解析就补上（失败也无所谓）
      const text = job.jsonBuffer.join('\n')
      if (text) {
        try {
          const data = JSON.parse(text)
          if (data && !Array.isArray(data)) {
            if (data.title) job.title = String(data.title)
            if (data.pan) job.pan = String(data.pan)
          }
        } catch {
          /* 忽略 */
        }
      }
      job.jsonBuffer = []
      if (code === 0 || code === 2) {
        // 2 = 部分成功：任务算跑完，但失败数如实留在 failed 里
        finish(job, 'done')
        return
      }
      const tail = job.log.slice(-3).join(' / ')
      const hint = code === 1
        ? '这是「参数/前提不满足」，不是链接问题（检查保存目录、凭据文件）'
        : code === 3
          ? '一个文件都没下成功：链接多半已失效，或该网盘要求登录态'
          : `pan.py 退出码 ${code}`
      finish(job, 'error', tail ? `${hint}。输出：${tail}` : hint)
    })
  }

  function pump() {
    while (countActive() < maxConcurrent && queue.length > 0) {
      const nextId = queue.shift()
      const job = jobs.get(nextId)
      if (!job || job.status !== 'queued') continue
      run(job)
    }
  }

  return {
    start(input = {}) {
      const url = String(input.url || '').trim()
      if (!url) throw badRequest('缺少分享链接')
      const dir = validateDownloadDir(input.dir)
      assertWritable(dir)

      const job = {
        id: crypto.randomUUID(),
        status: 'queued',
        url,
        panName: String(input.pan || ''),
        pan: String(input.pan || ''),
        title: '',
        pwd: String(input.pwd || ''),
        guest: Boolean(input.guest),
        cookie: input.cookie ? String(input.cookie) : '',
        token: input.token ? String(input.token) : '',
        captchaCode: input.captchaCode ? String(input.captchaCode) : '',
        jobs: Math.min(8, Math.max(1, Number(input.jobs) || 3)),
        threads: Math.min(16, Math.max(1, Number(input.threads) || 1)),
        noResume: Boolean(input.noResume),
        overwrite: Boolean(input.overwrite),
        // 选择性下载：前端传解析结果里的 path（文件或目录）。空 = 整条分享。
        only: normalizeOnly(input.only),
        dir,
        total: 0,
        done: 0,
        skipped: 0,
        failed: 0,
        percent: 0,
        bytesDone: 0,
        bytesTotal: 0,
        current: '',
        files: [],
        log: [],
        error: '',
        createdAt: Date.now(),
        startedAt: 0,
        endedAt: 0,
        lastActivity: 0,
        timer: null,
        child: null,
        jsonBuffer: [],
      }
      jobs.set(job.id, job)
      trimHistory()
      queue.push(job.id)
      pump()
      return publicJob(job)
    },

    get(id) {
      const job = jobs.get(String(id))
      if (!job) throw notFound('下载任务不存在（服务重启后任务历史会清空）')
      return publicJob(job)
    },

    list(limit = 10) {
      const size = Math.min(50, Math.max(1, Number(limit) || 10))
      return [...jobs.values()]
        .sort((a, b) => b.createdAt - a.createdAt)
        .slice(0, size)
        .map(publicJob)
    },

    cancel(id) {
      const job = jobs.get(String(id))
      if (!job) throw notFound('下载任务不存在')
      if (!['queued', 'running'].includes(job.status)) {
        return publicJob(job)
      }
      if (job.status === 'queued') {
        job.status = 'cancelled'
        job.endedAt = Date.now()
        job.error = '排队中被取消'
        const at = queue.indexOf(job.id)
        if (at >= 0) queue.splice(at, 1)
        return publicJob(job)
      }
      job.status = 'cancelled'
      try {
        job.child?.kill('SIGKILL')
      } catch {
        /* 已经退出 */
      }
      finish(job, 'cancelled')
      return publicJob(job)
    },

    /** 供测试与状态页使用：当前并发与队列长度 */
    stats() {
      return { active: countActive(), queued: queue.length, total: jobs.size, maxConcurrent }
    },

    /** 进程退出时收拾正在跑的任务，避免留下孤儿 python */
    shutdown() {
      for (const job of jobs.values()) {
        if (job.status !== 'running') continue
        try {
          job.child?.kill('SIGKILL')
        } catch {
          /* 忽略 */
        }
        if (job.timer) clearTimeout(job.timer)
      }
    },
  }
}

export const downloadManager = createDownloadManager()

/** 默认保存目录：用户下载文件夹下的 pan 子目录 */
export function defaultDownloadDir() {
  try {
    const downloads = path.join(os.homedir(), 'Downloads')
    return path.join(fs.existsSync(downloads) ? downloads : os.homedir(), 'pan')
  } catch {
    return ''
  }
}

/** 打开目录前的最小校验：复用 processManager 的实现，这里只挡明显不属于下载目录的入参 */
export function assertOpenableDir(raw) {
  const dir = String(raw ?? '').trim()
  if (!dir) throw new HttpError(400, '缺少目录')
  if (!fs.existsSync(dir)) throw new HttpError(400, `目录不存在：${dir}`)
  return dir
}
