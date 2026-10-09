// 可选 LLM 意图适配器测试：mock OpenAI 兼容 /chat/completions。
// 覆盖：正常 LLM 解析、未知变量交回确定性校验失败、超时/坏响应回退规则解析。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseIntentWithLlm, probeProvider, providerConfig } from '../src/llm.js'
import { openAiEndpoint, requestOpenAiIntent } from '../src/llm/openai.js'
import { parseIntentPayload } from '../src/llm/parse.js'
import { startTestServer, createTask, waitForSnapshot } from './helpers.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE = fs.readFileSync(path.join(here, 'fixtures', 'nitrogen_response_demo.csv'))

// 产品代码的超时哨兵定时器刻意 unref（不挂住服务关闭）；测试文件中所有 HTTP 服务关闭后，
// 用例会在“事件循环已排空”时被 runner 取消。这里持有一个文件级 ref 定时器，after 时释放。
const keepAlive = setTimeout(() => {}, 120000)
after(() => clearTimeout(keepAlive))

function mockChatServer(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(async (req, res) => {
      let body = ''
      for await (const chunk of req) body += chunk
      const payload = JSON.parse(body)
      const out = handler(payload)
      if (out instanceof Error) {
        res.writeHead(500)
        return res.end(out.message)
      }
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify(out))
    })
    server.listen(0, '127.0.0.1', () => resolve(server))
  })
}

// undici keep-alive 连接会让 server.close 回调挂起；强制关闭全部连接
function closeMockServer(server) {
  server.closeAllConnections?.()
  return new Promise((resolve) => server.close(() => resolve()))
}

const profile = {
  columns: [
    { name: 'week', inferredType: 'categorical' },
    { name: 'control', inferredType: 'numeric' },
    { name: 'treatment_a', inferredType: 'numeric' },
    { name: 'treatment_b', inferredType: 'numeric' }
  ]
}

test('LLM 返回合法 JSON：source=llm，变量经真实列名校验', async () => {
  const server = await mockChatServer(() => ({
    choices: [{ message: { content: JSON.stringify({ goal: '比较处理组趋势', variables: ['treatment_a', 'treatment_b'], ambiguities: [], chartType: 'line' }) } }]
  }))
  const port = server.address().port
  process.env.LOCAL_AGENT_LLM_BASE_URL = `http://127.0.0.1:${port}`
  process.env.LOCAL_AGENT_LLM_API_KEY = 'test-key'
  try {
    const r = await parseIntentWithLlm('画图', profile)
    assert.equal(r.source, 'llm')
    assert.deepEqual(r.spec.variables, ['treatment_a', 'treatment_b'])
    assert.equal(r.spec.chartType, 'line')
  } finally {
    delete process.env.LOCAL_AGENT_LLM_BASE_URL
    delete process.env.LOCAL_AGENT_LLM_API_KEY
    await closeMockServer(server)
  }
})

test('LLM 编造不存在的变量：保留在 missingFields，上层据此 UNKNOWN_FIELD', async () => {
  const server = await mockChatServer(() => ({
    choices: [{ message: { content: JSON.stringify({ goal: '分析营收', variables: ['revenue'], ambiguities: [] }) } }]
  }))
  const port = server.address().port
  process.env.LOCAL_AGENT_LLM_BASE_URL = `http://127.0.0.1:${port}`
  process.env.LOCAL_AGENT_LLM_API_KEY = 'test-key'
  try {
    const r = await parseIntentWithLlm('分析营收', profile)
    assert.equal(r.source, 'llm')
    assert.deepEqual(r.spec.variables, [])
    assert.deepEqual(r.spec.missingFields, ['revenue'])
  } finally {
    delete process.env.LOCAL_AGENT_LLM_BASE_URL
    delete process.env.LOCAL_AGENT_LLM_API_KEY
    await closeMockServer(server)
  }
})

test('端到端：LLM 给出未知字段时任务 FAILED / UNKNOWN_FIELD（不虚构字段）', async () => {
  const server = await mockChatServer(() => ({
    choices: [{ message: { content: JSON.stringify({ goal: '分析营收', variables: ['revenue'], ambiguities: [] }) } }]
  }))
  const port = server.address().port
  process.env.LOCAL_AGENT_LLM_BASE_URL = `http://127.0.0.1:${port}`
  process.env.LOCAL_AGENT_LLM_API_KEY = 'test-key'
  const h = await startTestServer(1)
  try {
    const { json } = await createTask(h, { csv: SAMPLE, prompt: '请分析营收变化并出图' })
    const task = await waitForSnapshot(h, json.taskId, (t) => t.state === 'FAILED')
    assert.equal(task.error.code, 'UNKNOWN_FIELD')
    assert.ok(task.error.message.includes('revenue'))
  } finally {
    delete process.env.LOCAL_AGENT_LLM_BASE_URL
    delete process.env.LOCAL_AGENT_LLM_API_KEY
    await h.close()
    await closeMockServer(server)
  }
})

test('端到端：LLM 正常解析时任务推进到 PRESENT，日志标明来源 llm', async () => {
  const server = await mockChatServer(() => ({
    choices: [{ message: { content: JSON.stringify({ goal: '比较三个处理组随观测周的变化趋势', variables: [], ambiguities: [], chartType: 'line' }) } }]
  }))
  const port = server.address().port
  process.env.LOCAL_AGENT_LLM_BASE_URL = `http://127.0.0.1:${port}`
  process.env.LOCAL_AGENT_LLM_API_KEY = 'test-key'
  const h = await startTestServer(1)
  try {
    const { json } = await createTask(h, { csv: SAMPLE, prompt: '比较三个处理组随观测周的变化趋势，生成论文用图' })
    const task = await waitForSnapshot(h, json.taskId, (t) => t.state === 'PRESENT')
    const intentStep = task.steps.find((s) => s.step_id === 'intent_parse')
    assert.match(intentStep.outputSummary, /\[llm\]/)
    assert.ok(task.execution.logs.some((l) => l.text.includes('意图解析来源：LLM')))
  } finally {
    delete process.env.LOCAL_AGENT_LLM_BASE_URL
    delete process.env.LOCAL_AGENT_LLM_API_KEY
    await h.close()
    await closeMockServer(server)
  }
})

test('LLM 超时：回退确定性规则并带 llmError', async () => {
  const slowFetch = () => new Promise(() => {})
  process.env.LOCAL_AGENT_LLM_BASE_URL = 'http://127.0.0.1:9'
  process.env.LOCAL_AGENT_LLM_API_KEY = 'k'
  try {
    const r = await parseIntentWithLlm('字段 week 的趋势图', profile, { fetchImpl: slowFetch, timeoutMs: 80 })
    assert.equal(r.source, 'rule')
    assert.equal(r.llmError, 'TIMEOUT')
    assert.deepEqual(r.spec.variables, ['week'])
  } finally {
    delete process.env.LOCAL_AGENT_LLM_BASE_URL
    delete process.env.LOCAL_AGENT_LLM_API_KEY
  }
})

test('LLM 返回坏 JSON / schema 不合法：回退规则解析', async () => {
  process.env.LOCAL_AGENT_LLM_BASE_URL = 'http://x'
  process.env.LOCAL_AGENT_LLM_API_KEY = 'k'
  const r1 = await parseIntentWithLlm('字段 week 的趋势图', profile, {
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: 'not-json' } }] }) })
  })
  assert.equal(r1.source, 'rule')
  assert.ok(r1.llmError)
  const r2 = await parseIntentWithLlm('字段 week 的趋势图', profile, {
    fetchImpl: async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: JSON.stringify({ goal: 1, variables: 'x' }) } }] }) })
  })
  assert.equal(r2.source, 'rule')
  assert.equal(r2.llmError, 'schema_invalid')
  delete process.env.LOCAL_AGENT_LLM_BASE_URL
  delete process.env.LOCAL_AGENT_LLM_API_KEY
})

test('未配置 LLM 环境变量：直接使用确定性规则', async () => {
  const r = await parseIntentWithLlm('字段 week 的趋势图', profile)
  assert.equal(r.source, 'rule')
  assert.deepEqual(r.spec.variables, ['week'])
})

test('Anthropic content blocks and fenced JSON normalize to intent payload', () => {
  const parsed = parseIntentPayload({
    content: [{ type: 'text', text: '```json\n{"goal":"趋势","variables":["week"],"ambiguities":[],"chartType":"line"}\n```' }]
  }, 'anthropic')
  assert.equal(parsed.goal, '趋势')
  assert.deepEqual(parsed.variables, ['week'])
})

test('Agent Plan defaults to ark-code-latest when model is not overridden', () => {
  assert.equal(providerConfig({
    LOCAL_AGENT_LLM_PROVIDER: 'openai',
    LOCAL_AGENT_LLM_BASE_URL: 'https://ark.cn-beijing.volces.com/api/plan/v3',
    LOCAL_AGENT_LLM_API_KEY: 'secret'
  }).model, 'ark-code-latest')
})

test('Agent Plan provider config normalizes protocol and documented model aliases', () => {
  assert.deepEqual(providerConfig({
    LOCAL_AGENT_LLM_PROVIDER: 'openai',
    LOCAL_AGENT_LLM_BASE_URL: 'https://ark.cn-beijing.volces.com/api/plan/v3/',
    LOCAL_AGENT_LLM_API_KEY: 'secret',
    LOCAL_AGENT_LLM_MODEL: 'doubao-seed-2.D-lite'
  }), {
    provider: 'openai',
    protocol: 'responses',
    baseUrl: 'https://ark.cn-beijing.volces.com/api/plan/v3',
    apiKey: 'secret',
    model: 'doubao-seed-2.0-lite',
    timeoutMs: 60000,
    anthropicVersion: '2023-06-01'
  })
  assert.equal(openAiEndpoint('https://ark.cn-beijing.volces.com/api/plan/v3/', 'chat_completions'), 'https://ark.cn-beijing.volces.com/api/plan/v3/chat/completions')
  assert.equal(openAiEndpoint('https://ark.cn-beijing.volces.com/api/v3/responses', 'responses'), 'https://ark.cn-beijing.volces.com/api/v3/responses')
})

test('OpenAI Responses protocol uses /responses and normalizes output_text', async () => {
  let request
  const result = await parseIntentWithLlm('字段 week 的趋势图', profile, {
    config: { provider: 'openai', protocol: 'responses', baseUrl: 'https://ark.example/api/v3', apiKey: 'response-test', model: 'doubao-seed-2-1-pro-260628', timeoutMs: 1000 },
    fetchImpl: async (url, init) => {
      request = { url, init }
      return {
        ok: true,
        json: async () => ({ output: [{ type: 'message', content: [{ type: 'output_text', text: '{"goal":"趋势","variables":["week"],"ambiguities":[],"chartType":"line"}' }] }] })
      }
    }
  })
  assert.equal(result.source, 'llm')
  assert.equal(request.url, 'https://ark.example/api/v3/responses')
  const body = JSON.parse(request.init.body)
  assert.ok(Array.isArray(body.input))
  assert.equal(body.messages, undefined)
  assert.equal(body.max_output_tokens, 2048, '推理模型需足够 max_output_tokens')
})

test('provider probe reports only redacted status metadata', async () => {
  const config = { provider: 'openai', protocol: 'chat_completions', baseUrl: 'https://ark.example/api/plan/v3', apiKey: 'do-not-leak', model: 'doubao-seed-2.0-lite', timeoutMs: 1000 }
  const failed = await probeProvider(config, async () => ({ ok: false, status: 401, headers: new Map([['x-request-id', 'req-safe']]) }))
  assert.deepEqual(failed, {
    ok: false,
    provider: 'openai',
    protocol: 'chat_completions',
    model: 'doubao-seed-2.0-lite',
    endpoint: 'https://ark.example/api/plan/v3/chat/completions',
    category: 'AUTHENTICATION_FAILED',
    status: 401,
    requestId: 'req-safe'
  })
  assert.doesNotMatch(JSON.stringify(failed), /do-not-leak/)
})

test('OpenAI request error exposes status and request id but never response body', async () => {
  await assert.rejects(
    requestOpenAiIntent(
      { protocol: 'chat_completions', baseUrl: 'https://ark.example/api/plan/v3', apiKey: 'secret', model: 'doubao-seed-2.0-lite' },
      [{ role: 'user', content: 'hello' }],
      async () => ({ ok: false, status: 429, headers: new Map([['x-request-id', 'req-rate']]), text: async () => 'secret provider response' })
    ),
    (error) => error.code === 'HTTP_429' && error.status === 429 && error.requestId === 'req-rate' && !String(error).includes('secret provider response')
  )
})

test('Anthropic provider uses Agent Plan messages endpoint and auth-token Bearer header', async () => {
  let request
  const result = await parseIntentWithLlm('字段 week 的趋势图', profile, {
    config: { provider: 'anthropic', baseUrl: 'https://ark.cn-beijing.volces.com/api/plan', apiKey: 'anthropic-test', model: 'ark-code-latest', timeoutMs: 1000, anthropicVersion: '2023-06-01' },
    fetchImpl: async (url, init) => {
      request = { url, init }
      return {
        ok: true,
        json: async () => ({ content: [{ type: 'text', text: '```json\n{"goal":"趋势","variables":["week"],"ambiguities":[],"chartType":"line"}\n```' }] })
      }
    }
  })
  assert.equal(result.source, 'llm')
  assert.equal(request.url, 'https://ark.cn-beijing.volces.com/api/plan/v1/messages')
  assert.equal(request.init.headers.authorization, 'Bearer anthropic-test')
  assert.equal(request.init.headers['x-api-key'], undefined)
  assert.equal(request.init.headers['anthropic-version'], '2023-06-01')
  const body = JSON.parse(request.init.body)
  assert.equal(body.model, 'ark-code-latest')
  assert.equal(body.max_tokens, 2048, '推理模型需足够 max_tokens，否则 reasoning 占满后 content 为空')
  assert.ok(body.system.includes('意图解析器'))
})

test('401/429 errors fall back with stable category and never expose response body', async () => {
  process.env.LOCAL_AGENT_LLM_BASE_URL = 'https://example.invalid/api/plan/v3'
  process.env.LOCAL_AGENT_LLM_API_KEY = 'test-secret-key'
  try {
    for (const status of [401, 429]) {
      const result = await parseIntentWithLlm('字段 week 的趋势图', profile, {
        fetchImpl: async () => ({ ok: false, status, text: async () => 'provider-secret-body' })
      })
      assert.equal(result.source, 'rule')
      assert.equal(result.llmError, `HTTP_${status}`)
      assert.doesNotMatch(JSON.stringify(result), /provider-secret-body|test-secret-key/)
    }
  } finally {
    delete process.env.LOCAL_AGENT_LLM_BASE_URL
    delete process.env.LOCAL_AGENT_LLM_API_KEY
  }
})

after(() => {
  delete process.env.LOCAL_AGENT_LLM_BASE_URL
  delete process.env.LOCAL_AGENT_LLM_API_KEY
})
