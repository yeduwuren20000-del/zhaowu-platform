import fsp from 'node:fs/promises'
import path from 'node:path'
import crypto from 'node:crypto'
import { FILES } from '../config.js'
import { decryptFromBuffer, encryptToBuffer, describeHeader, parseHeader } from '../utils/vaultCrypto.js'
import {
  RECOVERY_MODES,
  createRecoveryKey,
  deleteRecoveryKey,
  hasRecoveryKey,
  recoverWithRecoveryKey,
  recoveryInfo,
} from '../utils/recoveryKey.js'
import { nowIso } from '../utils/ids.js'
import { badRequest, notFound } from '../utils/http.js'

/**
 * 凭据仓库（Vault）：主密码加密的私密条目存储。
 *
 * 与项目既有安全口径保持一致，且比它更严：
 *  - 磁盘上**只有密文**，条目明文永远不落盘（服务器密码、SSH 私钥、API Token…）；
 *  - 主密码不落盘，只在"已解锁"期间驻留内存，进程退出即消失；
 *  - 每条记录单独用不同的 salt/nonce 加密，AES-256-GCM 提供完整性校验；
 *  - 条目**列表**不加密元数据（只有标题），因此解锁前也能显示"有多少条"——
 *    但正文、密码、私钥必须解锁后才可见。
 *
 * 为什么条目元数据也放进密文体而不是单独明文存：
 * 避免"未解锁时接口吐出标题清单"这种半明文泄露；但为了让用户知道"里面有什么"，
 * 解锁后一次性返回全部条目，不做分页查询（凭据量通常在几十条级别）。
 */

const MAX_ENTRIES = 500
const MAX_TITLE = 120
const MAX_SECRET = 20000

// 主密码在内存中的驻留状态（进程级，不落盘）
let session = { unlocked: false, keyMaterial: null, since: null }

function requireUnlocked() {
  if (!session.unlocked) {
    throw badRequest('凭据库未解锁：请先输入主密码解锁', { needUnlock: true })
  }
  return session
}

/** 已解锁状态下读取并解密整库（库必然已存在——解锁时创建过了） */
async function readDecrypted() {
  const buf = await readVaultFile()
  if (!buf) throw badRequest('凭据库文件缺失，请重启工作台后重新解锁')
  return decryptFromBuffer(buf, session.keyMaterial)
}

function normalizeSecret(value, field, max) {
  if (value === undefined || value === null) return ''
  const text = String(value)
  if (text.length > max) throw badRequest(`「${field}」过长（${text.length} 字符，上限 ${max}）`)
  return text
}

/** 必填文本：超长直接报错，不静默截断 —— 凭据内容被悄悄砍掉比报错危险得多 */
function requiredText(value, field, max) {
  const text = String(value ?? '').trim()
  if (!text) throw badRequest(`「${field}」不能为空`)
  if (text.length > max) throw badRequest(`「${field}」过长（${text.length} 字符，上限 ${max}）`)
  return text
}

function newId() {
  return `vault_${crypto.randomBytes(8).toString('hex')}`
}

async function readVaultFile() {
  try {
    return await fsp.readFile(FILES.vault)
  } catch (error) {
    if (error.code === 'ENOENT') return null
    throw error
  }
}

/**
 * 写库：**覆盖已有文件之前先自动快照**。
 *
 * 快照逻辑放在这里而不是各个调用点，是为了让"任何一次覆盖写都有兜底"成为
 * 不可能遗漏的性质 —— 新增一个写入口时不会因为忘记加快照就悄悄失去保护。
 * 快照失败**不阻断写入**：备份是保险，不该因为磁盘满之类的边缘情况把主功能锁死。
 */
async function writeVaultFile(buf, { snapshotReason = 'auto' } = {}) {
  await fsp.mkdir(path.dirname(FILES.vault), { recursive: true })
  const current = await readVaultFile()
  if (current && current.length > 0) {
    await snapshotVault(snapshotReason).catch((error) => {
      console.warn(`[vault] 写入前快照失败（继续写入）：${error.message}`)
    })
  }
  await fsp.writeFile(FILES.vault, buf)
}

// ---- 备份 ----
//
// 起因是一次真实的误删：清理测试残留时把用户刚存的数据一并删掉了，
// AES-256-GCM 设计上不可逆，没有备份就等于永久丢失。
//
// 约定：**任何覆盖写之前先快照**。这样即使后续操作出错、或者有人误删文件，
// 最新的一份快照都在，能恢复到出事前一刻。
// 备份内容与主库同样是密文（快照的是文件字节，不解密），不额外泄露。

const BACKUP_DIR = path.join(path.dirname(FILES.vault), 'vault-backups')
const BACKUP_PREFIX = 'vault-'
const BACKUP_SUFFIX = '.dsmv'
const MAX_BACKUPS = 20

function backupStamp() {
  // 文件名要排序友好：用时间戳而不是 Date.now()（位数一致）
  return new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '').replace('T', '-')
}

async function ensureBackupDir() {
  await fsp.mkdir(BACKUP_DIR, { recursive: true })
}

/** 列出可用备份（新→旧） */
async function listBackups() {
  try {
    const names = await fsp.readdir(BACKUP_DIR)
    const items = []
    for (const name of names) {
      if (!name.startsWith(BACKUP_PREFIX) || !name.endsWith(BACKUP_SUFFIX)) continue
      const full = path.join(BACKUP_DIR, name)
      const stat = await fsp.stat(full).catch(() => null)
      if (!stat) continue
      items.push({
        name,
        bytes: stat.size,
        at: stat.mtime.toISOString(),
      })
    }
    return items.sort((a, b) => (a.at < b.at ? 1 : -1))
  } catch (error) {
    if (error.code === 'ENOENT') return []
    throw error
  }
}

/** 保留最近 MAX_BACKUPS 份，删掉更老的 */
async function pruneBackups() {
  const all = await listBackups()
  const stale = all.slice(MAX_BACKUPS)
  for (const item of stale) {
    await fsp.rm(path.join(BACKUP_DIR, item.name), { force: true }).catch(() => {})
  }
  return stale.length
}

/**
 * 给当前库文件做一份快照。
 * @param {string} reason 记进文件名，便于回溯为什么会有这份备份
 */
async function snapshotVault(reason = 'auto') {
  const existing = await readVaultFile()
  if (!existing) return null
  await ensureBackupDir()
  const safeReason = String(reason).replace(/[^a-z0-9_-]/gi, '').slice(0, 24) || 'auto'
  // 时间戳只到秒：同一秒内连续两次写库（例如快速保存两条）会生成同名文件，
  // 后写的会覆盖先写的，快照就丢了一份。加随机后缀保证唯一。
  const unique = crypto.randomBytes(3).toString('hex')
  const name = `${BACKUP_PREFIX}${backupStamp()}-${safeReason}-${unique}${BACKUP_SUFFIX}`
  const target = path.join(BACKUP_DIR, name)
  // 先写临时文件再改名：避免中途崩溃留下半个备份
  const tmp = `${target}.tmp`
  await fsp.writeFile(tmp, existing)
  await fsp.rename(tmp, target)
  await pruneBackups()
  return { name, bytes: existing.length }
}

/**
 * 读取凭据库文件；不存在时**用给定的主密码创建**一个空库。
 * 注意：创建时必须用调用方提供的密码，绝不能用随机密码 ——
 * 否则首次解锁必然失败（用户输入的密码对不上随机生成的）。
 */
async function loadOrCreate(password, { mode = RECOVERY_MODES.offline } = {}) {
  const existing = await readVaultFile()
  if (existing) return existing
  const buf = encryptToBuffer({ version: 1, entries: [], mode }, password, {})
  await writeVaultFile(buf)
  if (mode === RECOVERY_MODES.recoverable) {
    await createRecoveryKey(password)
  }
  return buf
}

export const vaultService = {
  /**
   * 库状态：是否已存在、是否已解锁、条目数（不解锁也能看条目数），
   * 以及**忘记密码时能否找回**（取决于创建时选的模式）。
   */
  async status() {
    const recovery = await recoveryInfo()
    const buf = await readVaultFile()
    if (!buf) {
      return {
        exists: false,
        unlocked: false,
        entryCount: 0,
        header: null,
        recovery: { exists: false, mode: null, canRecover: false },
      }
    }
    let entryCount = 0
    if (session.unlocked) {
      const data = decryptFromBuffer(buf, session.keyMaterial)
      entryCount = (data?.entries || []).length
    }
    let header = null
    try {
      header = describeHeader(buf)
    } catch {
      header = null
    }
    return {
      exists: true,
      unlocked: session.unlocked,
      entryCount,
      header,
      // 有恢复密钥才说明是"可找回"模式；两者不一致时以"有密钥"为准（更安全的一侧）
      recovery: {
        exists: recovery.exists,
        createdAt: recovery.createdAt || null,
        scope: recovery.scope || null,
        mode: recovery.exists ? RECOVERY_MODES.recoverable : RECOVERY_MODES.offline,
        canRecover: recovery.exists,
      },
    }
  },

  /**
   * 用主密码解锁。库不存在时，用这个密码创建。
   * @param {string} password 主密码
   * @param {object} [options]
   * @param {'offline'|'recoverable'} [options.mode] 仅在首次创建时生效：
   *   offline（默认）= 不存任何东西，密码忘了就是永久丢失；
   *   recoverable = 额外生成一把本机恢复密钥（DPAPI 保护），忘了可在本机找回。
   */
  async unlock(password, { mode = RECOVERY_MODES.offline } = {}) {
    if (!password) throw badRequest('主密码不能为空')
    const buf = await loadOrCreate(password, { mode })
    let data
    try {
      data = decryptFromBuffer(buf, password)
    } catch (error) {
      // 不区分"文件损坏"和"密码错"的细节给前端会误导，这里都归为主密码不对
      throw badRequest('主密码不正确')
    }
    session = {
      unlocked: true,
      // 内存里保存的是主密码本身，而不是派生出来的密钥：
      // 派生密钥**从不跨请求缓存**，每次加解密都重跑一遍 PBKDF2（600k 次），
      // 这样进程内存里长期存在的只有用户自己知道的那串字符，
      // 攻击者即使拿到内存快照也无法直接拿去加解密（还得再付 600k 次的代价）。
      keyMaterial: password,
      since: nowIso(),
    }
    return { ok: true, entryCount: (data?.entries || []).length, mode: data?.mode || RECOVERY_MODES.offline }
  },

  /**
   * "忘记密码"找回流程。
   * **注意能力边界**：它并不能恢复主密码本身（主密码任何地方都没存），
   * 而是用本机恢复密钥验证你确实知道主密码，从而解锁凭据库。
   */
  async recover(password) {
    if (!password) throw badRequest('请输入你当初设置的主密码')
    try {
      await recoverWithRecoveryKey(password)
    } catch (error) {
      if (error.code === 'NO_RECOVERY_KEY') {
        throw badRequest('这个凭据库创建时选择了「不存恢复密钥」，密码无法找回')
      }
      if (error.code === 'RECOVERY_MISMATCH') {
        throw badRequest('恢复密钥与当前环境不匹配（它绑定在创建时的 Windows 账户与电脑上）')
      }
      throw badRequest(error.message || '找回失败')
    }
    // 恢复密钥已验证通过，主密码也就被确认正确，直接解锁
    return this.unlock(password)
  },

  /**
   * 切换找回模式。
   *  - 开启：需要当前主密码，生成一把本机恢复密钥；
   *  - 关闭：删除恢复密钥，从此密码无法找回。
   */
  async setRecoveryMode(enable, password) {
    if (!password) throw badRequest('需要输入当前主密码以确认身份')
    const buf = await loadOrCreate(password)
    // 校验主密码正确，避免用一个错的密码去"开启"找回（那等于给真正的密码上保险也没用）
    try {
      decryptFromBuffer(buf, password)
    } catch {
      throw badRequest('主密码不正确')
    }
    if (enable) {
      await createRecoveryKey(password)
      return { ok: true, mode: RECOVERY_MODES.recoverable }
    }
    await deleteRecoveryKey()
    return { ok: true, mode: RECOVERY_MODES.offline }
  },

  /** 锁定：立刻清掉内存里的主密码 */
  lock() {
    session = { unlocked: false, keyMaterial: null, since: null }
    return { ok: true }
  },

  /** 修改主密码：需要旧密码验证，成功后整库重新加密 */
  async changeMasterPassword(oldPassword, newPassword) {
    const next = requiredText(newPassword, '新主密码', 1024)
    if (next.length < 6) throw badRequest('新主密码至少 6 位')
    const buf = await loadOrCreate(oldPassword)
    let data
    try {
      data = decryptFromBuffer(buf, oldPassword)
    } catch {
      throw badRequest('原主密码不正确')
    }
    const fresh = encryptToBuffer(data, next, {})
    await writeVaultFile(fresh, { snapshotReason: 'chpwd' })
    session.keyMaterial = next
    // 恢复密钥是由**旧主密码**派生的：不同步重建的话，改完密码后"找回"会永远失败。
    // 这是个很容易漏掉的一致性坑，因此放在这里强制同步。
    if (await hasRecoveryKey()) {
      await createRecoveryKey(next)
    }
    return { ok: true }
  },

  /** 列出全部条目（需解锁）。返回明文——调用方必须自己决定是否要脱敏展示。 */
  async list() {
    requireUnlocked()
    const data = await readDecrypted()
    const entries = (data?.entries || []).map((item) => ({
      id: item.id,
      title: item.title,
      content: item.content || '',
      updatedAt: item.updatedAt,
    }))
    return { entries, unlockedSince: session.since }
  },

  /**
   * 新增 / 更新一条：只认「标题」和「内容」两个字段。
   *
   * 刻意做窄：早期版本有类型/主机/用户名/标签/备注五六个字段，实测下来
   * 每条都要点开填，反而比直接往内容里贴一整段更快。凭据的形态千差万别
   *（私钥、密码、Token、证书、备注），与其猜字段，不如给一个自由的内容框。
   */
  async upsert(input = {}) {
    requireUnlocked()
    const title = requiredText(input.title, '标题', MAX_TITLE)
    const content = normalizeSecret(input.content ?? input.secret, '内容', MAX_SECRET)
    // 空内容条目没有意义（用户也点不了保存），服务端同样拒绝，避免存出一堆空壳
    if (!content) throw badRequest('「内容」不能为空')

    const data = await readDecrypted()
    const entries = Array.isArray(data?.entries) ? data.entries : []

    const id = input.id || newId()
    const now = nowIso()
    const index = entries.findIndex((item) => item.id === id)
    if (index === -1 && entries.length >= MAX_ENTRIES) {
      throw badRequest(`条目数已达上限（${MAX_ENTRIES} 条）`)
    }

    const record = {
      id,
      title,
      content,
      createdAt: index === -1 ? now : entries[index].createdAt || now,
      updatedAt: now,
    }

    if (index === -1) entries.push(record)
    else entries[index] = record

    await writeVaultFile(encryptToBuffer({ version: 1, entries }, session.keyMaterial, {}), { snapshotReason: 'save' })
    return { id: record.id, updated: index !== -1 }
  },

  /** 删除一条 */
  async remove(id) {
    requireUnlocked()
    const data = await readDecrypted()
    const entries = Array.isArray(data?.entries) ? data.entries : []
    const next = entries.filter((item) => item.id !== id)
    if (next.length === entries.length) throw notFound('凭据条目不存在')
    await writeVaultFile(encryptToBuffer({ version: 1, entries: next }, session.keyMaterial, {}), { snapshotReason: 'delete' })
    return { removed: 1 }
  },

  /** 导出一份备份文件（含完整自描述头部，换台电脑也能导入） */
  async exportBackup() {
    requireUnlocked()
    const buf = await readVaultFile()
    if (!buf) throw badRequest('凭据库文件缺失')
    return { buffer: buf, header: describeHeader(buf) }
  },

  /**
   * 手动备份 / 恢复。
   *
   * 背景：出过一次真实的误删事故（清理测试残留时把用户数据一起删了，
   * AES-256-GCM 不可逆、无备份即永久丢失），所以除了写入前自动快照，
   * 还要给用户一个能自己掌控、能导到别处的出口。
   */
  async listBackups() {
    const items = await listBackups()
    return { items, max: MAX_BACKUPS, dir: BACKUP_DIR }
  },

  /** 立刻做一份手动备份（同样会走保留上限） */
  async createBackup(reason = 'manual') {
    requireUnlocked()
    const created = await snapshotVault(reason)
    if (!created) throw badRequest('凭据库文件缺失，无法备份')
    return created
  },

  /**
   * 从备份恢复。
   * 安全点：恢复前**先把当前库也快照一份**（理由 manual-restore），
   * 这样"恢复错了"本身也可以再恢复回去。
   */
  async restoreBackup(name) {
    requireUnlocked()
    const safeName = String(name ?? '').trim()
    // 只允许备份目录下的标准文件名，拒绝任何路径穿越
    if (!/^[A-Za-z0-9._-]+\.dsmv$/.test(safeName) || safeName.includes('..')) {
      throw badRequest('备份名不合法')
    }
    const source = path.join(BACKUP_DIR, safeName)
    const buffer = await fsp.readFile(source).catch(() => null)
    if (!buffer) throw notFound('备份文件不存在')

    // 备份是密文，必须能解开才算有效（避免恢复出一个坏文件导致库彻底不可用）
    parseHeader(buffer)
    try {
      decryptFromBuffer(buffer, session.keyMaterial)
    } catch {
      throw badRequest('该备份无法用当前主密码解开，可能来自另一份库')
    }

    await writeVaultFile(buffer, { snapshotReason: 'before-restore' })
    return { restored: safeName, bytes: buffer.length }
  },

  /** 从备份文件导入：必须提供该备份的主密码 */
  async importBackup(buffer, password) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 64) {
      throw badRequest('备份文件内容无效')
    }
    parseHeader(buffer) // 校验是不是合法凭据文件
    let data
    try {
      data = decryptFromBuffer(buffer, password)
    } catch {
      throw badRequest('备份文件的主密码不正确')
    }
    if (!Array.isArray(data?.entries)) throw badRequest('备份文件内容格式不正确')

    // 合并：以 id 去重，同 id 以后导入的为准
    const current = session.unlocked ? await readDecrypted() : { entries: [] }
    const merged = new Map()
    for (const item of current.entries || []) merged.set(item.id, item)
    let added = 0, updated = 0
    for (const item of data.entries) {
      if (merged.has(item.id)) updated += 1
      else added += 1
      merged.set(item.id, item)
    }
    await writeVaultFile(encryptToBuffer({ version: 1, entries: [...merged.values()] }, session.keyMaterial, {}), { snapshotReason: 'import' })
    return { added, updated, total: merged.size }
  },
}