// WebSocket 事件流测试：状态顺序、步骤/证据事件、三方案证据共享、统计只执行一次、历史重放与握手鉴权。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { startTestServer, createTask, waitForSnapshot, openEvents } from './helpers.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE = fs.readFileSync(path.join(here, 'fixtures', 'nitrogen_response_demo.csv'))

const h = await startTestServer()
after(async () => h.close())

function statesOf(events) {
  return events.filter((e) => e.type === 'state_delta').map((e) => e.state)
}

test('事件流：六状态按序推进，证据事件齐全，done 收尾', async () => {
  const { json } = await createTask(h, { csv: SAMPLE })
  const client = openEvents(h, json.taskId)
  await client.opened
  const last = await client.done
  assert.equal(last.type, 'done')

  const states = statesOf(client.events)
  assert.deepEqual(states, ['INGEST', 'UNDERSTAND', 'PLAN', 'ANALYZE', 'DESIGN', 'EXECUTE', 'VERIFY', 'PRESENT'])

  // 步骤事件：关键节点均出现且最终状态正确
  const stepStatus = (id) => {
    const updates = client.events.filter((e) => e.type === 'step_update' && e.step?.step_id === id).map((e) => e.step.status)
    return updates[updates.length - 1]
  }
  for (const id of ['csv_load', 'data_profile', 'intent_parse', 'stats_summarize', 'claim_bind', 'plan_candidates', 'plan_mmr']) {
    assert.equal(stepStatus(id), 'done', `${id} 最终应为 done`)
  }
  for (const id of ['code_execute', 'render_output', 'verify_validate']) {
    assert.equal(stepStatus(id), 'done', `${id} 应真实完成`)
  }

  // 证据事件：每条都是完整 EvidenceRecord
  const evidenceEvents = client.events.filter((e) => e.type === 'evidence')
  assert.ok(evidenceEvents.length >= 8)
  for (const e of evidenceEvents) {
    assert.ok(/^ev_/.test(e.evidence.evidence_id))
    assert.ok(e.evidence.tool.startsWith('stats.'))
    assert.ok(Array.isArray(e.evidence.fields) && e.evidence.fields.length > 0)
    assert.ok(e.evidence.scope && e.evidence.value)
  }

  // plans_ready 两次：DESIGN 首版 + VERIFY 回填验证结果
  const plansReady = client.events.filter((e) => e.type === 'plans_ready')
  assert.equal(plansReady.length, 2)
  assert.equal(plansReady[0].plans.length, 3)
  assert.ok(plansReady[1].plans.every((p) => p.executionStatus === 'verified'))

  // execution_update 最终 success 且携带真实 SVG
  const execEvents = client.events.filter((e) => e.type === 'execution_update')
  assert.ok(execEvents.length >= 2)
  assert.equal(execEvents.at(-1).execution.status, 'success')
  assert.ok(execEvents.at(-1).execution.artifactSvg.includes('<svg'))

  // done 是最后一个事件
  assert.equal(client.events.at(-1).type, 'done')
  client.close()
})

test('证据绑定：三套方案共享同一次统计结果与同一 evidenceIds 集合', async () => {
  const { json } = await createTask(h, { csv: SAMPLE })
  const task = await waitForSnapshot(h, json.taskId, (t) => t.state === 'PRESENT')

  const [p1, p2, p3] = task.plans
  // 1) 三方案 evidenceIds 完全一致且非空
  assert.ok(p1.evidenceIds.length >= 8)
  assert.deepEqual(p1.evidenceIds, p2.evidenceIds)
  assert.deepEqual(p2.evidenceIds, p3.evidenceIds)
  // 2) 每个被引用的 evidence_id 都真实存在于证据账本
  const ledger = new Set(task.evidence.map((e) => e.evidence_id))
  for (const p of task.plans) {
    for (const id of p.evidenceIds) assert.ok(ledger.has(id), `方案引用了不存在的证据 ${id}`)
    // 数据处理摘要中的结论同样带 evidence_id
    const cited = [...p.dataProcessingSummary.matchAll(/\[(ev_[a-z_0-9]+)\]/g)].map((m) => m[1])
    assert.ok(cited.length >= 3)
    for (const id of cited) assert.ok(ledger.has(id))
  }
  // 3) 三方案系列数据逐点相同（统计只执行一次），仅颜色/图型等设计不同
  const seriesKey = (p) =>
    JSON.stringify(
      p.series.map((s) => ({ label: s.label, y: s.y, yerr: s.yerr ?? null }))
    )
  assert.equal(seriesKey(p1), seriesKey(p2))
  assert.equal(seriesKey(p2), seriesKey(p3))
  // 4) 三方案至少两个维度真实差异
  for (const p of task.plans) assert.ok(p.diffDimensions.length >= 2)
  assert.notDeepEqual(p1.spec.panels[0].layers[0].kind, p2.spec.panels[0].layers[0].kind)
  assert.notEqual(p1.spec.figure.cols, p3.spec.figure.cols)
  // 5) 统计数值与证据一致：control 均值 15.25 必须出现在 ev_desc_0
  const desc0 = task.evidence.find((e) => e.evidence_id === 'ev_desc_0')
  assert.ok(desc0.value.includes('mean=15.25'))
})

test('统计只执行一次：stats_summarize 仅一个 done，趋势证据每系列仅一条', async () => {
  const { json } = await createTask(h, { csv: SAMPLE })
  const client = openEvents(h, json.taskId)
  await client.opened
  await client.done
  const summarizeDone = client.events.filter(
    (e) => e.type === 'step_update' && e.step?.step_id === 'stats_summarize' && e.step.status === 'done'
  )
  assert.equal(summarizeDone.length, 1)
  const trendCount = client.events.filter((e) => e.type === 'evidence' && e.evidence.tool === 'stats.trend').length
  assert.equal(trendCount, 3)
  client.close()
})

test('失败任务事件流：UNKNOWN_FIELD 以 error 事件终止于 FAILED', async () => {
  const { json } = await createTask(h, { csv: SAMPLE, prompt: '请分析不存在的字段 ghost_col 的趋势' })
  const client = openEvents(h, json.taskId)
  await client.opened
  const last = await client.done
  assert.equal(last.type, 'error')
  assert.equal(last.code, 'UNKNOWN_FIELD')
  const states = statesOf(client.events)
  assert.equal(states.at(-1), 'FAILED')
  assert.ok(states.includes('UNDERSTAND'))
  assert.ok(!states.includes('ANALYZE'))
  // 失败步骤被真实标记为 failed，不停留在 running
  const intentUpdates = client.events
    .filter((e) => e.type === 'step_update' && e.step?.step_id === 'intent_parse')
    .map((e) => e.step.status)
  assert.equal(intentUpdates.at(-1), 'failed')
  client.close()
})

test('晚连接通过历史重放获得完整事件序列（断线恢复语义）', async () => {
  const { json } = await createTask(h, { csv: SAMPLE })
  await waitForSnapshot(h, json.taskId, (t) => t.state === 'PRESENT')
  const client = openEvents(h, json.taskId)
  await client.opened
  // 重放应很快补发 done
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('重放超时')), 3000)
    client.done.then((e) => {
      clearTimeout(t)
      resolve(e)
    })
  })
  const states = statesOf(client.events)
  assert.deepEqual(states, ['INGEST', 'UNDERSTAND', 'PLAN', 'ANALYZE', 'DESIGN', 'EXECUTE', 'VERIFY', 'PRESENT'])
  // seq 单调递增、不重不漏
  const seqs = client.events.map((e) => e.seq)
  assert.deepEqual(seqs, seqs.slice().sort((a, b) => a - b))
  assert.equal(new Set(seqs).size, seqs.length)
  client.close()
})

test('WebSocket 握手后认证（P0-6）：错误令牌拒绝、未知任务认证后 404', async () => {
  const { json } = await createTask(h, { csv: SAMPLE })
  
  // 1) 发送错误令牌，立即被拒绝
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/api/tasks/${json.taskId}/events`)
    const timeout = setTimeout(() => reject(new Error('测试超时')), 3000)
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'auth', token: 'invalid-token-xxx' }))
    })
    ws.addEventListener('message', (ev) => {
      const data = JSON.parse(ev.data)
      if (data.type === 'error' && data.code === 'UNAUTHORIZED') {
        clearTimeout(timeout)
        ws.close()
        resolve()
      }
    })
    ws.addEventListener('error', () => {
      clearTimeout(timeout)
      reject(new Error('WebSocket 连接错误'))
    })
  })
  
  // 2) 未知任务 ID，认证成功但找不到任务（404）
  await new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${h.port}/api/tasks/task_nope/events`)
    const timeout = setTimeout(() => reject(new Error('测试超时')), 3000)
    ws.addEventListener('open', () => {
      ws.send(JSON.stringify({ type: 'auth', token: h.token }))
    })
    ws.addEventListener('message', (ev) => {
      const data = JSON.parse(ev.data)
      if (data.type === 'error' && data.code === 'TASK_NOT_FOUND') {
        clearTimeout(timeout)
        ws.close()
        resolve()
      }
    })
    ws.addEventListener('error', () => {
      clearTimeout(timeout)
      reject(new Error('WebSocket 连接错误'))
    })
  })
})
