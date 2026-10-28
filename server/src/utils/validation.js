import { badRequest } from './http.js'

export function asText(value, { max = 300 } = {}) {
  if (value === undefined || value === null) return ''
  return String(value).replace(/\s+$/g, '').slice(0, max)
}

export function requireText(value, field, { max = 200 } = {}) {
  const text = asText(value, { max }).trim()
  if (!text) throw badRequest(`「${field}」不能为空`)
  return text
}

/** 端口：允许空（未记录端口），否则必须是 1-65535 的整数 */
export function optionalPort(value, field = '端口') {
  if (value === undefined || value === null || value === '') return null
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw badRequest(`「${field}」需要是 1-65535 之间的整数`)
  }
  return port
}

export function toBoolean(value, fallback = false) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  return ['true', '1', 'yes', 'on'].includes(String(value).toLowerCase())
}

/** 本地项目入参校验；partial=true 时只校验传入字段（编辑场景） */
export function sanitizeProjectInput(body = {}, { partial = false } = {}) {
  const out = {}
  const has = (key) => Object.prototype.hasOwnProperty.call(body, key)

  if (!partial || has('name')) out.name = requireText(body.name, '项目名称', { max: 120 })
  if (!partial || has('type')) out.type = asText(body.type, { max: 60 }).trim() || '自定义'
  if (!partial || has('dir')) out.dir = asText(body.dir, { max: 400 }).trim()
  if (!partial || has('startCommand')) out.startCommand = asText(body.startCommand, { max: 400 }).trim()
  if (!partial || has('stopCommand')) out.stopCommand = asText(body.stopCommand, { max: 400 }).trim()
  if (!partial || has('port')) out.port = optionalPort(body.port)
  if (!partial || has('portEnv')) out.portEnv = asText(body.portEnv, { max: 60 }).trim()
  // portArg：端口被占时怎么把新端口传给启动命令（如 "--port {port}"）。
  // 没有它，前端 dev server 只能靠 portEnv，端口一冲突就起不来。
  if (!partial || has('portArg')) out.portArg = asText(body.portArg, { max: 120 }).trim()
  // containerName：Docker 托管型单容器项目（docker start <name>）的容器名。
  // 启动认领时用它 + docker ps 核对「端口占用者是不是我自己的容器」，
  // 避免把自己的容器误判成端口冲突、也不会重复起一套。
  if (!partial || has('containerName')) out.containerName = asText(body.containerName, { max: 120 }).trim()
  if (!partial || has('url')) out.url = asText(body.url, { max: 400 }).trim()
  if (!partial || has('remark')) out.remark = asText(body.remark, { max: 500 })
  if (!partial || has('icon')) out.icon = asText(body.icon, { max: 40 })
  if (!partial || has('accent')) out.accent = asText(body.accent, { max: 20 })
  if (has('remoteLinks')) out.remoteLinks = sanitizeRemoteLinks(body.remoteLinks)
  return out
}

/**
 * 远程关联校验（第七阶段）：只允许「服务器 + 可选 APP / 容器名」的引用，
 * 不接受任意字符串拼接，保证它只是"指向已有记录的 ID 引用"。
 */
export function sanitizeRemoteLinks(value) {
  if (!Array.isArray(value)) return []
  return value
    .map((item) => {
      const serverId = asText(item?.serverId, { max: 64 }).trim()
      if (!serverId) return null
      return {
        serverId,
        appId: asText(item?.appId, { max: 64 }).trim() || null,
        containerName: asText(item?.containerName, { max: 120 }).trim() || null,
        note: asText(item?.note, { max: 200 }).trim() || '',
        createdAt: asText(item?.createdAt, { max: 40 }).trim() || nowIsoSafe(),
      }
    })
    .filter(Boolean)
    .slice(0, 50)
}

function nowIsoSafe() {
  return new Date().toISOString()
}

/**
 * 远程日志路径校验：必须是绝对 POSIX 路径，且不含任何 shell 元字符。
 * 日志读取走 SFTP，这里再收一道口子，保证"路径只能来自允许列表"。
 */
export function isSafeRemotePath(target) {
  const value = String(target || '').trim()
  if (!value.startsWith('/')) return false
  if (value.length > 400) return false
  if (/[\r\n\t\0]/.test(value)) return false
  if (/[`$;|&<>'"*?\\]/.test(value)) return false
  if (value.includes('..')) return false
  return true
}

function sanitizeLogPaths(value) {
  const list = Array.isArray(value) ? value : String(value ?? '').split(/[\r\n,]+/)
  const cleaned = list.map((item) => String(item || '').trim()).filter(Boolean)
  const invalid = cleaned.filter((item) => !isSafeRemotePath(item))
  if (invalid.length > 0) {
    throw badRequest(`日志路径必须是绝对路径且不含特殊字符：${invalid.join('、')}`)
  }
  return [...new Set(cleaned)].slice(0, 20)
}

const AUTH_TYPES = ['key', 'agent', 'password']
const SECRET_FIELDS = ['password', 'passphrase', 'privateKey', 'privateKeyContent', 'secret', 'keyContent', 'sshPassword']

/** 服务器入参校验（第二阶段增加 SSH 连接与监控字段） */
export function sanitizeServerInput(body = {}, { partial = false } = {}) {
  const out = {}
  const has = (key) => Object.prototype.hasOwnProperty.call(body, key)

  const leaked = SECRET_FIELDS.filter((field) => has(field) && String(body[field] ?? '').length > 0)
  if (leaked.length > 0) {
    throw badRequest(
      `出于安全考虑，配置文件不保存密码或私钥正文（拒绝字段：${leaked.join('、')}）。` +
        '请改用环境变量 DSM_SSH_PASSWORD_<服务器ID> 或项目内 data/secrets.json，私钥则只填 keyPath 路径。',
    )
  }

  if (!partial || has('name')) out.name = requireText(body.name, '服务器名称', { max: 120 })
  if (!partial || has('host')) out.host = requireText(body.host, 'IP / 域名', { max: 200 })
  if (!partial || has('os')) out.os = asText(body.os, { max: 80 }).trim()
  if (!partial || has('sshPort')) out.sshPort = optionalPort(body.sshPort, 'SSH 端口') ?? 22
  if (!partial || has('remark')) out.remark = asText(body.remark, { max: 500 })
  if (!partial || has('user')) out.user = asText(body.user, { max: 80 }).trim()

  // ---- 第二阶段：SSH 只读监控 ----
  if (!partial || has('username')) {
    out.username = asText(body.username ?? body.user, { max: 80 }).trim() || 'root'
  }
  if (!partial || has('authType')) {
    const authType = asText(body.authType, { max: 20 }).trim().toLowerCase()
    out.authType = AUTH_TYPES.includes(authType) ? authType : 'key'
  }
  if (!partial || has('keyPath')) out.keyPath = asText(body.keyPath, { max: 400 }).trim()
  if (!partial || has('connectTimeout')) {
    const timeout = Number(body.connectTimeout)
    out.connectTimeout = Number.isFinite(timeout) ? Math.min(60000, Math.max(2000, Math.round(timeout))) : 8000
  }
  if (!partial || has('monitorEnabled')) out.monitorEnabled = toBoolean(body.monitorEnabled, true)
  if (!partial || has('dockerMonitorEnabled')) out.dockerMonitorEnabled = toBoolean(body.dockerMonitorEnabled, true)
  if (!partial || has('passwordEnv')) out.passwordEnv = asText(body.passwordEnv, { max: 80 }).trim()
  if (!partial || has('passphraseEnv')) out.passphraseEnv = asText(body.passphraseEnv, { max: 80 }).trim()
  if (!partial || has('logPaths')) {
    const paths = sanitizeLogPaths(body.logPaths)
    if (paths.length > 0 || has('logPaths')) out.logPaths = paths
  }
  return out
}

/** 服务器下 APP 记录校验 */
export function sanitizeAppInput(body = {}, { partial = false } = {}) {
  const out = {}
  const has = (key) => Object.prototype.hasOwnProperty.call(body, key)

  if (!partial || has('name')) out.name = requireText(body.name, 'APP / 服务名称', { max: 120 })
  if (!partial || has('port')) out.port = optionalPort(body.port)
  if (!partial || has('deployPath')) out.deployPath = asText(body.deployPath, { max: 400 }).trim()
  if (!partial || has('url')) out.url = asText(body.url, { max: 400 }).trim()
  if (!partial || has('status')) {
    const status = asText(body.status, { max: 20 }).trim()
    out.status = ['running', 'stopped', 'unknown'].includes(status) ? status : 'unknown'
  }
  if (!partial || has('remark')) out.remark = asText(body.remark, { max: 500 })
  return out
}
