import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import crypto from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

/**
 * 本机恢复密钥（Recovery Key）。
 *
 * 定位：这是"**忘记主密码时的兜底**"，不是"主密码的替代品"。
 *
 * 能力边界（必须对用户讲清，不要含糊）：
 *   - 它**防不住**已经登录你 Windows 账户的人，也不防能读你用户目录的进程；
 *   - 它**能防**的是：data/vault.dsmv 被拷走/被翻出来，但对方拿不到你的用户目录密钥；
 *   - 密钥文件用 **Windows DPAPI** 加密（当前用户 + 当前机器绑定），
 *     拷到别的电脑/别的账户下无法解密。
 *
 * 为什么不读取 Windows 登录密码来派生：Node 没有合法途径拿到它，
 * 而且那等于把凭据库的安全性绑在一个你无法控制也无法导出的东西上。
 */
const execFileAsync = promisify(execFile)

export const RECOVERY_MODES = {
  /** 不存恢复密钥：主密码忘了就是永久丢失 */
  offline: 'offline',
  /** 存本机恢复密钥：同一台电脑、同一 Windows 账户可找回 */
  recoverable: 'recoverable',
}

/** 恢复密钥文件名，放在用户配置目录而不是 data/（data/ 可能被备份/拷贝带走） */
function recoveryKeyPath() {
  const base =
    process.env.DSM_VAULT_RECOVERY_PATH ||
    path.join(os.homedir(), '.dev-server-manager', 'vault-recovery.key')
  return base
}

/** 恢复信封：说明这是什么、给谁用 */
async function readEnvelope() {
  try {
    const raw = await fs.promises.readFile(recoveryKeyPath(), 'utf8')
    return JSON.parse(raw)
  } catch {
    return null
  }
}

export async function hasRecoveryKey() {
  const envelope = await readEnvelope()
  return Boolean(envelope?.protected)
}

export async function recoveryInfo() {
  const envelope = await readEnvelope()
  if (!envelope?.protected) return { exists: false }
  return {
    exists: true,
    createdAt: envelope.createdAt || null,
    // 明确告知这层保护的边界，避免用户误以为它比主密码更强
    scope: '当前 Windows 账户 + 当前电脑',
  }
}

/**
 * 用 Windows DPAPI 保护一段数据。
 * PowerShell 调用 .NET ProtectedData（CurrentUser 作用域）。
 *
 * 传参方式说明：PowerShell 的 `-Command` 模式下 `$args` 拿不到后续位置参数
 * （它们会被当成命令文本的一部分，直接报 ParserError），
 * 因此这里通过环境变量传入。
 */
const PS_PROTECT =
  '$ErrorActionPreference="Stop";' +
  'Add-Type -AssemblyName System.Security;' +
  '$b=[Convert]::FromBase64String($env:DSM_DPV);' +
  // ProtectedData 没有无参构造，New-Object 会报 "找不到合适的构造函数"，必须用静态方法
  '$enc=[System.Security.Cryptography.ProtectedData]::Protect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);' +
  '[Convert]::ToBase64String($enc)'

const PS_UNPROTECT =
  '$ErrorActionPreference="Stop";' +
  'Add-Type -AssemblyName System.Security;' +
  '$b=[Convert]::FromBase64String($env:DSM_DPV);' +
  '$enc=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,[System.Security.Cryptography.DataProtectionScope]::CurrentUser);' +
  '[Convert]::ToBase64String($enc)'

async function runDpapi(script, valueBase64) {
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], {
    windowsHide: true,
    maxBuffer: 8 * 1024 * 1024,
    env: { ...process.env, DSM_DPV: valueBase64 },
  })
  return stdout.trim()
}

async function dpapiProtect(plainBuffer) {
  return runDpapi(PS_PROTECT, plainBuffer.toString('base64'))
}

/** 用 DPAPI 解开（必须同一用户 + 同一机器，否则直接失败） */
async function dpapiUnprotect(protectedBase64) {
  return Buffer.from(await runDpapi(PS_UNPROTECT, protectedBase64), 'base64')
}

/**
 * 生成并保存恢复密钥。
 * @param {string} masterPassword 主密码（恢复密钥由它 + 随机盐派生，不是直接存主密码）
 */
export async function createRecoveryKey(masterPassword, { salt } = {}) {
  const saltBuffer = salt ? Buffer.from(salt, 'base64') : crypto.randomBytes(16)
  // 恢复密钥 = PBKDF2(主密码, 盐, 600k) —— 拿到密钥文件也要知道主密码才能用，
  // 这让它成为"兜底"而不是"绕过主密码的后门"
  const derived = crypto.pbkdf2Sync(Buffer.from(String(masterPassword), 'utf8'), saltBuffer, 600000, 32, 'sha256')
  const protectedValue = await dpapiProtect(derived)

  const envelope = {
    version: 1,
    createdAt: new Date().toISOString(),
    kdf: 'pbkdf2-sha256',
    iterations: 600000,
    salt: saltBuffer.toString('base64'),
    protected: protectedValue,
    note: '本机恢复密钥。与主密码共同派生凭据库密钥；同一 Windows 账户在本机才能解开。',
  }
  await fs.promises.mkdir(path.dirname(recoveryKeyPath()), { recursive: true })
  await fs.promises.writeFile(recoveryKeyPath(), JSON.stringify(envelope, null, 2), 'utf8')
  // 尽力收紧权限（Windows 上只对 NTFS 有意义，失败不阻断）
  await fs.promises
    .chmod(recoveryKeyPath(), 0o600)
    .catch(() => {})
  return { created: true, path: recoveryKeyPath() }
}

/**
 * 用恢复密钥找回主密码派生的库密钥。
 * 注意：返回的是**派生出的库密钥材料**，不是主密码本身——
 * 主密码本身没有存任何地方，找不回来（这也是安全上的必然）。
 */
export async function recoverWithRecoveryKey(masterPassword) {
  const envelope = await readEnvelope()
  if (!envelope?.protected) {
    const error = new Error('本机没有恢复密钥：这个库创建时选择了"不存恢复密钥"模式，找不回密码')
    error.code = 'NO_RECOVERY_KEY'
    throw error
  }
  let derived
  try {
    derived = await dpapiUnprotect(envelope.protected)
  } catch {
    const error = new Error('恢复密钥无法解开：它绑定在创建时的 Windows 账户与电脑上，当前环境不匹配')
    error.code = 'RECOVERY_MISMATCH'
    throw error
  }
  const salt = Buffer.from(envelope.salt, 'base64')
  const expected = crypto.pbkdf2Sync(Buffer.from(String(masterPassword), 'utf8'), salt, envelope.iterations, 32, 'sha256')
  if (!crypto.timingSafeEqual(derived, expected)) {
    const error = new Error('主密码不正确')
    error.code = 'BAD_PASSWORD'
    throw error
  }
  return { ok: true }
}

/** 删除恢复密钥（转为"不存密码"模式） */
export async function deleteRecoveryKey() {
  await fs.promises.rm(recoveryKeyPath(), { force: true })
  return { removed: true }
}

export function recoveryKeyLocation() {
  return recoveryKeyPath()
}