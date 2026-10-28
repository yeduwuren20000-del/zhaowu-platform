// 临时静态服务：托管 dist-test，并把 /api 反代到后端实例
// （默认 8788；用 API_BASE 指向其它端口可验证「依赖缺失」等降级场景）
import { createServer } from 'node:http'
import { readFile } from 'node:fs/promises'
import { existsSync } from 'node:fs'
import { extname, join, normalize } from 'node:path'

const ROOT = join(process.cwd(), 'dist-test')
const PORT = Number(process.env.SERVE_PORT || 8790)
const API = process.env.API_BASE || 'http://127.0.0.1:8788'
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
}

const server = createServer(async (req, res) => {
  if (req.url.startsWith('/api')) {
    try {
      const chunks = []
      for await (const chunk of req) chunks.push(chunk)
      const upstream = await fetch(API + req.url, {
        method: req.method,
        headers: { 'content-type': req.headers['content-type'] || 'application/json' },
        body: chunks.length ? Buffer.concat(chunks) : undefined,
      })
      res.writeHead(upstream.status, { 'content-type': upstream.headers.get('content-type') || 'application/json' })
      res.end(Buffer.from(await upstream.arrayBuffer()))
    } catch (err) {
      res.writeHead(502, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: String(err && err.message) }))
    }
    return
  }

  const path = normalize(decodeURIComponent(req.url.split('?')[0])).replace(/^(\.\.[/\\])+/, '')
  let file = join(ROOT, path)
  if (!existsSync(file) || path === '/' || !extname(file)) file = join(ROOT, 'index.html')
  try {
    const body = await readFile(file)
    res.writeHead(200, { 'content-type': MIME[extname(file)] || 'application/octet-stream' })
    res.end(body)
  } catch {
    res.writeHead(404).end('not found')
  }
})

server.listen(PORT, '127.0.0.1', () => console.log(`serving dist-test on http://127.0.0.1:${PORT}`))
