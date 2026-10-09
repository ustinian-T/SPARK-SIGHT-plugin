import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runInSandbox, createSandboxRunner } from '../src/sandbox.js'
import { createTask, postJson, startTestServer, waitForSnapshot } from './helpers.js'

function workdir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'local-agent-cancel-test-'))
}

const LOOP = 'while True:\n    pass\n'

test('abort kills a running sandbox process tree and reports cancellation', async () => {
  const controller = new AbortController()
  let pid
  const running = runInSandbox({
    workdir: workdir(), engine: 'python', code: LOOP, csvBuffer: Buffer.from('x\n1\n'), csvName: 'data.csv',
    expected: [], timeoutMs: 30_000, signal: controller.signal, onSpawn: (childPid) => { pid = childPid }
  })
  const deadline = Date.now() + 3000
  while (!pid && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 10))
  assert.ok(pid, 'sandbox child should have started')
  controller.abort()
  const result = await running
  assert.equal(result.status, 'cancelled')
  assert.equal(result.cancelled, true)
})

test('abort removes queued sandbox work before it spawns', async () => {
  const runner = createSandboxRunner()
  const firstController = new AbortController()
  const secondController = new AbortController()
  let secondSpawned = false
  const first = runner({ workdir: workdir(), engine: 'python', code: LOOP, csvBuffer: Buffer.from('x\n1\n'), csvName: 'data.csv', expected: [], timeoutMs: 30_000, signal: firstController.signal })
  const second = runner({
    workdir: workdir(), engine: 'python', code: 'print(1)', csvBuffer: Buffer.from('x\n1\n'), csvName: 'data.csv', expected: [],
    signal: secondController.signal, onSpawn: () => { secondSpawned = true }
  })
  secondController.abort()
  firstController.abort()
  assert.equal((await first).status, 'cancelled')
  assert.equal((await second).status, 'cancelled')
  assert.equal(secondSpawned, false)
})

test('POST cancel makes CANCELLED terminal exactly once while render is active', async () => {
  let slowRuns = 0
  const slowRunner = ({ signal, engine }) => new Promise((resolve) => {
    slowRuns += 1
    const cancelled = () => resolve({ status: 'cancelled', engine, cancelled: true, artifacts: [], missingArtifacts: [] })
    if (signal.aborted) cancelled()
    else signal.addEventListener('abort', cancelled, { once: true })
  })
  const h = await startTestServer(1, { runSandbox: slowRunner })
  try {
    const created = await createTask(h, { csv: 'week,a,b\n1,2,3\n2,4,5\n', prompt: '比较 a 和 b 随 week 的变化趋势' })
    assert.equal(created.res.status, 201)
    await waitForSnapshot(h, created.json.taskId, (task) => task.state === 'EXECUTE')
    assert.equal(slowRuns, 1, 'server must use the injected sandbox runner')
    const cancelled = await postJson(h, `/api/tasks/${created.json.taskId}/cancel`, {})
    assert.equal(cancelled.res.status, 200)
    assert.equal(cancelled.json.state, 'CANCELLED')
    const snapshot = await waitForSnapshot(h, created.json.taskId, (task) => task.state === 'CANCELLED')
    assert.ok(snapshot.cancelledAt)
    await new Promise((resolve) => setTimeout(resolve, 30))
    const events = h.agent.store.get(created.json.taskId).events
    assert.equal(events.filter((event) => event.type === 'done' && event.state === 'CANCELLED').length, 1)
    assert.equal(events.at(-1).type, 'done')
    const again = await postJson(h, `/api/tasks/${created.json.taskId}/cancel`, {})
    assert.equal(again.json.state, 'CANCELLED')
    assert.equal(events.filter((event) => event.type === 'done' && event.state === 'CANCELLED').length, 1)
  } finally {
    await h.close()
  }
})

test('server close aborts and waits for background rendering', async () => {
  let aborted = false
  const slowRunner = ({ signal, engine }) => new Promise((resolve) => {
    const stop = () => {
      aborted = true
      resolve({ status: 'cancelled', engine, cancelled: true, artifacts: [], missingArtifacts: [] })
    }
    if (signal.aborted) stop()
    else signal.addEventListener('abort', stop, { once: true })
  })
  const h = await startTestServer(1, { runSandbox: slowRunner })
  const created = await createTask(h, { csv: 'week,a,b\n1,2,3\n2,4,5\n', prompt: '比较 a 和 b 随 week 的变化趋势' })
  await waitForSnapshot(h, created.json.taskId, (task) => task.state === 'EXECUTE')
  await h.close()
  assert.equal(aborted, true)
})
