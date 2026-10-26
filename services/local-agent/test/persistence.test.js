// 文件态持久化测试：任务跑完 → 关闭服务 → 同目录新服务恢复 → 快照/预览/trace 可读。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createServer } from '../src/server.js'
import { createTask, waitForSnapshot, TOKEN, FAST_PROBE } from './helpers.js'

const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-agent-persist-'))
after(() => fs.rmSync(dataDir, { recursive: true, force: true }))

async function server() {
  const agent = createServer({ host: '127.0.0.1', port: 0, token: TOKEN, stepDelayMs: 1, persist: true, dataDir, probeEngines: FAST_PROBE })
  const { port } = await agent.start()
  return { agent, base: `http://127.0.0.1:${port}`, token: TOKEN, close: () => agent.close() }
}

test('任务与产物落盘：.data 目录包含 data.csv / meta.json / events.jsonl / runs', async () => {
  const h = await server()
  try {
    const csv = 'week,control,treatment_a,treatment_b,control_sd,treatment_a_sd,treatment_b_sd\nW1,12.3,12.3,12.1,0.8,0.7,0.9\nW2,13.1,15.8,14.2,0.6,0.9,0.8\nW3,14.8,19.4,16.0,0.7,1.1,0.7\nW4,15.6,22.1,17.8,0.5,1.0,0.9\nW5,16.2,24.0,18.9,0.6,0.8,0.6\nW6,16.5,25.6,19.7,0.7,0.9,0.8\n'
    const created = await createTask(h, { csv: Buffer.from(csv, 'utf-8'), fileName: 'persist_demo.csv' })
    const taskId = created.json.taskId
    await waitForSnapshot(h, taskId, (t) => t.state === 'PRESENT')

    const dir = path.join(dataDir, 'tasks', taskId)
    assert.ok(fs.existsSync(path.join(dir, 'data.csv')))
    assert.ok(fs.existsSync(path.join(dir, 'meta.json')))
    const events = fs.readFileSync(path.join(dir, 'events.jsonl'), 'utf-8').trim().split(/\r?\n/)
    assert.ok(events.length > 20)
    const runs = path.join(dir, 'runs')
    const plans = fs.readdirSync(runs)
    assert.equal(plans.length, 3)
    for (const p of plans) {
      const attempt = fs.readdirSync(path.join(runs, p))[0]
      const files = fs.readdirSync(path.join(runs, p, attempt))
      assert.ok(files.some((f) => f.endsWith('.svg')))
      assert.ok(files.some((f) => f.endsWith('.png')))
      // 沙箱写入的原始数据保留上传文件名
      assert.ok(files.includes('persist_demo.csv'))
    }
  } finally {
    await h.close().catch(() => {})
  }
})

test('重启后任务恢复：快照为 PRESENT、验证结果保留、preview 从磁盘读取真实 SVG', async () => {
  // 先在第一个服务实例中跑完一个任务
  const h1 = await server()
  let h2
  try {
    const csv = fs.readFileSync(new URL('./fixtures/nitrogen_response_demo.csv', import.meta.url))
    const created = await createTask(h1, { csv, fileName: 'nitrogen_response_demo.csv' })
    const taskId = created.json.taskId
    const before = await waitForSnapshot(h1, taskId, (t) => t.state === 'PRESENT')
    await h1.close()

    // 同目录启动第二个实例：恢复任务
    h2 = await server()
  const health = await (await fetch(`${h2.base}/health`)).json()
  assert.ok(health.restoredTasks >= 1, `应恢复任务，实际 ${health.restoredTasks}`)

  const snap = await (await fetch(`${h2.base}/api/tasks/${taskId}`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()
  assert.equal(snap.state, 'PRESENT')
  assert.equal(snap.restored, true)
  assert.ok(snap.plans.every((p) => p.executionStatus === 'verified'))
  assert.equal(snap.verification.passed, before.verification.passed)
  assert.equal(snap.dataset.fingerprint, before.dataset.fingerprint)
  assert.ok(snap.execution.artifactSvg?.includes('<svg'), '事件重放恢复内联 SVG')

  // preview 从磁盘读取（恢复任务无内存 inline）
  const preview = await (await fetch(`${h2.base}/api/tasks/${taskId}/preview?planId=plan_density`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()
  assert.equal(preview.planId, 'plan_density')
  assert.ok(preview.svg.includes('<svg'))
  assert.ok(preview.width >= 320)

  // trace 同样可恢复
  const trace = await (await fetch(`${h2.base}/api/tasks/${taskId}/trace`, { headers: { authorization: `Bearer ${TOKEN}` } })).json()
  assert.equal(trace.trace.state, 'PRESENT')
  assert.equal(trace.trace.restored, true)
  assert.ok(trace.trace.verification.perPlan.plan_density.passed)

  // export zip 从磁盘补齐产物
  const zipRes = await fetch(`${h2.base}/api/tasks/${taskId}/export?planId=plan_clarity`, { headers: { authorization: `Bearer ${TOKEN}` } })
  assert.equal(zipRes.status, 200)
  const buf = Buffer.from(await zipRes.arrayBuffer())
  assert.equal(buf.readUInt32LE(0), 0x04034b50)
  assert.ok(buf.includes(Buffer.from('artifacts/plan_clarity.svg')))
  } finally {
    await h1.close().catch(() => {})
    if (h2) await h2.close().catch(() => {})
  }
})

test('LOCAL_AGENT_PERSIST=0 语义：persist:false 时不创建数据目录', async () => {
  const ephemeral = fs.mkdtempSync(path.join(os.tmpdir(), 'local-agent-nopersist-'))
  const agent = createServer({ host: '127.0.0.1', port: 0, token: TOKEN, stepDelayMs: 1, persist: false, dataDir: ephemeral, probeEngines: FAST_PROBE })
  await agent.start()
  assert.ok(!fs.existsSync(path.join(ephemeral, 'tasks')))
  await agent.close()
  fs.rmSync(ephemeral, { recursive: true, force: true })
})

test('残留损坏任务目录不阻断启动：过期任务清理失败时跳过并继续恢复其余任务', async () => {
  // 回归：TTL 清理与恢复在同一个循环里，deleteTask 抛错曾让整个服务启动失败
  // （真实故障：残留任务目录 fs.rmSync 报 EPERM，server.start() 直接崩）。
  // 系统层面无法可移植地"制造"删除失败，因此这里直接注入会抛错的 storage，
  // 精确验证恢复循环的容错契约。
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-agent-broken-'))
  try {
    // 先正常落盘一个任务，再用它作为恢复输入
    const h = await server()
    let taskId
    try {
      const csv = 'week,control,treatment_a,treatment_b,control_sd,treatment_a_sd,treatment_b_sd\nW1,12.3,12.3,12.1,0.8,0.7,0.9\nW2,13.1,15.8,14.2,0.6,0.9,0.8\n'
      const created = await createTask(h, { csv: Buffer.from(csv, 'utf-8'), fileName: 'good.csv' })
      taskId = created.json.taskId
      await waitForSnapshot(h, taskId, (t) => t.state === 'PRESENT')
    } finally {
      await h.close().catch(() => {})
    }
    fs.cpSync(dataDir, dir, { recursive: true, force: true })

    const { TaskStore } = await import('../src/taskStore.js')
    const { FileStorage } = await import('../src/storage.js')
    const storage = new FileStorage(dir)
    // 只取出本用例创建的那条记录，避免依赖 dataDir 中其他用例的残留
    const records = storage.loadAll().filter((rec) => rec.taskId === taskId)
    assert.equal(records.length, 1, `应读出本用例的任务记录，实际 ${records.length}`)

    let deleteAttempts = 0
    // 只让 deleteTask 失败，其余读写保持真实，从而精确落在恢复循环的清理分支
    const throwingStorage = Object.create(storage)
    throwingStorage.deleteTask = () => { deleteAttempts++; const e = new Error('EPERM: 目录被占用'); e.code = 'EPERM'; throw e }
    throwingStorage.loadAll = () => records
    throwingStorage.taskDir = storage.taskDir.bind(storage)

    const store = new TaskStore({ storage: throwingStorage, ttlMs: 1 })
    assert.doesNotThrow(() => store.restore(), '过期任务清理失败不得让 restore() 抛错')
    assert.equal(deleteAttempts, 1, '过期清理分支应被触发一次（否则本用例没有覆盖到该路径）')
  } finally {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})
