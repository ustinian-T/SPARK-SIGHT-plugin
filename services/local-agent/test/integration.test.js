// 端到端集成测试（第三轮收尾）：从干净启动走通完整链路——
// 健康检查 → 上传 CSV → WS 接收事件 → 快照 → 选择方案（分支保留）→ 反馈产生新版本 → 删除不可访问。
// 同时断言：状态顺序合法、统计只执行一次、三方案共享同一组 evidence_id。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from '../src/server.js'
import { TOKEN, FAST_PROBE, multipart, waitForSnapshot, getSnapshot, postJson } from './helpers.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE = fs.readFileSync(path.join(here, 'fixtures', 'nitrogen_response_demo.csv'))

// 与 llm.test 同理：纯 HTTP 断言阶段需要文件级 ref 定时器，避免事件循环提前排空
const keepAlive = setTimeout(() => {}, 120000)
after(() => clearTimeout(keepAlive))

async function startServer(opts = {}) {
  const agent = createServer({ host: '127.0.0.1', port: 0, token: TOKEN, stepDelayMs: 1, persist: false, probeEngines: FAST_PROBE, ...opts })
  const { host, port } = await agent.start()
  return { agent, base: `http://${host}:${port}`, port, token: TOKEN }
}

function openEvents(port, taskId) {
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/tasks/${taskId}/events`)
  const events = []
  let resolveDone
  const done = new Promise((resolve) => (resolveDone = resolve))
  let resolveOpened
  const opened = new Promise((resolve) => (resolveOpened = resolve))
  ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'auth', token: TOKEN })))
  ws.addEventListener('message', (ev) => {
    const data = JSON.parse(ev.data)
    if (data.type === 'authenticated') { resolveOpened(); return }
    events.push(data)
    if (data.type === 'done' || data.type === 'error') resolveDone(data)
  })
  return { ws, events, opened, done, close: () => ws.close() }
}

async function uploadCsv(base, { fileName = 'nitrogen_response_demo.csv', prompt = '比较三个处理组随观测周的变化趋势，生成论文用图' } = {}) {
  const { body, contentType } = multipart({ prompt, engine: 'python' }, [{ field: 'file', fileName, content: SAMPLE }])
  const res = await fetch(`${base}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': contentType, authorization: `Bearer ${TOKEN}`, 'x-agent-protocol': '1' },
    body
  })
  return { res, json: await res.json() }
}

test('集成：健康检查 → 创建 → 事件 → 快照 → 选择 → 反馈新版本 → 删除，全链路真实闭环', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-agent-integ-'))
  const server = await startServer({ persist: true, dataDir })
  try {
    // 1) 健康检查
    const hc = await fetch(`${server.base}/health`)
    assert.equal(hc.status, 200)
    const hcJson = await hc.json()
    assert.equal(hcJson.status, 'ok')
    assert.equal(hcJson.protocol, 1)

    // 2) 创建任务并立即订阅（连接即重放，不丢事件）
    const { res: createRes, json: created } = await uploadCsv(server.base)
    assert.equal(createRes.status, 201)
    assert.ok(/^task_[0-9a-z_]+$/i.test(created.taskId))
    const taskId = created.taskId
    const ev = openEvents(server.port, taskId)
    await ev.opened

    // 3) 首轮推进到 PRESENT
    const task = await waitForSnapshot(server, taskId, (t) => t.state === 'PRESENT')
    assert.equal(task.state, 'PRESENT')
    await ev.done

    // 4) 状态顺序合法（允许 REPAIR 循环，这里首轮无修复）
    const states = ev.events.filter((e) => e.type === 'state_delta').map((e) => e.state)
    const expected = ['INGEST', 'UNDERSTAND', 'PLAN', 'ANALYZE', 'DESIGN', 'EXECUTE', 'VERIFY', 'PRESENT']
    assert.deepEqual(states, expected, `首轮状态顺序应为 ${expected.join('→')}，实际 ${states.join('→')}`)
    const types = ev.events.map((e) => e.type)
    for (const t of ['state_delta', 'step_update', 'evidence', 'plans_ready', 'execution_update', 'done']) {
      assert.ok(types.includes(t), `首轮事件缺少 ${t}`)
    }
    assert.equal(types.at(-1), 'done')
    // 首轮两次 plans_ready：DESIGN（执行前，v1）与 VERIFY（验证后，v2）
    assert.equal(types.filter((t) => t === 'plans_ready').length, 2)

    // 5) 三套方案真实执行验证、共享同一组证据（统计只执行一次）
    assert.equal(task.plans.length, 3)
    for (const p of task.plans) assert.equal(p.executionStatus, 'verified')
    const evidenceIds = task.evidence.map((e) => e.evidence_id)
    assert.ok(evidenceIds.length >= 8, `证据数量应充足，实际 ${evidenceIds.length}`)
    for (const p of task.plans) {
      assert.deepEqual(p.evidenceIds, evidenceIds, `方案 ${p.plan_id} 必须与证据账本共享同一组 evidence_id`)
    }
    // 证据 id 唯一、无重复统计
    assert.equal(new Set(evidenceIds).size, evidenceIds.length)

    // 6) 选择方案三：置顶、进入 ITERATE，其余两套原样保留；偏好排序不产生新版本
    const versionsBefore = task.planVersions.length
    const sel = await postJson(server, `/api/tasks/${taskId}/select`, { planId: 'plan_density' })
    assert.equal(sel.res.status, 200)
    assert.deepEqual(sel.json.ranking[0], 'plan_density')
    const afterSelect = await waitForSnapshot(server, taskId, (t) => t.state === 'ITERATE')
    assert.equal(afterSelect.plans.length, 3, '其他方案必须保留为可恢复分支')
    assert.deepEqual(afterSelect.plans.map((p) => p.plan_id).sort(), ['plan_clarity', 'plan_convention', 'plan_density'])
    assert.equal(afterSelect.selectedPlanId, 'plan_density')
    assert.equal(afterSelect.planVersions.length, versionsBefore, '偏好排序不得生成新 PlotRevision')

    // 7) 反馈：生成新版本记录，旧版本完整保留；证据账本不重复追加
    const ev2 = openEvents(server.port, taskId)
    await ev2.opened
    const fb = await postJson(server, `/api/tasks/${taskId}/feedback`, { feedback: '把标题改为强调处理组差异，并加粗折线' })
    assert.equal(fb.res.status, 202)
    assert.equal(fb.json.revision, 'new')
    const revised = await waitForSnapshot(
      server,
      taskId,
      (t) => t.state === 'PRESENT' && t.planVersions.length >= versionsBefore + 2
    )
    await ev2.done
    assert.equal(revised.planVersions.length, versionsBefore + 2, 'feedback 应追加执行前/验证后两个 PlotRevision')
    const reasons = revised.planVersions.map((v) => v.reason)
    assert.deepEqual(reasons.slice(-2), ['feedback', 'feedback'])
    // 旧版本不可变：首轮两条仍为 initial
    assert.deepEqual(revised.planVersions.slice(0, versionsBefore).map((v) => v.reason), Array(versionsBefore).fill('initial'))
    // 版本号稠密、从 1 开始
    assert.deepEqual(revised.planVersions.map((v) => v.version), Array.from({ length: revised.planVersions.length }, (_, i) => i + 1))
    // 统计结论保持同一组 evidence_id（确定性复算，证据账本不重复）
    assert.deepEqual(revised.evidence.map((e) => e.evidence_id), evidenceIds)
    for (const p of revised.plans) assert.deepEqual(p.evidenceIds, evidenceIds)
    // feedback 轮真实重新执行；执行器可在 VERIFY 前按预算进入 REPAIR→EXECUTE 循环。
    const allStates = ev2.events.filter((e) => e.type === 'state_delta').map((e) => e.state)
    const iIterate = allStates.lastIndexOf('ITERATE')
    const feedbackStates = allStates.slice(iIterate)
    assert.deepEqual(feedbackStates.slice(0, 3), ['ITERATE', 'DESIGN', 'EXECUTE'])
    assert.deepEqual(feedbackStates.slice(-2), ['VERIFY', 'PRESENT'])
    const repairStates = feedbackStates.slice(3, -2)
    assert.equal(repairStates.length % 2, 0, `修复循环必须成对出现，实际：${feedbackStates.join('→')}`)
    for (let i = 0; i < repairStates.length; i += 2) {
      assert.deepEqual(repairStates.slice(i, i + 2), ['REPAIR', 'EXECUTE'])
    }
    assert.ok(ev2.events.some((e) => e.type === 'plans_ready' && e.reason === 'feedback'))

    // 8) 持久化原始文件与 runs 真实存在
    const taskDir = path.join(dataDir, 'tasks', taskId)
    assert.ok(fs.existsSync(path.join(taskDir, 'data.csv')))
    assert.ok(fs.existsSync(path.join(taskDir, 'events.jsonl')))

    // 9) 删除：立即不可访问（快照 404、WS 握手 404、目录物理清除）
    const del = await fetch(`${server.base}/api/tasks/${taskId}`, { method: 'DELETE', headers: { authorization: `Bearer ${TOKEN}` } })
    assert.equal(del.status, 200)
    const delJson = await del.json()
    assert.deepEqual([delJson.existed, delJson.deleted], [true, true])
    assert.ok(!fs.existsSync(taskDir), '任务目录（含原始 data.csv 与 runs）必须物理删除')
    const again = await getSnapshot(server, taskId)
    assert.equal(again.res.status, 404)
    assert.equal(again.json.error.code, 'TASK_NOT_FOUND')
    // P0-6：HTTP 升级成功，已删除任务在握手认证后返回 TASK_NOT_FOUND
    const wsReject = await new Promise((resolve) => {
      const ws = new WebSocket(`ws://127.0.0.1:${server.port}/api/tasks/${taskId}/events`)
      const timer = setTimeout(() => { ws.close(); resolve(false) }, 3000)
      ws.addEventListener('open', () => ws.send(JSON.stringify({ type: 'auth', token: TOKEN })))
      ws.addEventListener('message', (ev) => {
        const data = JSON.parse(ev.data)
        if (data.type === 'error' && data.code === 'TASK_NOT_FOUND') { clearTimeout(timer); ws.close(); resolve(true) }
        if (data.type === 'authenticated') { clearTimeout(timer); ws.close(); resolve(false) }
      })
    })
    assert.ok(wsReject, '已删除任务的 WS 认证必须返回 TASK_NOT_FOUND')

    // 10) 重复删除幂等
    const del2 = await fetch(`${server.base}/api/tasks/${taskId}`, { method: 'DELETE', headers: { authorization: `Bearer ${TOKEN}` } })
    const del2Json = await del2.json()
    assert.equal(del2.status, 200)
    assert.deepEqual([del2Json.existed, del2Json.deleted], [false, false])
    assert.equal(del2Json.code, 'TASK_NOT_FOUND')
  } finally {
    await server.agent.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('集成：终态（COMPLETE）后拒绝一切变更，只读能力仍可用', async () => {
  const server = await startServer()
  try {
    const { json } = await uploadCsv(server.base)
    const task = await waitForSnapshot(server, json.taskId, (t) => t.state === 'PRESENT')
    assert.equal(task.plans.length, 3)
    const done = await postJson(server, `/api/tasks/${json.taskId}/complete`, {})
    assert.equal(done.res.status, 200)
    const frozen = await waitForSnapshot(server, json.taskId, (t) => t.state === 'COMPLETE')
    assert.equal(frozen.state, 'COMPLETE')

    for (const [pathName, body] of [
      [`/api/tasks/${json.taskId}/feedback`, { feedback: '再改改' }],
      [`/api/tasks/${json.taskId}/select`, { planId: 'plan_clarity' }],
      [`/api/tasks/${json.taskId}/answer`, { answer: 'x' }]
    ]) {
      const r = await postJson(server, pathName, body)
      assert.equal(r.res.status, 409, `${pathName} 应 409`)
      assert.equal(r.json.error.code, 'TASK_TERMINAL')
    }
    // 只读仍可用
    const snap = await getSnapshot(server, json.taskId)
    assert.equal(snap.res.status, 200)
    const trace = await fetch(`${server.base}/api/tasks/${json.taskId}/trace`, { headers: { authorization: `Bearer ${TOKEN}` } })
    assert.equal(trace.status, 200)
  } finally {
    await server.agent.close()
  }
})

