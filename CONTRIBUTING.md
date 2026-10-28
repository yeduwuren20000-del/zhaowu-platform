# 贡献指南

感谢你想让这个项目更好。开始前请先读一遍这一页，能省掉大部分来回。

## 适合贡献什么

- 修复 bug、补测试、改进 Windows/Linux 端口与进程采集的兼容性。
- 识别规则的补充（新框架 / 新运行时），但必须**同时给出判定依据**，不接受"看起来像"的猜测式规则。
- 文档、界面细节、错误提示的中文表达。

如果你打算新增一个功能方向（比如接入云厂商 API、加数据库、做后台常驻轮询），先开 Issue 说清楚场景再动手——本项目有意保持"本地、只读采集、零数据库、不常驻轮询"这几条边界。

## 开发环境

- Windows 10/11（CI 同样跑 windows-latest）+ Node.js 18 以上；本项目在 Node 20 / 22 / 24 上验证过。
- 不需要任何全局工具，`npm` + Git 即可。

```bash
npm run install:all   # 安装 server/ 与 web/ 依赖
npm run dev           # 后端 8787 + 前端 5180（热更新）
npm start             # 生产式：构建前端 + 单端口 8787
npm test              # 全部测试，并汇总断言数
npm run ui            # 逐页截图 + 收集控制台错误（需本机 Chrome/Edge）
```

## 目录与分层

```
server/src/store/     数据读写（JSON 仓储，原子写）
server/src/services/  业务与采集逻辑
server/src/routes/    HTTP 接口（只做参数校验与转发）
web/src/{pages,components,hooks,api,styles,utils}
```

请保持这条依赖方向：routes → services → store。不要在 routes 里直接读写文件，也不要在 store 里调用 services。

## 硬性约束（改代码前先看）

1. **不引入数据库。** 持久化只有 `data/*.json`，走 `createJsonStore`。
2. **不执行任意命令。** SSH 侧只能跑仓库里写死的只读脚本；Docker 侧只能跑查询类命令。新增采集项必须说明它为什么是只读的。
3. **凭据不落库。** 密码、私钥口令、AI Key 只能来自环境变量或 `data/secrets.json`，绝不能出现在 `servers.json`、日志或事件里。提交带明文凭据的字段会被后端拒绝，这是特性不是 bug。
4. **事实字段不可伪造。** `pid` / `port` / `address` / `processName` / `exePath` / `commandLine` / `startedAt` 只能来自系统采集，请求体与 AI 建议都不能覆盖。
5. **不新增后台高频轮询。** 状态比对发生在视图刷新时；时间线靠状态指纹去抖，不做每秒快照。
6. **任何阶段的改动都要让全部测试通过。** 新增能力时补对应测试，别只改实现。

## 测试要求

- 测试放在 `server/test/`，命名 `*.test.mjs`，`npm test` 会自动收进去。
- 约定：用 `os.tmpdir()` + `DSM_DATA_DIR` 隔离数据，自己起需要的临时进程，结束时无条件清理子进程。
- 断言用现成的 `check(name, condition, detail)`，最后一行输出 `结果：通过 N 项，失败 M 项`（`scripts/test.mjs` 依赖这行做汇总）。
- 涉及远程的能力一律用 `server/test/ssh-fixture-server.mjs`（本地假 Linux）与 `server/test/fixtures/` 里的固定输出，**测试不得连真实服务器或依赖本机状态**。

跑单个文件：`node server/test/events.test.mjs`；按名字过滤：`npm test -- events`。

## 提交与分支

- 一个 PR 只做一件事；`git status` 确认没有把 `data/` 里的东西带进去。
- Commit message 用动词开头说清变化（`fix: 原子写临时文件名冲突` / `test: 补 Docker 变化事件断言`）。
- 界面改动请附 `npm run ui` 生成的截图，并在描述里说明你实际点过哪些路径。

## 版本与发布

版本号遵循语义化版本，三处必须同步：根 `package.json`、`server/package.json`、`web/package.json`，外加 `CHANGELOG.md` 的新条目。发版时打 `vX.Y.Z` 标签，Release 正文从 CHANGELOG 复制，不要另写一份。

## 隐私

不要在任何 Issue、PR、截图、日志里贴：真实公网 IP、用户名、密码、Token、私钥内容、`data/` 下的真实文件。示例统一使用 RFC 5737 的文档保留地址（`203.0.113.x`、`198.51.100.x`）和通用路径（`D:\projects\my-app`）。

README 里的界面截图必须在**全新克隆**（只有示例数据的环境）上生成，不要在开发机上直接截——那会把真实项目名、真实目录、真实进程命令行带进版本库。

```bash
node server/test/ui-snapshot.mjs http://127.0.0.1:8787 docs   # 输出到 docs/
```

## 许可

提交即表示你同意你的贡献以 MIT 许可证随本项目一起发布。
