import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { PROJECT_ROOT } from '../config.js'
import { HttpError, badRequest } from '../utils/http.js'

/**
 * 多网盘分享直链解析 —— 本地 Python 工具（tools/panlink）的 Node 侧封装。
 *
 * 为什么单独起一个进程而不是用 Node 重写：
 *   tools/panlink 是零依赖的纯标准库实现，10 家网盘的签名/风控逻辑已经调通
 *   （含移动云盘 mcloud-sign、百度 sign 签名、迅雷验证码流程），用 Node 重来一遍不划算。
 *
 * 两个 Windows 专属坑（都实测过）：
 *   1. Python 默认按控制台代码页（GBK）写 stdout，中文 JSON 会被写成 GBK，
 *      Node 按 utf8 解就是乱码或直接抛错 —— 必须强制 PYTHONIOENCODING=utf-8。
 *   2. Cookie / Bearer 不能走命令行参数：cmdline 会出现在进程列表里（wmic 可见），
 *      工作台是常驻服务，改用环境变量传给子进程。
 */

export const PAN_TOOL_DIR = process.env.DSM_PAN_DIR
  ? path.resolve(process.env.DSM_PAN_DIR)
  : path.join(PROJECT_ROOT, 'tools', 'panlink')

export const PAN_PYTHON = process.env.DSM_PYTHON || 'python'

/** 单次解析默认超时：列大目录 + 逐文件取链可能很久 */
const DEFAULT_TIMEOUT_MS = 120000
const LIST_TIMEOUT_MS = 20000

/**
 * 迅雷验证码图片的落盘目录。
 * 为什么不让 pan.py 用临时文件：GUI 拿不到那个随机路径（错误信息里虽然有，
 * 但解析文本取路径太脆）。改成调用方指定位置，失败时直接把图片读回来
 *  base64 内嵌给前端，不必再开一个静态路由、也不必做目录穿越防护。
 */
const CAPTCHA_DIR = path.join(os.tmpdir(), 'dsm-pan-captcha')
const CAPTCHA_TTL_MS = 60 * 60 * 1000

function freshCaptchaPath() {
  fs.mkdirSync(CAPTCHA_DIR, { recursive: true })
  // 顺手清掉一小时前的残留：验证码图片是一次性的，留着只会堆积
  const cutoff = Date.now() - CAPTCHA_TTL_MS
  for (const name of fs.readdirSync(CAPTCHA_DIR)) {
    const full = path.join(CAPTCHA_DIR, name)
    try {
      if (fs.statSync(full).mtimeMs < cutoff) fs.unlinkSync(full)
    } catch {
      /* 删不掉就算了，不影响主流程 */
    }
  }
  return path.join(CAPTCHA_DIR, `captcha-${process.pid}-${Date.now()}.png`)
}

/** 把验证码图片读成 data URI；读不到返回空串（调用方退回普通错误） */
function readCaptchaImage(pngPath) {
  try {
    const data = fs.readFileSync(pngPath)
    if (data.length === 0 || data.length > 2 * 1024 * 1024) return ''
    return `data:image/png;base64,${data.toString('base64')}`
  } catch {
    return ''
  }
}

function runPan(args, { timeout = DEFAULT_TIMEOUT_MS, env = {} } = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(PAN_PYTHON, args, {
      cwd: PAN_TOOL_DIR,
      windowsHide: true,
      env: {
        ...process.env,
        PYTHONIOENCODING: 'utf-8',
        PYTHONUTF8: '1',
        ...env,
      },
    })

    let stdout = ''
    let stderr = ''
    let settled = false

    const timer = setTimeout(() => {
      settled = true
      child.kill('SIGKILL')
      reject(new HttpError(504, `解析超时（超过 ${Math.round(timeout / 1000)} 秒）。分享内文件较多时可稍后重试。`))
    }, timeout)

    child.stdout.setEncoding('utf8')
    child.stderr.setEncoding('utf8')
    child.stdout.on('data', (chunk) => { stdout += chunk })
    child.stderr.on('data', (chunk) => { stderr += chunk })

    child.on('error', (err) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      reject(new HttpError(
        500,
        `无法启动 Python（${PAN_PYTHON}）：${err.message}。可设置环境变量 DSM_PYTHON 指定解释器路径。`,
      ))
    })

    child.on('close', (code) => {
      clearTimeout(timer)
      if (settled) return
      settled = true
      resolve({ code, stdout, stderr })
    })
  })
}

/**
 * 从 stdout 里截出 JSON。
 * pan.py 在输出 JSON 前会先打印一行「[识别网盘] xxx」，所以不能直接 JSON.parse 整个 stdout。
 */
function extractJson(text) {
  const start = text.indexOf('{')
  if (start < 0) return null
  try {
    return JSON.parse(text.slice(start))
  } catch {
    return null
  }
}

function failFromOutput(stdout, stderr, fallback) {
  const raw = (stderr || '').trim() || (stdout || '').trim()
  const message = raw.replace(/^错误:\s*/, '').split('\n').filter(Boolean).slice(-2).join(' / ') || fallback
  const error = new HttpError(400, message)
  error.extra = { detail: raw.slice(0, 2000) }
  return error
}

/** 支持的网盘列表（含是否需要登录、凭据提示） */
export async function listPans() {
  const { code, stdout, stderr } = await runPan(['pan.py', '--list-pans', '--json'], { timeout: LIST_TIMEOUT_MS })
  if (code !== 0) throw failFromOutput(stdout, stderr, '网盘工具执行失败')
  const data = extractJson(stdout)
  if (!data?.pans) throw new HttpError(500, '网盘工具返回了无法解析的内容')
  return data.pans
}

/**
 * 解析分享链接。
 * @returns {{pan: string, title: string, files: Array<{path:string,is_dir:boolean,size:number,url:string}>}}
 */
export async function resolveShare({ url, pan, pwd, cookie, token, captchaCode, guest = false } = {}) {
  const shareUrl = String(url || '').trim()
  if (!shareUrl) throw badRequest('缺少分享链接')

  const args = ['pan.py']
  if (pan) args.push('--pan', String(pan))
  if (pwd) args.push('--pwd', String(pwd))
  if (guest) args.push('--guest')
  args.push('--json')
  args.push(shareUrl) // 放最后，避免链接被当成选项

  // 迅雷可能触发图形验证码：给子进程一个确定的图片落盘位置。
  // 失败时 pan.py 会在 stderr 打 CAPTCHA_REQUIRED<TAB>路径，这里把图片
  // 读回来内嵌给前端（用户填文字 → 带 captchaCode 重试）。
  let captchaPath = ''
  try {
    captchaPath = freshCaptchaPath()
    args.push('--captcha-png', captchaPath)
  } catch {
    captchaPath = '' // 临时目录不可写也不该让解析本身失败
  }

  // 敏感值走环境变量，不进 cmdline
  const env = {}
  if (cookie) env.PAN_COOKIE = String(cookie)
  if (token) env.PAN_TOKEN = String(token)
  if (captchaCode) env.PAN_CAPTCHA_CODE = String(captchaCode)

  const { code, stdout, stderr } = await runPan(args, { env })
  if (code !== 0) {
    // 验证码是「可继续」的失败：图片已经在 captchaPath（或 pan.py 退回的
    // 临时文件，以标记里的路径为准），交给前端展示，别当普通错误扔掉。
    if (captchaPath && /CAPTCHA_REQUIRED/.test(stderr)) {
      const marked = /CAPTCHA_REQUIRED\t(.+)/.exec(stderr)
      const image = readCaptchaImage((marked?.[1] || captchaPath).trim())
      if (image) {
        throw new HttpError(400, '需要输入图形验证码', {
          needsCaptcha: true,
          captchaImage: image,
        })
      }
    }
    throw failFromOutput(stdout, stderr, '解析失败')
  }

  const data = extractJson(stdout)
  if (!data) throw new HttpError(500, `网盘工具返回了非 JSON 内容：${stdout.slice(0, 300)}`)

  return {
    pan: data.pan || '',
    title: data.title || '',
    files: Array.isArray(data.files) ? data.files : [],
  }
}
