/**
 * 服务器「快速填入」解析单元测试（纯函数，不联网、不依赖真实系统状态）：
 *   node server/test/server-quick-fill.test.mjs
 *
 * 覆盖：
 *   - SSH 命令：短选项（-p/-i/-l 及其分离写法）、长选项（--port/--user/--identityfile）、引号路径、shell 提示符残留
 *   - 裸连接串：user@host、user@host:port、IPv6
 *   - .ssh/config 片段：多行指令写法与单行键值写法
 *   - 云控制台字段块：中英文字段名
 *   - 安全口径：明文口令一律丢弃，只接受环境变量名 / 凭据文件路径这类"引用"
 *   - 不编造：非法端口、非法 host、看不懂的文本、空输入一律不产出字段
 */
import { parseServerQuickFill } from '../src/utils/serverQuickFill.js'

let passed = 0
const failures = []

function check(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failures.push({ name, detail })
    console.log(`  ✗ ${name}`, detail ?? '')
  }
}

function fields(text) {
  return parseServerQuickFill(text).fields
}

console.log('【SSH 命令】')
{
  const f = fields('ssh -p 2222 -i ~/.ssh/id_ed25519 root@203.0.113.10')
  check('解析 host', f.host === '203.0.113.10', f.host)
  check('解析端口', f.sshPort === '2222', f.sshPort)
  check('解析用户', f.username === 'root', f.username)
  check('解析私钥路径', f.keyPath === '~/.ssh/id_ed25519', f.keyPath)
  check('认证方式自动定为密钥', f.authType === 'key', f.authType)
}
{
  const f = fields('ssh -p 2222 -i C:\\Users\\me\\.ssh\\id_rsa deploy@10.0.0.5')
  check('Windows 私钥路径原样保留', f.keyPath === 'C:\\Users\\me\\.ssh\\id_rsa', f.keyPath)
  check('解析用户', f.username === 'deploy', f.username)
}
{
  const f = fields('ssh -p 22 -l deploy 203.0.113.10')
  check('-l 写法解析用户', f.username === 'deploy', f.username)
  check('-l 写法解析 host', f.host === '203.0.113.10', f.host)
}
{
  const f = fields('ssh -i "/home/me/.ssh/my key" root@example.com')
  check('带空格的引号路径不被拆散', f.keyPath === '/home/me/.ssh/my key', f.keyPath)
}
{
  const f = fields('ssh --port=2222 --user=ops --identityfile=~/.ssh/id_ed25519 build.example.com')
  check('长选项等号写法：端口', f.sshPort === '2222', f.sshPort)
  check('长选项等号写法：用户', f.username === 'ops', f.username)
  check('长选项等号写法：私钥', f.keyPath === '~/.ssh/id_ed25519', f.keyPath)
}
{
  const f = fields('ssh --port 2200 --user ops example.com')
  check('长选项分离写法：端口', f.sshPort === '2200', f.sshPort)
  check('长选项分离写法：用户', f.username === 'ops', f.username)
}
check('shell 提示符残留不影响解析', fields('$ ssh root@192.168.1.10').host === '192.168.1.10', fields('$ ssh root@192.168.1.10'))
check('scp 命令同样识别', fields('scp -P 2222 ./a.txt root@203.0.113.10:/tmp/').host === '203.0.113.10', fields('scp -P 2222 ./a.txt root@203.0.113.10:/tmp/'))

console.log('\n【裸连接串】')
check('user@host', fields('deploy@203.0.113.10').host === '203.0.113.10', fields('deploy@203.0.113.10'))
check('user@host:port 拆出端口', fields('deploy@203.0.113.10:2022').sshPort === '2022', fields('deploy@203.0.113.10:2022'))
check('user@host:port 拆出用户', fields('deploy@203.0.113.10:2022').username === 'deploy', fields('deploy@203.0.113.10:2022'))
check('IPv6 带方括号保留', fields('ssh -p 2222 root@[2001:db8::1]').host === '[2001:db8::1]', fields('ssh -p 2222 root@[2001:db8::1]'))
check('内网短主机名可用', fields('deploy@intranet').host === 'intranet', fields('deploy@intranet'))
check('域名可用', fields('root@api.example.com').host === 'api.example.com', fields('root@api.example.com'))
check('host 必填时给出建议名称', fields('deploy@203.0.113.10').name === '203.0.113.10', fields('deploy@203.0.113.10').name)

console.log('\n【.ssh/config 片段】')
{
  const f = fields('Host prod\n  HostName 203.0.113.10\n  User deploy\n  Port 2222\n  IdentityFile ~/.ssh/id_ed25519')
  check('解析 HostName', f.host === '203.0.113.10', f.host)
  check('解析 User', f.username === 'deploy', f.username)
  check('解析 Port', f.sshPort === '2222', f.sshPort)
  check('解析 IdentityFile', f.keyPath === '~/.ssh/id_ed25519', f.keyPath)
}
{
  const f = fields('HostName=203.0.113.10\nUser=deploy\nPort=2200')
  check('单行键值写法', f.host === '203.0.113.10' && f.username === 'deploy' && f.sshPort === '2200', f)
}
check('注释行不影响解析', fields('Host prod\n  # 这是注释\n  HostName 1.2.3.4').host === '1.2.3.4', fields('Host prod\n  # 这是注释\n  HostName 1.2.3.4'))

console.log('\n【云控制台字段块】')
{
  const f = fields('名称：生产主库\nIP 地址：203.0.113.10\nSSH 端口：22\n用户名：root\n操作系统：Ubuntu 22.04')
  check('中文名称', f.name === '生产主库', f.name)
  check('中文 IP 字段', f.host === '203.0.113.10', f.host)
  check('中文 SSH 端口字段', f.sshPort === '22', f.sshPort)
  check('中文用户名字段', f.username === 'root', f.username)
  check('中文系统字段', f.os === 'Ubuntu 22.04', f.os)
  check('「SSH 端口」不被误判成 ssh 命令', f.name === '生产主库', f.name)
}
{
  const f = fields('Name: prod-web\nIP: 203.0.113.10\nUsername: deploy\nOS: Debian 12')
  check('英文字段块', f.name === 'prod-web' && f.host === '203.0.113.10' && f.username === 'deploy' && f.os === 'Debian 12', f)
}

console.log('\n【安全：永不保存密码】')
{
  const r = parseServerQuickFill('ssh root@1.2.3.4 --passwordfile mySecretPassword123')
  check('明文口令不产出 passwordEnv', !('passwordEnv' in r.fields), r.fields)
  check('明文口令有明确提示', r.notes.some((n) => n.includes('明文口令')), r.notes)
}
check('占位口令被忽略', !('passwordEnv' in fields('ssh root@1.2.3.4 --passwordfile your_password')), fields('ssh root@1.2.3.4 --passwordfile your_password'))
check('password 字段本身也拒绝', !('password' in fields('ssh root@1.2.3.4')), fields('ssh root@1.2.3.4'))
{
  const f = fields('ssh root@1.2.3.4 --passwordfile DSM_SSH_PASSWORD_PROD')
  check('环境变量名作为密码来源被接受', f.passwordEnv === 'DSM_SSH_PASSWORD_PROD', f.passwordEnv)
  check('认证方式自动定为密码', f.authType === 'password', f.authType)
}
{
  const f = fields('ssh root@1.2.3.4 --passwordfile ~/.ssh/secrets.json')
  check('凭据文件路径被接受', f.passwordEnv === '~/.ssh/secrets.json', f.passwordEnv)
}

console.log('\n【不编造：识别不出就不产出字段】')
{
  const r = parseServerQuickFill('ssh -p 99999 root@203.0.113.10')
  check('非法端口被丢弃', !('sshPort' in r.fields), r.fields)
  check('非法端口有提示', r.notes.some((n) => n.includes('端口')), r.notes)
  check('其余字段仍正常解析', r.fields.host === '203.0.113.10', r.fields)
}
{
  const r = parseServerQuickFill('!!!!@@@###')
  check('垃圾文本不产出 host', !('host' in r.fields), r.fields)
  check('垃圾文本有提示', r.notes.length > 0, r.notes)
  // host 是乱码说明整段都不是服务器配置：残留的 username/sshPort 会把脏数据带进表单
  check('垃圾文本一个字段都不产出', Object.keys(r.fields).length === 0, r.fields)
}
check('非法 IPv4 被拒绝', !('host' in fields('deploy@999.999.999.999')), fields('deploy@999.999.999.999'))
check('完全看不懂的文本不产出字段', Object.keys(fields('随便一段跟服务器无关的文字')).length === 0, fields('随便一段跟服务器无关的文字'))
check('空输入不崩', Object.keys(fields('')).length === 0)
check('null 不崩', Object.keys(fields(null)).length === 0)
check('undefined 不崩', Object.keys(fields(undefined)).length === 0)
check('纯注释不产出字段', Object.keys(fields('# 这是我的配置\n# Host prod')).length === 0, fields('# 这是我的配置\n# Host prod'))

console.log('\n【字段名与前端约定一致】')
{
  const f = fields('ssh -p 2222 -i ~/.ssh/id_ed25519 root@203.0.113.10')
  const allowed = new Set(['name', 'host', 'os', 'sshPort', 'username', 'authType', 'keyPath', 'passwordEnv', 'remark'])
  const unexpected = Object.keys(f).filter((k) => !allowed.has(k))
  check('不产出前端表单以外的字段', unexpected.length === 0, unexpected)
}

console.log(`\n结果：通过 ${passed} 项，失败 ${failures.length} 项`)
if (failures.length > 0) {
  console.log(JSON.stringify(failures.slice(0, 12), null, 2))
  process.exitCode = 1
}