/**
 * 极简并发闸门：限制同时在跑的异步任务数量（SSH 连接数控制用）。
 * acquire() 返回释放函数，务必在 finally 中调用。
 */
export function createLimiter(max = 3) {
  const limit = Math.max(1, Number(max) || 1)
  const queue = []
  let active = 0

  function next() {
    if (active >= limit || queue.length === 0) return
    active += 1
    const { resolve } = queue.shift()
    resolve(() => {
      active -= 1
      next()
    })
  }

  return {
    get active() {
      return active
    },
    get pending() {
      return queue.length
    },
    get limit() {
      return limit
    },
    acquire() {
      return new Promise((resolve) => {
        queue.push({ resolve })
        next()
      })
    },
    /** 包一层：自动获取/释放 */
    async run(task) {
      const release = await this.acquire()
      try {
        return await task()
      } finally {
        release()
      }
    },
  }
}
