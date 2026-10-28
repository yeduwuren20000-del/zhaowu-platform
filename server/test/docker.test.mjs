/**
 * 本地 Docker 路由测试（真实 docker CLI，只读验证 + 参数校验 + 错误路径）。
 *   node server/test/docker.test.mjs
 *
 * 刻意不测「真的启停容器」——那会动用户正在跑的容器（比如 Dify）。
 * 执行路径由项目启动/停止的真实使用覆盖，这里保证：结构正确、动作白名单、
 * daemon 不在时给中文引导、日志可读。
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(here, '..', '..')
const DATA_DIR = path.join(os.tmpdir(), `dsm-docker-${Date.now()}`)
const API_PORT = Number(process.env.DSM_DOCKER_TEST_PORT || 8911)
const BASE = `http://127.0.0.1:${API_PORT}/api`

process.env.DSM_DATA_DIR = DATA_DIR
process.env.DSM_PORT = String(API_PORT)
process.env.DSM_DISCOVERY_ON_STARTUP = '0'

let passed = 0
const failures = []
let api = null

function check(name, condition, detail) {
  if (condition) {
    passed += 1
    console.log(`  ✓ ${name}`)
  } else {
    failures.push({ name, detail })
    console.log(`  ✗ ${name}${detail !== undefined ? ` -> ${JSON.stringify(detail)}` : ''}`)
  }
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

async function apiGet(pathname) {
  const response = await fetch(`${BASE}${pathname}`)
  const payload = await response.json().catch(() => null)
  return { status: response.status, data: payload?.data, error: payload?.error }
}

async function apiPost(pathname) {
  const response = await fetch(`${BASE}${pathname}`, { method: 'POST' })
  const payload = await response.json().catch(() => null)
  return { status: response.status, data: payload?.data, error: payload?.error }
}

try {
  api = spawn(process.execPath, [path.join(ROOT, 'server', 'src', 'index.js')], {
    cwd: ROOT,
    env: { ...process.env, DSM_DATA_DIR: DATA_DIR, DSM_PORT: String(API_PORT), DSM_DISCOVERY_ON_STARTUP: '0' },
    stdio: 'ignore',
  })
  // 等端口就绪
  for (let i = 0; i < 60; i += 1) {
    try {
      const response = await fetch(`${BASE}/health`)
      if (response.ok) break
    } catch {
      /* 还没起来 */
    }
    await sleep(300)
  }

  console.log('\n[1] GET /api/docker：概览结构')
  const overview = await apiGet('/docker')
  check('接口 200', overview.status === 200, overview.status)
  check('有 daemonOk 布尔字段', typeof overview.data?.daemonOk === 'boolean', overview.data)
  check('有 containers 数组', Array.isArray(overview.data?.containers), overview.data)

  if (overview.data?.daemonOk) {
    check('daemon 可用时 version 非空', Boolean(overview.data.version), overview.data.version)
    for (const container of overview.data.containers) {
      check(
        `容器 ${container.name} 字段完整`,
        Boolean(container.id && container.name && container.image && container.state && Array.isArray(container.ports)),
        container,
      )
      for (const port of container.ports) {
        check(`容器 ${container.name} 端口项有 text 字段`, typeof port.text === 'string' && port.text.length > 0, port)
      }
    }
    const running = overview.data.containers.find((item) => item.state === 'running')
    if (running) {
      console.log('\n[2] 运行中容器日志（只读）')
      const logs = await apiGet(`/docker/containers/${encodeURIComponent(running.id)}/logs?lines=5`)
      check('日志接口 200', logs.status === 200, logs.status)
      check('日志 lines 是字符串', typeof logs.data?.lines === 'string', typeof logs.data?.lines)
    } else {
      console.log('\n[2] 无运行中容器，跳过日志用例')
    }
  } else {
    console.log('\n[2] Docker daemon 不可用（Docker Desktop 没起）——验证引导文案分支')
    check('daemon 不可用时有中文引导', typeof overview.data?.error === 'string' && overview.data.error.length > 0, overview.data.error)
  }

  console.log('\n[3] 动作白名单与错误路径')
  const bad = await apiPost('/docker/containers/whatever/bogus-action')
  check('未知动作被 400 拒绝', bad.status === 400, bad.status)
  check('400 消息说明可用动作', String(bad.error?.message || '').includes('start/stop/restart'), bad.error)

  const ghost = await apiPost('/docker/containers/dsm-no-such-container/stop')
  check('对不存在的容器操作返回 502（而非 500 崩溃）', ghost.status === 502, ghost.status)
  check('502 消息是中文且提示检查 Docker Desktop', /Docker/.test(String(ghost.error?.message || '')) && /[\u4e00-\u9fa5]/.test(String(ghost.error?.message || '')), ghost.error)

  const ghostLog = await apiGet('/docker/containers/dsm-no-such-container/logs')
  check('不存在的容器日志返回 502 中文错误', ghostLog.status === 502 && /[\u4e00-\u9fa5]/.test(String(ghostLog.error?.message || '')), ghostLog)
} finally {
  if (api) api.kill()
  await sleep(300)
  fs.rmSync(DATA_DIR, { recursive: true, force: true })
}

console.log(`\n结果：通过 ${passed} 项，失败 ${failures.length} 项`)
if (failures.length > 0) {
  console.log(JSON.stringify(failures, null, 2))
  process.exitCode = 1
}
