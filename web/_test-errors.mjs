/**
 * friendlyError 翻译规则单测（纯函数，node 直跑，无需构建）。
 * 每条规则都钉死三件事：识别得出、给下一步动作、原文不外泄给新手（进 detail）。
 * 用法: node _test-errors.mjs
 */
import { friendlyError } from './src/utils/errors.js'

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`)
}

// ---- 网络层：请求没打到后端 ----
const netCases = [
  ['TypeError Failed to fetch', new TypeError('Failed to fetch')],
  ['NetworkError 长文案', new TypeError('NetworkError when attempting to fetch resource.')],
  ['ECONNREFUSED', new Error('connect ECONNREFUSED 127.0.0.1:8787')],
  ['load failed', new TypeError('load failed')],
  ['字符串输入（Wsl 页的 err.message）', 'Failed to fetch'],
]
for (const [label, err] of netCases) {
  const f = friendlyError(err)
  check(`网络错误 → 「连不上工作台服务」（${label}）`, f.title === '连不上工作台服务', f.title)
  check(`网络错误给出启动器线索（${label}）`, f.hint.includes('start.bat'), f.hint.slice(0, 40))
}

// ---- 服务端出错：打到了但崩了 ----
for (const [label, err] of [
  ['status=500', Object.assign(new Error('boom'), { status: 500 })],
  ['status=503', Object.assign(new Error('unavailable'), { status: 503 })],
  ['文本 HTTP 500', new Error('请求失败（HTTP 500）')],
]) {
  const f = friendlyError(err)
  check(`服务端错误 → 「服务端出错了」（${label}）`, f.title === '服务端出错了', f.title)
  check(`服务端错误指向日志页（${label}）`, f.hint.includes('日志'), f.hint.slice(0, 40))
}

// ---- 404：后端旧了 ----
const f404 = friendlyError(Object.assign(new Error('no route'), { status: 404 }))
check('404 → 「这个功能不存在」', f404.title === '这个功能不存在', f404.title)
check('404 建议重启工作台', f404.hint.includes('重启'), f404.hint.slice(0, 40))

// ---- 429：太频繁 ----
const f429 = friendlyError(Object.assign(new Error('too many'), { status: 429 }))
check('429 → 「操作太频繁了」', f429.title === '操作太频繁了', f429.title)

// ---- 识别不出：保留原文，不编造 ----
const biz = friendlyError(new Error('主密码错误，解锁失败'))
check('业务错误保留原文', biz.hint === '主密码错误，解锁失败', biz.hint)
check('业务错误不装成网络错误', biz.title !== '连不上工作台服务', biz.title)
check('业务错误无 detail（原文已在 hint）', biz.detail === '', String(biz.detail))

// ---- 空错误：兜底也不能空手 ----
for (const [label, err] of [
  ['null', null],
  ['空串', ''],
  ['空 message Error', new Error('')],
]) {
  const f = friendlyError(err)
  check(`空错误有兜底文案（${label}）`, f.title.length > 0 && f.hint.length > 10, `${f.title} / ${f.hint.slice(0, 20)}`)
  check(`空错误也指路（${label}）`, f.hint.includes('重试') || f.hint.includes('日志'), f.hint.slice(0, 30))
}

// ---- 不变量：任何识别出的错误，原文都必须进 detail（懂的人能排查） ----
const withDetail = friendlyError(new TypeError('Failed to fetch'))
check('识别出的错误原文进 detail', withDetail.detail === 'Failed to fetch', withDetail.detail)

// ---- 不变量：hint 必须含动作词（指出问题不给动作 = 没说） ----
const actionWords = ['重试', '确认', '重启', '等几秒', '日志']
const probes = [
  new TypeError('Failed to fetch'),
  Object.assign(new Error('x'), { status: 500 }),
  Object.assign(new Error('x'), { status: 404 }),
  Object.assign(new Error('x'), { status: 429 }),
  null,
]
const noAction = probes.filter((e) => !actionWords.some((w) => friendlyError(e).hint.includes(w)))
check('所有分支的 hint 都带下一步动作', noAction.length === 0, `缺动作的分支数=${noAction.length}`)

const passed = results.filter((r) => r.ok).length
const failed = results.length - passed
console.log(`\n结果：${passed} 项通过，${failed} 项失败`)
process.exit(failed > 0 ? 1 : 0)
