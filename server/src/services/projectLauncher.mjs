/**
 * 项目启动器（由 processManager 以 detached 方式拉起，独立运行）：
 *   node projectLauncher.mjs <启动命令> <项目目录> <日志文件>
 *
 * 为什么需要它：
 *   Windows 上 `shell: true` + `detached: true` 直接 spawn 时，子进程的标准输出
 *   不会写进继承的文件句柄（实测如此），日志会丢；而不 detached 又会让项目跟着
 *   工作台的控制台一起收到 Ctrl+C。
 *   折中方案：启动器自己 detached（独立进程组，工作台退出/ Ctrl+C 都不影响它），
 *   它再用 shell + 非 detached 去跑真实命令，并把子进程输出**转码后**写进日志。
 *
 * 转码（重要）：Windows 中文系统上 cmd / .cmd / 部分工具的输出是 GBK 字节流，
 *   而日志读取端一律按 UTF-8 解析——不透码的话，日志里所有中文都是乱码，
 *   「'vite' 不是内部或外部命令」这类关键线索会变成不可读的替换字符，
 *   启动失败诊断也就匹配不到。这里按行判定：UTF-8 严格解码成功就原样保留
 *   （Node 程序和本启动器自己写的都是 UTF-8），失败再按 GBK 解，最后 latin1 兜底。
 *
 * 只做一件事：执行用户配置的启动命令并转发输出；不读项目任何文件、不加载项目代码。
 *
 * 第四个可选参数：JSON 编码的额外环境变量（端口自动避让用）。比如 Dify 的
 * compose 端口由 EXPOSE_NGINX_PORT 控制，主端口 80 被占时就传
 * {"EXPOSE_NGINX_PORT":"8080"}，项目无需改任何配置即可换端口启动。
 */
import fs from 'node:fs'
import { spawn } from 'node:child_process'

const [command, cwd, logFile, envJson] = process.argv.slice(2)
const timestamp = () => new Date().toISOString()

function write(fd, text) {
  try {
    fs.writeSync(fd, text)
  } catch {
    /* 日志写不进去也不该影响项目运行 */
  }
}

/** 按字节块解码成 UTF-8 文本：先严格 UTF-8，失败按 GBK，再不行 latin1 保底 */
const utf8Strict = new TextDecoder('utf-8', { fatal: true })
let gbkDecoder = null
try {
  gbkDecoder = new TextDecoder('gbk')
} catch {
  /* Node 构建没带完整 ICU 时没有 gbk：退化成原来的行为（UTF-8 非严格） */
}
function decodeChunk(buf) {
  try {
    return utf8Strict.decode(buf)
  } catch {
    /* 含非 UTF-8 字节，继续 */
  }
  if (gbkDecoder) {
    try {
      return gbkDecoder.decode(buf)
    } catch {
      /* 继续兜底 */
    }
  }
  return buf.toString('latin1')
}

if (!command || !cwd || !logFile) {
  console.error('[launcher] 参数不足：node projectLauncher.mjs <启动命令> <项目目录> <日志文件>')
  process.exit(2)
}

let fd
try {
  fd = fs.openSync(logFile, 'a')
} catch (error) {
  console.error(`[launcher] 打不开日志文件 ${logFile}：${error.message}`)
  process.exit(2)
}

write(fd, `[launcher ${timestamp()}] 启动命令：${command}\n[launcher ${timestamp()}] 工作目录：${cwd}\n`)

let extraEnv = null
if (envJson) {
  try {
    extraEnv = JSON.parse(envJson)
    if (!extraEnv || typeof extraEnv !== 'object' || Array.isArray(extraEnv)) extraEnv = null
  } catch {
    // 环境变量传错不影响启动：按没有额外变量跑，日志里留一行线索
    extraEnv = null
  }
}

// 子进程输出走管道（不再直接继承 fd）：按行缓冲 → 转码 → 写日志。
// 直接继承 fd 会把 GBK 原样落盘，读取端按 UTF-8 解出乱码，诊断就失了线索。
const child = spawn(command, {
  cwd,
  shell: true,
  detached: false,
  windowsHide: true,
  stdio: ['ignore', 'pipe', 'pipe'],
  env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
})

const buffers = { out: Buffer.alloc(0), err: Buffer.alloc(0) }
const ended = { out: false, err: false }

function pump(which, chunk) {
  buffers[which] = Buffer.concat([buffers[which], chunk])
  // 只切完整行：多字节字符可能正好被 chunk 边界劈开，半行先攒着
  for (;;) {
    const idx = buffers[which].indexOf(0x0a)
    if (idx < 0) return
    const line = buffers[which].subarray(0, idx + 1)
    buffers[which] = buffers[which].subarray(idx + 1)
    write(fd, decodeChunk(line))
  }
}
function flush(which) {
  if (buffers[which].length > 0) {
    write(fd, decodeChunk(buffers[which]))
    buffers[which] = Buffer.alloc(0)
  }
}
child.stdout.on('data', (chunk) => pump('out', chunk))
child.stderr.on('data', (chunk) => pump('err', chunk))
child.stdout.on('end', () => {
  ended.out = true
  flush('out')
})
child.stderr.on('end', () => {
  ended.err = true
  flush('err')
})

write(fd, `[launcher ${timestamp()}] 子进程 PID=${child.pid}\n`)

child.on('error', (error) => {
  write(fd, `[launcher ${timestamp()}] 启动失败：${error.message}\n`)
  try {
    fs.closeSync(fd)
  } catch {
    /* 忽略 */
  }
  process.exit(1)
})

child.on('exit', (code, signal) => {
  // 管道里的尾巴可能比 exit 事件晚到：给两条流一个短的收敛窗口再收尾
  const deadline = Date.now() + 500
  const finish = () => {
    write(fd, `[launcher ${timestamp()}] 进程退出：code=${code ?? 'null'} signal=${signal ?? 'null'}\n`)
    try {
      fs.closeSync(fd)
    } catch {
      /* 忽略 */
    }
    process.exit(code ?? 0)
  }
  const tick = () => {
    if ((ended.out && ended.err) || Date.now() >= deadline) finish()
    else setTimeout(tick, 50)
  }
  setTimeout(tick, 50)
})

// 启动器收到终止信号时，把子进程一起带走（工作台 stop 走的是 taskkill /T，这里是兜底）
for (const signal of ['SIGTERM', 'SIGINT', 'SIGBREAK']) {
  process.on(signal, () => {
    try {
      child.kill()
    } catch {
      /* 忽略 */
    }
  })
}
