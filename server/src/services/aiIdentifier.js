import { createLimiter } from '../utils/limiter.js'

/**
 * AI 辅助识别层（可选、只读、只建议）
 *
 * 硬约束：
 *  1. 发给模型的输入**只有已经采集到的元数据**（进程名/exe/命令行/父进程/端口/监听地址/项目文件摘要）；
 *  2. 模型返回内容只能填充"建议字段"（名称、技术栈、用途、建议启动命令、置信度）；
 *  3. 事实字段（PID、端口、监听地址、路径、命令行、进程名、指纹）在合并时被完全保留，
 *     即使模型返回了这些字段也会被丢弃（见 mergeAiSuggestion）；
 *  4. 本模块不写任何数据（不登记项目、不改服务器记录）——只返回建议。
 */

export function aiConfig() {
  const apiKey = process.env.DSM_AI_API_KEY || ''
  const baseUrl = (process.env.DSM_AI_BASE_URL || 'https://api.openai.com/v1').replace(/\/+$/, '')
  const model = process.env.DSM_AI_MODEL || ''
  return {
    available: Boolean(apiKey && model),
    apiKey,
    baseUrl,
    model,
    timeoutMs: Math.max(3000, Number(process.env.DSM_AI_TIMEOUT_MS) || 20000),
    maxPerScan: Math.max(1, Number(process.env.DSM_AI_MAX) || 8),
    concurrency: Math.max(1, Number(process.env.DSM_AI_CONCURRENCY) || 2),
    reason: apiKey && model ? null : '未配置 AI（设置 DSM_AI_API_KEY 与 DSM_AI_MODEL 后启用，可选 DSM_AI_BASE_URL 指向兼容 OpenAI 的服务）',
  }
}

/** 事实字段：AI 永远不能改写这些 */
export const FACT_FIELDS = ['fingerprint', 'pid', 'port', 'address', 'listenAddress', 'processName', 'exePath', 'commandLine', 'projectDir', 'startedAt', 'registeredProjectId']

const SUGGESTION_FIELDS = ['serviceName', 'type', 'stack', 'purpose', 'suggestedStartCommand', 'confidence', 'reasoning']

/** 只把已采集到的元数据整理成给模型的输入 */
export function buildAiInput(candidate) {
  return {
    process: {
      name: candidate.processName || null,
      exePath: candidate.exePath || null,
      commandLine: candidate.commandLine || null,
      parentChain: (candidate.chain || []).slice(1, 4).map((item) => ({ name: item.name || null, commandLine: item.commandLine || null })),
    },
    listener: { port: candidate.port ?? null, address: candidate.address || null, protocol: 'tcp' },
    project: (() => {
      const root = candidate.project?.root || candidate.projectDir || null
      if (!root) return null
      return {
        dir: root,
        markers: candidate.project?.markers || candidate.projectMarkers || [],
        packageName: candidate.project?.stack?.packageName || null,
        scripts: candidate.project?.stack?.scripts || [],
        dependencies: candidate.project?.stack?.dependencies || [],
        kinds: candidate.project?.stack?.kinds || [],
        composeServices: candidate.project?.stack?.compose?.services || [],
      }
    })(),
    ruleGuess: {
      type: candidate.type || null,
      category: candidate.category || null,
      confidence: candidate.confidence ?? null,
      reasons: candidate.reasons || [],
    },
  }
}

export const SYSTEM_PROMPT = [
  '你是本地开发环境的服务识别助手。',
  '只根据用户提供的元数据推断，不要编造未提供的事实（不要臆造路径、端口、PID）。',
  '这些元数据可能不完整（例如命令行因权限读不到），信息不足时请降低 confidence 并在 reasoning 中说明。',
  '返回严格的 JSON 对象，不要输出多余文字，字段为：',
  '{"serviceName": string, "type": string, "stack": string[], "purpose": string, "suggestedStartCommand": string|null, "confidence": number, "reasoning": string}',
  'serviceName 用简短的中文或项目名；confidence 是 0-1 的小数。',
].join('\n')

function extractJson(text) {
  const raw = String(text || '').trim()
  if (!raw) return null
  const fenced = raw.match(/```(?:json)?\s*([\s\S]*?)```/i)
  const body = fenced ? fenced[1] : raw
  const start = body.indexOf('{')
  const end = body.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    return JSON.parse(body.slice(start, end + 1))
  } catch {
    return null
  }
}

/** 默认客户端：兼容 OpenAI 的 /chat/completions */
export async function defaultAiClient({ input, config }) {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), config.timeoutMs)
  try {
    const response = await fetch(`${config.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${config.apiKey}` },
      body: JSON.stringify({
        model: config.model,
        temperature: 0.1,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: SYSTEM_PROMPT },
          { role: 'user', content: JSON.stringify(input) },
        ],
      }),
      signal: controller.signal,
    })
    if (!response.ok) {
      const detail = await response.text().catch(() => '')
      throw new Error(`AI 接口返回 HTTP ${response.status}${detail ? `：${detail.slice(0, 200)}` : ''}`)
    }
    const payload = await response.json()
    return payload?.choices?.[0]?.message?.content ?? null
  } finally {
    clearTimeout(timer)
  }
}

function sanitizeString(value, max = 200) {
  if (value === null || value === undefined) return null
  const text = String(value).replace(/\s+$/g, '').slice(0, max)
  return text || null
}

/**
 * 合并 AI 建议：只接受白名单建议字段，事实字段一律以采集结果为准。
 * 即使模型返回 {"pid": 1, "port": 1, "projectDir": "C:\\fake"} 也会被丢弃。
 */
export function mergeAiSuggestion(candidate, ai, { model = null, at = new Date().toISOString() } = {}) {
  const invalid = []
  if (!ai || typeof ai !== 'object') return { candidate, appliedFields: [], rejectedFields: [], invalid }

  const suggestion = {}

  const name = sanitizeString(ai.serviceName, 120)
  if (name) suggestion.serviceName = name
  const type = sanitizeString(ai.type, 120)
  if (type) suggestion.type = type
  const purpose = sanitizeString(ai.purpose, 400)
  if (purpose) suggestion.purpose = purpose
  const command = sanitizeString(ai.suggestedStartCommand, 300)
  if (command) suggestion.suggestedStartCommand = command
  const reasoning = sanitizeString(ai.reasoning, 600)
  if (reasoning) suggestion.reasoning = reasoning
  if (Array.isArray(ai.stack)) suggestion.stack = ai.stack.map((item) => sanitizeString(item, 60)).filter(Boolean).slice(0, 10)
  const confidence = Number(ai.confidence)
  if (Number.isFinite(confidence)) suggestion.confidence = Math.max(0, Math.min(1, Math.round(confidence * 100) / 100))

  suggestion.model = model
  suggestion.at = at

  // 事实字段：逐个检查模型是否试图改写（记录被拒绝的字段，供测试与审计）
  for (const field of FACT_FIELDS) {
    if (ai[field] !== undefined) {
      invalid.push(field)
    }
  }
  for (const key of Object.keys(ai)) {
    if (!SUGGESTION_FIELDS.includes(key) && !FACT_FIELDS.includes(key)) invalid.push(key)
  }

  const appliedFields = Object.keys(suggestion).filter((key) => !['model', 'at'].includes(key))
  return { candidate: { ...candidate, ai: suggestion }, appliedFields, rejectedFields: FACT_FIELDS.filter((field) => invalid.includes(field)), invalid }
}

/** 对单个候选调用 AI（可注入 client 便于测试） */
export async function identifyService(candidate, { client = defaultAiClient, config = aiConfig() } = {}) {
  if (!config.available) return { available: false, reason: config.reason, error: null }
  const input = buildAiInput(candidate)
  try {
    const raw = await client({ input, config })
    const parsed = typeof raw === 'string' ? extractJson(raw) : raw
    if (!parsed) return { available: true, error: 'AI 返回内容不是合法 JSON', result: null }
    return { available: true, result: parsed, merged: mergeAiSuggestion(candidate, parsed, { model: config.model }), error: null }
  } catch (error) {
    return { available: true, error: error.message, result: null }
  }
}

/** 批量识别（受并发与数量上限约束；失败不影响规则结果） */
export async function identifyCandidates(candidates, { client = defaultAiClient, config = aiConfig(), limiter } = {}) {
  if (!config.available) {
    return { available: false, reason: config.reason, results: new Map(), used: 0 }
  }
  const gate = limiter || createLimiter(config.concurrency)
  const targets = candidates.slice(0, config.maxPerScan)
  const results = new Map()

  await Promise.all(
    targets.map((candidate) =>
      gate.run(async () => {
        const outcome = await identifyService(candidate, { client, config })
        results.set(candidate.fingerprint, outcome)
      }),
    ),
  )

  return {
    available: true,
    reason: null,
    results,
    used: targets.length,
    skipped: Math.max(0, candidates.length - targets.length),
    model: config.model,
  }
}
