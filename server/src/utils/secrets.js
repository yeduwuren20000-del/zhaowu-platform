import path from 'node:path'
import { DATA_DIR } from '../config.js'
import { readJson } from './fsx.js'

/**
 * SSH 凭据解析：密码 / 私钥口令**永不写入 servers.json**。
 *
 * 解析顺序：
 *   1. 环境变量：server.passwordEnv / server.passphraseEnv（显式指定）
 *      或默认 `DSM_SSH_PASSWORD_<SERVER_ID>`（ID 大写、非字母数字转下划线）
 *   2. 本地凭据文件 data/secrets.json（已在 .gitignore 中忽略）：
 *      { "<serverId>": { "password": "…", "passphrase": "…" } }
 *
 * 私钥正文同样不落库：只保存 keyPath，连接时从磁盘读取。
 */

export const SECRETS_FILE = path.join(DATA_DIR, 'secrets.json')

function defaultEnvName(serverId, kind) {
  const suffix = String(serverId || '').toUpperCase().replace(/[^A-Z0-9]/g, '_')
  return kind === 'password' ? `DSM_SSH_PASSWORD_${suffix}` : `DSM_SSH_PASSPHRASE_${suffix}`
}

let cache = { at: 0, data: null }

/** 读取本地凭据文件（60 秒缓存，文件不存在返回空对象） */
export async function readSecrets({ force = false } = {}) {
  if (!force && cache.data && Date.now() - cache.at < 60000) return cache.data
  let data = {}
  try {
    data = (await readJson(SECRETS_FILE, {})) || {}
  } catch (error) {
    console.warn(`[secrets] data/secrets.json 解析失败：${error.message}`)
    data = {}
  }
  cache = { at: Date.now(), data }
  return data
}

export function invalidateSecrets() {
  cache = { at: 0, data: null }
}

/** 是否有可用于连接的凭据（用于前端提示，不暴露内容） */
export async function hasSecret(server, kind = 'password') {
  const value = await resolveSecret(server, kind)
  return Boolean(value)
}

export async function resolveSecret(server, kind = 'password') {
  const envName = (kind === 'password' ? server.passwordEnv : server.passphraseEnv) || defaultEnvName(server.id, kind)
  const fromEnv = process.env[envName]
  if (fromEnv) return { value: fromEnv, source: `环境变量 ${envName}` }

  const secrets = await readSecrets()
  const entry = secrets?.[server.id] || {}
  const value = kind === 'password' ? entry.password : entry.passphrase
  if (value) return { value: String(value), source: `data/secrets.json` }

  return { value: null, source: null, envName }
}
