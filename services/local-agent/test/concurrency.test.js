// 并发隔离测试：两个任务同时创建、同时在沙箱队列中执行，断言
// taskId、事件流、磁盘文件、证据数据与版本谱系完全隔离，不串数据、不互相删除。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from '../src/server.js'
import { TOKEN, FAST_PROBE, multipart, waitForSnapshot, postJson } from './helpers.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const CSV_A = fs.readFileSync(path.join(here, 'fixtures', 'nitrogen_response_demo.csv'))
// 结构相似但数据完全不同的第二份 CSV（城市气温，不同列名/量级）
const CSV_B = Buffer.from(
  [
    'city,jan,feb,mar,jan_sd,feb_sd,mar_sd',
    'Xi\'an,-5.2,-1.1,6.8,0.4,0.5,0.6',
    'Beijing,-3.4,0.2,8.1,0.6,0.4,0.7',
    'Shanghai,4.8,6.4,10.9,0.3,0.4,0.5',
    'Guangzhou,13.9,15.1,18.4,0.5,0.3,0.4',
    'Chengdu,6.2,8.7,13.0,0.4,0.6,0.5',
    'Kunming,9.5,11.8,15.2,0.3,0.3,0.4'
  ].join('\n'),
  'utf-8'
)

const keepAlive = setTimeout(() => {}, 120000)
after(() => clearTimeout(keepAlive))

function upload(base, csv, { fileName, prompt }) {
  const { body, contentType } = multipart({ prompt, engine: 'python' }, [{ field: 'file', fileName, content: csv }])
  return fetch(`${base}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': contentType, authorization: `Bearer ${TOKEN}`, 'x-agent-protocol': '1' },
    body
  }).then(async (res) => ({ res, json: await res.json() }))
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

test('并发：两个任务同时运行，taskId/事件/文件/证据/版本互不串扰', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-agent-concurrency-'))
  const agent = createServer({ host: '127.0.0.1', port: 0, token: TOKEN, stepDelayMs: 1, persist: true, dataDir, probeEngines: FAST_PROBE })
  const { host, port } = await agent.start()
  const base = `http://${host}:${port}`
  try {
    // 同时创建两个任务
    const [a, b] = await Promise.all([
      upload(base, CSV_A, { fileName: 'nitrogen.csv', prompt: '比较三个处理组随观测周的变化趋势，生成论文用图' }),
      upload(base, CSV_B, { fileName: 'weather.csv', prompt: '比较各城市一季度气温变化，生成论文用图' })
    ])
    assert.equal(a.res.status, 201)
    assert.equal(b.res.status, 201)
    assert.notEqual(a.json.taskId, b.json.taskId, '两个任务 taskId 必须不同')
    const idA = a.json.taskId
    const idB = b.json.taskId

    // 各自订阅事件流
    const evA = openEvents(port, idA)
    const evB = openEvents(port, idB)
    await Promise.all([evA.opened, evB.opened])

    const [snapA, snapB] = await Promise.all([
      waitForSnapshot({ base, token: TOKEN }, idA, (t) => t.state === 'PRESENT'),
      waitForSnapshot({ base, token: TOKEN }, idB, (t) => t.state === 'PRESENT')
    ])
    await Promise.all([evA.done, evB.done])

    // ---- 数据隔离：列结构、行数、标题各自正确 ----
    assert.deepEqual(snapA.dataset.columns.map((c) => c.name), ['week', 'control', 'treatment_a', 'treatment_b', 'control_sd', 'treatment_a_sd', 'treatment_b_sd'])
    assert.deepEqual(snapB.dataset.columns.map((c) => c.name), ['city', 'jan', 'feb', 'mar', 'jan_sd', 'feb_sd', 'mar_sd'])
    assert.equal(snapA.title, 'nitrogen.csv')
    assert.equal(snapB.title, 'weather.csv')

    // ---- 事件流隔离：A 的事件中不得出现 B 的列名/方案数据，反之亦然 ----
    const blobA = JSON.stringify(evA.events)
    const blobB = JSON.stringify(evB.events)
    assert.ok(blobA.includes('treatment_a'), 'A 事件流应包含 A 的列')
    assert.ok(!blobA.includes('Guangzhou'), 'A 事件流不得混入 B 的数据')
    assert.ok(blobB.includes('Guangzhou'), 'B 事件流应包含 B 的数据')
    assert.ok(!blobB.includes('treatment_a'), 'B 事件流不得混入 A 的列')
    // 每条 WS 连接只收到自己任务的事件（事件计数 > 0 且状态完整）
    assert.ok(evA.events.some((e) => e.type === 'state_delta' && e.state === 'PRESENT'))
    assert.ok(evB.events.some((e) => e.type === 'state_delta' && e.state === 'PRESENT'))

    // ---- 证据数据隔离：同 id 不同值，统计结论绑定各自数据 ----
    const descA = snapA.evidence.find((e) => e.evidence_id === 'ev_desc_0')
    const descB = snapB.evidence.find((e) => e.evidence_id === 'ev_desc_0')
    assert.ok(descA && descB)
    assert.notEqual(JSON.stringify(descA), JSON.stringify(descB), '证据内容必须来自各自数据')
    assert.match(JSON.stringify(descB), /jan|feb|mar/)

    // ---- 磁盘文件隔离 ----
    const dirA = path.join(dataDir, 'tasks', idA)
    const dirB = path.join(dataDir, 'tasks', idB)
    assert.ok(fs.existsSync(dirA) && fs.existsSync(dirB))
    assert.deepEqual(fs.readFileSync(path.join(dirA, 'data.csv')), CSV_A)
    assert.deepEqual(fs.readFileSync(path.join(dirB, 'data.csv')), CSV_B)
    const runsA = fs.readdirSync(path.join(dirA, 'runs')).sort()
    const runsB = fs.readdirSync(path.join(dirB, 'runs')).sort()
    assert.deepEqual(runsA, ['plan_clarity', 'plan_convention', 'plan_density'])
    assert.deepEqual(runsB, ['plan_clarity', 'plan_convention', 'plan_density'])

    // ---- 版本谱系隔离：只对 A 提交反馈，B 版本数不变 ----
    const versionsBBefore = snapB.planVersions.length
    const fb = await postJson({ base, token: TOKEN }, `/api/tasks/${idA}/feedback`, { feedback: '强调处理组之间的差异' })
    assert.equal(fb.res.status, 202)
    const revisedA = await waitForSnapshot(
      { base, token: TOKEN },
      idA,
      (t) => t.state === 'PRESENT' && t.planVersions.length >= versionsBBefore + 2
    )
    assert.equal(revisedA.planVersions.length, versionsBBefore + 2)
    const snapB2 = await (await fetch(`${base}/api/tasks/${idB}`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()
    assert.equal(snapB2.planVersions.length, versionsBBefore, 'B 的版本谱系不得受 A 的反馈影响')
    assert.equal(snapB2.state, 'PRESENT')

    // ---- 删除隔离：删 A 不影响 B ----
    const del = await fetch(`${base}/api/tasks/${idA}`, { method: 'DELETE', headers: { authorization: `Bearer ${TOKEN}` } })
    assert.equal(del.status, 200)
    assert.ok(!fs.existsSync(dirA), 'A 目录必须物理删除')
    assert.ok(fs.existsSync(dirB), 'B 目录不得受影响')
    const a404 = await fetch(`${base}/api/tasks/${idA}`, { headers: { authorization: `Bearer ${TOKEN}` } })
    assert.equal(a404.status, 404)
    const bStill = await fetch(`${base}/api/tasks/${idB}`, { headers: { authorization: `Bearer ${TOKEN}` } })
    assert.equal(bStill.status, 200)
    const bJson = await bStill.json()
    assert.equal(bJson.state, 'PRESENT')
    assert.equal(bJson.plans.length, 3)
    evA.close()
    evB.close()
  } finally {
    await agent.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})
