/**
 * 一次性静态校验（用 @babel 手搓，因为本机 esbuild 起不来）：
 *   1) 语法能否解析
 *   2) 有没有引用未声明的变量（parse 查不出来，必须靠作用域分析）
 *   3) import 进来的符号在目标模块里是否真的导出
 *   4) 字面量 className 里的类名在 CSS 里是否定义
 * 用法: node _check.mjs [file...]
 */
import { readFileSync, readdirSync } from 'node:fs'
import { dirname, resolve as resolvePath } from 'node:path'
import babel from '@babel/core'

/**
 * 无参时自动收集 src/ 下全部 .js/.jsx。
 * 历史教训：这里曾写死 defaults = ['src/pages/Pans.jsx']，导致「全部通过」
 * 实际只覆盖了单文件——后来全量跑立刻抓到 Logs.jsx 误用不存在变量的真 bug。
 * 静态检查的默认行为必须是全量，不允许留「只查一个文件」的后门。
 */
function collectSources(dir = 'src', acc = []) {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const target = `${dir}/${entry.name}`
    if (entry.isDirectory()) collectSources(target, acc)
    else if (entry.name.endsWith('.js') || entry.name.endsWith('.jsx')) acc.push(target)
  }
  return acc
}

const files = process.argv.slice(2).length > 0 ? process.argv.slice(2) : collectSources()
if (files.length === 0) {
  console.error('没有找到任何待检查文件')
  process.exit(1)
}
// 样式分散在 styles/ 多个文件里，必须全读，否则会误报「类没定义」
const cssDir = 'src/styles'
const css = readdirSync(cssDir)
  .filter((name) => name.endsWith('.css'))
  .map((name) => readFileSync(`${cssDir}/${name}`, 'utf8'))
  .join('\n')
const cssClasses = new Set([...css.matchAll(/\.([a-zA-Z][\w-]*)/g)].map((m) => m[1]))
// BEM 家族匹配：CSS 里出现过 .foo__bar 时，.foo / .foo__baz / .foo--x 都算有样式支撑。
// 父类（.server-detail / .vault-mode）常常只做结构容器、样式全在子类上——
// 这不是「类没定义」，是检查器误报；误报会淹没真 FAIL（狼来了），比漏报更糟。
const cssBlocks = new Set()
for (const cls of cssClasses) {
  const block = cls.split(/__|--/)[0]
  if (block) cssBlocks.add(block)
}

let failed = false
// 每个文件单独计数：否则第一个文件出错后，后面的文件都会显示 FAIL（假失败同样不可信）
let fileErrors = 0
const report = (level, file, line, msg) => {
  if (level === 'error') {
    failed = true
    fileErrors += 1
  }
  const where = line ? `${file}:${line}` : file
  console.log(`${level === 'error' ? 'FAIL' : 'WARN'}  ${where}  ${msg}`)
}

function noUndefPlugin(reportFn) {
  return ({ types: t }) => {
    const declared = new Set([
      'console', 'window', 'document', 'localStorage', 'sessionStorage', 'navigator', 'fetch',
      'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', 'Promise', 'JSON', 'Math',
      'Number', 'String', 'Boolean', 'Object', 'Array', 'Date', 'Error', 'RegExp', 'URL', 'URLSearchParams',
      'EventSource', // SSE 日志流用的浏览器全局
      'Map', 'Set', 'WeakMap', 'WeakSet', 'Symbol', 'BigInt', 'Proxy', 'Reflect',
      'encodeURIComponent', 'decodeURIComponent', 'parseInt', 'parseFloat', 'isNaN',
      'undefined', 'globalThis', 'alert', 'confirm', 'requestAnimationFrame',
    ])
    return {
      visitor: {
        Program: {
          exit(path) {
            for (const name of Object.keys(path.scope.bindings)) declared.add(name)
          },
        },
        ReferencedIdentifier(path) {
          const name = path.node.name
          if (declared.has(name)) return
          if (name === 'arguments') return
          if (path.parentPath.isMemberExpression() && path.parentKey === 'property') return
          if (path.parentPath.isObjectProperty() && path.parentKey === 'key' && !path.parent.computed) return
          if (path.parentPath.isJSXAttribute && path.parentPath.isJSXAttribute()) return
          if (path.scope.hasBinding(name, true)) return
          reportFn(t, path.node.loc?.start.line, name)
        },
      },
    }
  }
}

function checkImports(ast, file, src) {
  const check = (source, importedNames, line) => {
    if (!source.startsWith('.')) return
    const target = resolvePath(dirname(file), source)
    let code = ''
    try {
      code = readFileSync(target, 'utf8')
    } catch {
      report('error', file, line, `import 目标不存在: ${source}`)
      return
    }
    // 该模块是否默认导出 / 具名导出
    const hasDefault = /export\s+default/.test(code)
    const named = new Set()
    for (const m of code.matchAll(/export\s+(?:async\s+)?(?:function|const|let|class)\s+([A-Za-z_$][\w$]*)/g)) named.add(m[1])
    for (const m of code.matchAll(/export\s*\{([^}]+)\}/g)) {
      for (const part of m[1].split(',')) {
        const name = part.trim().split(/\s+as\s+/).pop()?.trim()
        if (name) named.add(name)
      }
    }
    for (const item of importedNames) {
      if (item === 'default') {
        if (!hasDefault) report('error', file, line, `${source} 没有默认导出`)
        continue
      }
      if (!named.has(item)) report('error', file, line, `${source} 未导出 ${item}`)
    }
  }

  for (const node of ast.program.body) {
    if (node.type !== 'ImportDeclaration') continue
    const source = node.source.value
    const names = []
    for (const spec of node.specifiers) {
      if (spec.type === 'ImportDefaultSpecifier') names.push('default')
      else names.push(spec.imported.name)
    }
    check(source, names, node.loc?.start.line)
  }
}

function checkClasses(ast, file) {
  const walk = (node) => {
    if (!node || typeof node !== 'object') return
    if (Array.isArray(node)) return node.forEach(walk)
    if (node.type === 'JSXAttribute' && node.name?.name === 'className') {
      const value = node.value
      if (value?.type === 'StringLiteral') {
        for (const cls of value.value.split(/\s+/).filter(Boolean)) {
          const defined = cssClasses.has(cls) || cssBlocks.has(cls.split(/__|--/)[0])
          if (!defined) report('error', file, node.loc?.start.line, `CSS 里没有 .${cls}`)
        }
      }
    }
    for (const key of Object.keys(node)) {
      if (key === 'loc' || key === 'leadingComments' || key === 'trailingComments') continue
      walk(node[key])
    }
  }
  walk(ast.program.body)
}

for (const file of files) {
  fileErrors = 0
  let src
  try {
    src = readFileSync(file, 'utf8')
  } catch {
    report('error', file, 0, '文件不存在')
    continue
  }
  const missing = []
  let ast
  try {
    // 必须用 transformSync：parseSync 只做语法解析，根本不会跑 visitor（上一版就栽在这，
    // 变异体注入未声明变量后依然报 PASS —— 绿得可疑就是错的）
    const result = babel.transformSync(src, {
      filename: file,
      sourceType: 'module',
      configFile: false,
      babelrc: false,
      ast: true,
      code: false,
      parserOpts: { plugins: ['jsx'] },
      plugins: [
        noUndefPlugin((t, line, name) => missing.push({ line, name })),
      ],
    })
    ast = result.ast
  } catch (err) {
    report('error', file, err.loc?.line, `解析失败: ${err.message}`)
    continue
  }
  if (missing.length > 0) {
    for (const item of missing) report('error', file, item.line, `未声明的变量 ${item.name}`)
  }
  checkImports(ast, file, src)
  checkClasses(ast, file)
  console.log(`${fileErrors === 0 ? 'PASS' : 'FAIL'}  ${file}  (${src.split('\n').length} 行)`)
}

console.log(failed ? '\n== 有错误 ==' : '\n== 全部通过 ==')
process.exit(failed ? 1 : 0)
