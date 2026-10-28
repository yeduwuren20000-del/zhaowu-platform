/**
 * 本地影院（mediaService）测试：托管生命周期 + 认领 + 端口避让 + 日志 + 契约。
 *   node server/test/media.test.mjs
 *
 * 设计要点（避免 ESM 模块缓存导致的 env 串味）：
 *   - 所有环境变量（DATA_DIR / MEDIA_DIR / MEDIA_PORT / MEDIA_LIBRARY）在文件顶部
 *     统一设一份，且在首次 import mediaService 之前就定好 —— mediaService 与 config
 *     都在 import 时读取这些 env，必须保证只加载一次且值稳定。
 *   - unitTests 与 e2eTests 共用同一个临时 MEDIA_DIR（里面放一个 fake server.py），
 *     contractTests 才去看真实的 tools/mediaserver。
 *
 * 全部本地闭环，不联网：
 *   - 单测：假 LocalCinema HTTP 服务（带 Server: LocalCinema/2.0 响应头）验认领与能力探测；
 *   - e2e：共享临时目录里的 fake server.py（真 Python 起真 HTTP），验 start/stop/端口避让/认领；
 *   - 契约：tools/mediaserver 的文件形状与环境变量覆盖仍在（有 Python 才跑编译检查）。
 */
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import { spawn, spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, '..', '..')
const MEDIA_TOOL_DIR = path.join(ROOT, 'tools', 'mediaserver')

// --------------------------------------------------------- 共享临时环境（import 前定好）
const SHARED_TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsm-media-'))
const SHARED_DATA = path.join(SHARED_TMP, 'data')
const SHARED_MEDIA = path.join(SHARED_TMP, 'mediaserver')
const SHARED_LIB = path.join(SHARED_TMP, 'my-library')

process.env.DSM_DATA_DIR = SHARED_DATA
process.env.DSM_MEDIA_DIR = SHARED_MEDIA
process.env.DSM_MEDIA_PORT = '17771'
process.env.DSM_MEDIA_LIBRARY = SHARED_LIB

fs.mkdirSync(SHARED_MEDIA, { recursive: true })
fs.mkdirSync(SHARED_LIB, { recursive: true })

const FAKE_SERVER_PY = `
import json, os, sys
from http.server import ThreadingHTTPServer, BaseHTTPRequestHandler

PORT = int(os.environ.get("PORT", "8888"))

class H(BaseHTTPRequestHandler):
    server_version = "LocalCinema/2.0"
    protocol_version = "HTTP/1.1"
    def log_message(self, *a):
        pass
    def _send(self, code, obj):
        body = json.dumps(obj).encode("utf-8")
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)
    def do_GET(self):
        if self.path.startswith("/api/list"):
            return self._send(200, {"items": [{"rel": "x.mp4"}], "upscaler": True, "ffmpeg": True})
        if self.path.startswith("/api/dl"):
            return self._send(200, {"ok": True, "version": "fake-ytdlp"})
        return self._send(404, {"error": "not found"})

ThreadingHTTPServer(("127.0.0.1", PORT), H).serve_forever()
`
fs.writeFileSync(path.join(SHARED_MEDIA, 'server.py'), FAKE_SERVER_PY, 'utf8')

const PYTHON = process.env.DSM_PYTHON || 'python'
const HAS_PYTHON = !spawnSync(PYTHON, ['--version'], { encoding: 'utf8' }).error

let passed = 0
const failures = []
function check(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failures.push({ name, detail })
    console.log(`  ✗ ${name}${detail ? ` —— ${detail}` : ''}`)
  }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** 等端口就绪（不依赖内部 portScanner，独立可测） */
function waitPortOpen(port, timeoutMs = 8000) {
  const start = Date.now()
  return new Promise((resolve) => {
    const tryOnce = () => {
      const sock = net.connect(port, '127.0.0.1')
      sock.once('connect', () => { sock.destroy(); resolve(true) })
      sock.once('error', () => {
        sock.destroy()
        if (Date.now() - start > timeoutMs) resolve(false)
        else setTimeout(tryOnce, 200)
      })
    }
    tryOnce()
  })
}

/** 假 LocalCinema 服务（Node http）：带 Server: LocalCinema/2.0 响应头，可配签名 */
function startFakeMedia({ port = 0, upscaler = true, ffmpeg = false, ytdlp = false, signature = 'LocalCinema/2.0', version = '2026.01.01' } = {}) {
  const server = http.createServer((req, res) => {
    // Connection: close 很关键：node 默认 keep-alive 下，探针的第二次请求会复用旧 socket
    // 导致 /api/list 被误路由成 404（真实 Python 影院用 ThreadingHTTPServer 不受影响）。
    res.setHeader('Connection', 'close')
    if (signature) res.setHeader('Server', signature)
    if (req.url.startsWith('/api/list')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ items: [{ rel: 'a.mp4' }, { rel: 'b.mp4' }], upscaler, ffmpeg }))
      return
    }
    if (req.url.startsWith('/api/dl')) {
      res.writeHead(200, { 'Content-Type': 'application/json' })
      res.end(JSON.stringify({ ok: ytdlp, version }))
      return
    }
    res.writeHead(404)
    res.end('{}')
  })
  return new Promise((resolve, reject) => {
    server.on('error', reject)
    server.listen(port, '127.0.0.1', () => resolve({
      port: server.address().port,
      close: () => new Promise((done) => server.close(done)),
    }))
  })
}

// ---------------------------------------------------------------- 单测：认领 / 能力 / 状态
async function unitTests() {
  console.log('\n[单元] 常量、认领、能力探测、状态机、日志')
  const media = await import('../src/services/mediaService.js')

  // 目录常量：默认值与覆盖
  check('MEDIA_DIR 跟随 DSM_MEDIA_DIR', media.MEDIA_DIR === SHARED_MEDIA)
  check('片库目录跟随 DSM_MEDIA_LIBRARY', media.mediaLibraryDir() === SHARED_LIB)
  check('默认端口可被 DSM_MEDIA_PORT 覆盖', media.MEDIA_DEFAULT_PORT === 17771)

  // 什么都没起：不运行
  const idle = await media.status()
  check('空闲时 running=false', idle.running === false)
  check('空闲时 port 取默认端口', idle.port === 17771)
  check('空闲时无 url', idle.url === null)

  // 假影院在跑（带签名响应头）+ 状态文件记着一个死 PID → 认领
  const fake = await startFakeMedia({ upscaler: true, ffmpeg: true, ytdlp: true, version: '2026.10.27' })
  const stateFile = path.join(SHARED_DATA, 'media.json')
  fs.mkdirSync(SHARED_DATA, { recursive: true })
  fs.writeFileSync(stateFile, JSON.stringify({ pid: 999999, port: fake.port, startedAt: new Date().toISOString() }))

  const adopted = await media.status()
  check('端口上有 LocalCinema 时认领为运行中', adopted.running === true)
  check('认领实例标记 adopted=true', adopted.adopted === true)
  check('认领时 url 指向实际端口', adopted.url === `http://127.0.0.1:${fake.port}`)
  check('能力标志来自影院自己的 /api/list（upscaler）', adopted.capabilities?.upscaler === true)
  check('能力标志来自影院自己的 /api/list（ffmpeg）', adopted.capabilities?.ffmpeg === true)
  check('能力标志来自影院自己的 /api/dl（ytdlp）', adopted.capabilities?.ytdlp === true)
  check('yt-dlp 版本号透传', adopted.capabilities?.ytdlpVersion === '2026.10.27')
  check('视频计数来自 items 长度', adopted.capabilities?.videoCount === 2)

  // 签名不对（别的服务占了端口）→ 不认领，并清掉记着死 PID 的残留状态
  const fakeOther = await startFakeMedia({ signature: 'nginx/1.25' })
  fs.writeFileSync(stateFile, JSON.stringify({ pid: 999999, port: fakeOther.port, startedAt: new Date().toISOString() }))
  const probeOther = await media.status()
  check('签名不匹配（别的服务）不认领', probeOther.running === false)
  check('不认领且进程已死时清理残留状态文件', !fs.existsSync(stateFile))
  await fake.close()
  await fakeOther.close()

  // 日志尾部
  const logFile = path.join(SHARED_DATA, 'logs', 'mediaserver.log')
  fs.mkdirSync(path.dirname(logFile), { recursive: true })
  fs.writeFileSync(logFile, Array.from({ length: 200 }, (_, i) => `line-${i}`).join('\n'))
  const tail = media.logTail(10)
  check('logTail 只取尾部 N 行', tail.split('\n').length === 10 && tail.includes('line-199'))
}

// ---------------------------------------------------------------- e2e：真 Python 生命周期
async function e2eTests() {
  console.log('\n[e2e] 真 Python 生命周期（fake server.py）')
  if (!HAS_PYTHON) {
    console.log('  - 跳过：本机没有可用的 python')
    return
  }

  const media = await import('../src/services/mediaService.js')

  // 1. 启动 → 运行 → 能力就位
  const started = await media.start()
  check('start() 返回运行中', started.running === true)
  check('start() 用默认端口', started.port === 17771)
  check('start()  url 形如 http://127.0.0.1:PORT', started.url === 'http://127.0.0.1:17771')
  check('start() 记录 PID', Number.isInteger(started.pid) && started.pid > 0)
  check('能力探测：upscaler', started.capabilities?.upscaler === true)
  check('能力探测：ytdlp', started.capabilities?.ytdlp === true)

  // 2. 重复启动 → 幂等（不再起第二份）
  const again = await media.start()
  check('重复启动幂等（不换端口）', again.port === 17771 && again.running === true)

  // 3. status 复读运行态
  const s = await media.status()
  check('status() 读到运行态', s.running === true && s.port === 17771)

  // 4. 端口避让：占住默认端口（无 LocalCinema 签名）→ start() 顺延
  await media.stop()
  await sleep(300)
  const blocker = await startFakeMedia({ port: 17771, signature: null })
  const shifted = await media.start()
  check('默认端口被占时顺延换端口', shifted.running === true && shifted.port !== 17771)
  check('换端口时消息说明避让', /改用/.test(shifted.message || ''))
  check('换端口后 url 同步更新', shifted.url === `http://127.0.0.1:${shifted.port}`)
  await media.stop()
  await blocker.close()
  await sleep(300)

  // 5. 认领外部实例：在默认端口手工起一个真 python 影院，start() 应认领而不是再起一份
  const extProc = spawn(PYTHON, ['server.py'], {
    cwd: SHARED_MEDIA,
    env: { ...process.env, PORT: '17771' },
    stdio: 'ignore',
    detached: true,
  })
  extProc.unref()
  const extReady = await waitPortOpen(17771)
  check('外部 python 影院已在默认端口监听', extReady === true)
  const adopted = await media.start()
  check('认领已在运行的外部实例（adopted）', adopted.adopted === true && adopted.port === 17771)
  check('认领也做能力探测', adopted.capabilities?.upscaler === true)
  const stoppedExternal = await media.stop()
  check('认领后的 stop 释放默认端口', stoppedExternal.portReleased === true)
  await sleep(300)
  const afterStop = await media.status()
  check('stop 后 status 回到未运行', afterStop.running === false)

  // 6. 启动日志落盘（服务自己写的文件）
  const logFile = path.join(SHARED_DATA, 'logs', 'mediaserver.log')
  check('启动日志写入 data/logs/mediaserver.log', fs.existsSync(logFile) && /启动/.test(fs.readFileSync(logFile, 'utf8')))
}

// ---------------------------------------------------------------- 契约：tools/mediaserver
async function contractTests() {
  console.log('\n[契约] tools/mediaserver 文件形状')
  for (const name of ['server.py', 'agg.py', 'dl.py', 'index.html', 'sources.json', 'start.bat']) {
    check(`存在 ${name}`, fs.existsSync(path.join(MEDIA_TOOL_DIR, name)))
  }
  check('存在 static/hls.min.js（离线 HLS 播放）', fs.existsSync(path.join(MEDIA_TOOL_DIR, 'static', 'hls.min.js')))
  check('存在 library/ 片库目录', fs.existsSync(path.join(MEDIA_TOOL_DIR, 'library')))
  check('存在 ../upscaler 超分工具', fs.existsSync(path.join(ROOT, 'tools', 'upscaler', 'upscale.py')))

  let sources = null
  try {
    sources = JSON.parse(fs.readFileSync(path.join(MEDIA_TOOL_DIR, 'sources.json'), 'utf8'))
  } catch { /* 留在下面判 */ }
  check('sources.json 是合法 JSON 且带 sources 数组', Boolean(sources) && Array.isArray(sources.sources))

  const server = fs.readFileSync(path.join(MEDIA_TOOL_DIR, 'server.py'), 'utf8')
  const dl = fs.readFileSync(path.join(MEDIA_TOOL_DIR, 'dl.py'), 'utf8')
  check('server.py 支持 PORT 环境变量', /os\.environ\.get\("PORT"/.test(server))
  check('server.py 支持 MEDIA_LIBRARY_DIR 覆盖', /MEDIA_LIBRARY_DIR/.test(server))
  check('server.py 支持 MEDIA_UPSCALER_DIR 覆盖', /MEDIA_UPSCALER_DIR/.test(server))
  check('dl.py 支持 MEDIA_UPSCALER_DIR 覆盖', /MEDIA_UPSCALER_DIR/.test(dl))
  check('server.py 只绑 127.0.0.1（不对外）', /HOST = "127\.0\.0\.1"/.test(server))
  check('响应头带 LocalCinema 签名（认领依据）', /server_version = "LocalCinema/.test(server))

  if (HAS_PYTHON) {
    for (const name of ['server.py', 'agg.py', 'dl.py']) {
      const r = spawnSync(PYTHON, ['-m', 'py_compile', path.join(MEDIA_TOOL_DIR, name)], { encoding: 'utf8' })
      check(`${name} 编译通过`, r.status === 0, r.stderr?.slice(0, 200))
    }
    fs.rmSync(path.join(MEDIA_TOOL_DIR, '__pycache__'), { recursive: true, force: true })
  }
}

// ---------------------------------------------------------------- 汇总
async function main() {
  await unitTests()
  await e2eTests()
  await contractTests()

  // 清理共享临时目录（含 fake server.py 与状态/日志）
  fs.rmSync(SHARED_TMP, { recursive: true, force: true })

  console.log(`\n结果：通过 ${passed} 项，失败 ${failures.length} 项`)
  if (failures.length > 0) {
    for (const f of failures) console.log(`  ✗ ${f.name}${f.detail ? ` —— ${f.detail}` : ''}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('测试执行异常：', error)
  process.exitCode = 1
})
