import { Router } from 'express'
import { vaultService } from '../services/vaultService.js'
import { asyncRoute, sendOk } from '../utils/http.js'

const router = Router()

/**
 * 凭据库（主密码加密的私密存储）。
 *
 * 固定路径全部注册在其它动态路由之前，避免被当成条目 ID 匹配掉。
 * 主密码不落盘，只在解锁期间驻留内存；锁定接口会立刻清除。
 */

/** 库状态：是否已存在、是否已解锁（不解锁也能看条目数） */
router.get(
  '/status',
  asyncRoute(async (req, res) => {
    sendOk(res, await vaultService.status())
  }),
)

/** 解锁。首次调用时用这个密码创建库，可选 mode 决定是否生成本机恢复密钥 */
router.post(
  '/unlock',
  asyncRoute(async (req, res) => {
    sendOk(
      res,
      await vaultService.unlock(req.body?.password, { mode: req.body?.mode }),
    )
  }),
)

/** 忘记主密码时用本机恢复密钥找回（需要你仍知道主密码本身，见服务层注释） */
router.post(
  '/recover',
  asyncRoute(async (req, res) => {
    sendOk(res, await vaultService.recover(req.body?.password))
  }),
)

/** 开启 / 关闭"本机可找回"（关闭后密码将无法找回） */
router.post(
  '/recovery-mode',
  asyncRoute(async (req, res) => {
    sendOk(res, await vaultService.setRecoveryMode(Boolean(req.body?.enable), req.body?.password))
  }),
)

/** 锁定：立刻清除内存中的主密码 */
router.post(
  '/lock',
  asyncRoute(async (req, res) => {
    sendOk(res, vaultService.lock())
  }),
)

/** 修改主密码 */
router.post(
  '/change-password',
  asyncRoute(async (req, res) => {
    sendOk(res, await vaultService.changeMasterPassword(req.body?.oldPassword, req.body?.newPassword))
  }),
)

/** 列出条目（明文，需已解锁） */
router.get(
  '/entries',
  asyncRoute(async (req, res) => {
    sendOk(res, await vaultService.list())
  }),
)

/** 新增或更新条目 */
router.post(
  '/entries',
  asyncRoute(async (req, res) => {
    sendOk(res, await vaultService.upsert(req.body || {}))
  }),
)

/** 删除条目 */
router.delete(
  '/entries/:id',
  asyncRoute(async (req, res) => {
    sendOk(res, await vaultService.remove(req.params.id))
  }),
)

/**
 * 备份与恢复。
 * 起因是一次真实的误删事故，这里同时提供自动快照（写入前）与手动出口。
 */

/** 列出可用备份 */
router.get(
  '/backups',
  asyncRoute(async (req, res) => {
    sendOk(res, await vaultService.listBackups())
  }),
)

/** 立刻手动备份一份 */
router.post(
  '/backups',
  asyncRoute(async (req, res) => {
    sendOk(res, await vaultService.createBackup(req.body?.reason || 'manual'))
  }),
)

/** 从指定备份恢复（恢复前会自动把当前库也快照一份） */
router.post(
  '/backups/restore',
  asyncRoute(async (req, res) => {
    sendOk(res, await vaultService.restoreBackup(req.body?.name))
  }),
)

export default router