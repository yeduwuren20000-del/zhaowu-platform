import { Router } from 'express'
import { listPans, resolveShare } from '../services/panService.js'
import { pushLinks, testConnection } from '../services/aria2Service.js'
import {
  assertOpenableDir,
  defaultDownloadDir,
  downloadManager,
} from '../services/panDownloadService.js'
import { openDirectory } from '../services/processManager.js'
import { asyncRoute, badRequest, sendOk } from '../utils/http.js'

const router = Router()

/**
 * 多网盘分享直链解析 + 落地。
 *
 * 存在的理由：网盘分享页只给「转存再下载」这条路，直链藏在需要签名/登录态的
 * 接口后面。这里把已调通的 10 家网盘解析能力接进工作台，粘贴链接即可拿到直链，
 * 并给出三个出口：
 *   ① 复制    —— 贴到任意下载器
 *   ② 推送    —— 交给常驻 aria2 跑满带宽（不占用工作台进程）
 *   ③ 下载    —— 工作台自己下到本机目录（带进度、可取消、断点续传）
 *
 * 凭据一律由调用方每次传入（cookie / token / aria2 密钥），服务端不落盘：
 * 工作台是本地工具，但「把登录态写进磁盘」这件事没有必要性。
 */

/** 支持的网盘列表：名称、是否需要登录、凭据提示 */
router.get(
  '/',
  asyncRoute(async (req, res) => {
    sendOk(res, await listPans())
  }),
)

/** 页面默认值：默认保存目录、默认 aria2 地址（前端只做展示，用户可改） */
router.get(
  '/options',
  asyncRoute(async (req, res) => {
    sendOk(res, {
      downloadDir: defaultDownloadDir(),
      aria2Rpc: 'http://127.0.0.1:6800/jsonrpc',
      maxJobs: downloadManager.stats().maxConcurrent,
    })
  }),
)

/**
 * 解析分享链接。
 * body: { url, pan?, pwd?, cookie?, token?, captchaCode?, guest? }
 * 注意：cookie / token 由 service 走环境变量传给子进程，不进命令行。
 */
router.post(
  '/resolve',
  asyncRoute(async (req, res) => {
    const { url, pan, pwd, cookie, token, captchaCode, guest } = req.body || {}
    if (!url || !String(url).trim()) throw badRequest('缺少分享链接')
    sendOk(
      res,
      await resolveShare({ url, pan, pwd, cookie, token, captchaCode, guest: Boolean(guest) }),
    )
  }),
)

/** 测试 aria2 连通性：拿版本号，顺带验证密钥 */
router.post(
  '/aria2/test',
  asyncRoute(async (req, res) => {
    const { rpcUrl, secret } = req.body || {}
    sendOk(res, await testConnection({ rpcUrl, secret }))
  }),
)

/**
 * 推送直链到 aria2。
 * body: { rpcUrl?, secret?, dir?, items: [{ url, path?, headers? }] }
 */
router.post(
  '/aria2',
  asyncRoute(async (req, res) => {
    const { rpcUrl, secret, dir, items } = req.body || {}
    if (!Array.isArray(items) || items.length === 0) throw badRequest('没有可推送的直链')
    sendOk(res, await pushLinks({ rpcUrl, secret, dir, items }))
  }),
)

/**
 * 下载到本机（后台任务）。
 * body: { url, pan?, pwd?, cookie?, token?, captchaCode?, guest?, dir, jobs?, threads?, only? }
 *   only: 字符串数组——只下载这些文件/目录（来自解析结果的 path）；缺省 = 整条分享。
 */
router.post(
  '/download',
  asyncRoute(async (req, res) => {
    const body = req.body || {}
    sendOk(res, downloadManager.start(body))
  }),
)

router.get(
  '/downloads',
  asyncRoute(async (req, res) => {
    sendOk(res, downloadManager.list(req.query.limit))
  }),
)

router.get(
  '/downloads/:id',
  asyncRoute(async (req, res) => {
    sendOk(res, downloadManager.get(req.params.id))
  }),
)

router.post(
  '/downloads/:id/cancel',
  asyncRoute(async (req, res) => {
    sendOk(res, downloadManager.cancel(req.params.id))
  }),
)

/** 打开下载目录（Windows 资源管理器） */
router.post(
  '/open-dir',
  asyncRoute(async (req, res) => {
    const dir = assertOpenableDir(req.body?.dir)
    sendOk(res, await openDirectory(dir))
  }),
)

export default router
