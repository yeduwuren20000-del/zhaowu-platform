// 本机构建通道：本机 esbuild 原生二进制起不来（Go runtime 在 osinit 阶段加载 winmm.dll
// 被火绒 HIPS 拦截，报 "winmm.dll not found"；winmm.dll 本身完好——System32/SysWOW64
// 双份、PE 头正常、微软签名有效、无 DLL 劫持、非沙箱），而 Vite 的 transform /
// commonjs / 压缩三处都依赖 esbuild，所以改用 Rollup + Babel 打包。
// 产物结构与 Vite 等价（index.html + assets/index.js + assets/index.css），
// 已经过全部 e2e 回归验证；用户在正常环境恢复 esbuild 后可随时切回 `npm run build:vite`。
// 用法：node _rollup.mjs [输出目录]   缺省 dist-test/（本地测试）；正式产物：node _rollup.mjs dist
import { readFileSync, writeFileSync, mkdirSync, rmSync } from 'node:fs'
import { createRequire } from 'node:module'
import nodeResolve from '@rollup/plugin-node-resolve'
import commonjs from '@rollup/plugin-commonjs'
import replace from '@rollup/plugin-replace'
import babel from '@rollup/plugin-babel'

const require = createRequire(import.meta.url)
// rollup 在本机解析到 CJS 入口，ESM 具名导出拿不到，走 require；API 名是 rollup() 而非 build()
const { rollup } = require('rollup')
const jsxPlugin = require.resolve('@babel/plugin-transform-react-jsx')

/** 收集 CSS import，最后合并成一个文件 —— 项目里的 css 没有互相 @import，可安全拼接 */
function collectCss() {
  const chunks = []
  return {
    name: 'collect-css',
    transform(code, id) {
      if (!id.endsWith('.css')) return null
      chunks.push({ id, code })
      return { code: 'export default {}', map: null }
    },
    generateBundle() {
      const css = chunks.map((c) => `/* ${c.id.split(/[\\/]/).pop()} */\n${c.code}`).join('\n')
      this.emitFile({ type: 'asset', fileName: 'assets/index.css', source: css })
    },
  }
}

const OUT_DIR = process.argv[2] || process.env.DSM_BUILD_DIR || 'dist-test'

rmSync(OUT_DIR, { recursive: true, force: true })
mkdirSync(`${OUT_DIR}/assets`, { recursive: true })

const bundle = await rollup({
  input: 'src/main.jsx',
  plugins: [
    replace({ preventAssignment: true, values: { 'process.env.NODE_ENV': JSON.stringify('production') } }),
    nodeResolve({ extensions: ['.mjs', '.js', '.jsx', '.json'] }),
    commonjs({ include: /node_modules/, requireReturnsDefault: 'auto' }),
    babel({
      babelHelpers: 'bundled',
      extensions: ['.js', '.jsx'],
      exclude: /node_modules/,
      babelrc: false,
      configFile: false,
      plugins: [[jsxPlugin, { runtime: 'automatic' }]],
    }),
    collectCss(),
  ],
  onwarn(warning, warn) {
    if (warning.code === 'MODULE_LEVEL_DIRECTIVE' || warning.code === 'SOURCEMAP_ERROR') return
    if (warning.code === 'CIRCULAR_DEPENDENCY') return
    warn(warning)
  },
})

const out = await bundle.write({
  dir: OUT_DIR,
  format: 'es',
  entryFileNames: 'assets/index.js',
  assetFileNames: 'assets/[name][extname]',
  inlineDynamicImports: true,
})

// 生成 index.html：复用原模板（保留首屏骨架），只把入口脚本换成打包产物
const html = readFileSync('index.html', 'utf8')
  .replace('<script type="module" src="/src/main.jsx"></script>', '<script type="module" src="/assets/index.js"></script>')
  .replace('</head>', '    <link rel="stylesheet" href="/assets/index.css" />\n  </head>')
writeFileSync(`${OUT_DIR}/index.html`, html)

console.log('BUILD OK')
for (const item of out.output) {
  console.log(' ', item.type === 'asset' ? `${item.fileName}  ${item.source.length}B` : `${item.fileName}  ${item.code.length}B`)
}
