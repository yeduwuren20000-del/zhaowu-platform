import http from 'node:http'
import https from 'node:https'
import path from 'node:path'
import { HttpError, badRequest } from '../utils/http.js'

/**
 * aria2 JSON-RPC 客户端（零依赖，只用 node:http）。
 *
 * 为什么不用全局 fetch —— 这不是风格问题，是**踩过的坑**：
 * 本机常驻代理（HTTP_PROXY=http://127.0.0.1:60807）时，Node 的全局 fetch 会把
 * 发往 127.0.0.1 的请求也塞进代理（undici 的 EnvHttpProxyAgent 在没有 NO_PROXY
 * 时就是这么干的），于是「aria2 明明在跑」却收到 502，错误看起来像 aria2 挂了。
 * node:http 天然不读代理环境变量，从根上避开这一类误判。
 *
 * 另一个刻意选择：逐条 addUri 而不是 system.multicall。multicall 的 token 要
 * 塞进每个子调用里，一处写错就整批失败且错误不可定位；本地回环 RPC 单次 <5ms，
 * 逐条换来的是「哪一条被拒绝」的精确错误。
 */

const DEFAULT_RPC = 'http://127.0.0.1:6800/jsonrpc'
export const RPC_TIMEOUT_MS = Number(process.env.DSM_ARIA2_TIMEOUT_MS || 8000)
const MAX_LINKS = 500

/** 归一化 RPC 地址：允许只填 http://127.0.0.1:6800（自动补 /jsonrpc） */
export function normalizeRpcUrl(raw) {
  const text = String(raw ?? '').trim() || DEFAULT_RPC
  let url
  try {
    url = new URL(text)
  } catch {
    throw badRequest(`aria2 RPC 地址不合法：${text}（形如 http://127.0.0.1:6800/jsonrpc）`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw badRequest('aria2 RPC 只支持 http / https')
  }
  if (!url.pathname || url.pathname === '/') url.pathname = '/jsonrpc'
  return url
}

function postJson(url, payload, timeoutMs) {
  return new Promise((resolve, reject) => {
    const lib = url.protocol === 'https:' ? https : http
    const body = Buffer.from(JSON.stringify(payload))
    const req = lib.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port || (url.protocol === 'https:' ? 443 : 80),
        path: `${url.pathname}${url.search}`,
        method: 'POST',
        // agent: false = 不共用连接池：RPC 是低频调用，池化只会让「改了地址」时串到旧连接
        agent: false,
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': body.length,
          Accept: 'application/json',
        },
        timeout: timeoutMs,
      },
      (res) => {
        const chunks = []
        res.on('data', (chunk) => chunks.push(chunk))
        res.on('end', () => {
          resolve({ status: res.statusCode || 0, text: Buffer.concat(chunks).toString('utf8') })
        })
      },
    )
    req.on('timeout', () => {
      const error = new Error(`RPC 超时（${timeoutMs}ms）`)
      error.code = 'ETIMEDOUT'
      req.destroy(error)
    })
    req.on('error', reject)
    req.end(body)
  })
}

function endpointLabel(url) {
  return `${url.hostname}:${url.port || (url.protocol === 'https:' ? 443 : 80)}`
}

/** 一次 JSON-RPC 调用，错误统一翻译成「人能照着做」的提示 */
export async function rpcCall({ rpcUrl, secret, method, params = [] }, { timeoutMs = RPC_TIMEOUT_MS } = {}) {
  const url = rpcUrl instanceof URL ? rpcUrl : normalizeRpcUrl(rpcUrl)
  const payload = {
    jsonrpc: '2.0',
    id: `dsm-${Date.now()}`,
    method,
    // aria2 的密钥固定是 params 的第一个元素，且必须是 `token:<secret>` 形式
    params: secret ? [`token:${secret}`, ...params] : params,
  }

  let res
  try {
    res = await postJson(url, payload, timeoutMs)
  } catch (error) {
    const code = String(error?.code || '')
    if (code === 'ECONNREFUSED') {
      throw new HttpError(
        502,
        `连不上 aria2（${endpointLabel(url)}）。确认 aria2 已启动并开启 RPC：`
          + 'aria2c --enable-rpc=true --rpc-listen-port=6800',
      )
    }
    if (code === 'ECONNRESET' || code === 'ETIMEDOUT' || code === 'EHOSTUNREACH' || code === 'ENOTFOUND') {
      throw new HttpError(504, `aria2 RPC 无响应（${endpointLabel(url)}）：${error.message}`)
    }
    throw new HttpError(502, `aria2 RPC 请求失败：${error.message}`)
  }

  if (res.status === 401 || res.status === 403) {
    throw new HttpError(400, 'aria2 拒绝了这个请求：RPC 密钥不对。请核对 aria2 的 --rpc-secret')
  }
  if (res.status === 404) {
    throw new HttpError(
      400,
      `aria2 RPC 路径不存在（${url.pathname}）。地址应形如 http://127.0.0.1:6800/jsonrpc`,
    )
  }

  let data
  try {
    data = JSON.parse(res.text)
  } catch {
    // 最常见的两种情况：填成了 Web 控制台首页，或填成了 BitTorrent 的 tracker 端口
    throw new HttpError(
      502,
      `aria2 返回的不是 JSON（HTTP ${res.status}）：`
        + `${String(res.text).slice(0, 120)}。确认地址是 …/jsonrpc 而不是网页界面`,
    )
  }

  if (data.error) {
    const message = String(data.error.message || JSON.stringify(data.error))
    // aria2 的鉴权失败**不是** HTTP 401，而是 200 + JSON-RPC error{code:1,message:"Unauthorized"}。
    // 只看状态码会把它当成"普通业务错误"，用户看到 Unauthorized 完全不知道要改哪里。
    if (/unauthor|token|secret/i.test(message)) {
      throw new HttpError(400, `aria2 拒绝了这个请求：RPC 密钥不对（${message}）。请核对 aria2 的 --rpc-secret`)
    }
    throw new HttpError(400, `aria2 拒绝了 ${method}：${message}`)
  }
  return data.result
}

/** 探活：拿版本号，顺带确认密钥是否正确 */
export async function testConnection({ rpcUrl, secret } = {}) {
  const url = normalizeRpcUrl(rpcUrl)
  const version = await rpcCall({ rpcUrl: url, secret, method: 'aria2.getVersion' })
  return {
    url: url.toString(),
    version: version?.version || '',
    enabledFeatures: Array.isArray(version?.enabledFeatures) ? version.enabledFeatures : [],
  }
}

/** 校验一条直链：只接受 http/https（file:// 与磁力链不属于「网盘直链」范畴） */
function assertHttpUrl(value, index) {
  const text = String(value || '').trim()
  if (!text) throw badRequest(`第 ${index + 1} 条直链为空`)
  let url
  try {
    url = new URL(text)
  } catch {
    throw badRequest(`第 ${index + 1} 条不是合法 URL：${text.slice(0, 80)}`)
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') {
    throw badRequest(`第 ${index + 1} 条不是 http/https 直链：${url.protocol}`)
  }
  return text
}

/** 把网盘的文件路径变成 aria2 的 out 文件名（aria2 的 out 不能再带目录分隔符） */
export function toOutName(item, used = new Set()) {
  const rawPath = String(item?.path || '').split('?')[0]
  let base = path.basename(rawPath) || path.basename(String(item?.url || '').split('?')[0]) || 'download'
  base = base.replace(/[\\/:*?"<>|\0\r\n]/g, '_').trim().slice(0, 120) || 'download'
  if (!used.has(base)) {
    used.add(base)
    return base
  }
  const ext = path.extname(base)
  const stem = ext ? base.slice(0, -ext.length) : base
  let n = 2
  let candidate = `${stem} (${n})${ext}`
  while (used.has(candidate)) {
    n += 1
    candidate = `${stem} (${n})${ext}`
  }
  used.add(candidate)
  return candidate
}

/** headers 对象 -> aria2 需要的 ["K: V", ...] */
function toHeaderList(headers) {
  if (!headers || typeof headers !== 'object') return []
  return Object.entries(headers)
    .filter(([key, value]) => key && value !== undefined && value !== null && value !== '')
    .map(([key, value]) => `${key}: ${value}`)
}

/**
 * 批量推送直链到 aria2。
 * @param {{rpcUrl?:string, secret?:string, dir?:string, items:Array<{url:string,path?:string,headers?:object}>}} input
 */
export async function pushLinks({ rpcUrl, secret, dir, items } = {}) {
  const list = Array.isArray(items) ? items : []
  if (list.length === 0) throw badRequest('没有可推送的直链')
  if (list.length > MAX_LINKS) throw badRequest(`一次最多推送 ${MAX_LINKS} 条，当前 ${list.length} 条`)

  const url = normalizeRpcUrl(rpcUrl)
  const targetDir = String(dir ?? '').trim()
  if (targetDir && /[\0\r\n]/.test(targetDir)) throw badRequest('保存目录包含非法字符')

  const used = new Set()
  const results = []
  for (let i = 0; i < list.length; i += 1) {
    const item = list[i] || {}
    const link = assertHttpUrl(item.url, i)
    const out = toOutName(item, used)
    const options = { out }
    if (targetDir) options.dir = targetDir
    const headers = toHeaderList(item.headers)
    if (headers.length > 0) options.header = headers

    try {
      const gid = await rpcCall({ rpcUrl: url, secret, method: 'aria2.addUri', params: [[link], options] })
      results.push({ path: item.path || out, out, ok: true, gid: String(gid || '') })
    } catch (error) {
      results.push({ path: item.path || out, out, ok: false, error: error.message })
      // 密钥错 / 连不上：后面每一条都会同样失败，早点收手并如实说明
      if (/密钥|连不上|无响应|不是 JSON|路径不存在/.test(error.message)) {
        for (let rest = i + 1; rest < list.length; rest += 1) {
          results.push({
            path: list[rest]?.path || toOutName(list[rest] || {}, used),
            ok: false,
            error: '已中止（前面的请求表明 aria2 不可用）',
          })
        }
        break
      }
    }
  }

  const okCount = results.filter((item) => item.ok).length
  return {
    url: url.toString(),
    dir: targetDir || '',
    pushed: okCount,
    failed: results.length - okCount,
    results,
  }
}
