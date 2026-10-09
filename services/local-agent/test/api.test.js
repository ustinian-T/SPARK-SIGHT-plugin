// HTTP API 集成测试：健康检查、创建任务、快照、错误响应、澄清应答、删除、能力探测。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  startTestServer,
  createTask,
  getSnapshot,
  waitForSnapshot,
  waitSettled,
  multipart,
  TOKEN
} from './helpers.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE = fs.readFileSync(path.join(here, 'fixtures', 'nitrogen_response_demo.csv'))

const h = await startTestServer()
after(async () => h.close())

test('GET /health 无需令牌返回服务与协议版本', async () => {
  const res = await fetch(`${h.base}/health`)
  assert.equal(res.status, 200)
  const body = await res.json()
  assert.equal(body.status, 'ok')
  assert.equal(body.protocol, 1)
  assert.equal(body.service, '@deep-imaging/local-agent')
})

test('新实例不接受旧版固定管理员密码', async () => {
  if (process.env.LOCAL_AGENT_ADMIN_PASSWORD !== undefined) return
  // 中性占位符：本用例只验证“旧版固定口令已失效”，公开仓库不保留任何真实历史凭据。
  const res = await fetch(`${h.base}/api/auth/login`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ username: 'admin', password: 'legacy-default-password', expectedRole: 'admin' })
  })
  assert.equal(res.status, 401)
})

test('VS Code webview 可完成本机 Agent 的 CORS 预检，其他站点不可跨源读取', async () => {
  const allowed = 'https://abc123.vscode-webview.net'
  const preflight = await fetch(`${h.base}/api/capabilities`, {
    method: 'OPTIONS',
    headers: { origin: allowed, 'access-control-request-method': 'GET', 'access-control-request-headers': 'authorization,x-agent-protocol' }
  })
  assert.equal(preflight.status, 204)
  assert.equal(preflight.headers.get('access-control-allow-origin'), allowed)
  const health = await fetch(`${h.base}/health`, { headers: { origin: allowed } })
  assert.equal(health.headers.get('access-control-allow-origin'), allowed)
  const desktopWebview = 'vscode-webview://1234-abcd'
  const embedded = await fetch(`${h.base}/health`, { headers: { origin: desktopWebview } })
  assert.equal(embedded.headers.get('access-control-allow-origin'), desktopWebview)
  const hostile = await fetch(`${h.base}/health`, { headers: { origin: 'https://example.com' } })
  assert.equal(hostile.headers.get('access-control-allow-origin'), null)
})

test('未携带令牌访问受保护接口返回 401 稳定错误', async () => {
  const res = await fetch(`${h.base}/api/tasks/whatever`)
  assert.equal(res.status, 401)
  const body = await res.json()
  assert.equal(body.error.code, 'UNAUTHORIZED')
})

test('协议主版本不兼容返回 409', async () => {
  const res = await fetch(`${h.base}/api/tasks/whatever`, {
    headers: { authorization: `Bearer ${TOKEN}`, 'x-agent-protocol': '9' }
  })
  assert.equal(res.status, 409)
  assert.equal((await res.json()).error.code, 'PROTOCOL_MISMATCH')
})

test('POST /api/tasks 正常创建并推进到 PRESENT，快照与前端 AgentTask 契约兼容', async () => {
  const { res, json } = await createTask(h, { csv: SAMPLE })
  assert.equal(res.status, 201)
  assert.match(json.taskId, /^task_/)
  assert.equal(json.state, 'INGEST')

  const task = await waitForSnapshot(h, json.taskId, (t) => t.state === 'PRESENT')
  // AgentTask 必填字段
  for (const k of ['taskId', 'state', 'title', 'createdAt', 'dataset', 'steps', 'evidence', 'plans', 'execution', 'preferences', 'retries']) {
    assert.ok(k in task, `快照缺少 ${k}`)
  }
  assert.equal(task.dataset.rows, 6)
  assert.equal(task.dataset.cols, 7)
  assert.match(task.dataset.fingerprint, /^[0-9a-f]{64}$/)
  assert.equal(task.plans.length, 3)
  assert.ok(task.acceptedClaimIds.length >= 2)
  assert.ok(task.acceptedClaimIds.every((id) => /^claim_[a-z_0-9]+$/.test(id)))
  assert.equal(new Set(task.acceptedClaimIds).size, task.acceptedClaimIds.length)
  assert.equal(task.execution.status, 'success') // 沙箱真实执行成功
  assert.ok(task.execution.artifactSvg?.includes('<svg'), '执行记录内联真实 SVG')
  // EXECUTE/RENDER/VERIFY 真实完成，产物通过独立验证
  for (const id of ['code_execute', 'render_output', 'verify_validate']) {
    const step = task.steps.find((s) => s.step_id === id)
    assert.equal(step.status, 'done', `${id} 应为 done`)
  }
  for (const p of task.plans) {
    assert.equal(p.executionStatus, 'verified', `${p.plan_id} 应验证通过`)
    assert.ok(p.verification?.passed)
    assert.ok(task.planArtifacts[p.plan_id].verified)
  }
  assert.ok(task.verification.passed, '三方案整体验证应通过')
  // 六阶段对应步骤均完成
  for (const id of ['csv_load', 'csv_encoding', 'data_profile', 'intent_parse', 'plan_build', 'stats_summarize', 'claim_bind', 'plan_candidates', 'plan_mmr']) {
    const step = task.steps.find((s) => s.step_id === id)
    assert.equal(step.status, 'done', `${id} 应为 done`)
  }
})

test('GET 未知 taskId 返回 404 TASK_NOT_FOUND', async () => {
  const { res, json } = await getSnapshot(h, 'task_does_not_exist')
  assert.equal(res.status, 404)
  assert.equal(json.error.code, 'TASK_NOT_FOUND')
})

test('非法 CSV / 空文件 / 缺文件 / 错误引擎在创建时得到稳定错误响应', async () => {
  const cases = [
    { name: '空文件', csv: Buffer.alloc(0), expect: 400, code: 'EMPTY_FILE' },
    { name: '二进制', csv: Buffer.from([0x41, 0x00, 0x42, 0x0a]), expect: 400, code: 'BINARY_CONTENT' },
    { name: '仅表头', csv: 'a,b,c\n', expect: 400, code: 'NO_DATA_ROWS' },
    { name: '重复列名', csv: 'a,b,a\n1,2,3\n', expect: 400, code: 'DUPLICATE_HEADER' },
    { name: '无数值列', csv: 'name,city\n张三,西安\n李四,北京\n', expect: 422, code: 'NO_NUMERIC_FIELDS' }
  ]
  for (const c of cases) {
    const { res, json } = await createTask(h, { csv: c.csv, fileName: 'bad.csv' })
    assert.equal(res.status, c.expect, `${c.name} 状态码`)
    assert.equal(json.error.code, c.code, `${c.name} 错误码`)
  }

  // 缺少文件部分
  const noFile = multipart({ prompt: '测试任务', engine: 'python' }, [])
  const r1 = await fetch(`${h.base}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': noFile.contentType, authorization: `Bearer ${TOKEN}` },
    body: noFile.body
  })
  assert.equal(r1.status, 400)
  assert.equal((await r1.json()).error.code, 'MISSING_FILE')

  // 非法引擎
  const r2 = await createTask(h, { csv: SAMPLE, engine: 'excel' })
  assert.equal(r2.res.status, 400)
  assert.equal(r2.json.error.code, 'INVALID_ENGINE')

  // 错误 Content-Type
  const r3 = await fetch(`${h.base}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: '{}'
  })
  assert.equal(r3.status, 415)
  assert.equal((await r3.json()).error.code, 'UNSUPPORTED_MEDIA_TYPE')
})

test('prompt 引用不存在字段：任务 FAILED 且错误码 UNKNOWN_FIELD，不生成方案', async () => {
  const { json } = await createTask(h, {
    csv: SAMPLE,
    prompt: '请对不存在的字段 revenue 绘制趋势折线图对比各组'
  })
  const task = await waitForSnapshot(h, json.taskId, (t) => t.state === 'FAILED')
  assert.equal(task.error.code, 'UNKNOWN_FIELD')
  assert.ok(task.error.message.includes('revenue'))
  assert.equal(task.plans.length, 0)
  assert.ok(task.error.message.includes('不存在'))
})

test('需求过短进入 NEED_INPUT，/answer 应答后继续推进到 PRESENT', async () => {
  const { json } = await createTask(h, { csv: SAMPLE, prompt: '看图' })
  const waiting = await waitForSnapshot(h, json.taskId, (t) => t.state === 'NEED_INPUT')
  assert.ok(waiting.pendingQuestion.question)
  assert.ok(waiting.pendingQuestion.options.length >= 2)

  // 空回答 400
  const rEmpty = await fetch(`${h.base}/api/tasks/${json.taskId}/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ answer: '' })
  })
  assert.equal(rEmpty.status, 400)

  const r = await fetch(`${h.base}/api/tasks/${json.taskId}/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ answer: '希望比较各组之间的直接对比差异' })
  })
  assert.equal(r.status, 200)
  const task = await waitForSnapshot(h, json.taskId, (t) => t.state === 'PRESENT')
  assert.equal(task.plans.length, 3)
  assert.equal(task.pendingQuestion, undefined)
})

test('澄清回答引用不存在字段同样诚实失败', async () => {
  const { json } = await createTask(h, { csv: SAMPLE, prompt: '画图' })
  await waitForSnapshot(h, json.taskId, (t) => t.state === 'NEED_INPUT')
  await fetch(`${h.base}/api/tasks/${json.taskId}/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ answer: '请用 salary 字段做对比' })
  })
  const task = await waitForSnapshot(h, json.taskId, (t) => t.state === 'FAILED')
  assert.equal(task.error.code, 'UNKNOWN_FIELD')
})

test('非 NEED_INPUT 状态调用 /answer 返回 409 TASK_NOT_WAITING', async () => {
  const { json } = await createTask(h, { csv: SAMPLE })
  await waitForSnapshot(h, json.taskId, (t) => t.state === 'PRESENT')
  const r = await fetch(`${h.base}/api/tasks/${json.taskId}/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
    body: JSON.stringify({ answer: '随便回答' })
  })
  assert.equal(r.status, 409)
  assert.equal((await r.json()).error.code, 'TASK_NOT_WAITING')
})

test('DELETE /api/tasks/:id 删除后立即不可访问（WEB-005）', async () => {
  const { json } = await createTask(h, { csv: SAMPLE })
  await waitSettled(h, json.taskId)
  const r = await fetch(`${h.base}/api/tasks/${json.taskId}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${TOKEN}` }
  })
  assert.equal(r.status, 200)
  assert.equal((await r.json()).deleted, true)
  const again = await getSnapshot(h, json.taskId)
  assert.equal(again.res.status, 404)
  // DELETE 幂等：重复删除返回 200 + existed:false/deleted:false + 可解释错误码
  const r2 = await fetch(`${h.base}/api/tasks/${json.taskId}`, {
    method: 'DELETE',
    headers: { authorization: `Bearer ${TOKEN}` }
  })
  assert.equal(r2.status, 200)
  const body2 = await r2.json()
  assert.equal(body2.existed, false)
  assert.equal(body2.deleted, false)
  assert.equal(body2.code, 'TASK_NOT_FOUND')
})

test('GET /api/capabilities 真实探测解释器（本机 Python 应可用）', async () => {
  // 直接调用真实探测（测试服务默认使用快速桩，避免每个文件重复探测）
  const { probeEngines } = await import('../src/engines.js')
  const engines = probeEngines()
  for (const e of ['python', 'r', 'matlab']) {
    assert.ok(typeof engines[e].available === 'boolean')
  }
  assert.ok(engines.python.available, '当前环境装有 Python')
  assert.match(engines.python.version, /Python 3\.\d+/)

  // 端点返回同一结构
  const r = await fetch(`${h.base}/api/capabilities`, { headers: { authorization: `Bearer ${TOKEN}` } })
  assert.equal(r.status, 200)
  const body = await r.json()
  assert.ok(typeof body.runtimes.python.available === 'boolean')
  assert.equal('path' in body.runtimes.matlab, false, '公开能力响应不得暴露本机解释器绝对路径')
})

test('未知路由返回 JSON 404', async () => {
  const r = await fetch(`${h.base}/api/nope`, { headers: { authorization: `Bearer ${TOKEN}` } })
  assert.equal(r.status, 404)
  assert.equal((await r.json()).error.code, 'NOT_FOUND')
})

test('engine 参数真实透传：r / matlab 方案携带对应引擎且三引擎源码齐全；不可用时自动切 Python 执行', async () => {
  for (const engine of ['r', 'matlab']) {
    const { json, res } = await createTask(h, { csv: SAMPLE, engine, prompt: '比较处理组随周数的趋势，生成论文图' })
    assert.equal(res.status, 201)
    const task = await waitForSnapshot(h, json.taskId, (t) => t.state === 'PRESENT')
    assert.ok(task.plans.every((p) => p.engine === engine), `engine=${engine}`)
    for (const p of task.plans) {
      assert.ok(p.code.python.includes('matplotlib'))
      assert.match(p.code.r, /ggsave|svg\(/)
      assert.match(p.code.matlab, /exportgraphics|print\(/)
      assert.ok(p.dependencies.length >= 1)
      // 不可用引擎诚实切换：实际验证引擎为 python
      assert.equal(p.verification.engine, 'python')
    }
    assert.ok(task.retries >= 3, '三方案各至少记一次 ENGINE 切换修复')
    assert.equal(task.execution.engine, 'python')
    assert.ok(task.execution.status === 'success')
  }
})

test('prompt 与 engine 字段经 multipart 正确解析（非文件字段不丢失）', async () => {
  const mp = multipart(
    { prompt: '自定义需求：对比各处理组', engine: 'python' },
    [{ field: 'file', fileName: 'nitrogen_response_demo.csv', content: SAMPLE }]
  )
  const r = await fetch(`${h.base}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': mp.contentType, authorization: `Bearer ${TOKEN}` },
    body: mp.body
  })
  assert.equal(r.status, 201)
  const { taskId } = await r.json()
  const task = await waitForSnapshot(h, taskId, (t) => t.state === 'PRESENT')
  // 自定义需求进入方案标题
  assert.ok(task.plans.some((p) => p.spec.figure.title.includes('自定义需求')))
})
