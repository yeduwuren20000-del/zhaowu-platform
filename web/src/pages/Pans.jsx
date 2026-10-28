import { useCallback, useEffect, useMemo, useState } from 'react'
import { api } from '../api/client.js'
import { Icon } from '../components/Icons.jsx'
import {
  Button,
  Card,
  EmptyState,
  ErrorNotice,
  Field,
  Loading,
  Notice,
  SearchBox,
  Switch,
  Tabs,
} from '../components/ui.jsx'
import { useToast } from '../hooks/useToast.jsx'
import { PageHint } from '../components/PageHint.jsx'
import { copyText } from '../utils/clipboard.js'
import { formatBytes } from '../utils/format.js'

/**
 * 网盘直链：粘贴分享链接 -> 拿到可直接下载的 URL。
 *
 * 为什么值得单独一页：网盘网页版只给「转存再下载」，直链藏在需要签名/登录态的接口后面。
 * 这里复用已调通的 8 家解析能力（tools/panlink），拿到的链接可以丢给 aria2 跑满带宽。
 *
 * 凭据为什么按网盘分开存：各家要的 Cookie 完全不同，百度是 BDUSS、天翼是 SESSION。
 * 只用一个槽位会出现「填了百度、切到天翼还带着百度的 Cookie 发过去」——报错还看不出来原因。
 * 所以这里一个网盘一个槽位，切网盘自动带出各自的那份，切走前先把当前输入存回原槽位。
 *
 * 边界：只解析、不下载；凭据只留在本机浏览器，不写后端。
 */

const CRED_STORE_KEY = 'dsm.pan.credentials.v2'
const CRED_LEGACY_KEY = 'dsm.pan.credentials.v1'
const HISTORY_KEY = 'dsm.pan.history.v1'
const TRANSFER_KEY = 'dsm.pan.transfer.v1'
const SLOT_AUTO = '*' // 自动识别（未指定网盘）用的槽位
const HISTORY_MAX = 8
/** 任务在跑时的轮询间隔：1.2 秒够用，再快只是刷屏，再慢进度条会卡顿 */
const JOB_POLL_MS = 1200

function loadTransferSettings() {
  const saved = readJSON(TRANSFER_KEY, null)
  const base = {
    dir: '',
    rpcUrl: 'http://127.0.0.1:6800/jsonrpc',
    secret: '',
    jobs: 3,
    threads: 1,
    resume: true,
  }
  if (!saved || typeof saved !== 'object') return base
  return {
    ...base,
    ...saved,
    jobs: Number(saved.jobs) || base.jobs,
    threads: Number(saved.threads) || base.threads,
    resume: saved.resume !== false,
  }
}

/** 任务状态 -> 中文标签（进度卡的副标题直接用） */
const JOB_STATUS = {
  queued: ['排队中'],
  running: ['下载中'],
  done: ['已完成'],
  error: ['失败'],
  cancelled: ['已取消'],
}

/** aria2 / 下载类错误同样值得翻译：原文是英文 JSON-RPC 术语，新手看不懂 */
function explainTransferError(message) {
  const text = String(message || '')
  if (!text) return ''
  if (/连不上/.test(text)) return 'aria2 没在跑，或没开 RPC。命令：aria2c --enable-rpc=true --rpc-listen-port=6800'
  if (/密钥/.test(text)) return '密钥和 aria2 启动参数 --rpc-secret 对不上'
  if (/不是 JSON|jsonrpc/.test(text)) return '地址要指向 /jsonrpc，不是 aria2 的网页界面'
  if (/目录/.test(text)) return '换一个已存在的可写目录（不建议盘符根目录或系统目录）'
  if (/超时|无响应/.test(text)) return '网络或 aria2 卡住了，稍后重试'
  return ''
}

function readJSON(key, fallback) {
  try {
    const raw = localStorage.getItem(key)
    if (!raw) return fallback
    const parsed = JSON.parse(raw)
    return parsed ?? fallback
  } catch {
    return fallback
  }
}

/** 读凭据槽位；兼容上一版「一锅端」的单槽位格式，迁移到自动识别槽 */
function loadSlots() {
  const stored = readJSON(CRED_STORE_KEY, null)
  if (stored && typeof stored === 'object' && !Array.isArray(stored)) return stored
  const legacy = readJSON(CRED_LEGACY_KEY, null)
  if (legacy && (legacy.cookie || legacy.token)) {
    return { [SLOT_AUTO]: { cookie: legacy.cookie || '', token: legacy.token || '' } }
  }
  return {}
}

function slotLabel(key) {
  return key === SLOT_AUTO ? '自动识别' : key
}

function relativeTime(ts) {
  const value = Number(ts)
  if (!Number.isFinite(value) || value <= 0) return ''
  const diff = Date.now() - value
  if (diff < 0) return ''
  const minute = Math.floor(diff / 60000)
  if (minute < 1) return '刚刚'
  if (minute < 60) return `${minute} 分钟前`
  const hour = Math.floor(minute / 60)
  if (hour < 24) return `${hour} 小时前`
  const day = Math.floor(hour / 24)
  if (day < 30) return `${day} 天前`
  const date = new Date(value)
  return `${date.getMonth() + 1}-${date.getDate()}`
}

/**
 * 从网盘的 authHint 反推它需要哪种凭据。
 * 只对「需要登录」的网盘判断——夸克 / 115 的提示文案里也会提到 --cookie（可选项），
 * 不能因为文案里出现这个词就当成必填，否则游客可用的网盘也会被标成「本网盘需要」。
 * 后端只给了提示文案没给枚举字段，这里按提示里的参数名判断——文案改动时需同步。
 */
function credentialNeed(panItem) {
  if (!panItem?.requiresAuth) return { cookie: false, token: false }
  const hint = panItem.authHint || ''
  return {
    cookie: /--cookie|Cookie|BDUSS|SESSION/i.test(hint),
    token: /--token|Bearer/i.test(hint),
  }
}

/**
 * 把后端/平台抛回来的原始错误翻成「发生了什么 + 下一步做什么」。
 * 新手最容易卡在这里：原文案是技术描述，看不出该改哪一步。
 */
function explainError(message) {
  const text = String(message || '')
  if (!text) return null

  if (/-guest|游客/i.test(text)) {
    return {
      title: '这个分享支持游客态，不用登录',
      tips: ['勾选「游客态解析」再试一次', '游客态拿不到的（部分加密分享）再回来填凭据'],
      primary: 'guest',
    }
  }
  if (/9019|need\s*verify|滑块|风控|risk/i.test(text)) {
    return {
      title: '被平台风控拦住了（不是你操作错了）',
      tips: [
        '换家庭宽带 / 关掉代理再试——数据中心 IP 常被判定为风险出口',
        '在「登录凭据」里填该网盘的 Cookie，登录态能显著降低风控概率',
        '刚连续试过多次也会触发，等几分钟再来',
      ],
      primary: 'cookie',
    }
  }
  if (/captcha|验证码/i.test(text)) {
    return {
      title: '该网盘要求人工验证',
      tips: [
        '迅雷等会强制验证码，先去官网网页版手动通过一次',
        '带上登录 Cookie 通常可以跳过这一步',
      ],
      primary: 'cookie',
    }
  }
  if (/cookie|登录态|BDUSS|__puus|SESSION|token|Bearer|需要登录/i.test(text)) {
    return {
      title: '这个分享需要登录态才能取链',
      tips: [
        '展开「登录凭据」粘贴该网盘的 Cookie（浏览器登录后从开发者工具复制整串）',
        '阿里云盘用 Token 而不是 Cookie',
      ],
      primary: 'cookie',
    }
  }
  if (/不存在|已失效|NotFound|ShareInfo|Invalid|已删除|提取码/i.test(text)) {
    return {
      title: '分享不存在、已失效，或提取码不对',
      tips: ['先在浏览器里打开这个链接，确认还能正常看', '有提取码的话填进「提取码」再试'],
      primary: 'url',
    }
  }
  if (/超时|timeout|ETIMEDOUT|ECONN|fetch failed/i.test(text)) {
    return {
      title: '网络请求超时',
      tips: ['检查网络 / 代理是否通', '大分享逐文件取链较慢，稍等重试'],
      primary: 'retry',
    }
  }
  return null
}

export function PansPage() {
  const toast = useToast()

  const [pans, setPans] = useState([])
  const [pansError, setPansError] = useState('')
  const [loadingPans, setLoadingPans] = useState(true)

  const [url, setUrl] = useState('')
  const [pan, setPan] = useState('') // 空 = 自动识别
  const [pwd, setPwd] = useState('')
  const [guest, setGuest] = useState(false)
  const [cookie, setCookie] = useState('')
  const [token, setToken] = useState('')
  const [remember, setRemember] = useState(true)
  const [slots, setSlots] = useState({}) // { 网盘名: { cookie, token } }
  const [credOpen, setCredOpen] = useState(false)
  const [supportOpen, setSupportOpen] = useState(false)

  const [resolving, setResolving] = useState(false)
  const [result, setResult] = useState(null)
  const [error, setError] = useState('')

  // 结果区筛选：分享目录一大（实测上百项）时，靠这两个控件定位文件比滚动快
  const [fileFilter, setFileFilter] = useState('all')
  const [query, setQuery] = useState('')

  // 勾选状态：只处理选中的文件（目录行勾选 = 其下全部文件）。
  // 默认全选——不勾就等于「整条分享」，与旧行为一致；取消勾选才收窄。
  const [selected, setSelected] = useState(() => new Set())
  // 迅雷验证码：解析失败时带回图片（data URI），用户填文字后重试
  const [captchaImage, setCaptchaImage] = useState('')
  const [captchaCode, setCaptchaCode] = useState('')

  const [history, setHistory] = useState([])

  // 落地方式（下载 / 推送 aria2）的设置：默认值来自后端 options，用户改动存本机
  const [transfer, setTransfer] = useState(() => loadTransferSettings())
  const [transferOpen, setTransferOpen] = useState(false)
  const [testingAria2, setTestingAria2] = useState(false)
  const [aria2Info, setAria2Info] = useState(null)
  const [pushing, setPushing] = useState(false)
  const [pushResult, setPushResult] = useState(null)
  const [starting, setStarting] = useState(false)
  const [job, setJob] = useState(null)
  const [jobError, setJobError] = useState('')

  const activeKey = pan || SLOT_AUTO
  const storedActive = Boolean(slots[activeKey] && (slots[activeKey].cookie || slots[activeKey].token))

  useEffect(() => {
    const saved = loadSlots()
    setSlots(saved)
    const initial = saved[SLOT_AUTO]
    if (initial) {
      setCookie(initial.cookie || '')
      setToken(initial.token || '')
      if (initial.cookie || initial.token) setCredOpen(true) // 已存凭据就展开，否则用户看不到自己存过什么
    }
    const savedHistory = readJSON(HISTORY_KEY, [])
    setHistory(Array.isArray(savedHistory) ? savedHistory.slice(0, HISTORY_MAX) : [])
  }, [])

  // 默认保存目录来自后端（用户下载文件夹下的 pan 子目录）；已经存过设置就不覆盖
  useEffect(() => {
    let alive = true
    api
      .pansOptions()
      .then((options) => {
        if (!alive || !options) return
        setTransfer((prev) => ({
          ...prev,
          dir: prev.dir || options.downloadDir || '',
          rpcUrl: prev.rpcUrl || options.aria2Rpc || 'http://127.0.0.1:6800/jsonrpc',
        }))
      })
      .catch(() => {
        /* 拿不到默认值不影响手填 */
      })
    return () => {
      alive = false
    }
  }, [])

  const updateTransfer = useCallback((patch) => {
    setTransfer((prev) => {
      const next = { ...prev, ...patch }
      try {
        localStorage.setItem(TRANSFER_KEY, JSON.stringify(next))
      } catch {
        /* 隐私模式忽略 */
      }
      return next
    })
  }, [])

  const loadPans = useCallback(async () => {
    setLoadingPans(true)
    setPansError('')
    try {
      setPans(await api.pans())
    } catch (err) {
      setPansError(err.message)
    } finally {
      setLoadingPans(false)
    }
  }, [])

  useEffect(() => {
    loadPans()
  }, [loadPans])

  const selectedPan = useMemo(() => pans.find((item) => item.name === pan) || null, [pans, pan])
  const need = useMemo(() => credentialNeed(selectedPan), [selectedPan])

  // 切到需要登录的网盘时自动展开凭据区：用户接下来必然要填，替他省一次点击
  useEffect(() => {
    if (selectedPan && (credentialNeed(selectedPan).cookie || credentialNeed(selectedPan).token)) {
      setCredOpen(true)
    }
  }, [selectedPan])

  const persistSlots = useCallback((next) => {
    try {
      localStorage.setItem(CRED_STORE_KEY, JSON.stringify(next))
      localStorage.removeItem(CRED_LEGACY_KEY)
    } catch {
      /* 隐私模式 / 配额满：忽略，内存里仍可用 */
    }
  }, [])

  /** 把当前输入存回某个槽位；两边都空就删掉槽位，避免留下空记录 */
  const commitSlot = useCallback(
    (key, cookieValue, tokenValue) => {
      const next = { ...slots }
      if (cookieValue || tokenValue) next[key] = { cookie: cookieValue, token: tokenValue }
      else delete next[key]
      setSlots(next)
      if (remember) persistSlots(next)
      return next
    },
    [slots, remember, persistSlots],
  )

  const switchPan = useCallback(
    (nextPan) => {
      // 切走前先把当前输入写回原槽位，否则填了一半再换网盘就白填了
      const next = commitSlot(activeKey, cookie, token)
      const target = next[nextPan || SLOT_AUTO] || {}
      setPan(nextPan)
      setCookie(target.cookie || '')
      setToken(target.token || '')
      // 目标网盘必须登录时，游客态没有意义，顺手关掉避免「开了游客态却还在报需要登录」
      const meta = pans.find((item) => item.name === nextPan)
      if (meta?.requiresAuth) setGuest(false)
    },
    [commitSlot, activeKey, cookie, token, pans],
  )

  const clearSlot = useCallback(
    (key) => {
      const next = { ...slots }
      delete next[key]
      setSlots(next)
      persistSlots(next) // 清除是明确意图，即使「自动保存」关着也要落盘
      if (key === activeKey) {
        setCookie('')
        setToken('')
      }
      toast.success('已清除', `${slotLabel(key)} 的凭据`)
    },
    [slots, persistSlots, activeKey, toast],
  )

  const runResolve = useCallback(
    async ({ shareUrl, panName, pwdValue, guestValue, cookieValue, tokenValue, captchaCode: code }) => {
      const target = String(shareUrl || '').trim()
      if (!target) {
        setError('请先粘贴分享链接')
        return
      }
      setResolving(true)
      setError('')
      setResult(null)
      try {
        const data = await api.resolvePan({
          url: target,
          pan: panName || undefined,
          pwd: pwdValue || undefined,
          // 游客态下凭据本来就不该参与，干脆不发，避免「游客态还带着旧 Cookie」的歧义
          cookie: guestValue ? undefined : cookieValue || undefined,
          token: guestValue ? undefined : tokenValue || undefined,
          guest: guestValue || undefined,
          captchaCode: code || undefined,
        })
        setResult(data)
        setFileFilter('all')
        setQuery('')
        // 新结果默认全选：不勾 = 整条分享，与「继续优化」之前的行为一致
        setSelected(new Set((data.files || []).filter((f) => !f.is_dir).map((f) => f.path)))
        setCaptchaImage('')
        setCaptchaCode('')

        const entry = {
          url: target,
          pan: data.pan || panName || '',
          title: data.title || '',
          count: data.files?.length || 0,
          pwd: pwdValue || '',
          guest: Boolean(guestValue),
          at: Date.now(),
        }
        const nextHistory = [entry, ...history.filter((item) => item.url !== target)].slice(0, HISTORY_MAX)
        setHistory(nextHistory)
        try {
          localStorage.setItem(HISTORY_KEY, JSON.stringify(nextHistory))
        } catch {
          /* 忽略配额问题 */
        }

        toast.success('解析完成', `${data.pan} · ${data.files?.length || 0} 项`)
      } catch (err) {
        setError(err.message)
        // 迅雷验证码：后端把图片内嵌在 error.details 里。收下图、留着输入框，
        // 用户填文字后原地重试——不用回浏览器 F12 找Cookie 那么绝望。
        if (err.details?.needsCaptcha && err.details.captchaImage) {
          setCaptchaImage(err.details.captchaImage)
        } else {
          setCaptchaImage('')
        }
        toast.error('解析失败', err.message)
      } finally {
        setResolving(false)
      }
    },
    [history, toast],
  )

  /** 提交验证码文字，重新解析同一条链接 */
  const submitCaptcha = useCallback(() => {
    const code = captchaCode.trim()
    if (!code) {
      toast.error('先填图中文字', '看不清可以点「换一张」')
      return
    }
    return runResolve({
      shareUrl: url,
      panName: pan,
      pwdValue: pwd,
      guestValue: guest,
      cookieValue: cookie,
      tokenValue: token,
      captchaCode: code,
    })
  }, [captchaCode, runResolve, url, pan, pwd, guest, cookie, token, toast])

  const resolve = useCallback(() => {
    commitSlot(activeKey, cookie, token)
    return runResolve({
      shareUrl: url,
      panName: pan,
      pwdValue: pwd,
      guestValue: guest,
      cookieValue: cookie,
      tokenValue: token,
    })
  }, [commitSlot, activeKey, cookie, token, url, pan, pwd, guest, runResolve])

  const reparse = useCallback(
    (entry) => {
      const target = slots[entry.pan || SLOT_AUTO] || {}
      setUrl(entry.url)
      setPan(entry.pan || '')
      setPwd(entry.pwd || '')
      setCookie(target.cookie || '')
      setToken(target.token || '')
      setGuest(Boolean(entry.guest))
      runResolve({
        shareUrl: entry.url,
        panName: entry.pan || '',
        pwdValue: entry.pwd || '',
        guestValue: Boolean(entry.guest),
        cookieValue: target.cookie || '',
        tokenValue: target.token || '',
      })
    },
    [slots, runResolve],
  )

  const removeHistory = useCallback(
    (target) => {
      const next = history.filter((item) => item.url !== target)
      setHistory(next)
      try {
        localStorage.setItem(HISTORY_KEY, JSON.stringify(next))
      } catch {
        /* 忽略 */
      }
    },
    [history],
  )

  const files = result?.files || []
  const dirCount = files.filter((f) => f.is_dir).length
  const fileCount = files.length - dirCount

  const visibleFiles = useMemo(() => {
    const keyword = query.trim().toLowerCase()
    return files.filter((file) => {
      if (fileFilter === 'file' && file.is_dir) return false
      if (fileFilter === 'dir' && !file.is_dir) return false
      if (keyword && !String(file.path || '').toLowerCase().includes(keyword)) return false
      return true
    })
  }, [files, fileFilter, query])

  const viewLinks = visibleFiles.filter((f) => !f.is_dir && f.url)
  const viewSize = visibleFiles.reduce((sum, f) => sum + (Number(f.size) || 0), 0)
  const explained = useMemo(() => explainError(error), [error])

  // ---- 勾选 → 实际要处理的文件 ----
  // 状态里只存**文件路径**：目录行点击时展开成其下全部文件。这样每个勾选状态
  // 都无歧义（不存在「勾了父目录又勾子文件」的部分覆盖），传给 pan.py 的
  // --only 也全是精确路径，匹配不到时它的警告才说得清。
  const selectedFiles = useMemo(
    () => files.filter((f) => !f.is_dir && f.url && selected.has(f.path)),
    [files, selected],
  )

  const downloadable = useMemo(() => files.filter((f) => !f.is_dir && f.url), [files])
  const allSelected = downloadable.length > 0 && selectedFiles.length === downloadable.length
  const selectedSize = selectedFiles.reduce((sum, f) => sum + (Number(f.size) || 0), 0)

  /** 目录行是否整目录选中（用于显示勾态；空目录算未选中） */
  const dirCovered = useCallback(
    (dirPath) => {
      const under = files.filter((f) => !f.is_dir && f.path.startsWith(`${dirPath}/`))
      return under.length > 0 && under.every((f) => selected.has(f.path))
    },
    [files, selected],
  )

  /** 全选/取消全选：按「可下载的文件」算，不把目录行和取链失败的行算进去 */
  const toggleAll = useCallback(() => {
    setSelected((prev) => {
      const covered = downloadable.every((f) => prev.has(f.path))
      return covered ? new Set() : new Set(downloadable.map((f) => f.path))
    })
  }, [downloadable])

  /** 单行勾选：文件行切自己；目录行把其下全部文件一起切入/切出 */
  const toggleOne = useCallback(
    (file) => {
      setSelected((prev) => {
        const next = new Set(prev)
        if (file.is_dir) {
          const under = files.filter((f) => !f.is_dir && f.path.startsWith(`${file.path}/`))
          const covered = under.length > 0 && under.every((f) => next.has(f.path))
          for (const f of under) {
            if (covered) next.delete(f.path)
            else next.add(f.path)
          }
          return next
        }
        if (next.has(file.path)) next.delete(file.path)
        else next.add(file.path)
        return next
      })
    },
    [files],
  )

  /** 下载时只把「不等于全选」的勾选传下去：全选时省略 --only，行为与旧版一致 */
  const onlyForDownload = useMemo(
    () => (allSelected ? [] : [...selected]),
    [allSelected, selected],
  )

  // 进度优先用字节（准确），拿不到 Content-Length 时退回「按文件个数」——
  // 有些网盘不返回长度，直接显示 0% 会让人以为卡住了
  const jobPercent = useMemo(() => {
    if (!job) return 0
    if (job.status === 'done') return 100
    if (job.bytesTotal > 0) return Math.min(99, Math.round(job.percent))
    const finished = (job.done || 0) + (job.skipped || 0) + (job.failed || 0)
    if (job.total > 0) return Math.min(99, Math.round((finished / job.total) * 100))
    return 0
  }, [job])

  const copyAll = useCallback(async () => {
    const links = selectedFiles.map((f) => f.url)
    if (links.length === 0) return
    const ok = await copyText(links.join('\n'))
    if (ok) toast.success('已复制', `${links.length} 条直链`)
    else toast.error('复制失败', '浏览器拒绝了剪贴板访问，请手动选中复制')
  }, [selectedFiles, toast])

  const copyOne = useCallback(
    async (file) => {
      const ok = await copyText(file.url)
      if (ok) toast.success('已复制', file.path)
      else toast.error('复制失败', '请手动选中复制')
    },
    [toast],
  )

  /** 只有拿到直链的文件才谈得上推送/下载 */
  const toItems = useCallback(
    (targets) =>
      targets
        .filter((file) => !file.is_dir && file.url)
        .map((file) => ({ url: file.url, path: file.path, headers: file.headers })),
    [],
  )

  const testAria2 = useCallback(async () => {
    setTestingAria2(true)
    setAria2Info(null)
    try {
      const info = await api.aria2Test({ rpcUrl: transfer.rpcUrl, secret: transfer.secret || undefined })
      setAria2Info(info)
      toast.success('aria2 连通', `版本 ${info.version || '未知'}`)
    } catch (err) {
      setAria2Info({ error: err.message })
      toast.error('连不上 aria2', err.message)
    } finally {
      setTestingAria2(false)
    }
  }, [transfer.rpcUrl, transfer.secret, toast])

  const pushToAria2 = useCallback(
    async (targets) => {
      const items = toItems(targets)
      if (items.length === 0) {
        toast.error('没有可推送的直链', '先解析出直链，或把筛选切回「文件」')
        return
      }
      setPushing(true)
      setPushResult(null)
      try {
        const data = await api.aria2Push({
          rpcUrl: transfer.rpcUrl,
          secret: transfer.secret || undefined,
          dir: transfer.dir || undefined,
          items,
        })
        setPushResult(data)
        if (data.failed > 0) {
          toast.error('部分推送失败', `成功 ${data.pushed} / 失败 ${data.failed}`)
        } else {
          toast.success('已推送到 aria2', `${data.pushed} 条，aria2 会自己下完`)
        }
      } catch (err) {
        setPushResult({ error: err.message })
        toast.error('推送失败', err.message)
      } finally {
        setPushing(false)
      }
    },
    [toItems, transfer.rpcUrl, transfer.secret, transfer.dir, toast],
  )

  const startDownload = useCallback(async () => {
    const target = url.trim()
    if (!target) {
      toast.error('没有可下载的分享', '先粘贴链接并解析')
      return
    }
    if (!transfer.dir.trim()) {
      setTransferOpen(true)
      toast.error('先设置保存目录', '下载需要知道文件存到哪')
      return
    }
    setStarting(true)
    setJobError('')
    try {
      const data = await api.startPanDownload({
        url: target,
        pan: pan || undefined,
        pwd: pwd || undefined,
        // 游客态下凭据不该参与（与解析时的口径一致）
        cookie: guest ? undefined : cookie || undefined,
        token: guest ? undefined : token || undefined,
        captchaCode: undefined,
        guest: guest || undefined,
        dir: transfer.dir,
        jobs: transfer.jobs,
        threads: transfer.threads,
        noResume: !transfer.resume,
        // 只下勾选的（全选时传空数组 = 整条分享，与旧行为一致）
        only: onlyForDownload,
      })
      setJob(data)
      toast.success(
        '已开始下载',
        onlyForDownload.length > 0
          ? `保存到 ${data.dir}（已选 ${onlyForDownload.length} 项）`
          : `保存到 ${data.dir}`,
      )
    } catch (err) {
      setJobError(err.message)
      toast.error('无法开始下载', err.message)
    } finally {
      setStarting(false)
    }
  }, [url, pan, pwd, guest, cookie, token, transfer, onlyForDownload, toast])

  const cancelDownload = useCallback(async () => {
    if (!job) return
    try {
      setJob(await api.cancelPanDownload(job.id))
      toast.success('已取消', '已下的部分保留，重跑同一条会接着下')
    } catch (err) {
      toast.error('取消失败', err.message)
    }
  }, [job, toast])

  const openDir = useCallback(async () => {
    const dir = job?.dir || transfer.dir
    if (!dir) {
      toast.error('还没有目录', '先设置保存目录')
      return
    }
    try {
      await api.openPanDir(dir)
    } catch (err) {
      toast.error('打不开目录', err.message)
    }
  }, [job, transfer.dir, toast])

  // 任务在跑时轮询进度；结束时补一条结果提示（成功/失败都要说清楚）
  const jobId = job?.id
  const jobStatus = job?.status
  useEffect(() => {
    if (!jobId || !['queued', 'running'].includes(jobStatus)) return undefined
    let alive = true
    const timer = setInterval(async () => {
      try {
        const next = await api.panDownload(jobId)
        if (!alive) return
        setJob(next)
        if (!['queued', 'running'].includes(next.status)) {
          if (next.status === 'done') {
            toast.success('下载结束', `成功 ${next.done} / 跳过 ${next.skipped} / 失败 ${next.failed}`)
          } else if (next.status === 'error') {
            toast.error('下载失败', next.error)
          }
        }
      } catch (err) {
        if (alive) setJobError(err.message)
      }
    }, JOB_POLL_MS)
    return () => {
      alive = false
      clearInterval(timer)
    }
  }, [jobId, jobStatus, toast])

  return (
    <div className="page">
      <div className="page__header">
        <div className="page__title">网盘直链</div>
        <div className="page__actions">
          <Button icon="refresh" loading={loadingPans} onClick={loadPans}>
            刷新网盘列表
          </Button>
        </div>
      </div>

      {/* 每页一次性提示：新手落地第一眼就知道这页是干嘛的（见 PageHint） */}
      <PageHint id="pans" icon="link">
        粘贴网盘分享链接，取回可直接下载的直链，然后三选一：复制走外部下载器、推给 aria2 后台下、或让工作台自己下到本机目录。凭据按网盘分开存：切到哪个网盘，就带出哪个网盘的 Cookie。
      </PageHint>

      {pansError ? (
        <ErrorNotice error={pansError} onRetry={() => loadPans().catch(() => {})} retryLabel="重新加载" />
      ) : null}

      <Card title="解析分享" icon="link" subtitle="粘贴链接，取回可直接下载的直链">
        <div className="form-grid">
          <Field
            label="分享链接 *"
            full
            hint={pans.length > 0
              ? `支持 ${pans.length} 家：${pans.map((item) => item.name).join(' / ')}`
              : '支持夸克 / 蓝奏 / 阿里 / 天翼 / 迅雷 / 百度 / 115 / 中国移动 / UC / 123 云盘'}
          >
            <input
              className="input"
              value={url}
              placeholder="https://pan.quark.cn/s/xxxx"
              onChange={(e) => setUrl(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !resolving) resolve()
              }}
            />
          </Field>

          <Field label="网盘" hint="留空则自动识别">
            <select className="select" value={pan} onChange={(e) => switchPan(e.target.value)}>
              <option value="">自动识别</option>
              {pans.map((item) => (
                <option key={item.name} value={item.name}>
                  {item.name}
                  {item.requiresAuth ? '（需登录）' : '（游客可用）'}
                </option>
              ))}
            </select>
          </Field>

          <Field label="提取码" hint="分享设有提取码时填写">
            <input
              className="input"
              value={pwd}
              placeholder="如 abcd"
              onChange={(e) => setPwd(e.target.value)}
            />
          </Field>
        </div>

        {selectedPan && !selectedPan.requiresAuth ? (
          <div style={{ marginTop: 12 }}>
            <Switch
              checked={guest}
              onChange={setGuest}
              label={`游客态解析（免凭据；${selectedPan.name} 支持时最快）`}
            />
          </div>
        ) : null}

        <div className="pan-actions">
          <Button
            variant="primary"
            icon="search"
            loading={resolving}
            disabled={!url.trim()}
            onClick={resolve}
          >
            解析直链
          </Button>
          <button
            type="button"
            className="card__toggle"
            aria-expanded={credOpen}
            onClick={() => setCredOpen((prev) => !prev)}
          >
            <Icon name={credOpen ? 'chevronDown' : 'chevronRight'} size={13} />
            登录凭据（可选）
          </button>
          {storedActive ? (
            <span className="pan-cred-saved">
              <Icon name="check" size={11} />
              已存「{slotLabel(activeKey)}」的凭据
              <button type="button" className="pan-cred-saved__x" onClick={() => clearSlot(activeKey)}>
                清除
              </button>
            </span>
          ) : null}
        </div>

        {credOpen ? (
          <div className="pan-cred">
            <div className="form-grid">
              <Field
                label={need.cookie && selectedPan ? 'Cookie（本网盘需要）' : 'Cookie'}
                hint={
                  selectedPan
                    ? `只用于「${selectedPan.name}」，切换网盘会自动换成该网盘已存的那份`
                    : '只存在本机浏览器，不会发给后端保存'
                }
                full
              >
                <input
                  className="input"
                  value={cookie}
                  placeholder="BDUSS=…; SESSION=…"
                  onChange={(e) => setCookie(e.target.value)}
                />
              </Field>
              <Field
                label={need.token && selectedPan ? 'Token（本网盘需要）' : 'Token'}
                hint="阿里云盘等用 Bearer token"
                full
              >
                <input
                  className="input"
                  value={token}
                  placeholder="eyJhbGciOi…"
                  onChange={(e) => setToken(e.target.value)}
                />
              </Field>
            </div>
            <div className="pan-cred__foot">
              <Switch checked={remember} onChange={setRemember} label="自动保存到本机（按网盘分别存）" />
              <span className="footnote">
                {Object.keys(slots).length > 0
                  ? `已存 ${Object.keys(slots).length} 家：${Object.keys(slots).map(slotLabel).join('、')}`
                  : '关闭后不再自动保存；已存的可在下方列表逐项清除'}
              </span>
            </div>
          </div>
        ) : null}

        {selectedPan?.authHint ? (
          <div style={{ marginTop: 12 }}>
            <Notice tone={selectedPan.requiresAuth ? 'warn' : 'info'} icon="alert">
              <b>{selectedPan.name}</b>：{selectedPan.authHint}
            </Notice>
          </div>
        ) : null}
      </Card>

      {resolving && !result ? <Loading text="正在解析（列目录 + 逐文件取链，大分享可能要十几秒）…" /> : null}

      {error ? (
        <Notice tone="error" icon="alert">
          <div className="pan-err__title">{explained ? explained.title : '解析失败'}</div>
          <div className="pan-err__raw">{error}</div>
          {explained ? (
            <ul className="pan-err__tips">
              {explained.tips.map((tip) => (
                <li key={tip}>{tip}</li>
              ))}
            </ul>
          ) : null}
          <div className="pan-err__actions">
            {explained?.primary === 'guest' ? (
              <Button size="sm" icon="user" onClick={() => setGuest(true)}>
                开启游客态
              </Button>
            ) : null}
            {explained?.primary === 'cookie' ? (
              <Button size="sm" icon="shield" onClick={() => setCredOpen(true)}>
                去填登录凭据
              </Button>
            ) : null}
            <Button size="sm" icon="refresh" loading={resolving} onClick={resolve}>
              重试
            </Button>
          </div>
        </Notice>
      ) : null}

      {/* 迅雷图形验证码：解析失败时后端把图片内嵌回来。在这里填文字原地重试，
          不用回浏览器登录态那套流程；「换一张」= 不带文字再解析一次。 */}
      {captchaImage ? (
        <Card title="需要图形验证码" icon="shield" subtitle="迅雷风控触发，输入图中文字即可继续">
          <div className="pan-captcha">
            <img className="pan-captcha__img" src={captchaImage} alt="迅雷验证码" />
            <div className="pan-captcha__side">
              <Field label="图中文字" full hint="看不清就换一张；填错会再要一次">
                <input
                  className="input"
                  value={captchaCode}
                  placeholder="输入验证码文字"
                  onChange={(e) => setCaptchaCode(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' && !resolving) submitCaptcha()
                  }}
                />
              </Field>
              <div className="pan-actions">
                <Button
                  variant="primary"
                  icon="check"
                  loading={resolving}
                  disabled={!captchaCode.trim()}
                  onClick={submitCaptcha}
                >
                  提交并重新解析
                </Button>
                <Button icon="refresh" loading={resolving} onClick={resolve}>
                  换一张
                </Button>
              </div>
            </div>
          </div>
        </Card>
      ) : null}

      {result ? (
        <Card
          title={result.title || '（无标题）'}
          icon="link"
          subtitle={`${result.pan} · ${files.length} 项`}
          actions={
            <div className="pan-actions pan-actions--tight">
              <Button
                icon="copy"
                size="sm"
                disabled={selectedFiles.length === 0}
                onClick={copyAll}
                title={allSelected ? '复制全部直链' : `只复制勾选的 ${selectedFiles.length} 条`}
              >
                复制全部直链{allSelected ? '' : `（${selectedFiles.length}）`}
              </Button>
              <Button
                icon="send"
                size="sm"
                loading={pushing}
                disabled={selectedFiles.length === 0}
                onClick={() => pushToAria2(selectedFiles)}
                title={allSelected ? '把全部直链交给 aria2' : `只推送勾选的 ${selectedFiles.length} 条`}
              >
                推送到 aria2{allSelected ? '' : `（${selectedFiles.length}）`}
              </Button>
              <Button
                variant="primary"
                icon="download"
                size="sm"
                loading={starting}
                disabled={selectedFiles.length === 0}
                onClick={startDownload}
                title="由工作台自己下载到本机目录，可看进度、可取消"
              >
                下载到本机{allSelected ? '' : `（${selectedFiles.length}）`}
              </Button>
            </div>
          }
        >
          <div className="toolbar">
            <Tabs
              value={fileFilter}
              onChange={setFileFilter}
              options={[
                { value: 'all', label: '全部', count: files.length },
                { value: 'file', label: '文件', count: fileCount },
                { value: 'dir', label: '目录', count: dirCount },
              ]}
            />
            <SearchBox value={query} onChange={setQuery} placeholder="搜索路径…" width={240} />
            <div className="spacer" />
            <span className="footnote">
              {visibleFiles.length} 项 · 直链 {viewLinks.length} 条{viewSize ? ` · ${formatBytes(viewSize)}` : ''}
              {allSelected
                ? ''
                : ` · 已选 ${selectedFiles.length}${selectedSize ? `（${formatBytes(selectedSize)}）` : ''}`}
            </span>
            <Button
              size="sm"
              icon={allSelected ? 'square' : 'checkSquare'}
              onClick={toggleAll}
              disabled={downloadable.length === 0}
              title={allSelected ? '取消全部勾选' : '选中全部可下载文件'}
            >
              {allSelected ? '取消全选' : '全选'}
            </Button>
          </div>

          {files.length === 0 ? (
            <EmptyState title="没有解析出文件" hint="分享可能已失效、为空，或需要登录态 / 提取码。" />
          ) : visibleFiles.length === 0 ? (
            <EmptyState title="没有匹配项" hint="换个关键词，或把筛选切回「全部」。" />
          ) : (
            <table className="table">
              <thead>
                <tr>
                  <th style={{ width: 36 }} className="pan-check-cell">
                    <input
                      type="checkbox"
                      className="pan-check"
                      checked={allSelected}
                      onChange={toggleAll}
                      disabled={downloadable.length === 0}
                      title={allSelected ? '取消全选' : '全选'}
                      aria-label="全选或取消全选"
                    />
                  </th>
                  <th>路径</th>
                  <th style={{ width: 100 }}>大小</th>
                  <th>直链</th>
                  <th style={{ width: 128 }} className="table__actions" />
                </tr>
              </thead>
              <tbody>
                {visibleFiles.map((file, index) => {
                  // 勾态：文件看自己；目录看其下是否整目录选中（空目录恒为 false）
                  const checked = file.is_dir
                    ? dirCovered(file.path)
                    : selected.has(file.path)
                  // 没有直链的文件勾了也下不动：保留勾框但禁用，比隐藏更能说明问题
                  const disabled = file.is_dir
                    ? !files.some((f) => !f.is_dir && f.path.startsWith(`${file.path}/`))
                    : !file.url
                  return (
                    <tr key={`${file.path}-${index}`}>
                      <td className="pan-check-cell">
                        <input
                          type="checkbox"
                          className="pan-check"
                          checked={checked}
                          disabled={disabled}
                          onChange={() => toggleOne(file)}
                          title={disabled ? '没有可下载的直链' : ''}
                          aria-label={`选择 ${file.path}`}
                        />
                      </td>
                      <td className="table__path" title={file.path}>
                        <Icon name={file.is_dir ? 'folder' : 'fileText'} size={13} />
                        {'  '}
                        {file.path}
                      </td>
                      <td className="tech">{file.is_dir ? '—' : formatBytes(Number(file.size) || 0)}</td>
                      <td className="tech" title={file.url || ''}>
                        {file.url ? (
                          <span className="pans-url">{file.url}</span>
                        ) : (
                          <span className="muted">{file.is_dir ? '目录' : '未取到直链'}</span>
                        )}
                      </td>
                      <td className="table__actions">
                        {file.url ? (
                          <div className="pan-row-actions">
                            <Button size="sm" icon="copy" onClick={() => copyOne(file)}>
                              复制
                            </Button>
                            <Button
                              size="sm"
                              icon="send"
                              loading={pushing}
                              onClick={() => pushToAria2([file])}
                              title="只推送这一条到 aria2"
                            >
                              推送
                            </Button>
                          </div>
                        ) : null}
                      </td>
                    </tr>
                  )
                })}
              </tbody>
            </table>
          )}
        </Card>
      ) : null}

      {/* 落地设置：默认折叠。不下载/不推送的人不该被这些参数挡住 */}
      <div className="card">
        <header className="card__header">
          <div className="card__title">
            <button
              type="button"
              className="card__toggle"
              aria-expanded={transferOpen}
              onClick={() => setTransferOpen((prev) => !prev)}
            >
              <Icon name={transferOpen ? 'chevronDown' : 'chevronRight'} size={13} />
              下载与推送设置
            </button>
          </div>
          <div className="card__actions">
            <span className="footnote pan-transfer__summary">
              {transfer.dir ? transfer.dir : '未设置保存目录'}
              {aria2Info?.version ? ` · aria2 ${aria2Info.version}` : ''}
            </span>
            <Button size="sm" icon="folderOpen" onClick={openDir}>
              打开目录
            </Button>
          </div>
        </header>
        {transferOpen ? (
          <div className="card__body">
            <div className="form-grid">
              <Field
                label="保存目录"
                full
                hint="下载到本机时的落地位置；推送 aria2 时作为它的 dir。必须是完整路径（不要用盘符根目录）"
              >
                <input
                  className="input"
                  value={transfer.dir}
                  placeholder="D:\\Downloads\\pan"
                  onChange={(e) => updateTransfer({ dir: e.target.value })}
                />
              </Field>

              <Field label="aria2 RPC 地址" full hint="aria2c --enable-rpc=true --rpc-listen-port=6800 启动后的地址">
                <input
                  className="input"
                  value={transfer.rpcUrl}
                  placeholder="http://127.0.0.1:6800/jsonrpc"
                  onChange={(e) => updateTransfer({ rpcUrl: e.target.value })}
                />
              </Field>

              <Field label="aria2 密钥" hint="对应 aria2 的 --rpc-secret，留空表示没设密钥">
                <input
                  className="input"
                  type="password"
                  value={transfer.secret}
                  placeholder="留空 = 无密钥"
                  onChange={(e) => updateTransfer({ secret: e.target.value })}
                />
              </Field>

              <Field label="文件并发" hint="同时下几个文件（1 = 串行，更稳）">
                <select
                  className="select"
                  value={transfer.jobs}
                  onChange={(e) => updateTransfer({ jobs: Number(e.target.value) })}
                >
                  {[1, 2, 3, 5, 8].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </Field>

              <Field label="单文件分块" hint=">1 时用 Range 多线程；服务端不支持会自动回退">
                <select
                  className="select"
                  value={transfer.threads}
                  onChange={(e) => updateTransfer({ threads: Number(e.target.value) })}
                >
                  {[1, 2, 4, 8].map((n) => (
                    <option key={n} value={n}>
                      {n}
                    </option>
                  ))}
                </select>
              </Field>
            </div>

            <div className="pan-cred__foot">
              <Switch
                checked={transfer.resume}
                onChange={(value) => updateTransfer({ resume: value })}
                label="断点续传（中断后重跑接着下）"
              />
              <Button size="sm" icon="wifi" loading={testingAria2} onClick={testAria2}>
                测试 aria2
              </Button>
              {aria2Info?.version ? (
                <span className="pan-cred-cell__ok">
                  <Icon name="check" size={11} /> 连通，版本 {aria2Info.version}
                </span>
              ) : null}
            </div>

            {aria2Info?.error ? (
              <div style={{ marginTop: 10 }}>
                <Notice tone="error" icon="alert">
                  {aria2Info.error}
                  {explainTransferError(aria2Info.error) ? (
                    <div className="pan-err__raw">{explainTransferError(aria2Info.error)}</div>
                  ) : null}
                </Notice>
              </div>
            ) : null}

            {pushResult ? (
              <div style={{ marginTop: 10 }}>
                {pushResult.error ? (
                  <Notice tone="error" icon="alert">
                    {pushResult.error}
                    {explainTransferError(pushResult.error) ? (
                      <div className="pan-err__raw">{explainTransferError(pushResult.error)}</div>
                    ) : null}
                  </Notice>
                ) : (
                  <Notice tone={pushResult.failed ? 'warn' : 'info'} icon="check">
                    已推送 {pushResult.pushed} 条{pushResult.failed ? `，失败 ${pushResult.failed} 条` : ''}
                    {pushResult.dir ? `，保存到 ${pushResult.dir}` : ''}
                    {pushResult.failed ? (
                      <div className="pan-err__raw">
                        {pushResult.results
                          .filter((item) => !item.ok)
                          .slice(0, 3)
                          .map((item) => `${item.path}：${item.error}`)
                          .join('；')}
                      </div>
                    ) : null}
                  </Notice>
                )}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>

      {jobError ? (
        <Notice tone="error" icon="alert">
          {jobError}
          {explainTransferError(jobError) ? (
            <div className="pan-err__raw">{explainTransferError(jobError)}</div>
          ) : null}
        </Notice>
      ) : null}

      {job ? (
        <Card
          title="下载任务"
          icon="download"
          subtitle={JOB_STATUS[job.status]?.[0] || job.status}
          actions={
            <div className="pan-actions pan-actions--tight">
              {['queued', 'running'].includes(job.status) ? (
                <Button size="sm" icon="stop" onClick={cancelDownload}>
                  取消
                </Button>
              ) : (
                <Button size="sm" icon="refresh" loading={starting} onClick={startDownload}>
                  再下一次
                </Button>
              )}
              <Button size="sm" icon="folderOpen" onClick={openDir}>
                打开目录
              </Button>
            </div>
          }
        >
          <div className="pan-job">
            <div className="pan-job__bar" role="progressbar" aria-valuenow={jobPercent} aria-valuemin={0} aria-valuemax={100}>
              <div
                className={`pan-job__fill is-${job.status}`}
                style={{ width: `${Math.min(100, Math.max(0, jobPercent))}%` }}
              />
            </div>
            <div className="pan-job__meta">
              <span className="tech">{jobPercent}%</span>
              {job.bytesTotal > 0 ? (
                <span className="tech">
                  {formatBytes(job.bytesDone)} / {formatBytes(job.bytesTotal)}
                </span>
              ) : null}
              <span className="footnote">
                成功 {job.done} · 跳过 {job.skipped} · 失败 {job.failed} · 共 {job.total || '—'} 个文件
              </span>
              <span className="spacer" />
              <span className="footnote pan-job__dir" title={job.dir}>
                {job.dir}
              </span>
            </div>
            {job.current ? <div className="pan-job__current">正在处理：{job.current}</div> : null}
            {job.error ? <div className="pan-err__raw">{job.error}</div> : null}
            {job.files?.length > 0 ? (
              <ul className="pan-job__files">
                {job.files.slice(-8).map((file, index) => (
                  <li key={`${file.path}-${index}`} className={`is-${file.state}`}>
                    {file.state === 'ok' ? '✓' : file.state === 'skipped' ? '=' : '✗'} {file.path}
                    {file.error ? `（${file.error}）` : ''}
                  </li>
                ))}
                {job.files.length > 8 ? <li className="muted">…另有 {job.files.length - 8} 条</li> : null}
              </ul>
            ) : null}
            {job.log?.length > 0 && job.status === 'error' ? (
              <div className="pan-job__log">{job.log.slice(-3).join('\n')}</div>
            ) : null}
          </div>
        </Card>
      ) : null}

      {/* 最近解析：没有结果时才出现，避免和直链表抢注意力 */}
      {!result && history.length > 0 ? (
        <Card title="最近解析" icon="clock" subtitle="点一条即可重新取链，不用再粘一次">
          <div className="pan-hist">
            {history.map((entry) => (
              <div className="pan-hist__row" key={entry.url}>
                <div className="pan-hist__main">
                  <div className="pan-hist__title" title={entry.title || entry.url}>
                    {entry.title || entry.url}
                  </div>
                  <div className="pan-hist__meta">
                    {entry.pan || '自动识别'} · {entry.count} 项 · {relativeTime(entry.at)}
                  </div>
                </div>
                <div className="pan-hist__actions">
                  <Button size="sm" icon="refresh" loading={resolving} onClick={() => reparse(entry)}>
                    重新解析
                  </Button>
                  <Button size="sm" icon="trash" onClick={() => removeHistory(entry.url)}>
                    删除
                  </Button>
                </div>
              </div>
            ))}
          </div>
        </Card>
      ) : null}

      {/* 默认折叠：这份清单是查阅 + 管理凭据用的，摊开会挤掉上面的解析区 */}
      <div className="card">
        <header className="card__header">
          <div className="card__title">
            <button
              type="button"
              className="card__toggle"
              aria-expanded={supportOpen}
              onClick={() => setSupportOpen((prev) => !prev)}
            >
              <Icon name={supportOpen ? 'chevronDown' : 'chevronRight'} size={13} />
              支持的网盘与凭据要求
            </button>
          </div>
          <div className="card__actions">
            <span className="footnote">
              {pans.length} 家 · 游客可用 {pans.filter((item) => !item.requiresAuth).length} 家 · 已存凭据{' '}
              {Object.keys(slots).length} 家
            </span>
          </div>
        </header>
        {supportOpen ? (
          <div className="card__body card__body--flush">
            {pans.length === 0 ? (
              <EmptyState title="暂无网盘信息" hint="点右上角刷新重试。" />
            ) : (
              <table className="table">
                <thead>
                  <tr>
                    <th style={{ width: 140 }}>网盘</th>
                    <th style={{ width: 84 }}>登录态</th>
                    <th>凭据说明</th>
                    <th style={{ width: 150 }}>本机凭据</th>
                  </tr>
                </thead>
                <tbody>
                  {pans.map((item) => {
                    const saved = slots[item.name]
                    const hasSaved = Boolean(saved && (saved.cookie || saved.token))
                    return (
                      <tr key={item.name}>
                        <td>{item.name}</td>
                        <td>
                          <span className={`status-word ${item.requiresAuth ? 'is-warn' : 'muted'}`}>
                            {item.requiresAuth ? '需登录' : '游客可用'}
                          </span>
                        </td>
                        <td className="muted">{item.authHint}</td>
                        <td>
                          {hasSaved ? (
                            <span className="pan-cred-cell">
                              <span className="pan-cred-cell__ok">
                                <Icon name="check" size={11} /> 已配置
                              </span>
                              <button
                                type="button"
                                className="pan-cred-saved__x"
                                onClick={() => clearSlot(item.name)}
                              >
                                清除
                              </button>
                            </span>
                          ) : (
                            <span className="muted">{item.requiresAuth ? '未配置' : '不需要'}</span>
                          )}
                        </td>
                      </tr>
                    )
                  })}
                </tbody>
              </table>
            )}
          </div>
        ) : null}
      </div>

      {!result && !resolving ? (
        <Notice tone="info" icon="alert">
          直链有时效（几十分钟到几小时，各网盘不同），过期后重新解析即可。三个出口的分工：复制最通用；
          推给 aria2 不占工作台进程，适合大文件；下载到本机会把进度留在页面上，关掉页面也不会中断。
          部分网盘（百度、迅雷）会按出口 IP 做风控，遇到验证码或 need verify 属于平台策略，不是解析失败。
        </Notice>
      ) : null}
    </div>
  )
}

export default PansPage
