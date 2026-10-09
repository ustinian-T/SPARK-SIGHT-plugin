import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startTestServer, postJson, waitForSnapshot } from './helpers.js'

test('failed task retry retains original data/history and produces a real verified plan', async () => {
  const h = await startTestServer(1, { persist: true, dataDir: fs.mkdtempSync(path.join(os.tmpdir(), 'deep-retry-test-')) })
  try {
    const original = h.agent.store.create({ title: 'Retry', engine: 'python', prompt: '比较 a 和 b 随 week 的变化趋势', fileName: 'data.csv', bytes: Buffer.from('week,a,b\n1,2,3\n2,3,4\n3,4,5\n'), tenantId: 'local' })
    h.agent.store.emit(original, { type: 'state_delta', state: 'FAILED' })
    h.agent.store.emit(original, { type: 'error', code: 'TEST_TRANSIENT', message: 'temporary failure' })
    const n = original.events.length
    const url = `/api/projects/${original.projectId}/tasks/${original.taskId}/retry`
    const result = await postJson(h, url, {})
    assert.equal(result.res.status, 201, result.body)
    assert.notEqual(result.json.taskId, original.taskId)
    assert.equal(result.json.retryOf, original.taskId)
    assert.equal(original.state, 'FAILED')
    assert.equal(original.events.length, n)
    const duplicate = await postJson(h, url, {})
    assert.equal(duplicate.res.status, 409)
    const retry = h.agent.store.get(result.json.taskId)
    assert.deepEqual(retry.bytes, original.bytes)
    const done = await waitForSnapshot(h, retry.taskId, t => ['PRESENT','FAILED'].includes(t.state))
    assert.equal(done.state, 'PRESENT', JSON.stringify(done.error))
    assert.ok(done.plans.some(p => p.executionStatus === 'verified'))
    assert.equal((await postJson(h, `/api/tasks/${retry.taskId}/retry`, {})).res.status, 409)
  } finally { await h.close() }
})

test('retry rejects removed data and unauthorized identities', async () => {
  const h = await startTestServer()
  try {
    const task = h.agent.store.create({ title: 'Expired', engine: 'python', prompt: 'compare', fileName: 'data.csv', bytes: Buffer.alloc(0), tenantId: 'local' })
    h.agent.store.emit(task, { type: 'state_delta', state: 'FAILED' })
    assert.equal((await postJson(h, `/api/tasks/${task.taskId}/retry`, {})).res.status, 409)
    const r = await fetch(`${h.base}/api/tasks/${task.taskId}/retry`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
    assert.equal(r.status, 401)
  } finally { await h.close() }
})
