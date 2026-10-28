import fs from 'node:fs'
import path from 'node:path'

/**
 * 项目元数据探测（只读、有限深度）：
 *   - 只读白名单里的常见项目文件，绝不递归全盘扫描；
 *   - 只做文本/JSON 解析，**不执行任何脚本**（不 npm install、不 pip、不构建）；
 *   - 每个文件最多读 maxBytes，目录逐级向上最多 maxUp 层。
 */

export const MARKER_FILES = [
  'package.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  'package-lock.json',
  'vite.config.js',
  'vite.config.ts',
  'vite.config.mjs',
  'next.config.js',
  'next.config.mjs',
  'next.config.ts',
  'nuxt.config.ts',
  'angular.json',
  'vue.config.js',
  'svelte.config.js',
  'astro.config.mjs',
  'remix.config.js',
  'pyproject.toml',
  'requirements.txt',
  'Pipfile',
  'setup.py',
  'manage.py',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'composer.json',
  'Gemfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml',
  'Dockerfile',
]

/** 强标记：命中即认为这是项目根目录 */
const STRONG_MARKERS = new Set([
  'package.json',
  'pyproject.toml',
  'requirements.txt',
  'Pipfile',
  'manage.py',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'composer.json',
  'Gemfile',
  'docker-compose.yml',
  'docker-compose.yaml',
  'compose.yml',
  'compose.yaml',
])

const DEPENDENCY_OF_INTEREST = [
  'vite', 'react', 'react-dom', 'next', 'nuxt', 'vue', '@vue/cli-service', 'react-scripts', 'svelte', 'astro',
  'express', 'koa', 'fastify', '@nestjs/core', 'hapi', 'webpack', 'parcel', 'esbuild', 'rollup',
  'electron', 'tauri', 'prisma', 'typeorm', 'sequelize', 'mongoose', 'socket.io', 'ws',
  'vitest', 'jest', 'playwright', '@playwright/test', 'cypress', 'storybook',
]

const PY_HINTS = ['fastapi', 'flask', 'django', 'uvicorn', 'gunicorn', 'streamlit', 'gradio', 'jupyter', 'celery', 'tornado', 'aiohttp', 'pytorch', 'torch', 'transformers', 'pandas']
const JVM_HINTS = ['spring-boot', 'spring-boot-starter', 'quarkus', 'micronaut', 'tomcat', 'jetty', 'struts']
const RUST_HINTS = ['axum', 'actix-web', 'rocket', 'tauri', 'warp']
const GO_HINTS = ['gin-gonic', 'labstack/echo', 'gofiber', 'beego']

/** 明显的系统目录不参与探测 */
const DENY_DIR_PREFIXES = ['c:\\windows', 'c:\\program files', 'c:\\program files (x86)', 'c:\\programdata', '\\\\?\\']

/**
 * 不可信的项目根目录：编辑器扩展、应用数据、缓存目录里的 package.json 不算"项目"，
 * 否则会把 VS Code 扩展、Electron 应用的资源目录误报成开发项目。
 */
const IMPLAUSIBLE_ROOT_PATTERNS = [
  '\\appdata\\local\\',
  '\\appdata\\roaming\\',
  '\\.vscode\\extensions\\',
  '\\.vscode-insiders\\extensions\\',
  '\\program files\\',
  '\\program files (x86)\\',
  '\\windows\\',
  '\\node_modules\\',
  '\\npm-cache\\',
  '\\.npm\\',
  '\\.cache\\',
  '\\app.asar', // Electron 打包后的应用内部目录（resources/app.asar.unpacked/cli 之类）
]

/** 明显不可能作为"项目根"的目录形态：盘符根目录、用户配置目录本身 */
const IMPLAUSIBLE_EXACT = [
  /^[a-z]:\\?$/i, // C:\ 或 D:
  /^[a-z]:\\users$/i,
  /^[a-z]:\\users\\[^\\]+$/i, // C:\Users\someone（用户主目录里常被别的工具塞一个 package.json）
  /^[a-z]:\\users\\[^\\]+\\(documents|downloads|desktop|pictures|videos|music|onedrive)$/i,
]

export function isPlausibleProjectRoot(dir) {
  if (!dir) return false
  const lower = path.resolve(dir).toLowerCase()

  // 临时目录里的项目是真实存在的（测试、脚手架解压等），此时不套用 AppData 规则；
  // 但"临时目录里面又套了一层 AppData"仍按不可信处理。
  const tempMatch = lower.match(/^(.*?(?:\\appdata\\local\\temp|\\temp|\/tmp)(?:\\|\/|$))(.*)$/)
  const inTemp = Boolean(tempMatch)
  const remainder = tempMatch ? tempMatch[2] : lower
  const nestedAppData = remainder.includes('appdata')
  const patterns = inTemp && !nestedAppData ? IMPLAUSIBLE_ROOT_PATTERNS.filter((pattern) => !pattern.includes('appdata')) : IMPLAUSIBLE_ROOT_PATTERNS

  if (patterns.some((pattern) => lower.includes(pattern))) return false
  if (IMPLAUSIBLE_EXACT.some((pattern) => pattern.test(lower))) return false
  // 目录名本身是 node_modules / .git 等，也不是项目根
  const base = path.basename(lower)
  if (['node_modules', 'dist', 'build', '.git', 'extensions', 'cache'].includes(base)) return false
  return true
}

export function isSafeDirectory(dir) {
  if (!dir) return false
  const resolved = path.resolve(dir)
  const lower = resolved.toLowerCase()
  if (DENY_DIR_PREFIXES.some((prefix) => lower.startsWith(prefix))) return false
  try {
    return fs.statSync(resolved).isDirectory()
  } catch {
    return false
  }
}

function readTextFile(file, maxBytes) {
  try {
    const stat = fs.statSync(file)
    if (!stat.isFile() || stat.size > maxBytes) return { ok: false, reason: stat.size > maxBytes ? '文件过大，已跳过' : '不是普通文件', size: stat.size }
    return { ok: true, text: fs.readFileSync(file, 'utf8'), size: stat.size }
  } catch (error) {
    return { ok: false, reason: error.code || error.message, size: 0 }
  }
}

function pickDependencies(dependencies = {}) {
  const keys = Object.keys(dependencies)
  const interesting = keys.filter((key) => DEPENDENCY_OF_INTEREST.includes(key))
  return { total: keys.length, interesting }
}

/** 解析 package.json 的关键信息（只看名字、脚本名与依赖名，不执行） */
export function summarizePackageJson(text) {
  try {
    const parsed = JSON.parse(text)
    const dependencies = { ...(parsed.dependencies || {}), ...(parsed.devDependencies || {}) }
    return {
      kind: 'node',
      name: typeof parsed.name === 'string' ? parsed.name : null,
      version: typeof parsed.version === 'string' ? parsed.version : null,
      scripts: parsed.scripts && typeof parsed.scripts === 'object' ? Object.keys(parsed.scripts) : [],
      dependencies: pickDependencies(dependencies),
      packageManager: parsed.packageManager || null,
      private: Boolean(parsed.private),
    }
  } catch (error) {
    return { kind: 'node', parseError: `package.json 解析失败：${error.message}` }
  }
}

/** 文本型清单：只做关键字扫描 */
export function scanTextHints(text, hints) {
  const lower = String(text || '').toLowerCase()
  return hints.filter((hint) => lower.includes(hint.toLowerCase()))
}

export function summarizePyProject(text) {
  const hints = scanTextHints(text, PY_HINTS)
  const nameMatch = String(text).match(/^\s*name\s*=\s*["']([^"']+)["']/m)
  return { kind: 'python', name: nameMatch ? nameMatch[1] : null, hints, declares: hints.length > 0 }
}

export function summarizeCompose(text) {
  const services = []
  const lines = String(text || '').split(/\r?\n/)
  let inServices = false
  for (const line of lines) {
    if (/^\s*services\s*:/.test(line)) {
      inServices = true
      continue
    }
    if (inServices) {
      const match = line.match(/^\s{2}([A-Za-z0-9._-]+)\s*:/)
      if (match) services.push(match[1])
      else if (/^\S/.test(line)) inServices = false
    }
  }
  const ports = [...String(text || '').matchAll(/["']?(\d{2,5}):(\d{2,5})["']?/g)].map((match) => Number(match[1]))
  return { kind: 'docker-compose', services: services.slice(0, 20), publishedPorts: [...new Set(ports)].slice(0, 20) }
}

/** 探测单个目录（只看白名单文件） */
export function probeDirectory(dir, { maxBytes = 262144 } = {}) {
  const result = { dir, exists: false, files: {}, markers: [], summaries: {} }
  if (!isSafeDirectory(dir)) return result
  result.exists = true

  for (const marker of MARKER_FILES) {
    const file = path.join(dir, marker)
    let stat = null
    try {
      stat = fs.statSync(file)
    } catch {
      continue
    }
    if (!stat.isFile()) continue
    result.markers.push(marker)
    result.files[marker] = { size: stat.size, mtime: stat.mtimeMs }

    const needsContent = ['package.json', 'pyproject.toml', 'requirements.txt', 'Pipfile', 'pom.xml', 'build.gradle', 'build.gradle.kts', 'Cargo.toml', 'go.mod', 'docker-compose.yml', 'docker-compose.yaml', 'compose.yml', 'compose.yaml']
    if (!needsContent.includes(marker)) continue

    const read = readTextFile(file, maxBytes)
    if (!read.ok) {
      result.files[marker].skipped = read.reason
      continue
    }
    if (marker === 'package.json') result.summaries.packageJson = summarizePackageJson(read.text)
    else if (marker === 'pyproject.toml') result.summaries.pyproject = summarizePyProject(read.text)
    else if (marker === 'requirements.txt' || marker === 'Pipfile') {
      result.summaries[marker === 'Pipfile' ? 'pipfile' : 'requirements'] = { kind: 'python', hints: scanTextHints(read.text, PY_HINTS) }
    } else if (marker === 'pom.xml' || marker.startsWith('build.gradle')) {
      result.summaries.jvm = { kind: 'jvm', hints: scanTextHints(read.text, JVM_HINTS) }
    } else if (marker === 'Cargo.toml') result.summaries.rust = { kind: 'rust', hints: scanTextHints(read.text, RUST_HINTS) }
    else if (marker === 'go.mod') result.summaries.go = { kind: 'go', hints: scanTextHints(read.text, GO_HINTS) }
    else if (marker.startsWith('docker-compose') || marker.startsWith('compose')) result.summaries.compose = summarizeCompose(read.text)
  }
  return result
}

/** 向上找项目根目录：命中强标记、且目录"像项目"才算数 */
export function findProjectRoot(startDir, { maxUp = 5 } = {}) {
  let current = path.resolve(startDir)
  for (let depth = 0; depth <= maxUp; depth += 1) {
    const probed = probeDirectory(current)
    if (probed.markers.some((marker) => STRONG_MARKERS.has(marker)) && isPlausibleProjectRoot(current)) {
      return { root: current, depth, probed }
    }
    const parent = path.dirname(current)
    if (parent === current || !isSafeDirectory(parent)) break
    current = parent
  }
  return null
}

/**
 * 综合多个候选目录，找出最可信的项目根目录与元数据。
 * candidates: [{ dir, source, confidence }]
 */
export function detectProject(candidates = [], { maxUp = 5 } = {}) {
  const visited = new Map()
  const probes = []
  let best = null

  for (const candidate of candidates) {
    if (!candidate?.dir || !isSafeDirectory(candidate.dir)) continue
    const key = path.resolve(candidate.dir).toLowerCase()
    if (visited.has(key)) continue
    visited.set(key, true)

    const found = findProjectRoot(candidate.dir, { maxUp })
    if (!found) continue
    const score = candidate.confidence * 100 - found.depth
    probes.push({ dir: found.root, source: candidate.source, confidence: candidate.confidence, depth: found.depth, markers: found.probed.markers })
    if (!best || score > best.score) {
      best = { score, root: found.root, source: candidate.source, confidence: candidate.confidence, depth: found.depth, probed: found.probed }
    }
  }

  if (!best) {
    return { root: null, markers: [], stack: null, probes, candidates: candidates.map((item) => item.dir) }
  }

  const summaries = best.probed.summaries || {}
  const stack = {
    kinds: [],
    node: summaries.packageJson || null,
    python: summaries.pyproject || summaries.requirements || summaries.pipfile || null,
    jvm: summaries.jvm || null,
    rust: summaries.rust || null,
    go: summaries.go || null,
    compose: summaries.compose || null,
    packageName: summaries.packageJson?.name || summaries.pyproject?.name || null,
    scripts: summaries.packageJson?.scripts || [],
    dependencies: summaries.packageJson?.dependencies?.interesting || [],
  }
  if (summaries.packageJson) stack.kinds.push('node')
  if (summaries.pyproject || summaries.requirements || summaries.pipfile) stack.kinds.push('python')
  if (summaries.jvm) stack.kinds.push('jvm')
  if (summaries.rust) stack.kinds.push('rust')
  if (summaries.go) stack.kinds.push('go')
  if (summaries.compose) stack.kinds.push('docker-compose')

  return {
    root: best.root,
    source: best.source,
    confidence: best.confidence,
    depth: best.depth,
    markers: best.probed.markers,
    hasDockerfile: best.probed.markers.includes('Dockerfile'),
    stack,
    probes,
  }
}
