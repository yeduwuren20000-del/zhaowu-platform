import http from 'node:http'

/**
 * 「端口漂移」专用 fixture：模拟 dev server 不理 --port、自己顺延端口的真实行为
 * （Vite 发现端口被占时的默认做法）。
 * argv 里的 --port 只当作「声明端口」，实际监听声明端口 +100。
 * 用法：node server/test/fixture-port-drift.mjs --port 5460
 */
const index = process.argv.indexOf('--port')
const declared = index > -1 ? Number(process.argv[index + 1]) : 5460
const port = (Number.isInteger(declared) && declared > 0 ? declared : 5460) + 100

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end(`fixture-port-drift ok on ${port} (declared ${declared})\n`)
})
server.listen(port, '127.0.0.1', () => {
  console.log(`[fixture-port-drift] declared=${declared} listening=${port}`)
})

process.on('SIGTERM', () => {
  server.close()
  process.exit(0)
})
