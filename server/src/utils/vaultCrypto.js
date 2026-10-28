/**
 * 凭据文件加密：AES-256-GCM + PBKDF2-SHA256(600k)，**全部参数自描述**。
 *
 * 设计动机（来自一次真实的踩坑）：
 *   早期某次用 AI 生成的加密备忘录只写了 7 字节魔数 "SYMEMO2" + 密文，
 *   既没记 KDF、也没记迭代次数、也没记盐。密码忘了之后，**即使知道密码也解不开**——
 *   因为文件里根本没有"该用什么算法派生密钥"的信息，等于数据在事实上永久损毁。
 *
 * 因此这里的硬性约定：
 *   1. 文件头必须包含完整 KDF/加密参数（salt、迭代次数、算法名），换机器也能解；
 *   2. 参数是**版本化**的，未来改算法时旧文件仍可按老参数解开；
 *   3. GCM 自带认证标签，密码错时解密会失败，不会"解出垃圾却看不出来"；
 *   4. 不做任何口令强度"猜测"或降级——错就是错，明确报错。
 *
 * 文件结构：
 *   "DSMVAULT1" (9B 魔数+版本)
 *   + 1B  kdfId      (1 = PBKDF2-SHA256)
 *   + 1B  cipherId   (1 = AES-256-GCM)
 *   + 4B  iterations (uint32 BE)
 *   + 16B salt
 *   + 12B nonce
 *   + 16B authTag
 *   + N   ciphertext
 */
import crypto from 'node:crypto'

export const MAGIC = Buffer.from('DSMVAULT1', 'latin1')
export const HEADER_SIZE = MAGIC.length + 1 + 1 + 4 + 16 + 12 + 16

const KDF_ID_PBKDF2_SHA256 = 1
const CIPHER_ID_AES_256_GCM = 1

/** 默认迭代次数：OWASP 2023 对 PBKDF2-HMAC-SHA256 的建议下限 */
const DEFAULT_ITERATIONS = 600000

// 预留的迭代次数档位：不同机器性能差异大，允许用户降档换取速度
export const ITERATION_PRESETS = [
  { label: '标准（600k，约 1 秒）', value: 600000 },
  { label: '较快（200k，约 0.3 秒）', value: 200000 },
  { label: '最快（50k，约 0.1 秒）', value: 50000 },
]

function toBuffer(key) {
  if (Buffer.isBuffer(key)) return key
  if (key instanceof Uint8Array) return Buffer.from(key)
  if (key?.type === 'Buffer' && Array.isArray(key.data)) return Buffer.from(key.data)
  if (Array.isArray(key)) return Buffer.from(key)
  if (typeof key === 'string') return Buffer.from(key, 'utf8')
  throw new TypeError('无法识别的密钥格式')
}

function readUint32BE(buf, offset) {
  return buf.readUInt32BE(offset)
}

/** 解析文件头，拿到全部解密参数。头部损坏时抛出可读错误。 */
export function parseHeader(buf) {
  const data = toBuffer(buf)
  if (data.length < HEADER_SIZE) {
    throw new Error(`文件太短，不足以包含凭据文件头（需要至少 ${HEADER_SIZE} 字节，实际 ${data.length}）`)
  }
  const magic = data.subarray(0, MAGIC.length).toString('latin1')
  if (magic !== MAGIC.toString('latin1')) {
    throw new Error(`不是凭据文件：文件头应为 "${MAGIC.toString('latin1')}"，实际为 "${magic}"`)
  }
  const offset = MAGIC.length
  const kdfId = data[offset]
  const cipherId = data[offset + 1]
  const iterations = readUint32BE(data, offset + 2)

  if (kdfId !== KDF_ID_PBKDF2_SHA256) {
    throw new Error(`不支持的密钥派生算法 ID=${kdfId}（本版本仅支持 ${KDF_ID_PBKDF2_SHA256} = PBKDF2-SHA256）`)
  }
  if (cipherId !== CIPHER_ID_AES_256_GCM) {
    throw new Error(`不支持的加密算法 ID=${cipherId}（本版本仅支持 ${CIPHER_ID_AES_256_GCM} = AES-256-GCM）`)
  }
  if (!Number.isInteger(iterations) || iterations < 1) {
    throw new Error(`文件头里的迭代次数非法：${iterations}`)
  }

  let cursor = offset + 6
  const salt = data.subarray(cursor, cursor + 16); cursor += 16
  const nonce = data.subarray(cursor, cursor + 12); cursor += 12
  const authTag = data.subarray(cursor, cursor + 16); cursor += 16

  return {
    kdf: 'pbkdf2-sha256',
    cipher: 'aes-256-gcm',
    iterations,
    salt: Buffer.from(salt),
    nonce: Buffer.from(nonce),
    authTag: Buffer.from(authTag),
    payload: data.subarray(cursor),
  }
}

/** 生成一份不含敏感数据、但足以说明"怎么解"的头部说明（供界面展示） */
export function describeHeader(buf) {
  const h = parseHeader(buf)
  return {
    kdf: h.kdf,
    cipher: h.cipher,
    iterations: h.iterations,
    payloadBytes: h.payload.length,
  }
}

function deriveKey(password, salt, iterations) {
  return crypto.pbkdf2Sync(Buffer.from(String(password), 'utf8'), salt, iterations, 32, 'sha256')
}

/**
 * 加密任意对象。
 * @param {unknown} value 要保存的数据
 * @param {string} password 主密码
 * @param {object} [options]
 * @returns {Buffer} 带完整自描述文件头的凭据文件
 */
export function encryptToBuffer(value, password, options = {}) {
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('主密码不能为空')
  }
  const iterations = Number.isInteger(options.iterations) ? options.iterations : DEFAULT_ITERATIONS
  if (iterations < 1000) throw new Error(`迭代次数过低（${iterations}），至少需要 1000`)

  const salt = options.salt ? toBuffer(options.salt) : crypto.randomBytes(16)
  if (salt.length !== 16) throw new Error(`盐值必须是 16 字节，实际 ${salt.length}`)
  const nonce = options.nonce ? toBuffer(options.nonce) : crypto.randomBytes(12)
  if (nonce.length !== 12) throw new Error(`nonce 必须是 12 字节，实际 ${nonce.length}`)

  const plain = Buffer.from(JSON.stringify(value ?? null), 'utf8')
  const key = deriveKey(password, salt, iterations)
  const cipher = crypto.createCipheriv('aes-256-gcm', key, nonce)
  const ciphertext = Buffer.concat([cipher.update(plain), cipher.final()])
  const authTag = cipher.getAuthTag()

  const header = Buffer.alloc(HEADER_SIZE)
  MAGIC.copy(header, 0)
  let cursor = MAGIC.length
  header.writeUInt8(KDF_ID_PBKDF2_SHA256, cursor); cursor += 1
  header.writeUInt8(CIPHER_ID_AES_256_GCM, cursor); cursor += 1
  header.writeUInt32BE(iterations, cursor); cursor += 4
  salt.copy(header, cursor); cursor += 16
  nonce.copy(header, cursor); cursor += 12
  authTag.copy(header, cursor)

  return Buffer.concat([header, ciphertext])
}

/**
 * 解密。密码错误时抛出"密码不正确"，
 * 而不是返回乱码——GCM 的认证标签能可靠区分这两种情况。
 */
export function decryptFromBuffer(buf, password) {
  const h = parseHeader(buf)
  if (typeof password !== 'string' || password.length === 0) {
    throw new Error('主密码不能为空')
  }
  const key = deriveKey(password, h.salt, h.iterations)
  let plain
  try {
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, h.nonce)
    decipher.setAuthTag(h.authTag)
    plain = Buffer.concat([decipher.update(h.payload), decipher.final()])
  } catch {
    // GCM 校验失败 = 密钥不对（也可能是文件被改动），两者都无法区分，
    // 但可以确定"不是有效的主密码或文件已损坏"
    throw new Error('密码不正确，或文件已损坏')
  }
  try {
    return JSON.parse(plain.toString('utf8'))
  } catch {
    throw new Error('解密成功但内容不是合法 JSON（文件可能已损坏）')
  }
}

/** 只验证密码是否正确，不返回内容（用于"解锁"前的探测） */
export function verifyPassword(buf, password) {
  try {
    decryptFromBuffer(buf, password)
    return true
  } catch {
    return false
  }
}