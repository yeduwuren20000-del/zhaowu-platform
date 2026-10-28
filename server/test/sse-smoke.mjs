// SSE 冒烟测试：连接 /api/logs/stream，打印前两帧后退出（临时脚本）
const url = 'http://127.0.0.1:8787/api/logs/stream?source=workbench&lines=5'
const controller = new AbortController()
const timer = setTimeout(() => controller.abort(), 6000)

try {
  const response = await fetch(url, { signal: controller.signal, headers: { Accept: 'text/event-stream' } })
  console.log('status', response.status, response.headers.get('content-type'))
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let frames = 0
  while (frames < 2) {
    const { value, done } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const parts = buffer.split('\n\n')
    buffer = parts.pop() || ''
    for (const part of parts) {
      const text = part.trim()
      if (!text) continue
      console.log('FRAME:', text.slice(0, 220))
      frames += 1
    }
  }
  controller.abort()
} catch (error) {
  console.log('SSE_TEST_ERROR', error.name, error.message)
} finally {
  clearTimeout(timer)
}
