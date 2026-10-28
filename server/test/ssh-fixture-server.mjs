/**
 * 测试用「假 Linux 服务器」：用 ssh2 的 server 端实现一个只读 SSH 服务。
 *
 * 目的：在没有真实 Linux 机器的情况下，端到端验证
 *   连接 -> 认证 -> 执行采集脚本 -> 解析指标 -> 端口核对 -> SFTP 读日志
 * 并且可以断言"客户端到底发了什么命令"，确保没有任意命令执行通道。
 *
 * 用法：await startFixtureSshServer({ port: 2299, username: 'root', password: 'fixture-pass' })
 */
import ssh2 from 'ssh2'
import { pathToFileURL } from 'node:url'
import { SAMPLE_LOG, buildMetricsStdout } from './fixtures/ssh-output.mjs'
import { buildDockerStdout } from './fixtures/docker-output.mjs'

const { Server, utils } = ssh2
const STATUS_CODE = utils.sftp.STATUS_CODE

const LOG_PATHS = new Map([
  ['/var/log/nginx/error.log', SAMPLE_LOG],
  [
    '/var/log/syslog',
    'Oct  6 10:20:30 prod-web-01 systemd[1]: Started Daily apt upgrade.\nOct  6 10:21:02 prod-web-01 sshd[902]: Accepted password for root\n',
  ],
])

export const FIXTURE_LOG_PATH = '/var/log/nginx/error.log'

export async function startFixtureSshServer({
  port = 2299,
  username = 'root',
  password = 'fixture-pass',
  host = '127.0.0.1',
  dockerStdout = buildDockerStdout(),
} = {}) {
  const hostKey = utils.generateKeyPairSync('ed25519').private
  const commands = []
  const rejectCommands = []

  const server = new Server({ hostKeys: [hostKey] }, (client) => {
    client.on('authentication', (ctx) => {
      if (ctx.method === 'password' && ctx.username === username && ctx.password === password) {
        ctx.accept()
        return
      }
      ctx.reject(['password'])
    })

    client.on('ready', () => {
      client.on('session', (accept) => {
        const session = accept()

        session.on('exec', (acceptExec, _rejectExec, info) => {
          const stream = acceptExec()
          commands.push(info.command)
          // 只允许两条固定的只读脚本：系统指标 与 Docker 采集；其它命令一律拒绝
          const isMetrics = info.command.includes('@@S:hostname') && info.command.includes('ss -lntup')
          const isDocker = info.command.includes('@@D:docker') && info.command.includes('docker stats --no-stream')
          if (isMetrics) {
            stream.write(buildMetricsStdout())
            stream.exit(0)
            stream.end()
            return
          }
          if (isDocker) {
            stream.write(dockerStdout)
            stream.exit(0)
            stream.end()
            return
          }
          rejectCommands.push(info.command)
          stream.write('fixture: command rejected\n')
          stream.exit(127)
          stream.end()
        })

        session.on('sftp', (acceptSftp) => {
          const sftp = acceptSftp()
          const handles = new Map()
          let nextHandle = 0

          const statOf = (reqid, remotePath) => {
            const content = LOG_PATHS.get(remotePath)
            if (content === undefined) {
              sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE)
              return
            }
            sftp.attrs(reqid, {
              mode: 0o100644,
              uid: 0,
              gid: 0,
              size: Buffer.byteLength(content),
              atime: Math.floor(Date.now() / 1000) - 60,
              mtime: Math.floor(Date.now() / 1000) - 10,
            })
          }

          sftp.on('STAT', statOf)
          sftp.on('LSTAT', statOf)

          sftp.on('OPEN', (reqid, remotePath) => {
            const content = LOG_PATHS.get(remotePath)
            if (content === undefined) {
              sftp.status(reqid, STATUS_CODE.NO_SUCH_FILE)
              return
            }
            nextHandle += 1
            const handle = Buffer.alloc(4)
            handle.writeUInt32BE(nextHandle, 0)
            handles.set(handle.toString('hex'), { path: remotePath, position: 0 })
            sftp.handle(reqid, handle)
          })

          sftp.on('READ', (reqid, handle, offset, length, position) => {
            const entry = handles.get(handle.toString('hex'))
            if (!entry) {
              sftp.status(reqid, STATUS_CODE.FAILURE)
              return
            }
            const content = Buffer.from(LOG_PATHS.get(entry.path) || '', 'utf8')
            const start = Number.isFinite(position) && position !== null && position !== undefined ? position : entry.position
            const chunk = content.subarray(start, Math.min(start + length, content.length))
            if (chunk.length === 0) {
              sftp.status(reqid, STATUS_CODE.EOF)
              return
            }
            entry.position = start + chunk.length
            sftp.data(reqid, chunk)
          })

          sftp.on('CLOSE', (reqid, handle) => {
            handles.delete(handle.toString('hex'))
            sftp.status(reqid, STATUS_CODE.OK)
          })

          sftp.on('FSTAT', (reqid, handle) => {
            const entry = handles.get(handle.toString('hex'))
            const content = entry ? LOG_PATHS.get(entry.path) : null
            if (content === undefined || content === null) {
              sftp.status(reqid, STATUS_CODE.FAILURE)
              return
            }
            sftp.attrs(reqid, { mode: 0o100644, uid: 0, gid: 0, size: Buffer.byteLength(content) })
          })
        })
      })
    })
  })

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, resolve)
  })

  return {
    port,
    host,
    username,
    password,
    commands,
    rejectCommands,
    close: () =>
      new Promise((resolve) => {
        server.close(() => resolve())
      }),
  }
}

// 直接运行时：起一个常驻的假服务器，方便手工/接口联调
//   node server/test/ssh-fixture-server.mjs 2299
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const port = Number(process.argv[2] || 2299)
  const password = process.env.DSM_FIXTURE_PASSWORD || 'fixture-pass'
  const instance = await startFixtureSshServer({ port, username: 'root', password })
  console.log(`[fixture] 假 Linux 服务器已启动：ssh root@${instance.host}:${instance.port}（密码 ${password}）`)
  console.log('[fixture] 支持：只读采集脚本、SFTP 读取 /var/log/nginx/error.log 与 /var/log/syslog')
}
