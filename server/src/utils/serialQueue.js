/**
 * 串行队列：把一串「读-改-写」按提交顺序排队执行。
 *
 * 为什么需要它：`jsonStore.mutate(fn)` 只把**写盘**排进内部串行链，
 * 而 load / structuredClone 是立刻发生的。于是同一份快照被多个并发调用读到，
 * 各自改完再依次落盘 —— 后写入者覆盖前面的，产生丢失更新（lost update）。
 *
 * 典型翻车现场：一轮自动采集里 3~4 台机器并行 recordOutcome，
 * 失败计数基于同一份旧快照各自 +1，最终只记到 1 次，该熔断的机器永远熔不断。
 *
 * 用法：
 *   const enqueue = createSerialQueue()
 *   await enqueue(() => repo.mutate(...))   // 整个读-改-写都在队列里
 *
 * 注意：一次报错不会卡死队列（错误照常抛给调用方，但链继续往下走）。
 */
export function createSerialQueue() {
  let tail = Promise.resolve()
  return function enqueue(task) {
    const run = tail.then(task, task)
    tail = run.then(
      () => undefined,
      () => undefined,
    )
    return run
  }
}
