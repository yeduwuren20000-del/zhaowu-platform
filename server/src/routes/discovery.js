import { Router } from 'express'
import {
  acknowledgeCandidates,
  associateCandidate,
  dissociateService,
  getDiscoveryState,
  getProjectGroups,
  identifyCandidateByFingerprint,
  ignoreCandidates,
  registerCandidate,
  registerGroup,
  registerGroups,
  restoreCandidates,
  scanLocalServices,
  setProjectRemoteLink,
} from '../services/localDiscoveryService.js'
import { discoveryRepo } from '../store/discoveryRepo.js'
import { aiConfig } from '../services/aiIdentifier.js'
import { asyncRoute, sendOk } from '../utils/http.js'

const router = Router()

/** 项目分组视图（第五阶段）：按项目目录聚合同一项目的多个进程/端口 */
router.get(
  '/groups',
  asyncRoute(async (req, res) => {
    sendOk(res, await getProjectGroups())
  }),
)

/** 执行一次本地服务发现（手动触发；启动时也会跑一次） */
router.post(
  '/scan',
  asyncRoute(async (req, res) => {
    const includeAi = Boolean(req.body?.includeAi)
    const result = await scanLocalServices({ includeAi, force: true })
    const config = aiConfig()
    sendOk(res, {
      ...result,
      ai: {
        enabled: includeAi,
        available: config.available,
        model: config.model || null,
        note: result.aiNote,
        summary: result.aiSummary || null,
      },
    })
  }),
)

/** 最近一次扫描结果（含候选/过滤/忽略与"新发现"提醒） */
router.get(
  '/latest',
  asyncRoute(async (req, res) => {
    const [state, scan, ignored] = await Promise.all([getDiscoveryState(), discoveryRepo.getLastScan(), discoveryRepo.listIgnored()])
    const config = aiConfig()
    sendOk(res, {
      state,
      ignored,
      ai: { available: config.available, model: config.model || null, note: config.reason },
      scan: scan
        ? {
            at: scan.at,
            durationMs: scan.durationMs,
            summary: scan.summary,
            aiNote: scan.aiNote,
            candidates: scan.candidates || [],
            filtered: scan.filtered || [],
            ignored: scan.ignored || [],
          }
        : null,
    })
  }),
)

/** 登记候选为项目（事实字段取自服务端扫描结果） */
router.post(
  '/register',
  asyncRoute(async (req, res) => {
    sendOk(res, await registerCandidate({ fingerprint: req.body?.fingerprint, overrides: req.body?.overrides || {} }))
  }),
)

/** 登记整个项目组：只创建一个项目，同目录的其它监听服务作为子服务登记 */
router.post(
  '/register-group',
  asyncRoute(async (req, res) => {
    sendOk(
      res,
      await registerGroup({
        groupId: req.body?.groupId,
        primaryFingerprint: req.body?.primaryFingerprint,
        overrides: req.body?.overrides || {},
      }),
    )
  }),
)

/** 一键批量登记多个项目组：每组只创建一个项目，其余服务成为子服务 */
router.post(
  '/register-groups',
  asyncRoute(async (req, res) => {
    sendOk(
      res,
      await registerGroups({
        groupIds: req.body?.groupIds,
        overrides: req.body?.overrides || {},
      }),
    )
  }),
)

/** 把候选关联为已登记项目的子服务（"发现新的子服务" -> 关联） */
router.post(
  '/associate',
  asyncRoute(async (req, res) => {
    sendOk(
      res,
      await associateCandidate({
        fingerprint: req.body?.fingerprint,
        projectId: req.body?.projectId,
        overrides: req.body?.overrides || {},
      }),
    )
  }),
)

/** 解除子服务关联 */
router.post(
  '/dissociate',
  asyncRoute(async (req, res) => {
    sendOk(res, await dissociateService({ projectId: req.body?.projectId, serviceId: req.body?.serviceId }))
  }),
)

/** 第七阶段：登记 / 取消项目与远程服务器的显式关联（端口对不上时的兜底） */
router.post(
  '/project-link',
  asyncRoute(async (req, res) => {
    sendOk(
      res,
      await setProjectRemoteLink({
        projectId: req.body?.projectId,
        serverId: req.body?.serverId,
        appId: req.body?.appId ?? null,
        containerName: req.body?.containerName ?? null,
        remove: Boolean(req.body?.remove),
        note: req.body?.note || '',
      }),
    )
  }),
)

/** 忽略（记录指纹，后续扫描不再提示） */
router.post(
  '/ignore',
  asyncRoute(async (req, res) => {
    sendOk(res, await ignoreCandidates({ fingerprints: req.body?.fingerprints, note: req.body?.note }))
  }),
)

/** 恢复被忽略的服务 */
router.post(
  '/restore',
  asyncRoute(async (req, res) => {
    sendOk(res, await restoreCandidates({ fingerprints: req.body?.fingerprints }))
  }),
)

/** 首页提醒已读 */
router.post(
  '/acknowledge',
  asyncRoute(async (req, res) => {
    sendOk(res, await acknowledgeCandidates({ fingerprints: req.body?.fingerprints }))
  }),
)

/** 单个候选的 AI 辅助识别（按需触发，结果只作为建议） */
router.post(
  '/identify',
  asyncRoute(async (req, res) => {
    sendOk(res, await identifyCandidateByFingerprint(req.body?.fingerprint))
  }),
)

export default router
