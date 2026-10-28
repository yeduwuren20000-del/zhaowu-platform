import http from 'node:http'

/**
 * 冒烟测试用的最小服务：用来验证"启动 -> 端口监听 -> 停止 -> 端口释放"整条链路。
 * 用法：node server/test/fixture-server.mjs [port] [port2] ...
 *       可以传多个端口，用来模拟"同一个进程监听多个端口"的项目。
 */
const ports = process.argv
  .slice(2)
  .map((value) => Number(value))
  .filter((value) => Number.isInteger(value) && value > 0 && value < 65536)
const listenPorts = ports.length > 0 ? ports : [5199]

const servers = listenPorts.map((port) => {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' })
    res.end(`fixture ok on ${port}\n`)
  })
  server.listen(port, '127.0.0.1', () => {
    console.log(`[fixture] listening on http://127.0.0.1:${port}`)
  })
  return server
})

process.on('SIGTERM', () => {
  for (const server of servers) server.close()
  process.exit(0)
})
