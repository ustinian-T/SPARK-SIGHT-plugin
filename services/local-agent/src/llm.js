// 可选模型仅做意图解析；统计、证据、方案与结论始终由确定性管线产生。
import { parseIntent } from './intent.js'
import { requestOpenAiIntent } from './llm/openai.js'
import { requestAnthropicIntent } from './llm/anthropic.js'
import { anthropicEndpoint } from './llm/anthropic.js'
import { openAiEndpoint } from './llm/openai.js'
import { parseIntentPayload } from './llm/parse.js'

const SYSTEM_PROMPT = `你是科研绘图辅助智能体的意图解析器。把用户需求解析为严格 JSON：
{
  "goal": string,
  "variables": string[],
  "ambiguities": string[],
  "chartType": "bar"|"line"|"panel"|null
}
禁止输出 JSON 以外的内容；禁止编造列名；禁止给出统计结论。`

export function providerConfig(env = process.env) {
  const provider = String(env.LOCAL_AGENT_LLM_PROVIDER ?? 'openai').toLowerCase()
  const normalizedProvider = provider === 'anthropic' ? 'anthropic' : 'openai'
  const baseUrl = env.LOCAL_AGENT_LLM_BASE_URL?.replace(/\/$/, '')
  const arkPlanOpenAi = /^https:\/\/ark\.cn-beijing\.volces\.com\/api\/(?:plan|coding)\/v3$/.test(baseUrl ?? '')
  const protocol = normalizedProvider === 'anthropic'
    ? 'anthropic_messages'
    : env.LOCAL_AGENT_LLM_PROTOCOL === 'chat_completions'
      ? 'chat_completions'
      : env.LOCAL_AGENT_LLM_PROTOCOL === 'responses' || arkPlanOpenAi ? 'responses' : 'chat_completions'
  const modelAliases = {
    'doubao-seed-2.D-lite': 'doubao-seed-2.0-lite',
    'doubao-seed-2-0-lite': 'doubao-seed-2.0-lite'
  }
  const configuredModel = env.LOCAL_AGENT_LLM_MODEL ?? 'ark-code-latest'
  return {
    provider: normalizedProvider,
    protocol,
    baseUrl,
    apiKey: env.LOCAL_AGENT_LLM_API_KEY,
    model: modelAliases[configuredModel] ?? configuredModel,
    timeoutMs: Number(env.LOCAL_AGENT_LLM_TIMEOUT_MS ?? 60000),
    anthropicVersion: env.LOCAL_AGENT_ANTHROPIC_VERSION ?? '2023-06-01'
  }
}

function diagnosticCategory(error) {
  if (error?.status === 401 || error?.status === 403) return 'AUTHENTICATION_FAILED'
  if (error?.status === 404) return 'ENDPOINT_OR_MODEL_NOT_FOUND'
  if (error?.status === 429) return 'RATE_LIMITED'
  if (error?.name === 'AbortError') return 'TIMEOUT'
  return 'REQUEST_FAILED'
}

export async function probeProvider(input = providerConfig(), fetchImpl = fetch) {
  const config = { ...input }
  const endpoint = config.provider === 'anthropic'
    ? anthropicEndpoint(config.baseUrl)
    : openAiEndpoint(config.baseUrl, config.protocol)
  const base = { provider: config.provider, protocol: config.protocol, model: config.model, endpoint }
  const ctrl = new AbortController()
  const timer = setTimeout(() => ctrl.abort(), config.timeoutMs ?? 60000)
  timer.unref?.()
  try {
    await requestIntent(config, [{ role: 'user', content: 'Return {"ok":true} as JSON.' }], fetchImpl, ctrl.signal)
    return { ok: true, ...base, category: 'CONNECTED' }
  } catch (error) {
    return {
      ok: false,
      ...base,
      category: diagnosticCategory(error),
      ...(Number.isInteger(error?.status) ? { status: error.status } : {}),
      ...(error?.requestId ? { requestId: error.requestId } : {})
    }
  } finally {
    clearTimeout(timer)
  }
}

export function llmConfigured(config = providerConfig()) {
  return !!(config.baseUrl && config.apiKey)
}

async function requestIntent(config, messages, fetchImpl, signal) {
  if (config.provider === 'anthropic') return requestAnthropicIntent(config, messages, fetchImpl, signal)
  return requestOpenAiIntent(config, messages, fetchImpl, signal)
}

function normalizeError(error) {
  if (error?.name === 'AbortError') return 'TIMEOUT'
  if (/^(HTTP_\d{3}|EMPTY_COMPLETION|MALFORMED_RESPONSE)$/.test(error?.code ?? '')) return error.code
  return 'REQUEST_FAILED'
}

function validateIntent(parsed, columns) {
  if (typeof parsed?.goal !== 'string' || !Array.isArray(parsed.variables) || !Array.isArray(parsed.ambiguities)) {
    throw Object.assign(new Error('schema invalid'), { code: 'SCHEMA_INVALID' })
  }
  const known = new Set(columns)
  const stringVariables = parsed.variables.filter((value) => typeof value === 'string')
  return {
    goal: parsed.goal.slice(0, 200),
    variables: stringVariables.filter((value) => known.has(value)),
    ambiguities: parsed.ambiguities.map(String).slice(0, 5),
    missingFields: stringVariables.filter((value) => !known.has(value)),
    engine: 'python',
    chartType: ['bar', 'line', 'panel'].includes(parsed.chartType) ? parsed.chartType : null
  }
}

/** @returns {Promise<{spec:object, source:'llm'|'rule', raw?:object, llmError?:string}>} */
export async function parseIntentWithLlm(prompt, profile, options = {}) {
  const fallback = { spec: parseIntent(prompt, profile), source: 'rule' }
  const config = { ...providerConfig(options.env), ...(options.config ?? {}) }
  if (options.timeoutMs !== undefined) config.timeoutMs = options.timeoutMs
  if (!llmConfigured(config)) return fallback

  const columns = profile.columns.map((column) => column.name)
  const messages = [
    { role: 'system', content: SYSTEM_PROMPT },
    {
      role: 'user',
      content: `CSV 列名：${JSON.stringify(columns)}；列类型：${JSON.stringify(profile.columns.map((column) => ({ name: column.name, type: column.inferredType })))}\n用户需求：${prompt}`
    }
  ]
  const ctrl = new AbortController()
  let timer
  try {
    timer = setTimeout(() => ctrl.abort(), config.timeoutMs)
    timer.unref?.()
    const timeout = new Promise((_, reject) => {
      const sentinel = setTimeout(() => reject(Object.assign(new Error('timeout'), { name: 'AbortError' })), config.timeoutMs + 10)
      sentinel.unref?.()
    })
    const payload = await Promise.race([requestIntent(config, messages, options.fetchImpl ?? fetch, ctrl.signal), timeout])
    const parsed = parseIntentPayload(payload, config.provider, config.protocol)
    return { spec: validateIntent(parsed, columns), source: 'llm', raw: parsed }
  } catch (error) {
    const code = error?.code === 'SCHEMA_INVALID' ? 'schema_invalid' : normalizeError(error)
    return { ...fallback, llmError: code }
  } finally {
    clearTimeout(timer)
  }
}
