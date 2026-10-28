import path from 'node:path'
import express from 'express'
import cors from 'cors'
import { DATA_DIR, HOST, LOG_DIR, PORT, WEB_DIST_DIR } from './config.js'
import { ensureDir, pathExistsSync } from './utils/fsx.js'
import { errorHandler } from './utils/http.js'
import apiRouter from './routes/index.js'
import { logRepo } from './store/logRepo.js'
import { runtimeRepo } from './store/runtimeRepo.js'
import { processInfo } from './services/processInfo.js'
import { portScanner } from './services/portScanner.js'
import { downloadManager } from './services/panDownloadService.js'

const app = express()

// localhost 永远不该走 HTTP 代理：本机若设了 HTTP_PROXY，undici 的 EnvHttpProxyAgent
// 会把 localhost 也误导向代理而失败（文档转换要把请求发到本机容器）。这里补一道保险。
for (const key of ['NO_PROXY', 'no_proxy']) {
  const cur = process.env[key] || ''
  if (!/(^|[, ])(localhost|127\.0\.0\.1|\[::1\])([, ]|$)/.test(cur)) {
    process.env[key] = [cur, 'localhost', '127.0.0.1'].filter(Boolean).join(',')
  }
}

app.disable('x-powered-by')
app.use(cors())
// 默认 1mb 足够日常 JSON；文档转换接口用 base64 传文件，需要更大的上限。
// 本地工具，放宽到 50mb 不会带来风险。
app.use(express.json({ limit: '50mb' }))

app.use('/api', apiRouter)

// 生产模式：直接托管前端构建产物，单端口访问
const distExists = pathExistsSync(WEB_DIST_DIR)
if (distExists) {
  app.use(express.static(WEB_DIST_DIR, { index: 'index.html' }))
}

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next()
  if (!distExists) {
    return res
      .status(200)
      .type('html')
      .send(
        `<!doctype html><meta charset="utf-8"><title>DevServerManager</title>
         <body style="background:#0b1220;color:#e6edf7;font:16px/1.7 system-ui;padding:48px">
         <h2>后端已启动，前端尚未构建</h2>
         <p>请在项目根目录执行 <code style="color:#7dd3fc">npm run build</code>，或直接运行 <code style="color:#7dd3fc">start.bat</code>（会自动构建）。</p>
         <p>API 可用：<a style="color:#7dd3fc" href="/api/health">/api/health</a></p></body>`,
      )
  }
  return res.sendFile(path.join(WEB_DIST_DIR, 'index.html'))
})

app.use(errorHandler)

async function bootstrap() {
  await ensureDir(DATA_DIR)
  await ensureDir(LOG_DIR)

  // 与真实进程对账：上次退出时残留的 PID 记录立即清理。
  // 判定必须是「PID 活 或 端口在听」——Docker 托管型项目（docker compose up -d /
  // docker start）的启动器发射完容器就退出，PID 已死但容器还在服务，只按 PID 清
  // 会把 Dify / Stirling 的运行态误删（状态假变「已停止」，实际端口也丢了，
  // 停止时找不到人）。
  const runtimeEntries = await runtimeRepo.all()
  const aliveIds = new Set()
  for (const [projectId, entry] of Object.entries(runtimeEntries)) {
    if (entry?.pid && processInfo.isPidAlive(entry.pid)) {
      aliveIds.add(projectId)
      continue
    }
    if (entry?.port && (await portScanner.isPortListening(entry.port, { force: true }))) {
      aliveIds.add(projectId)
    }
  }
  const dropped = await runtimeRepo.reconcile((entry, projectId) => aliveIds.has(projectId))
  if (dropped.length > 0) {
    console.log(`[startup] 清理失效运行态 ${dropped.length} 条`)
  }

  app.listen(PORT, HOST, async () => {
    console.log(`\n  开发与服务器管理工作台`)
    console.log(`  API   : http://${HOST}:${PORT}/api`)
    console.log(`  Web   : ${distExists ? `http://${HOST}:${PORT}` : '未构建（开发模式请访问 Vite 5180）'}`)
    console.log(`  数据  : ${DATA_DIR}\n`)
    await logRepo.append({
      level: 'info',
      source: 'workbench',
      message: `工作台后端已启动（http://${HOST}:${PORT}，PID ${process.pid}）`,
    })

    // 启动时做一次本地服务发现（低频：只在这一刻跑一次，用户也可以手动再扫）
    if (process.env.DSM_DISCOVERY_ON_STARTUP !== '0') {
      setTimeout(() => {
        import('./services/localDiscoveryService.js')
          .then(({ scanLocalServices }) => scanLocalServices({ includeAi: false }))
          .then((result) => {
            console.log(
              `[discovery] 启动扫描完成：${result.summary.recommended} 个待登记、` +
                `${result.summary.registered} 个已登记、${result.summary.filtered} 个已过滤（${result.durationMs}ms）`,
            )
          })
          .catch((error) => console.warn(`[discovery] 启动扫描失败：${error.message}`))
      }, 2500).unref?.()
    }

    // 恢复 SSH 自动刷新（默认关闭，只有用户在服务器页开过才会真的跑）
    if (process.env.DSM_AUTO_MONITOR_ON_STARTUP !== '0') {
      import('./services/autoMonitor.js')
        .then(({ restoreAutoMonitor }) => restoreAutoMonitor())
        .then((state) => {
          if (state.running) console.log(`[auto-monitor] 已恢复 SSH 自动刷新，间隔 ${Math.round(state.intervalMs / 1000)} 秒`)
        })
        .catch((error) => console.warn(`[auto-monitor] 恢复失败：${error.message}`))
    }
  })
}

/**
 * 退出时收掉网盘下载的子进程。
 * 不这么做的话，关掉工作台后台仍留着一个 python 在写盘（Windows 上不会随父进程退出），
 * 用户既看不到进度也没法取消，只能去任务管理器找。`shutdown()` 只杀进程，保留 .part。
 */
for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
  process.on(signal, () => {
    downloadManager.shutdown()
    process.exit(0)
  })
}
process.on('exit', () => downloadManager.shutdown())

bootstrap().catch((error) => {
  console.error('[startup] 启动失败：', error)
  process.exitCode = 1
})
