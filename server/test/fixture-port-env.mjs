import http from 'node:http'

/**
 * 端口自动避让测试专用 fixture：端口只从环境变量 PORT 读（模拟 vite/dify 这类
 * 「端口由 env 决定」的项目）。argv 传端口一概忽略——避让机制的正确性正依赖
 * 「改 env 才能改端口」，否则测试不出注入是否真的生效。
 * 用法：node server/test/fixture-port-env.mjs（PORT 缺省 5198）
 */
const port = Number(process.env.PORT) > 0 ? Number(process.env.PORT) : 5198

const server = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
  res.end(`fixture-port-env ok on ${port}\n`)
})
server.listen(port, '127.0.0.1', () => {
  console.log(`[fixture-port-env] listening on http://127.0.0.1:${port} (PORT=${process.env.PORT ?? '未设置'})`)
})

process.on('SIGTERM', () => {
  server.close()
  process.exit(0)
})
