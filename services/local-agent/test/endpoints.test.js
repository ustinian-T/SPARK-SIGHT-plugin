// 新端点集成测试：preferences / replan / preview / export(zip) / trace / traces。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import zlib from 'node:zlib'
import { fileURLToPath } from 'node:url'
import { startTestServer, createTask, waitForSnapshot, postJson, getRaw } from './helpers.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE = fs.readFileSync(path.join(here, 'fixtures', 'nitrogen_response_demo.csv'))

const h = await startTestServer()
after(async () => h.close())

/** 最小 ZIP 中央目录解析，返回 {文件名: Buffer} */
function unzip(buf) {
  const files = {}
  let p = 0
  while (p + 4 <= buf.length) {
    const sig = buf.readUInt32LE(p)
    if (sig !== 0x04034b50) break
    const method = buf.readUInt16LE(p + 8)
    const compSize = buf.readUInt32LE(p + 18)
    const nameLen = buf.readUInt16LE(p + 26)
    const extraLen = buf.readUInt16LE(p + 28)
    const name = buf.toString('utf-8', p + 30, p + 30 + nameLen)
    const dataStart = p + 30 + nameLen + extraLen
    const data = buf.subarray(dataStart, dataStart + compSize)
    files[name] = method === 8 ? zlib.inflateRawSync(data) : data
    p = dataStart + compSize
  }
  return files
}

async function settledTask(prompt = '比较三个处理组随观测周的变化趋势，生成论文用图') {
  const { json } = await createTask(h, { csv: SAMPLE, prompt })
  const task = await waitForSnapshot(h, json.taskId, (t) => t.state === 'PRESENT')
  return { taskId: json.taskId, task }
}

test('POST preferences（select_plan）：设置选中方案、权重重排序并下发 plans_ready', async () => {
  const { taskId } = await settledTask()
  const r = await postJson(h, `/api/tasks/${taskId}/preferences`, { kind: 'select_plan', planId: 'plan_density' })
  assert.equal(r.res.status, 200)
  assert.equal(r.json.selectedPlanId, 'plan_density')
  assert.equal(r.json.ranking[0], 'plan_density', '被选方案应排到首位')
  assert.equal(r.json.preference.kind, 'select_plan')

  const snap = await (await fetch(`${h.base}/api/tasks/${taskId}`, { headers: { authorization: `Bearer ${h.token}` } })).json()
  assert.equal(snap.selectedPlanId, 'plan_density')
  assert.equal(snap.preferences[0].planId, 'plan_density')
  assert.equal(snap.plans[0].plan_id, 'plan_density')
  assert.ok(snap.plansVersion >= 2)
})

test('POST preferences 未知方案 404；方案未生成时 409', async () => {
  const { json } = await createTask(h, { csv: SAMPLE, prompt: '比较三个处理组随观测周的变化趋势，生成论文用图' })
  // 方案尚未生成（INGEST 阶段）
  const early = await postJson(h, `/api/tasks/${json.taskId}/preferences`, { kind: 'select_plan', planId: 'plan_clarity' })
  assert.equal(early.res.status, 409)
  await waitForSnapshot(h, json.taskId, (t) => t.state === 'PRESENT')
  const bad = await postJson(h, `/api/tasks/${json.taskId}/preferences`, { kind: 'select_plan', planId: 'plan_nope' })
  assert.equal(bad.res.status, 404)
  assert.equal(bad.json.error.code, 'PLAN_NOT_FOUND')
})

test('POST replan：按反馈重新生成并真实执行，再次进入 PRESENT', async () => {
  const { taskId } = await settledTask()
  const r = await postJson(h, `/api/tasks/${taskId}/replan`, { feedback: '改成黑白印刷友好的期刊图' })
  assert.equal(r.res.status, 202)
  const task = await waitForSnapshot(h, taskId, (t) => t.state === 'PRESENT' && (t.planArtifacts ? Object.values(t.planArtifacts).length === 3 : false))
  assert.ok(task.plans.every((p) => p.executionStatus === 'verified'))
  assert.ok(task.plans.some((p) => p.spec.figure.title.includes('黑白印刷')))
})

test('POST code：保存可编辑源码为新修订，使旧产物失效并阻止密钥入库', async () => {
  const { taskId, task } = await settledTask()
  const plan = task.plans[0]
  const edited = `${plan.code.python}\n# 用户编辑：调整说明\n`
  const r = await postJson(h, `/api/tasks/${taskId}/code`, { planId: plan.plan_id, engine: 'python', code: edited })
  assert.equal(r.res.status, 200)
  assert.equal(r.json.revision.reason, 'code_edit')
  const snap = await (await fetch(`${h.base}/api/tasks/${taskId}`, { headers: { authorization: `Bearer ${h.token}` } })).json()
  const saved = snap.plans.find((item) => item.plan_id === plan.plan_id)
  assert.equal(saved.code.python, edited)
  assert.equal(saved.executionStatus, 'code_edited_unverified')
  assert.equal(snap.planArtifacts[plan.plan_id], undefined)

  const secret = await postJson(h, `/api/tasks/${taskId}/code`, {
    planId: plan.plan_id, engine: 'python', code: `API_KEY="${'ark-' + 'x'.repeat(30)}"`
  })
  assert.equal(secret.res.status, 400)
  assert.match(secret.json.error.message, /密钥/)
})

test('GET preview：返回真实 SVG 与 PNG 元数据；默认取选中/首选方案；未知方案 404', async () => {
  const { taskId } = await settledTask()
  const r = await getRaw(h, `/api/tasks/${taskId}/preview`)
  assert.equal(r.res.status, 200)
  const preview = JSON.parse(r.buf.toString('utf-8'))
  assert.ok(preview.svg.includes('<svg'))
  assert.ok(preview.width >= 320 && preview.height >= 240)
  assert.equal(preview.verification.passed, true)

  const density = await (await fetch(`${h.base}/api/tasks/${taskId}/preview?planId=plan_density`, { headers: { authorization: `Bearer ${h.token}` } })).json()
  assert.equal(density.planId, 'plan_density')
  assert.ok(density.svg.includes('<svg'))

  const bad = await fetch(`${h.base}/api/tasks/${taskId}/preview?planId=plan_nope`, { headers: { authorization: `Bearer ${h.token}` } })
  assert.equal(bad.status, 404)
  assert.equal((await bad.json()).error.code, 'PLAN_NOT_FOUND')
})

test('GET export：ZIP 含三引擎代码、数据、规格、证据与真实产物，可解包', async () => {
  const { taskId } = await settledTask()
  const r = await getRaw(h, `/api/tasks/${taskId}/export?planId=plan_convention`)
  assert.equal(r.res.status, 200)
  assert.match(r.res.headers.get('content-type'), /zip/)
  assert.equal(r.buf.readUInt32LE(0), 0x04034b50, 'ZIP 本地文件头签名')
  const files = unzip(r.buf)
  for (const name of ['plot.py', 'plot.R', 'plot.m', 'data.csv', 'ChartSpec.json', 'evidence.json', 'evidence.md', 'README.txt', 'artifacts/plan_convention.svg', 'artifacts/plan_convention.png', 'artifacts/plan_convention.pdf']) {
    assert.ok(files[name], `zip 缺少 ${name}`)
  }
  assert.deepEqual(files['data.csv'], SAMPLE)
  const spec = JSON.parse(files['ChartSpec.json'].toString('utf-8'))
  assert.ok(spec.figure.title.length > 0)
  assert.ok(spec.figure.rows >= 1 && spec.figure.cols >= 1)
  const evidence = JSON.parse(files['evidence.json'].toString('utf-8'))
  assert.ok(evidence.some((e) => e.evidence_id === 'ev_desc_0'))
})

test('GET trace：包含状态时间线、错误签名、验证、偏好、指纹与事件计数', async () => {
  const { taskId } = await settledTask('比较三个处理组随观测周的变化趋势，生成论文用图')
  await postJson(h, `/api/tasks/${taskId}/preferences`, { kind: 'browse' })
  const r = await getRaw(h, `/api/tasks/${taskId}/trace`)
  assert.equal(r.res.status, 200)
  const trace = JSON.parse(r.buf.toString('utf-8')).trace
  const states = trace.states.map((s) => s.state)
  assert.deepEqual(states, ['INGEST', 'UNDERSTAND', 'PLAN', 'ANALYZE', 'DESIGN', 'EXECUTE', 'VERIFY', 'PRESENT'])
  assert.match(trace.fingerprint, /^[0-9a-f]{64}$/)
  assert.equal(trace.verification.passed, true)
  assert.ok(trace.verification.perPlan.plan_clarity.passed)
  assert.ok(trace.steps.some((s) => s.step_id === 'code_execute' && s.status === 'done'))
  assert.ok(trace.eventCount > 20)
  assert.equal(trace.preferences.length, 1)
})

test('GET /api/traces：任务列表含验证状态与指纹', async () => {
  const r = await getRaw(h, '/api/traces')
  assert.equal(r.res.status, 200)
  const body = JSON.parse(r.buf.toString('utf-8'))
  assert.ok(Array.isArray(body.traces))
  assert.ok(body.traces.length >= 1)
  const item = body.traces[0]
  assert.ok(item.taskId && item.fingerprint && typeof item.verified === 'boolean')
})
