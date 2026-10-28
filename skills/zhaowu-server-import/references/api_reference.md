# 昭武工作台 · 服务器导入 API 参考

后端：`http://127.0.0.1:8787/api`（Windows 上 curl 一律加 `--noproxy 127.0.0.1`）
源码：`server/src/routes/servers.js`、`server/src/utils/serverQuickFill.js`、`server/src/utils/validation.js`

## 1. 解析：`POST /api/servers/quick-fill`

请求 `{ text: "..." }` → 响应 `{ ok, data: { fields, matched, notes } }`。

`fields` 可能出现的键（**只出现确实识别到的**）：

| 键 | 来源 |
|---|---|
| `name` | 键值块的「名称 / 服务器名称 / name」；没给时用 `host` 做建议值 |
| `host` | ssh 命令的目标、`user@host`、`HostName`、键值块的「IP / 公网IP / 域名 / 地址」 |
| `username` | `user@host`、`-l` / `--user`、`User` 指令、键值块「用户名 / 登录用户」 |
| `sshPort` | `-p` / `-P` / `--port`、`Port` 指令、键值块「端口 / SSH 端口」、host 里的 `:2222` |
| `keyPath` | `-i` / `--identityfile` / `IdentityFile` 指令 |
| `passwordEnv` | `--passwordfile` / `--pwfile` / `PasswordFile` 指令（**只接受引用，见第 4 节**） |
| `authType` | 有 `keyPath` → `key`；有 `passwordEnv` → `password` |
| `os` / `remark` | 键值块的「系统 / 操作系统」「备注 / 用途」 |

`matched` 取值：`SSH 命令`、`.ssh/config 配置`、`user@host 连接串`、`字段键值对`、`私钥路径`、`密码来源`。

`notes` 是**必须转述给用户**的取舍说明，典型三类：

- `「xxx」不像合法的 IP 或域名，已忽略，请手工填写`
- `文本里像是一段明文口令，已忽略（只接受环境变量名或凭据文件路径）`
- `文本里同时出现端口 22 与 2222，已采用 2222`

## 2. 建记录：`POST /api/servers`

必填 `name`、`host`。可提交字段（服务端 `sanitizeServerInput`）：

| 字段 | 类型 / 约束 | 默认 |
|---|---|---|
| `name` | 字符串 ≤120 | 必填 |
| `host` | 字符串 ≤200 | 必填 |
| `os` | 字符串 ≤80 | `''` |
| `sshPort` | 1–65535 | `22` |
| `remark` | 字符串 ≤500 | `''` |
| `user` | 字符串 ≤80（旧字段，`username` 优先） | `''` |
| `username` | 字符串 ≤80 | `root` |
| `authType` | `key` / `agent` / `password` | `key` |
| `keyPath` | 字符串 ≤400（**路径**） | `''` |
| `connectTimeout` | 毫秒，服务端夹到 2000–60000 | `8000` |
| `monitorEnabled` | 布尔 | `true` |
| `dockerMonitorEnabled` | 布尔 | `true` |
| `passwordEnv` | 字符串 ≤80（**环境变量名**） | `''` |
| `passphraseEnv` | 字符串 ≤80（**环境变量名**） | `''` |
| `logPaths` | 字符串数组（允许读取的远端日志路径） | `[]` |

## 3. 探活

| 方法 | 路径 | 说明 |
|---|---|---|
| POST | `/api/servers/:id/probe` | TCP 探活（不依赖 SSH），判断机器是否在线 |
| POST | `/api/servers/:id/probe-ssh` | SSH 只读监控：CPU / 内存 / 磁盘 / 监听端口 / Docker |
| POST | `/api/servers/probe-ssh` | 全部服务器采集（`{ force, staleMs }`） |

## 4. 安全红线（服务端强制，不是建议）

- 请求体里出现 `password` / `passphrase` / `privateKey` / `privateKeyContent` / `secret` / `keyContent` / `sshPassword` 且非空 → **400**，并提示改用 `DSM_SSH_PASSWORD_<服务器ID>` 或 `data/secrets.json`。
- 私钥只存路径（`keyPath`），连接时从磁盘读，**不入库**。
- `passwordEnv` / `passphraseEnv` 只存**变量名**；值放环境变量或 `data/secrets.json`（已 gitignore）。
- 解析器对明文口令与常见占位口令（`password` / `123456` / `changeme` …）一律丢弃并写进 `notes`。

## 5. 解析器行为细节（复现问题时看这里）

- **端口冲突**：`host` 里的 `:port` 优先级**高于**单独的端口字段（后解析的覆盖先解析的，并写 `notes`）。
- **IPv6**：`[2001:db8::1]:2222` 会拆成 `host=[2001:db8::1]`、`sshPort=2222`；方括号保留，否则会被 scp 规则误当 `host:path`。
- **scp**：`root@host:/tmp/x` 里的远程路径会被剥掉，只留 `host`。
- **`Host prod` 别名**：`.ssh/config` 的 `Host` 行**不**填进 `host`（那是别名不是地址），只认 `HostName`。
- **中文键名**：`公网IP`、`SSH 端口`、`IP地址`、`登录用户` 等都识别。
- **垃圾输入**：`!!!@@@###` 这类不构成合法主机的，`fields` 为空并给 note，**绝不硬凑**。

## 6. 自测样例

```bash
# 1) ssh 命令（端口 + 私钥 + 用户）
curl -s --noproxy 127.0.0.1 -X POST http://127.0.0.1:8787/api/servers/quick-fill \
  -H 'Content-Type: application/json' \
  -d '{"text":"ssh -p 2222 -i ~/.ssh/id_ed25519 deploy@203.0.113.10"}'
# 期望 fields: host / username=deploy / sshPort=2222 / keyPath=~/.ssh/id_ed25519 / authType=key / name

# 2) 云控制台块
curl -s --noproxy 127.0.0.1 -X POST http://127.0.0.1:8787/api/servers/quick-fill \
  -H 'Content-Type: application/json' \
  -d '{"text":"公网IP：203.0.113.10\nSSH端口：2222\n登录用户：deploy\n操作系统：Ubuntu 24.04"}'

# 3) 明文口令必须被丢弃
curl -s --noproxy 127.0.0.1 -X POST http://127.0.0.1:8787/api/servers/quick-fill \
  -H 'Content-Type: application/json' \
  -d '{"text":"HostName 203.0.113.10\nUser root\nPasswordFile hunter2"}'
# 期望 notes 里出现「明文口令…已忽略」，fields 里没有 passwordEnv
```
