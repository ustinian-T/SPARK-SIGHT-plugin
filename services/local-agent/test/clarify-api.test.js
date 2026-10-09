// 三轮澄清端到端（HTTP 层）：建任务携带 clarify=true → 逐轮 NEED_INPUT(round/total/key) → /answer 推进 → PRESENT；
// clarifyAnswers 预填跳过已答轮次。
import { test, after, before } from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import { startTestServer, multipart, getSnapshot, waitForSnapshot, waitSettled, TOKEN } from './helpers.js'

const here = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname)
const SAMPLE = fs.readFileSync(path.join(here, 'fixtures', 'nitrogen_response_demo.csv'))

let h
before(async () => { h = await startTestServer(1) })
after(async () => { await h.close() })

async function createTaskWithClarify(fields = {}, extra = {}) {
  const { body, contentType } = multipart(
    { prompt: '比较三个处理组随观测周的变化趋势，生成论文用图', engine: 'python', ...fields },
    [{ field: 'file', fileName: 'nitrogen_response_demo.csv', content: SAMPLE }]
  )
  const res = await fetch(`${h.base}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': contentType, authorization: `Bearer ${h.token}`, 'x-agent-protocol': '1' },
    body
  })
  const json = await res.json()
  assert.equal(res.status, 201, `创建失败：${JSON.stringify(json)}`)
  return json.taskId
}

async function waitForNeedInput(taskId, round) {
  return waitForSnapshot(h, taskId, (t) => t.state === 'NEED_INPUT' && t.pendingQuestion?.round === round, { timeout: 20000 })
}

async function answer(taskId, answer) {
  const res = await fetch(`${h.base}/api/tasks/${taskId}/answer`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${h.token}` },
    body: JSON.stringify({ answer })
  })
  const json = await res.json()
  assert.equal(res.status, 200, `answer 失败：${res.status} ${JSON.stringify(json)}`)
  return json
}

test('clarify=true：三轮轮询（round1 图型任务 → round2 图型偏好 → round3 标题图注排版）后进入 PRESENT', async () => {
  const taskId = await createTaskWithClarify({ clarify: 'true' })

  // 第 1 轮：图型任务
  let snap = await waitForNeedInput(taskId, 1)
  assert.equal(snap.pendingQuestion.key, 'goal')
  assert.equal(snap.pendingQuestion.total, 3)
  assert.ok(Array.isArray(snap.pendingQuestion.options) && snap.pendingQuestion.options.length >= 2)
  await answer(taskId, '对比组间差异')

  // 第 2 轮：图型偏好
  snap = await waitForNeedInput(taskId, 2)
  assert.equal(snap.pendingQuestion.key, 'chartType')
  assert.ok(snap.pendingQuestion.options.some((o) => o.includes('热力图') || o.includes('双Y轴') || o.includes('三维曲面')))
  await answer(taskId, '自动选择')

  // 第 3 轮：标题/图注/排版
  snap = await waitForNeedInput(taskId, 3)
  assert.equal(snap.pendingQuestion.key, 'presentation')
  assert.ok(snap.pendingQuestion.hint.includes('标题='))
  await answer(taskId, '标题=各处理组日均产量；图注=图1-1 各处理组日均产量对比；标题字色=#6E8FB2；图注字号=10.5')

  const done = await waitForSnapshot(h, taskId, (t) => t.state === 'PRESENT' || t.state === 'FAILED', { timeout: 180000 })
  assert.equal(done.state, 'PRESENT', `澄清后任务应推进到 PRESENT：${JSON.stringify(done.error)}`)
  assert.equal(done.clarification.goal, 'comparison')
  assert.equal(done.clarification.chartType, 'auto')
  assert.equal(done.clarification.title, '各处理组日均产量')
  assert.equal(done.clarification.caption, '图1-1 各处理组日均产量对比')
  assert.equal(done.clarification.typography.title.color, '#6E8FB2')
  assert.equal(done.clarification.typography.caption.size, 10.5)
  // 三方案带图注与排版字段
  for (const p of done.plans) {
    assert.ok(p.caption, '方案应携带图注')
    assert.ok(p.typography && p.typography.fontFamily === 'SimHei', '方案应携带科研排版参数')
    assert.match(p.spec.figure.title, /各处理组日均产量/)
  }
})

test('clarifyAnswers 预填跳过 round1/2，仅询问 round3', async () => {
  const taskId = await createTaskWithClarify({
    clarify: 'true',
    clarifyAnswers: JSON.stringify({ goal: 'trend', chartType: 'dual_axis', answeredRounds: [1, 2] })
  })
  const snap = await waitForNeedInput(taskId, 3)
  assert.equal(snap.pendingQuestion.key, 'presentation')
  await answer(taskId, '全部按科研默认')
  const done = await waitForSnapshot(h, taskId, (t) => t.state === 'PRESENT' || t.state === 'FAILED', { timeout: 180000 })
  assert.equal(done.state, 'PRESENT', `预填任务应推进到 PRESENT：${JSON.stringify(done.error)}`)
  assert.equal(done.clarification.goal, 'trend')
  assert.equal(done.clarification.chartType, 'dual_axis')
  const rounds = done.clarification.answers.map((a) => a.round)
  assert.deepEqual(rounds, [1, 2, 3])
  // 双Y轴被强制进三套方案之一（selectionAudit 挂在数组上，快照 JSON 会丢失，故直接查候选）
  assert.ok(done.plans.some((p) => p.candidateId === 'c_clarity_dual_axis'), '三套方案中应含双Y轴图')
})

test('未启用 clarify：保持既有行为（长 prompt 直达，无轮询）', async () => {
  const { body, contentType } = multipart(
    { prompt: '比较三个处理组随观测周的变化趋势，生成论文用图', engine: 'python' },
    [{ field: 'file', fileName: 'nitrogen_response_demo.csv', content: SAMPLE }]
  )
  const res = await fetch(`${h.base}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': contentType, authorization: `Bearer ${h.token}`, 'x-agent-protocol': '1' },
    body
  })
  const json = await res.json()
  const done = await waitForSnapshot(h, json.taskId, (t) => t.state === 'PRESENT' || t.state === 'FAILED' || t.state === 'NEED_INPUT', { timeout: 180000 })
  assert.equal(done.state, 'PRESENT', `未启用澄清应直达 PRESENT：${JSON.stringify(done.error)}`)
  assert.equal(done.clarification, undefined)
  for (const p of done.plans) assert.equal(p.caption, '图1-1 ' + p.spec.figure.title)
})
