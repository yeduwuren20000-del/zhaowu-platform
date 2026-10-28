---
name: zhaowu-server-import
description: 把一段"服务器连接信息"（ssh 命令行、云控制台复制的字段块、.ssh/config 片段、user@host:port 连接串）解析成昭武工作台新增服务器表单的全部字段，并直接调 API 一键建好服务器记录。当用户说「帮我加个服务器」「把这台机器导进工作台」「一键配置 SSH」「快速嵌入」，或直接粘来 ssh 命令 / IP+端口+用户名 时使用。
---

# 昭武工作台 · 服务器一键导入

把「一段连接文本」变成「一条能用、能探活的工作台服务器记录」。

## 三条红线（后面每一步都受它约束）

1. **绝不保存密码或私钥正文**。后端会直接 400 拒收 `password` / `passphrase` / `privateKey` / `keyContent` / `sshPassword` 等字段。只能写 `keyPath`（**路径**，`~/...` 可保留）和 `passwordEnv` / `passphraseEnv`（**环境变量名**，不是值）。
2. **不猜**。解析不出来就问用户，不要编造 host / 用户名 / 端口。宁可少填，不可填错。
3. **只填空的**。用户已经手工填过的值不覆盖；提交前把「识别到什么」摊开给用户看。

## 环境

| 项 | 值 |
|---|---|
| 工作台根目录 | 本仓库根目录（`package.json` 所在处）。不知道在哪就问用户，或用 `ZHAOWU_HOME` 覆盖 |
| 后端 API | `http://127.0.0.1:8787/api` |
| 探活 | `GET /api/health` |

> **Windows 必读**：`curl` 一律带 `--noproxy 127.0.0.1`。本机开着代理时回环请求会被劫持成 502，看起来像后端挂了。

后端没起来就拉起来（用工作台自己的入口，不要另写一套）：

```bash
# 在仓库根目录执行（端口被占用就不用重复起）
node server/src/index.js &
```

## 三步走

### 第 1 步：解析（用工作台自己的解析器）

**不要自己写正则**——`server/src/utils/serverQuickFill.js` 已经覆盖了端口冲突、IPv6 方括号、scp 路径、中文键名等一堆坑，直接调它：

```bash
curl -s --noproxy 127.0.0.1 -X POST http://127.0.0.1:8787/api/servers/quick-fill \
  -H 'Content-Type: application/json' \
  -d '{"text":"ssh -p 2222 -i ~/.ssh/id_ed25519 deploy@203.0.113.10"}'
```

返回 `{ fields, matched, notes }`：

| 键 | 含义 | 怎么用 |
|---|---|---|
| `fields` | **只含确实识别到的**字段 | 直接映射到下面的 schema |
| `matched` | 命中的输入形态 | 用来告诉用户「我按 SSH 命令解析的」 |
| `notes` | 解析过程中的取舍（明文口令已忽略、端口冲突取哪个…） | **原样转述**，不要自己吞掉 |

### 第 2 步：补全默认值 + 让用户确认

拿 `fields` 对照 schema，缺的**必填项问用户**，可选的用默认值并说明：

| 字段 | 必填 | 默认 | 约束 / 说明 |
|---|---|---|---|
| `name` | ✅ | 取 `host` | 服务器名称，≤120 字；用户给了别名就用别名 |
| `host` | ✅ | — | IP / 域名，≤200 字；**不能带 `user@`、不能带端口** |
| `username` | | `root` | 登录用户，≤80 字 |
| `sshPort` | | `22` | 1–65535 整数 |
| `authType` | | `key` | `key` / `agent` / `password` |
| `keyPath` | 当 `authType=key` | — | 私钥**路径**，≤400 字，支持 `~/...` |
| `passwordEnv` | 当 `authType=password` | — | 环境变量**名**（如 `DSM_SSH_PASSWORD_<服务器ID>`），≤80 字 |
| `passphraseEnv` | | — | 私钥口令的环境变量**名** |
| `os` | | 空 | 如 `Ubuntu 24.04`、`Debian 12` |
| `connectTimeout` | | `8000` | 毫秒，服务端会夹到 2000–60000 |
| `monitorEnabled` | | `true` | SSH 只读监控（CPU/内存/磁盘/端口） |
| `dockerMonitorEnabled` | | `true` | 顺带采集远端 Docker |
| `remark` | | 空 | 备注，≤500 字 |
| `logPaths` | | `[]` | 远端日志路径数组 |

确认话术要**一条消息说完三件事**：识别到什么 / 我补了哪些默认值 / 还缺什么。让用户一眼能改。

### 第 3 步：建记录 + 必做探活

```bash
curl -s --noproxy 127.0.0.1 -X POST http://127.0.0.1:8787/api/servers \
  -H 'Content-Type: application/json' \
  -d '{"name":"prod","host":"203.0.113.10","username":"deploy","sshPort":2222,"authType":"key","keyPath":"~/.ssh/id_ed25519","connectTimeout":8000,"monitorEnabled":true,"dockerMonitorEnabled":true}'
```

拿到 `id` 后**两层探活都跑**，不做完不许说"配好了"：

```bash
# TCP 探活（不依赖 SSH，先确认机器活着）
curl -s --noproxy 127.0.0.1 -X POST http://127.0.0.1:8787/api/servers/<id>/probe
# SSH 只读监控（真的登进去拿指标）
curl -s --noproxy 127.0.0.1 -X POST http://127.0.0.1:8787/api/servers/<id>/probe-ssh
```

探活失败要分清三种情况，别一句"连不上"打发：

- `timeout` / 连接被拒 → 网络或端口不对（云安全组、防火墙）
- `Permission denied (publickey)` → keyPath 指错、私钥权限不对（Windows 上 `.ssh` 目录 ACL 也会导致）、或远端没配 authorized_keys
- `Host key verification failed` → 首次连接需要用户确认指纹，让用户在终端先手动连一次

## 输入形态对照

| 用户粘来的东西 | 解析结果 | 注意 |
|---|---|---|
| `ssh root@1.2.3.4` | host=1.2.3.4, username=root | 端口用默认 22 |
| `ssh -p 2222 -i ~/.ssh/id_ed25519 deploy@host` | 端口/私钥/用户全中，`authType=key` | 私钥只取路径 |
| `deploy@host:2222` | 裸连接串 | 没 `ssh` 前缀也认 |
| 云控制台块（公网IP/端口/用户名/系统，一行一个） | 键值对，中英文字段名都认 | `主机：1.2.3.4:22` 会把端口拆出来 |
| `.ssh/config` 片段 | 认 `HostName`/`User`/`Port`/`IdentityFile` | `Host prod` 的别名本身不填进 host |
| `ssh -p 22 root@h` + 明文口令 | 口令**被丢弃** + `notes` 提示 | 要问用户想用 `passwordEnv` 还是私钥 |
| `!!!@@@###` 之类垃圾 | `fields` 为空 + 提示没识别到 | 直接转手工填，不要硬凑 |

## 不要做

- ❌ 把私钥正文、明文口令塞进请求体（400，且是安全错误）
- ❌ 为了"看起来成功"跳过探活
- ❌ 没明确指令就 `PUT /api/servers/:id` 改用户已有记录
- ❌ 自己重新实现解析规则（会和前端"快速嵌入"行为不一致，用户会看到两套结果）

## 参考

- `references/api_reference.md` — 四个端点 + 解析器完整规则 + 字段约束
- 源码：`server/src/utils/serverQuickFill.js`、`server/src/utils/validation.js`、`server/src/routes/servers.js`
