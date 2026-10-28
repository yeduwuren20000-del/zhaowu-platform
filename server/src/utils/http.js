/** 业务错误：带 HTTP 状态码，交给统一错误处理中间件 */
export class HttpError extends Error {
  constructor(status, message, extra = {}) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.extra = extra
  }
}

export function badRequest(message, extra) {
  return new HttpError(400, message, extra)
}

export function notFound(message = '记录不存在') {
  return new HttpError(404, message)
}

/** 包装 async 路由，Express 4 不会自动捕获 Promise 拒绝 */
export function asyncRoute(handler) {
  return (req, res, next) => {
    Promise.resolve(handler(req, res, next)).catch(next)
  }
}

export function sendOk(res, data) {
  res.json({ ok: true, data })
}

export function errorHandler(error, req, res, next) { // eslint-disable-line no-unused-vars
  // body-parser 超限（如文档转换传了大文件）：默认 message 是英文 "request entity
  // too large"、状态码 413，前端会原样展示给用户——换成能行动的中文。
  const tooLarge = error?.type === 'entity.too.large'
  if (tooLarge) {
    error.message = '文件太大：单个文件请控制在 35MB 以内（服务器上传上限）'
  }
  const status = error instanceof HttpError ? error.status : tooLarge ? 413 : 500
  const payload = {
    ok: false,
    error: {
      message: error?.message || '服务器内部错误',
      ...(error instanceof HttpError ? error.extra : {}),
    },
  }
  if (status >= 500) console.error('[api]', req.method, req.originalUrl, error)
  res.status(status).json(payload)
}
