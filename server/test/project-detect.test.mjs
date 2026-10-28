/**
 * 项目目录识别单元测试（纯函数 + 临时目录，不联网、不执行任何项目脚本）：
 *   node server/test/project-detect.test.mjs
 *
 * 覆盖：
 *   - Node 项目：dev 脚本优先、端口从脚本文本里读、pnpm/yarn 提示
 *   - Docker Compose：容器化启停 + 发布端口
 *   - Python：manage.py（Django）/ 入口文件兜底 / 没有入口时的诚实说明
 *   - 空目录、坏目录、空输入：不编造
 *   - 产出字段必须是前端表单认得的键（与 sanitizeProjectInput 对齐）
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { inspectProjectDir, guessPortFromCommand } from '../src/services/projectInspect.js'

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'dsm-pdetect-'))

let passed = 0
const failures = []

function check(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failures.push({ name, detail })
    console.log(`  ✗ ${name}${detail !== undefined ? ' -> ' + JSON.stringify(detail) : ''}`)
  }
}

/** 造一个项目目录并写入文件，返回目录路径 */
function makeProject(name, files) {
  const dir = path.join(TMP, name)
  fs.mkdirSync(dir, { recursive: true })
  for (const [file, content] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, file), content)
  }
  return dir
}

console.log('【Node 项目】')
{
  const dir = makeProject('vite-app', {
    'package.json': JSON.stringify({
      name: 'family-album-web',
      scripts: { dev: 'vite --port 5173', start: 'vite preview' },
      devDependencies: { vite: '^5.0.0', react: '^18.0.0' },
    }),
    'vite.config.ts': 'export default {}',
  })
  const r = inspectProjectDir(dir)
  check('空目录之外的输入不报错', r.ok === true, r)
  check('名称取自 package.json', r.fields.name === 'family-album-web', r.fields.name)
  check('类型识别为前端', r.fields.type === '前端', r.fields.type)
  check('启动命令取 dev 脚本（优先于 start）', r.fields.startCommand === 'npm run dev', r.fields.startCommand)
  check('端口从脚本文本里读出', r.fields.port === 5173, r.fields.port)
  check('访问地址按端口生成', r.fields.url === 'http://localhost:5173', r.fields.url)
  check('候选命令含 dev 与 start', r.candidates.startCommand.map((c) => c.command).join(' ') === 'npm run dev npm run start', r.candidates.startCommand)
  check('说明里点名了脚本来源', r.notes.some((n) => n.includes('dev') && n.includes('package.json')), r.notes)
  check('matched 记录读到的文件', r.matched.includes('package.json') && r.matched.includes('vite.config.ts'), r.matched)
}
{
  const dir = makeProject('node-no-dev', {
    'package.json': JSON.stringify({ name: 'worker', scripts: { build: 'tsc' }, dependencies: { express: '^4.0.0' } }),
  })
  const r = inspectProjectDir(dir)
  check('没有 dev/start 脚本时不编造启动命令', !('startCommand' in r.fields), r.fields)
  check('没有启动脚本时有说明', r.notes.some((n) => n.includes('启动命令请自己填')), r.notes)
  check('类型仍按依赖识别为 Node 服务', r.fields.type === 'Node 服务', r.fields.type)
}
{
  const dir = makeProject('pnpm-app', {
    'package.json': JSON.stringify({ name: 'pnpm-app', packageManager: 'pnpm@9.1.0', scripts: { dev: 'vite' } }),
  })
  const r = inspectProjectDir(dir)
  check('pnpm 项目给出换包管理器的提示', r.notes.some((n) => n.includes('pnpm')), r.notes)
}
{
  const dir = makeProject('scripts-order', {
    'package.json': JSON.stringify({ name: 'x', scripts: { start: 'node server.js', dev: 'nodemon server.js', 'dev:worker': 'node worker.js' } }),
  })
  const r = inspectProjectDir(dir)
  check('dev 仍然压过 start', r.fields.startCommand === 'npm run dev', r.fields.startCommand)
  check('dev:worker 这类形态也进候选', r.candidates.startCommand.some((c) => c.command === 'npm run dev:worker'), r.candidates.startCommand)
}
{
  const dir = makeProject('no-name', {
    'package.json': JSON.stringify({ scripts: { dev: 'vite --port 3000' } }),
  })
  const r = inspectProjectDir(dir)
  check('package.json 没有 name 时用目录名兜底', r.fields.name === 'no-name', r.fields.name)
}

console.log('\n【Docker Compose】')
{
  const dir = makeProject('compose-app', {
    'docker-compose.yml': 'services:\n  web:\n    image: nginx\n    ports:\n      - "8080:80"\n  db:\n    image: postgres\n',
  })
  const r = inspectProjectDir(dir)
  check('启动命令为 docker compose up -d', r.fields.startCommand === 'docker compose up -d', r.fields.startCommand)
  check('停止命令为 docker compose down', r.fields.stopCommand === 'docker compose down', r.fields.stopCommand)
  check('端口取第一个发布端口', r.fields.port === 8080, r.fields.port)
  check('类型识别为 Docker Compose', r.fields.type === 'Docker Compose', r.fields.type)
}

console.log('\n【Python 项目】')
{
  const dir = makeProject('django-app', { 'manage.py': '#!/usr/bin/env python', 'requirements.txt': 'django==5.0\n' })
  const r = inspectProjectDir(dir)
  check('manage.py 给出 runserver', r.fields.startCommand === 'python manage.py runserver', r.fields.startCommand)
  check('Django 默认端口 8000', r.fields.port === 8000, r.fields.port)
  check('类型识别为 Python', r.fields.type === 'Python', r.fields.type)
}
{
  const dir = makeProject('fastapi-app', { 'main.py': 'from fastapi import FastAPI', 'requirements.txt': 'fastapi\nuvicorn\n' })
  const r = inspectProjectDir(dir)
  check('入口文件兜底为 python main.py', r.fields.startCommand === 'python main.py', r.fields.startCommand)
  check('main.py 也给进候选', r.candidates.startCommand.some((c) => c.command === 'python main.py'), r.candidates.startCommand)
  check('没有端口可读时不猜端口', !('port' in r.fields), r.fields)
}
{
  const dir = makeProject('py-no-entry', { 'requirements.txt': 'flask\n' })
  const r = inspectProjectDir(dir)
  check('看不到入口文件时不编造启动命令', !('startCommand' in r.fields), r.fields)
  check('没有入口文件时有诚实说明', r.notes.some((n) => n.includes('入口文件')), r.notes)
}

console.log('\n【识别不出 / 异常输入】')
{
  const dir = makeProject('empty-dir', { 'README.md': '# hi' })
  const r = inspectProjectDir(dir)
  check('空目录不产出字段', Object.keys(r.fields).length === 0, r.fields)
  check('空目录有下一步提示', r.notes.some((n) => n.includes('子目录')), r.notes)
}
check('不存在的目录返回错误', inspectProjectDir(path.join(TMP, 'no-such-dir-xyz')).ok === false)
check('空输入返回错误', inspectProjectDir('').ok === false)
check('null 不崩', inspectProjectDir(null).ok === false)
check('undefined 不崩', inspectProjectDir(undefined).ok === false)

console.log('\n【端口猜测】')
check('--port 8000', guessPortFromCommand('uvicorn main:app --port 8000') === 8000)
check('--port=8000', guessPortFromCommand('vite --port=5173') === 5173)
check('PORT=3000', guessPortFromCommand('cross-env PORT=3000 node server.js') === 3000)
check('-p 8080:80', guessPortFromCommand('docker run -p 8080:80 nginx') === 8080)
check('越界端口丢弃', guessPortFromCommand('vite --port 99999') === null)
check('0 端口丢弃', guessPortFromCommand('vite --port 0') === null)
check('空文本不崩', guessPortFromCommand('') === null)
check('null 不崩', guessPortFromCommand(null) === null)

console.log('\n【字段名与前端表单约定一致】')
{
  const allowed = new Set(['name', 'type', 'dir', 'startCommand', 'stopCommand', 'port', 'url', 'remark'])
  const dir = makeProject('full-stack', {
    'package.json': JSON.stringify({ name: 'full-stack', scripts: { dev: 'vite --port 5173' } }),
    'docker-compose.yml': 'services:\n  web:\n    ports:\n      - "8080:80"\n',
  })
  const unexpected = Object.keys(inspectProjectDir(dir).fields).filter((key) => !allowed.has(key))
  check('不产出表单以外的字段', unexpected.length === 0, unexpected)
}

try {
  fs.rmSync(TMP, { recursive: true, force: true })
} catch {
  /* Windows 上文件占用时忽略，临时目录留在系统 TEMP 里无害 */
}

console.log(`\n结果：通过 ${passed} 项，失败 ${failures.length} 项`)
if (failures.length > 0) {
  console.log(JSON.stringify(failures.slice(0, 12), null, 2))
  process.exitCode = 1
}
