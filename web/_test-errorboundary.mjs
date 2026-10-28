/**
 * ErrorBoundary 单元测试：react-dom/server 直接渲染产品组件。
 *
 * 为什么费这个劲：错误边界是「页面崩了不白屏」的最后防线，但它只在真的抛错时
 * 才走 fallback 分支——e2e 里很难稳定触发渲染异常。
 * 注意：React 18 SSR 的错误边界**不捕获**渲染错误（renderToString 会直接把错误
 * 抛出，fallback 仅客户端生效），所以这里直接驱动实例：手动置 state.error 后调
 * render()，验证 fallback 的内容与契约。
 * 用法: node _test-errorboundary.mjs
 */
import { createElement as h } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import babel from '@babel/core'
import { readdirSync, readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { join, relative, dirname } from 'node:path'
import { pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const jsxPlugin = require.resolve('@babel/plugin-transform-react-jsx')

const results = []
const check = (name, ok, detail = '') => {
  results.push({ name, ok })
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  -> ' + detail : ''}`)
}

/** 把 src/ 全树转成 ESM（.jsx → .mjs），输出到 web/.tmp-unit-*（放 web 下才能找到 react） */
function buildTree(srcDir, outDir) {
  let count = 0
  const walk = (dir) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, entry.name)
      if (entry.isDirectory()) {
        walk(full)
        continue
      }
      if (!entry.name.endsWith('.js') && !entry.name.endsWith('.jsx')) continue
      const rel = relative(srcDir, full)
      const outPath = join(outDir, rel.replace(/\.jsx$/, '.mjs'))
      mkdirSync(dirname(outPath), { recursive: true })
      const out = babel.transformSync(readFileSync(full, 'utf8'), {
        filename: full,
        babelrc: false,
        configFile: false,
        plugins: [[jsxPlugin, { runtime: 'automatic' }]],
      })
      // 源码里 import './X.jsx' 写死了扩展名；产物改名 .mjs 后必须同步改说明符（.jsx 换成 .mjs，不是追加）
      writeFileSync(outPath, out.code.replace(/(from\s+['"])([^'"]*?)\.jsx(['"])/g, '$1$2.mjs$3'))
      count += 1
    }
  }
  walk(srcDir)
  writeFileSync(join(outDir, 'package.json'), JSON.stringify({ type: 'module' }))
  return count
}

const outDir = join(process.cwd(), `.tmp-unit-${Date.now().toString(36)}`)
try {
  const built = buildTree('src', outDir)
  console.log(`[setup] 已转换 ${built} 个源文件 → ${outDir}`)

  const { ErrorBoundary } = await import(pathToFileURL(join(outDir, 'components/ErrorBoundary.mjs')).href)

  // 必炸的子组件：渲染即抛错（模拟页面里任何一个环节崩了）
  function Boom() {
    throw new Error('模拟渲染崩溃：读到了 undefined.foo')
  }

  // ---- 1. 抛错后走 fallback：驱动实例 render（SSR 不捕获渲染错，见文件头注释）----
  const crashedInstance = new ErrorBoundary({ children: h(Boom) })
  crashedInstance.state = { error: new Error('模拟渲染崩溃：读到了 undefined.foo'), copied: false }
  const crashed = renderToStaticMarkup(crashedInstance.render())
  check('抛错时不白屏，渲染兜底卡片', crashed.includes('这一页出了点问题'), crashed.slice(0, 80))
  check('兜底卡有错误消息原文', crashed.includes('读到了 undefined.foo'))
  check('兜底卡有「重试这一页」按钮', crashed.includes('重试这一页'))
  check('兜底卡有「复制错误详情」', crashed.includes('复制错误详情'))
  check('兜底卡有折叠技术详情', crashed.includes('技术详情'))
  check('兜底卡告诉用户侧栏还能用', crashed.includes('左侧导航') || crashed.includes('去其他页面'))
  check('兜底卡声明数据不丢', crashed.includes('数据不会丢'))
  check('兜底卡是 role=alert（辅助技术可感知）', crashed.includes('role="alert"'))

  // ---- 2. 不抛错 → 完全透传，零侵入 ----
  const healthy = renderToStaticMarkup(h(ErrorBoundary, null, h('div', null, '正常业务内容')))
  check('正常时透传 children', healthy.includes('正常业务内容'))
  check('正常时不出现兜底文案', !healthy.includes('这一页出了点问题'))

  // ---- 3. getDerivedStateFromError 契约：必须返回带 error 的 state ----
  const derived = ErrorBoundary.getDerivedStateFromError(new Error('x'))
  check('getDerivedStateFromError 返回 { error }', derived && derived.error instanceof Error, JSON.stringify(Object.keys(derived || {})))

  // ---- 4. 边界可重置：setState 后回到 children（重试按钮的行为基础）----
  const instance = new ErrorBoundary({})
  instance.state = { error: new Error('boom'), copied: false }
  instance.setState = (patch) => {
    instance.state = { ...instance.state, ...(typeof patch === 'function' ? patch(instance.state) : patch) }
  }
  instance.handleRetry()
  check('handleRetry 清空 error（重试能回到页面）', instance.state.error === null)
} finally {
  rmSync(outDir, { recursive: true, force: true })
}

const passed = results.filter((r) => r.ok).length
const failed = results.length - passed
console.log(`\n结果：${passed} 项通过，${failed} 项失败`)
process.exit(failed > 0 ? 1 : 0)
