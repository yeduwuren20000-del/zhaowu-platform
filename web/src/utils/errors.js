/**
 * 把技术错误翻译成新手能行动的话。
 *
 * 原则：
 *   1) 只翻译「识别得出的」——网络断了、服务端 500、功能不存在。
 *      识别不出的一律保留原文：后端的业务错误本来就是人话（比如"主密码错误"），
 *      宁可少说，不编造。
 *   2) 每条都必须带「下一步做什么」——指出问题但不给动作，等于没说。
 *   3) 原文进 detail（折叠展示），懂的人能排查，新手不被吓到。
 */

const NETWORK_PATTERN = /failed to fetch|networkerror|network error|load failed|econnrefused|econnreset|econnaborted|fetch failed|socket hang up/i

/** 从 Error 对象或消息文本里取 HTTP 状态码（client.js 会挂 status；文本兜底匹配 "HTTP 500"） */
function statusOf(error, raw) {
  if (typeof error?.status === 'number') return error.status
  const match = raw.match(/HTTP\s+(\d{3})/i)
  return match ? Number(match[1]) : null
}

export function friendlyError(error) {
  const raw = error instanceof Error ? error.message : error == null ? '' : String(error)

  if (!raw) {
    return {
      title: '出了点问题',
      hint: '没有拿到具体原因。可以点重试再试一次；如果反复出现，去「日志」页看最后几行，那里会写明原因。',
      detail: '',
    }
  }

  // 1) 网络层：请求根本没打到后端。最常见：start.bat 没开、窗口被关了、后端崩了
  if (NETWORK_PATTERN.test(raw)) {
    return {
      title: '连不上工作台服务',
      hint: '数据取不回来，通常是因为后台服务没在运行。请确认启动工作台的那个窗口（start.bat）还开着，然后点重试。',
      detail: raw,
    }
  }

  const status = statusOf(error, raw)

  // 2) 服务端出错：请求打到了，但后台处理时崩了
  if (status === 500 || status === 502 || status === 503 || status === 504) {
    return {
      title: '服务端出错了',
      hint: '后台处理这个请求时出了问题。可以重试一次；如果反复出现，去「日志」页看最后几行，那里会写明原因。',
      detail: raw,
    }
  }

  // 3) 功能不存在：基本是后端还是旧版本（前端更新了、后端没重启）
  if (status === 404) {
    return {
      title: '这个功能不存在',
      hint: '后端可能还是旧版本。重启一下工作台（重新运行 start.bat）再试。',
      detail: raw,
    }
  }

  // 4) 限流/维护：稍等就好
  if (status === 429) {
    return {
      title: '操作太频繁了',
      hint: '后台被短时间打太多次。等几秒钟再重试。',
      detail: raw,
    }
  }

  // 5) 识别不出：保留原文（多为后端业务错误，本身就是人话）
  return { title: '没成功', hint: raw, detail: '' }
}
