import http from 'node:http'

/**
 * 命令行端口避让专用 fixture（模拟 vite/next 这类「端口由 --port 决定」的 dev server）。
 * 只认 argv 里的 --port；环境变量 PORT 仅作兜底证明它不是靠 env 生效的。
 * 用法：node server/test/fixture-port-arg.mjs --port 5199
 */
const index = process.argv.indexOf('--port')
const fromArgv = index > -1 ? Number(process.argv[index + 1]) : NaN
const port = Number.isInteger(fromArgv) && fromArgv > 0 ? fromArgv : Number(process.env.PORT) || 5199

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end(`fixture-port-arg ok on ${port}\n`)
})
server.listen(port, '127.0.0.1', () => {
  console.log(`[fixture-port-arg] listening on http://127.0.0.1:${port} (argv=${process.argv.slice(2).join(' ')})`)
})

process.on('SIGTERM', () => {
  server.close()
  process.exit(0)
})
