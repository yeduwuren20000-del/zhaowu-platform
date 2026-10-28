import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import ssh2 from 'ssh2'
import { PROJECT_ROOT } from '../config.js'
import { resolveSecret } from '../utils/secrets.js'

// ssh2 是 CommonJS 包，用默认导入再解构，避免 Node 的具名导出探测差异
const { Client } = ssh2

/**
 * SSH 客户端封装（只读用途）：连接、执行只读采集脚本、通过 SFTP 读取日志文件尾部。
 * 这里不做任何交互式 shell，也不接受来自前端的任意命令文本。
 */

export class SshError extends Error {
  constructor(message, { code = 'SSH_ERROR', detail = null } = {}) {
    super(message)
    this.name = 'SshError'
    this.code = code
    this.detail = detail
  }
}

const DEFAULT_TIMEOUT = 8000

function expandHome(target) {
  if (!target) return target
  if (target === '~') return os.homedir()
  if (target.startsWith('~/') || target.startsWith('~\\')) return path.join(os.homedir(), target.slice(2))
  return target
}

/** 把 ssh2 的错误翻译成人能看懂的提示 */
export function describeSshError(error, { timeoutMs } = {}) {
  if (!error) return { code: 'SSH_ERROR', message: '未知错误' }
  const level = error.level || ''
  const code = error.code || ''
  if (level === 'client-timeout' || code === 'ETIMEDOUT') {
    return { code: 'TIMEOUT', message: `连接超时（${timeoutMs || DEFAULT_TIMEOUT}ms 内未完成握手）` }
  }
  if (level === 'client-authentication') {
    return { code: 'AUTH_FAILED', message: '认证失败：请检查用户名、私钥路径或密码/口令配置' }
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') return { code: 'DNS_FAILED', message: '主机名无法解析' }
  if (code === 'ECONNREFUSED') return { code: 'REFUSED', message: '连接被拒绝：目标端口未开放或服务未启动' }
  if (code === 'EHOSTUNREACH' || code === 'ENETUNREACH') return { code: 'UNREACHABLE', message: '网络不可达（路由或防火墙）' }
  if (code === 'ECONNRESET') return { code: 'RESET', message: '连接被重置（中途断开，可能是防火墙或 sshd 限制）' }
  if (level === 'client-socket') return { code: 'SOCKET', message: `连接失败：${error.message}` }
  return { code: code || 'SSH_ERROR', message: error.message || String(error) }
}

/** 组装 ssh2 连接参数；密码/口令运行时解析，绝不落盘 */
export async function buildConnectConfig(server) {
  const timeout = Number(server.connectTimeout) || DEFAULT_TIMEOUT
  const config = {
    host: server.host,
    port: Number(server.sshPort) || 22,
    username: server.username || server.user || 'root',
    readyTimeout: timeout,
    keepaliveInterval: 5000,
    keepaliveCountMax: 2,
  }

  const authType = server.authType || 'key'
  if (authType === 'password') {
    const secret = await resolveSecret(server, 'password')
    if (!secret.value) {
      throw new SshError(
        `未配置 SSH 密码：请设置环境变量 ${secret.envName}，或写入 data/secrets.json 的 ${server.id}.password（配置文件里不会保存密码）`,
        { code: 'NO_CREDENTIAL' },
      )
    }
    config.password = secret.value
  } else if (authType === 'agent') {
    config.agent = process.env.SSH_AUTH_SOCK || '\\\\.\\pipe\\openssh-ssh-agent'
  } else {
    const keyPath = expandHome(server.keyPath)
    if (!keyPath) {
      throw new SshError('未配置私钥路径（keyPath），无法使用密钥登录', { code: 'NO_KEY_PATH' })
    }
    const resolved = path.isAbsolute(keyPath) ? keyPath : path.resolve(PROJECT_ROOT, keyPath)
    if (!fs.existsSync(resolved)) {
      throw new SshError(`私钥文件不存在：${resolved}`, { code: 'KEY_NOT_FOUND' })
    }
    config.privateKey = fs.readFileSync(resolved)
    const passphrase = await resolveSecret(server, 'passphrase')
    if (passphrase.value) config.passphrase = passphrase.value
  }
  return { config, timeout, authType }
}

/** 建立连接，返回 { client, latencyMs, timeout, authType } */
export async function connectSsh(server) {
  const { config, timeout, authType } = await buildConnectConfig(server)
  const client = new Client()
  const startedAt = Date.now()

  await new Promise((resolve, reject) => {
    const onReady = () => {
      client.removeListener('error', onError)
      resolve()
    }
    const onError = (error) => {
      client.removeListener('ready', onReady)
      const described = describeSshError(error, { timeoutMs: timeout })
      reject(new SshError(described.message, { code: described.code, detail: error.message }))
    }
    client.once('ready', onReady)
    client.once('error', onError)
    try {
      client.connect(config)
    } catch (error) {
      const described = describeSshError(error, { timeoutMs: timeout })
      reject(new SshError(described.message, { code: described.code, detail: error.message }))
    }
  })

  return { client, latencyMs: Date.now() - startedAt, timeout, authType }
}

/** 执行一条只读命令，返回 { stdout, stderr, code } */
export function execSsh(client, command, { timeoutMs = 15000 } = {}) {
  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (fn, payload) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      fn(payload)
    }
    const timer = setTimeout(() => {
      finish(reject, new SshError(`远程命令执行超时（${timeoutMs}ms）`, { code: 'EXEC_TIMEOUT' }))
    }, timeoutMs)

    client.exec(command, { pty: false }, (error, stream) => {
      if (error) {
        finish(reject, new SshError(`远程命令执行失败：${error.message}`, { code: 'EXEC_FAILED' }))
        return
      }
      let stdout = ''
      let stderr = ''
      let code = 0
      stream.on('data', (chunk) => {
        stdout += chunk.toString('utf8')
      })
      stream.stderr.on('data', (chunk) => {
        stderr += chunk.toString('utf8')
      })
      stream.on('exit', (exitCode) => {
        code = exitCode ?? 0
      })
      stream.on('close', () => finish(resolve, { stdout, stderr, code }))
      stream.on('error', (streamError) => {
        finish(reject, new SshError(`远程命令流错误：${streamError.message}`, { code: 'EXEC_STREAM' }))
      })
    })
  })
}

function sftpOf(client) {
  return new Promise((resolve, reject) => {
    client.sftp((error, sftp) => {
      if (error) reject(new SshError(`SFTP 不可用（可能被服务器关闭）：${error.message}`, { code: 'SFTP_UNAVAILABLE' }))
      else resolve(sftp)
    })
  })
}

function sftpStat(sftp, remotePath) {
  return new Promise((resolve, reject) => {
    sftp.stat(remotePath, (error, stats) => {
      if (error) reject(new SshError(`读取文件属性失败：${remotePath}（${error.message}）`, { code: 'STAT_FAILED' }))
      else resolve(stats)
    })
  })
}

/** 判断路径是否是普通文件（用于日志允许列表的校验） */
export async function sshPathInfo(client, remotePath) {
  const sftp = await sftpOf(client)
  try {
    const stats = await sftpStat(sftp, remotePath)
    return { exists: true, size: stats.size, isFile: stats.isFile(), mtime: stats.mtime ? stats.mtime * 1000 : null }
  } catch (error) {
    if (error.code === 'STAT_FAILED') return { exists: false, size: 0, isFile: false, mtime: null }
    throw error
  }
}

/**
 * 通过 SFTP 读取文件尾部若干行：先 stat 取大小，只读取最后 maxBytes 字节，
 * 再切出最后 N 行 —— 不经过 shell，天然只读、也无法注入命令。
 */
export async function sshReadFileTail(client, remotePath, { lines = 200, maxBytes = 256 * 1024 } = {}) {
  const sftp = await sftpOf(client)
  const stats = await sftpStat(sftp, remotePath)
  if (!stats.isFile()) throw new SshError(`目标不是普通文件：${remotePath}`, { code: 'NOT_A_FILE' })

  const size = Number(stats.size) || 0
  const start = Math.max(0, size - maxBytes)
  const chunks = []

  await new Promise((resolve, reject) => {
    const stream = sftp.createReadStream(remotePath, { start, end: Math.max(start, size - 1) })
    stream.on('data', (chunk) => chunks.push(chunk))
    stream.on('error', (error) => reject(new SshError(`读取日志失败：${error.message}`, { code: 'READ_FAILED' })))
    stream.on('close', resolve)
    stream.on('end', resolve)
  })

  const text = Buffer.concat(chunks).toString('utf8')
  const allLines = text.split(/\r?\n/)
  if (start > 0) allLines.shift() // 首行可能被截断，丢弃
  return {
    lines: allLines.filter((line) => line.length > 0).slice(-lines),
    size,
    mtime: stats.mtime ? stats.mtime * 1000 : null,
    truncated: start > 0,
  }
}

export function closeSsh(client) {
  try {
    client.end()
  } catch {
    /* 连接可能已经断开 */
  }
}
