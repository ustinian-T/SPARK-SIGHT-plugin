// 第三轮接口测试：answer / select / feedback(PlotRevision 版本历史) / complete /
// 终态状态机守卫 / DELETE 幂等与原始文件立即不可访问。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from '../src/server.js'
import { startTestServer, createTask, waitForSnapshot, postJson, getSnapshot, TOKEN } from './helpers.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE = fs.readFileSync(path.join(here, 'fixtures', 'nitrogen_response_demo.csv'))
const PROMPT = '比较三个处理组随观测周的变化趋势，生成论文用图'

const h = await startTestServer()
after(async () => h.close())

async function settled(prompt = PROMPT) {
  const { json } = await createTask(h, { csv: SAMPLE, prompt })
  const task = await waitForSnapshot(h, json.taskId, (t) => t.state === 'PRESENT')
  return { taskId: json.taskId, task }
}

// ---------- POST /answer：NEED_INPUT 澄清闭环 ----------

test('短 prompt 进入 NEED_INPUT；POST /answer 后真实推进到 PRESENT', async () => {
  const { json } = await createTask(h, { csv: SAMPLE, prompt: '画图' })
  const waiting = await waitForSnapshot(h, json.taskId, (t) => t.state === 'NEED_INPUT')
  assert.ok(waiting.pendingQuestion?.question)

  const empty = await postJson(h, `/api/tasks/${json.taskId}/answer`, { answer: '   ' })
  assert.equal(empty.res.status, 400)

  const r = await postJson(h, `/api/tasks/${json.taskId}/answer`, { answer: '希望比较三个处理组随观测周的变化趋势并带误差棒' })
  assert.equal(r.res.status, 200)
  const task = await waitForSnapshot(h, json.taskId, (t) => t.state === 'PRESENT')
  assert.equal(task.plans.length, 3)
})

test('非 NEED_INPUT 状态应答：409；终态应答：409 TASK_TERMINAL', async () => {
  const { taskId } = await settled()
  const late = await postJson(h, `/api/tasks/${taskId}/answer`, { answer: 'x' })
  assert.equal(late.res.status, 409)
  assert.equal(late.json.error.code, 'TASK_NOT_WAITING')
})

// ---------- POST /select：选择方案，其他方案保留为可恢复分支 ----------

test('POST /select：选中方案置顶、状态进入 ITERATE，三套方案全部保留', async () => {
  const { taskId } = await settled()
  const r = await postJson(h, `/api/tasks/${taskId}/select`, { planId: 'plan_density' })
  assert.equal(r.res.status, 200)
  assert.equal(r.json.selectedPlanId, 'plan_density')
  assert.equal(r.json.state, 'ITERATE')
  assert.deepEqual(r.json.ranking[0], 'plan_density')

  const snap = await (await getSnapshot(h, taskId)).json
  assert.equal(snap.state, 'ITERATE')
  assert.equal(snap.selectedPlanId, 'plan_density')
  // 其他方案保留为可恢复分支：一个不少
  assert.deepEqual(snap.plans.map((p) => p.plan_id).sort(), ['plan_clarity', 'plan_convention', 'plan_density'])
  assert.ok(snap.preferences.some((p) => p.kind === 'select_plan' && p.planId === 'plan_density'))
  // 选择/排序不产生新 PlotRevision 版本（版本数仍为首轮的 2）
  const versions = snap.planVersions.map((v) => v.version)
  assert.deepEqual(versions, [1, 2])
})

test('select 后可切回其他分支（可恢复分支语义）', async () => {
  const { taskId } = await settled()
  await postJson(h, `/api/tasks/${taskId}/select`, { planId: 'plan_density' })
  const back = await postJson(h, `/api/tasks/${taskId}/select`, { planId: 'plan_clarity' })
  assert.equal(back.res.status, 200)
  assert.equal(back.json.ranking[0], 'plan_clarity')
  const snap = await (await getSnapshot(h, taskId)).json
  assert.equal(snap.plans.length, 3, '切换分支不删除任何方案')
})

test('select 未知方案 404 PLAN_NOT_FOUND；方案未生成 409；缺 planId 400', async () => {
  const early = await createTask(h, { csv: SAMPLE, prompt: PROMPT })
  const before = await postJson(h, `/api/tasks/${early.json.taskId}/select`, { planId: 'plan_clarity' })
  assert.equal(before.res.status, 409)
  assert.equal(before.json.error.code, 'TASK_NOT_WAITING')

  const { taskId } = await settled()
  const bad = await postJson(h, `/api/tasks/${taskId}/select`, { planId: 'plan_nope' })
  assert.equal(bad.res.status, 404)
  assert.equal(bad.json.error.code, 'PLAN_NOT_FOUND')
  const noId = await postJson(h, `/api/tasks/${taskId}/select`, {})
  assert.equal(noId.res.status, 400)
})

// ---------- POST /feedback：新版本记录，旧版本不覆盖 ----------

test('POST /feedback：经 ITERATE 重新执行验证到 PRESENT，生成新 PlotRevision，旧版本保留', async () => {
  const { json } = await createTask(h, { csv: SAMPLE, prompt: PROMPT })
  const taskId = json.taskId
  await waitForSnapshot(h, taskId, (t) => t.state === 'PRESENT')

  // 晚连接：先吃历史重放，再记录 feedback 之后的状态序列
  const ws = new WebSocket(`ws://127.0.0.1:${h.port}/api/tasks/${taskId}/events`)
  const events = []
  let mark = 0
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('ws auth timeout')), 3000)
    ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'auth', token: TOKEN })))
    ws.addEventListener('message', (ev) => {
      const data = JSON.parse(ev.data)
      if (data.type === 'authenticated') { clearTimeout(t); resolve() }
    })
    ws.addEventListener('error', () => { clearTimeout(t); reject(new Error('ws error')) })
  })
  await new Promise((r) => setTimeout(r, 300)) // 等待历史重放
  ws.addEventListener('message', (ev) => events.push(JSON.parse(ev.data)))
  mark = events.length

  const r = await postJson(h, `/api/tasks/${taskId}/feedback`, { feedback: '改成黑白印刷友好的期刊图' })
  assert.equal(r.res.status, 202)

  const snap = await waitForSnapshot(
    h,
    taskId,
    (t) => t.state === 'PRESENT' && (t.planVersions ? t.planVersions.some((v) => v.reason === 'feedback') : false)
  )

  // 状态机合法转移：ITERATE → DESIGN → EXECUTE → VERIFY → PRESENT
  const newStates = events.slice(mark).filter((e) => e.type === 'state_delta').map((e) => e.state)
  const want = ['ITERATE', 'DESIGN', 'EXECUTE', 'VERIFY', 'PRESENT']
  for (const s of want) assert.ok(newStates.includes(s), `feedback 后缺少状态 ${s}，实际：${newStates.join(',')}`)
  assert.equal(newStates.indexOf('ITERATE'), 0)
  assert.equal(newStates.at(-1), 'PRESENT')

  // 版本历史：首轮 2 个 initial 版本 + feedback 轮 2 个版本，共 4 个，单调递增
  assert.equal(snap.planVersions.length, 4)
  assert.deepEqual(snap.planVersions.map((v) => v.version), [1, 2, 3, 4])
  assert.deepEqual(snap.planVersions.filter((v) => v.reason === 'initial').length, 2)
  const fb = snap.planVersions.filter((v) => v.reason === 'feedback')
  assert.equal(fb.length, 2)
  assert.ok(fb.every((v) => v.feedback?.includes('黑白印刷')))

  // 旧版本不可变且可回溯：v1 是执行前的三方案（仅标记 code_generated_not_executed、无 verification），
  // v2 是首轮验证后版本（verified + verification）
  const v1 = snap.planVersions[0]
  const v2 = snap.planVersions[1]
  assert.equal(v1.plans.length, 3)
  assert.ok(v1.plans.every((p) => p.executionStatus === 'code_generated_not_executed'))
  assert.ok(v1.plans.every((p) => !p.verification))
  assert.ok(v2.plans.every((p) => p.executionStatus === 'verified'))
  assert.ok(v2.plans.every((p) => p.verification))
  // 当前版本为 feedback 验证后的三方案，标题反映反馈
  assert.equal(snap.plansVersion, 4)
  assert.ok(snap.plans.every((p) => p.executionStatus === 'verified'))
  assert.ok(snap.plans.some((p) => p.spec.figure.title.includes('黑白印刷')))
  // ExecutionRecord.version 递增到 2
  assert.equal(snap.execution.version, 2)
  ws.close()
})

test('feedback 空内容 400；并发 feedback 409 TASK_BUSY；/replan 为等价别名', async () => {
  const { taskId } = await settled()
  const empty = await postJson(h, `/api/tasks/${taskId}/feedback`, { feedback: '' })
  assert.equal(empty.res.status, 400)

  const first = await postJson(h, `/api/tasks/${taskId}/feedback`, { feedback: '改成黑白印刷友好的期刊图' })
  assert.equal(first.res.status, 202)
  const busy = await postJson(h, `/api/tasks/${taskId}/feedback`, { feedback: '再改标题' })
  assert.equal(busy.res.status, 409)
  assert.equal(busy.json.error.code, 'TASK_BUSY')
  await waitForSnapshot(h, taskId, (t) => t.state === 'PRESENT' && t.plansVersion >= 4)

  // 别名 /replan 在 PRESENT 上同样可用
  const alias = await postJson(h, `/api/tasks/${taskId}/replan`, { feedback: '加大字号' })
  assert.equal(alias.res.status, 202)
  await waitForSnapshot(h, taskId, (t) => t.state === 'PRESENT' && t.plansVersion >= 6)
})

// ---------- COMPLETE / 终态守卫 ----------

test('POST /complete 冻结任务；终态后 select/feedback/preferences/answer 一律 409 TASK_TERMINAL', async () => {
  const { taskId } = await settled()
  const done = await postJson(h, `/api/tasks/${taskId}/complete`, {})
  assert.equal(done.res.status, 200)
  const snap = await (await getSnapshot(h, taskId)).json
  assert.equal(snap.state, 'COMPLETE')
  // 幂等：再次 complete 不报错、不重复发事件
  const again = await postJson(h, `/api/tasks/${taskId}/complete`, {})
  assert.equal(again.res.status, 200)
  assert.equal(again.json.frozen, true)

  for (const [pathName, body] of [
    [`/api/tasks/${taskId}/select`, { planId: 'plan_clarity' }],
    [`/api/tasks/${taskId}/feedback`, { feedback: '再改' }],
    [`/api/tasks/${taskId}/replan`, { feedback: '再改' }],
    [`/api/tasks/${taskId}/preferences`, { kind: 'browse' }],
    [`/api/tasks/${taskId}/answer`, { answer: 'x' }]
  ]) {
    const r = await postJson(h, pathName, body)
    assert.equal(r.res.status, 409, `${pathName} 应被终态守卫拒绝`)
    assert.equal(r.json.error.code, 'TASK_TERMINAL', pathName)
  }
  // 终态后只读端点仍可用
  const trace = await (await fetch(`${h.base}/api/tasks/${taskId}/trace`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()
  assert.equal(trace.trace.state, 'COMPLETE')
})

test('FAILED 终态后所有变更操作 409 TASK_TERMINAL，且不再产生任何状态事件', async () => {
  const { json } = await createTask(h, { csv: SAMPLE, prompt: '请分析不存在的字段 ghost_col 的趋势' })
  await waitForSnapshot(h, json.taskId, (t) => t.state === 'FAILED')
  for (const pathName of ['select', 'feedback', 'replan', 'preferences', 'answer', 'complete']) {
    const r = await postJson(h, `/api/tasks/${json.taskId}/${pathName}`, { planId: 'plan_clarity', feedback: 'x', answer: 'x', kind: 'browse' })
    assert.equal(r.res.status, 409, `${pathName} on FAILED`)
    assert.equal(r.json.error.code, 'TASK_TERMINAL')
  }
  const snap = await (await getSnapshot(h, json.taskId)).json
  assert.equal(snap.state, 'FAILED')
})

// ---------- DELETE：幂等 + 原始文件立即不可访问 ----------

test('DELETE 幂等；删除后快照 404、WS 拒绝、原始 data.csv 与 runs 物理清除', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-agent-iterate-del-'))
  const agent = createServer({ host: '127.0.0.1', port: 0, token: TOKEN, stepDelayMs: 1, persist: true, dataDir })
  const { port } = await agent.start()
  const base = `http://127.0.0.1:${port}`
  try {
    const { json } = await createTask({ base, token: TOKEN }, { csv: SAMPLE, prompt: PROMPT })
    await waitForSnapshot({ base, token: TOKEN }, json.taskId, (t) => t.state === 'PRESENT')
    const taskDir = path.join(dataDir, 'tasks', json.taskId)
    assert.ok(fs.existsSync(path.join(taskDir, 'data.csv')))
    assert.ok(fs.existsSync(path.join(taskDir, 'runs')))

    const del = await fetch(`${base}/api/tasks/${json.taskId}`, { method: 'DELETE', headers: { authorization: `Bearer ${TOKEN}` } })
    const delJson = await del.json()
    assert.equal(del.status, 200)
    assert.deepEqual([delJson.existed, delJson.deleted], [true, true])

    // 原始文件与产物立即不可访问
    assert.ok(!fs.existsSync(taskDir), '任务目录应被物理删除')
    assert.ok(!fs.existsSync(path.join(dataDir, 'tasks', json.taskId)))

    // 快照 404
    const get = await fetch(`${base}/api/tasks/${json.taskId}`, { headers: { authorization: `Bearer ${TOKEN}` } })
    assert.equal(get.status, 404)
    assert.equal((await get.json()).error.code, 'TASK_NOT_FOUND')

    // P0-6：HTTP 升级成功，已删除任务握手认证后返回 TASK_NOT_FOUND
    const handshake = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${port}/api/tasks/${json.taskId}/events`)
      const timer = setTimeout(() => { ws.close(); resolve('timeout') }, 3000)
      ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'auth', token: TOKEN })))
      ws.addEventListener('message', (ev) => {
        const data = JSON.parse(ev.data)
        if (data.type === 'error' && data.code === 'TASK_NOT_FOUND') { clearTimeout(timer); ws.close(); resolve('rejected') }
        if (data.type === 'authenticated') { clearTimeout(timer); ws.close(); resolve('opened') }
      })
    })
    assert.equal(handshake, 'rejected')

    // 重复删除：稳定、可解释、幂等
    const again = await fetch(`${base}/api/tasks/${json.taskId}`, { method: 'DELETE', headers: { authorization: `Bearer ${TOKEN}` } })
    const againJson = await again.json()
    assert.equal(again.status, 200)
    assert.deepEqual([againJson.existed, againJson.deleted], [false, false])
    assert.equal(againJson.code, 'TASK_NOT_FOUND')

    // 删除一个从未存在的 id 同样幂等
    const never = await fetch(`${base}/api/tasks/task_never_existed`, { method: 'DELETE', headers: { authorization: `Bearer ${TOKEN}` } })
    assert.equal(never.status, 200)
    assert.equal((await never.json()).existed, false)
  } finally {
    await agent.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})
