/**
 * 服务器「快速填入」：把用户手上常见的一段文本（终端里的 ssh 命令、云控制台的连接信息、
 * .ssh/config 片段）拆成表单字段。
 *
 * 设计口径：
 * - **只做识别与拆分，不猜**。解析不出就如实告诉用户缺哪一项，不编造主机名/用户名。
 * - **只填空的不覆盖**。已经手工填过的字段保持原样，避免把用户改过的内容冲掉。
 * - 纯函数、无副作用，方便单测锁住各种真实粘贴样本。
 */

/** 常见弱口令/占位口令——识别出来直接忽略，绝不当成"用户提供的信息" */
const PLACEHOLDER_PASSWORDS = new Set([
  'password', 'passwd', 'pass', '123456', '12345678', 'admin', 'root', 'test', 'xxx',
  'your_password', 'yourpassword', 'mypassword', 'changeme', 'secret', 'none', 'null',
  '***', '***password', 'xxxx', 'abc123', 'qwerty', 'toor',
])

function clean(value) {
  return String(value ?? '').trim().replace(/^["']|["']$/g, '').trim()
}

/** host:port 里把端口切出来，顺带处理 IPv6 的 [::1]:22 */
function splitHostPort(raw) {
  const text = clean(raw)
  // IPv6：[::1]:2222 —— 必须先判，否则下面的 scp 路径剥离会把 [2001:db8::1] 当成 host:path
  const bracketed = text.match(/^\[(.+)\]:(\d+)$/)
  if (bracketed) return { host: `[${bracketed[1]}]`, port: Number(bracketed[2]) }
  // 纯 IPv6 字面量（带方括号、无端口）：原样保留，别被 scp 规则剥掉
  if (/^\[[0-9a-f:.]+\]$/i.test(text)) return { host: text, port: null }
  // scp 的目标形如 root@host:/path/to —— 把远程路径去掉
  const scp = text.match(/^([^:/]+):(?!\/\/)(.+)$/)
  const rest = scp ? scp[1] : text
  if (!rest) return { host: '', port: null }
  const lastColon = rest.lastIndexOf(':')
  if (lastColon > 0 && !rest.slice(lastColon + 1).includes(':')) {
    const maybePort = rest.slice(lastColon + 1)
    if (/^\d{1,5}$/.test(maybePort)) {
      return { host: rest.slice(0, lastColon), port: Number(maybePort) }
    }
  }
  return { host: rest, port: null }
}

/** 私钥路径：把 ~ 与 Windows 路径都认下来 */
function normalizeKeyPath(raw) {
  const text = clean(raw).replace(/^["']|["']$/g, '')
  if (!text) return ''
  if (text === '~' || text.startsWith('~/')) return text
  return text
}

function isPlaceholderPassword(raw) {
  const text = clean(raw).toLowerCase()
  if (!text) return true
  return PLACEHOLDER_PASSWORDS.has(text)
}

/** 看起来像"引用"的密码来源：环境变量名，或指向凭据文件的路径 */
function isPasswordReference(raw) {
  const text = clean(raw)
  if (!text) return false
  if (isPlaceholderPassword(text)) return false
  // 环境变量名：DSM_SSH_PASSWORD_XXX / MY_PASS
  if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(text) && /^[A-Z0-9_]+$/.test(text)) return true
  // 凭据文件路径
  if (/^(~|\.{0,2}[\\/]|[A-Za-z]:[\\/]|\/)/.test(text) && /\.(json|txt|env|ini|conf)$/i.test(text)) return true
  return false
}

/**
 * 解析 ssh 命令行：
 *   ssh -p 2222 -i ~/.ssh/id_ed25519 root@203.0.113.10
 *   ssh user@host -p 22
 *   ssh -p22 -l deploy 203.0.113.10
 */
function parseSshCommand(text) {
  const out = {}
  const body = text.replace(/^[\s$#>]*(?:ssh|scp|sftp)\s+/i, '')
  const tokens = body.match(/"[^"]*"|'[^']*'|\S+/g) || []
  const positional = []

  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i]
    if (!token) continue
    // 短选项：-p/-i/-l/-o 等（scp 用大写 -P 表示端口）
    const short = token.match(/^-([pilLP])(.+)$/)
    if (short) {
      const flag = short[1].toLowerCase()
      const inline = short[2]
      const next = () => (inline ? inline : tokens[++i])
      if (flag === 'p') out.sshPort = next()
      else if (flag === 'i') out.keyPath = next()
      else if (flag === 'l') out.username = next()
      continue
    }
    // 短选项分离写法：-p 2222 / -i ~/.ssh/id_rsa
    if (/^-[pilP]$/.test(token)) {
      const flag = token.slice(1).toLowerCase()
      const next = () => tokens[++i]
      if (flag === 'p') out.sshPort = next()
      else if (flag === 'i') out.keyPath = next()
      else if (flag === 'l') out.username = next()
      continue
    }
    // 长选项
    const long = token.match(/^--(\S+?)(?:=(.*))?$/)
    if (long) {
      const key = long[1].toLowerCase()
      const value = long[2] !== undefined ? long[2] : tokens[++i]
      if (key === 'port') out.sshPort = value
      else if (key === 'identityfile') out.keyPath = value
      else if (key === 'user' || key === 'l') out.username = value
      else if (key === 'passwordfile' || key === 'pwfile') out.passwordEnv = value
      continue
    }
    positional.push(token)
  }

  if (positional.length > 0) {
    // scp 可能先跟本地路径（./a.txt），真正的目标是带 @ 或含 : 的那个
    const target =
      positional.find((t) => t.includes('@')) ||
      positional.find((t) => t.includes(':')) ||
      positional[0]
    // user@host 形式；用户名不允许含 [ ]（否则 IPv6 的方括号会被吃进用户名）
    const at = target.match(/^([^\s@[\]]+)@(.+)$/)
    if (at) {
      if (!out.username) out.username = clean(at[1])
      out.host = clean(at[2])
    } else {
      out.host = clean(target)
    }
  }
  return out
}

/**
 * 解析 .ssh/config 片段：
 *   Host prod
 *     HostName 203.0.113.10
 *     User deploy
 *     Port 2222
 *     IdentityFile ~/.ssh/id_ed25519
 * 也解析单行 `HostName=203.0.113.10` 这种键值对写法。
 */
function parseSshConfig(text) {
  const out = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const kv = line.match(/^([A-Za-z]+)\s*=\s*(.+)$/) || line.match(/^([A-Za-z]+)\s+(.+)$/)
    if (!kv) continue
    const key = kv[1].toLowerCase()
    const value = clean(kv[2])
    if (!value) continue
    if (key === 'hostname') out.host = value
    else if (key === 'user') out.username = value
    else if (key === 'port') out.sshPort = value
    else if (key === 'identityfile') out.keyPath = value
    else if (key === 'passwordfile' || key === 'pwfile') out.passwordEnv = value
  }
  return out
}

/** 解析云控制台那种"一行一字段"的纯文本块（字段名可能是中英文） */
function parseKeyValueLines(text) {
  const labelMap = {
    名称: 'name', 服务器名称: 'name', name: 'name', 主机名: 'host', 地址: 'host',
    ip: 'host', ip地址: 'host', 'ip 地址': 'host', 公网ip: 'host', 公网ip地址: 'host',
    '公网 ip': 'host', ipv4: 'host', ipv4地址: 'host', 域名: 'host', host: 'host', hostname: 'host',
    端口: 'sshPort', ssh端口: 'sshPort', 'ssh 端口': 'sshPort', port: 'sshPort',
    用户名: 'username', 用户: 'username', username: 'username', user: 'username', 登录用户: 'username',
    系统: 'os', 操作系统: 'os', os: 'os', 备注: 'remark', 用途: 'remark', remark: 'remark',
  }
  const out = {}
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line) continue
    // 支持 "主机：203.0.113.10" / "主机: 203.0.113.10" / "Host = 203.0.113.10"
    // 标签允许含空格与点（IP 地址、SSH 端口、IPv4 地址），但不能以分隔符开头
    const kv = line.match(/^([^\s:：=][^\s:：=]{0,11}(?:[\s]+[^\s:：=]{1,6})?)\s*[:：=]\s*(.+)$/)
    if (!kv) continue
    const rawKey = kv[1].trim()
    const key = labelMap[rawKey] || labelMap[rawKey.toLowerCase()] || labelMap[rawKey.replace(/\s+/g, '')]
    const value = clean(kv[2])
    if (!key || !value) continue
    if (key === 'host') {
      const { host, port } = splitHostPort(value)
      out.host = host
      if (port) out.sshPort = String(port)
    } else {
      out[key] = value
    }
  }
  return out
}

/**
 * host 是否像真的主机：IPv4 / 域名 / 带方括号的 IPv6。
 * 用于挡掉「!!!@@@###」这类被当成 user@host 的垃圾输入——
 * 宁可识别失败让用户手填，也不要把乱码当成主机名填进去。
 */
function isPlausibleHost(raw) {
  const text = clean(raw)
  if (!text || text.length > 253) return false
  // IPv6（带方括号或裸写法）
  if (/^\[[0-9a-f:.]+\]$/i.test(text)) return true
  if (/^[0-9a-f:]*:[0-9a-f:.]+$/i.test(text) && (text.match(/:/g) || []).length >= 2) return true
  // IPv4
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(text)) {
    return text.split('.').every((part) => Number(part) >= 0 && Number(part) <= 255)
  }
  // 域名：标签由字母数字与连字符组成，顶级标签至少 2 个字母，也允许单个 label 的内网主机名
  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)*$/i.test(text)) return false
  return text.includes('.') ? /[a-z]{2,}$/i.test(text) : true
}

/**
 * 主入口：识别文本形态并拆解。
 * @returns {{ fields: object, matched: string[], notes: string[] }}
 *   fields 只包含**确实识别到**的字段；notes 是给用户看的解释。
 */
export function parseServerQuickFill(text) {
  const raw = String(text ?? '').trim()
  const empty = { fields: {}, matched: [], notes: [] }
  if (!raw) return empty

  const fields = {}
  const matched = []
  const notes = []

  // 形态 1：包含 ssh 命令
  // 后面必须跟一个非中文的选项或主机名，否则「SSH 端口：22」这种中文字段名会被误判成命令
  if (/(?:^|\n)\s*(?:[$\-*>]\s*)?(?:ssh|scp|sftp)\s+[^\u4e00-\u9fff]/i.test(raw)) {
    Object.assign(fields, parseSshCommand(raw))
    matched.push('SSH 命令')
  }
  // 形态 2：.ssh/config 片段（出现 HostName 或 IdentityFile 等指令）
  if (!fields.host && /(hostname|identityfile|user)\s*[= ]/i.test(raw) && !/^host\s+\S+$/im.test(raw.replace(/^\s*host\s+\S+$/im, ''))) {
    const configFields = parseSshConfig(raw)
    if (Object.keys(configFields).length > 0) {
      Object.assign(fields, configFields)
      matched.push('.ssh/config 配置')
    }
  }
  // 形态 3：裸 user@host:port（没有 ssh 前缀）
  if (!fields.host && !matched.length) {
    const bare = raw.match(/^([^\s@]+)@([^\s:]+)(?::(\d{1,5}))?$/)
    if (bare) {
      fields.username = clean(bare[1])
      fields.host = clean(bare[2])
      if (bare[3]) fields.sshPort = bare[3]
      matched.push('user@host 连接串')
    }
  }
  // 形态 4：多行键值对（云控制台复制出来的字段块）
  if (!fields.host) {
    const kvFields = parseKeyValueLines(raw)
    if (Object.keys(kvFields).length > 0) {
      Object.assign(fields, kvFields)
      matched.push('字段键值对')
    }
  }

  // host 里的 :port 统一拆出来
  if (fields.host) {
    const { host, port } = splitHostPort(fields.host)
    fields.host = host
    if (port) {
      if (fields.sshPort && Number(fields.sshPort) !== port) {
        notes.push(`文本里同时出现端口 ${fields.sshPort} 与 ${port}，已采用 ${port}`)
      }
      fields.sshPort = String(port)
    }
  }

  // host 必须像真的主机名；不像就整个丢弃，绝不把乱码当成主机填进去
  if (fields.host !== undefined) {
    if (!isPlausibleHost(fields.host)) {
      notes.push(`「${fields.host}」不像合法的 IP 或域名，已忽略，请手工填写`)
      // 整个结果一起丢：host 都是乱码，说明这段文本不是服务器配置，
      // 残留的 username/sshPort 只会把垃圾数据带进表单（实测 `!!!@@@###` 会留下 username: "!!!"）
      for (const key of Object.keys(fields)) delete fields[key]
    }
  }

  // 清理与丢弃
  if (fields.keyPath !== undefined) {
    fields.keyPath = normalizeKeyPath(fields.keyPath)
    if (!fields.keyPath) delete fields.keyPath
    else {
      fields.authType = 'key'
      matched.push('私钥路径')
    }
  }
  if (fields.passwordEnv !== undefined) {
    const value = clean(fields.passwordEnv)
    // 只接受"引用"（环境变量名 / 凭据文件路径）；明文口令与占位口令一律丢弃——配置里永不保存密码
    if (!isPasswordReference(value)) {
      if (value && !isPlaceholderPassword(value)) {
        notes.push('文本里像是一段明文口令，已忽略（只接受环境变量名或凭据文件路径）')
      }
      delete fields.passwordEnv
    } else {
      fields.authType = 'password'
      matched.push('密码来源')
    }
  }
  if (fields.sshPort !== undefined) {
    const port = Number(fields.sshPort)
    if (Number.isInteger(port) && port >= 1 && port <= 65535) fields.sshPort = String(port)
    else {
      notes.push(`端口「${fields.sshPort}」不是 1-65535 的整数，已忽略`)
      delete fields.sshPort
    }
  }
  if (fields.username !== undefined) {
    fields.username = clean(fields.username)
    if (!fields.username) delete fields.username
  }
  if (!fields.authType && (fields.keyPath || fields.passwordEnv)) {
    fields.authType = fields.keyPath ? 'key' : 'password'
  }
  if (!fields.name && fields.host) {
    // 名称只做"可编辑的建议值"，不写死成 host
    fields.name = fields.host
  }

  // 去重 matched
  const uniqueMatched = [...new Set(matched)]
  if (!Object.keys(fields).length && !uniqueMatched.length) {
    notes.push('没能从这段文本里识别出可用信息，可直接手工填写')
  }
  return { fields, matched: uniqueMatched, notes }
}

export default parseServerQuickFill