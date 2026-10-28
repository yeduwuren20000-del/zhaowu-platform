import { Router } from 'express'
import { logRepo } from '../store/logRepo.js'
import { projectsRepo } from '../store/projectsRepo.js'
import { runtimeRepo } from '../store/runtimeRepo.js'
import { buildProjectViews, getProjectView } from '../services/projectService.js'
import { inspectProjectSource } from '../services/projectImport.js'
import { observeProjectStates } from '../services/eventService.js'
import { portScanner } from '../services/portScanner.js'
import {
  copyToClipboard,
  deleteProject,
  openDirectory,
  openUrl,
  restartProject,
  startProject,
  stopProject,
} from '../services/processManager.js'
import { asyncRoute, sendOk } from '../utils/http.js'
import { sanitizeProjectInput } from '../utils/validation.js'

const router = Router()

/** 列表：默认使用 2.5 秒内的端口扫描缓存，?force=1 强制重扫；顺带观察状态变化并记入时间线 */
router.get(
  '/',
  asyncRoute(async (req, res) => {
    const views = await buildProjectViews({ force: req.query.force === '1' })
    await observeProjectStates(views)
    sendOk(res, views)
  }),
)

router.post(
  '/',
  asyncRoute(async (req, res) => {
    const created = await projectsRepo.create(sanitizeProjectInput(req.body))
    portScanner.invalidate()
    await logRepo.append({
      level: 'info',
      source: created.name,
      message: `新增项目（${created.type}，端口 ${created.port ?? '未记录'}，目录 ${created.dir || '未填写'}）`,
    })
    sendOk(res, await getProjectView(created.id))
  }),
)

/**
 * 项目识别（只读）：用户填目录、填前端地址，或两个都填，帮他把表单少填几项。
 * 地址会在本地查监听进程，反推出项目目录与端口（"只记得 localhost:5173"的场景）。
 * 必须注册在下面的 /:id 之前，否则 "detect" 会被当成项目 ID 匹配掉。
 */
router.post(
  '/detect',
  asyncRoute(async (req, res) => {
    sendOk(res, await inspectProjectSource(req.body || {}))
  }),
)

router.get(
  '/:id',
  asyncRoute(async (req, res) => {
    const view = await getProjectView(req.params.id)
    if (view) await observeProjectStates([view])
    sendOk(res, view)
  }),
)

router.put(
  '/:id',
  asyncRoute(async (req, res) => {
    const updated = await projectsRepo.update(req.params.id, sanitizeProjectInput(req.body, { partial: true }))
    portScanner.invalidate()
    await logRepo.append({ level: 'info', source: updated.name, message: '项目配置已更新' })
    sendOk(res, await getProjectView(updated.id))
  }),
)

router.delete(
  '/:id',
  asyncRoute(async (req, res) => {
    const project = await projectsRepo.get(req.params.id)
    // 删除走 deleteProject：在跑的先停再删，杀不掉就 409 拒绝（防孤儿进程）
    const { removed, wasRunning } = await deleteProject(project)
    portScanner.invalidate()
    sendOk(res, { removed, wasRunning })
  }),
)

router.post(
  '/:id/start',
  asyncRoute(async (req, res) => {
    const project = await projectsRepo.get(req.params.id)
    const result = await startProject(project)
    sendOk(res, { result, project: await getProjectView(project.id) })
  }),
)

router.post(
  '/:id/stop',
  asyncRoute(async (req, res) => {
    const project = await projectsRepo.get(req.params.id)
    const result = await stopProject(project)
    sendOk(res, { result, project: await getProjectView(project.id) })
  }),
)

router.post(
  '/:id/restart',
  asyncRoute(async (req, res) => {
    const project = await projectsRepo.get(req.params.id)
    const result = await restartProject(project)
    sendOk(res, { result, project: await getProjectView(project.id) })
  }),
)

router.post(
  '/:id/open-dir',
  asyncRoute(async (req, res) => {
    const project = await projectsRepo.get(req.params.id)
    sendOk(res, await openDirectory(project.dir))
  }),
)

router.post(
  '/:id/open-url',
  asyncRoute(async (req, res) => {
    const project = await projectsRepo.get(req.params.id)
    // {port} 占位符替换成实际监听端口（自动避让后可能与配置端口不同，
    // 比如 Dify 的 http://localhost:{port} 在 80 被占时要开 8080）
    const runtime = await runtimeRepo.get(req.params.id)
    const port = runtime?.port ?? project.port
    const template = project.url || (project.port ? 'http://localhost:{port}' : '')
    let url = template.replace(/\{port\}/g, String(port ?? ''))
    // 端口被避让过（配置 5301 -> 实际 5302）：把地址里的旧端口换掉，
    // 否则"打开"会指向没人监听的端口。只替换端口段，不动路径。
    const declared = Number(project.port)
    const actual = Number(port)
    if (!template.includes('{port}') && declared && actual && declared !== actual) {
      url = url.replace(new RegExp(`:${declared}(?=[/?#]|$)`), `:${actual}`)
    }
    // 只把地址交回去，前端在**工作台内部**用 iframe 打开（内嵌抽屉）。
    // 两条路都比走 cmd.exe 好：cmd.exe 要多付一次进程创建（几百毫秒）；
    // 而新开浏览器窗口必然先画白色画布、再等首帧，用户看到的就是"闪白"。
    // 内嵌没有建窗这一步，iframe 载入前透明、底下是深色底，全程不出现白色。
    if (req.body?.clientOpen) {
      sendOk(res, { url, clientOpen: true })
      return
    }
    sendOk(res, await openUrl(url))
  }),
)

router.post(
  '/:id/copy',
  asyncRoute(async (req, res) => {
    const project = await projectsRepo.get(req.params.id)
    const what = req.body?.what === 'url' ? project.url || (project.port ? `http://localhost:${project.port}` : '') : project.dir
    sendOk(res, await copyToClipboard(what))
  }),
)

router.get(
  '/:id/log',
  asyncRoute(async (req, res) => {
    const project = await projectsRepo.get(req.params.id)
    const lines = Math.min(Number(req.query.lines) || 200, 2000)
    sendOk(res, { project: project.name, file: logRepo.projectFile(project.id), lines: await logRepo.readProjectLog(project.id, lines) })
  }),
)

router.delete(
  '/:id/log',
  asyncRoute(async (req, res) => {
    await logRepo.clearProjectLog(req.params.id)
    sendOk(res, { cleared: true })
  }),
)

export default router
