import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { PreferenceStore } from '../src/preferences.js'
import { FileStorage, tempDataDir } from '../src/storage.js'
import { createTask, getRaw, postJson, startTestServer, waitForSnapshot } from './helpers.js'

test('preference pause suppresses writes; revert and clear persist independently of tasks', () => {
  const root = tempDataDir('local-agent-pref-test-')
  const storage = new FileStorage(root)
  const prefs = new PreferenceStore(storage)
  prefs.setPaused(true)
  assert.equal(prefs.append({ event_id: 'p1', kind: 'select_plan', t: 1 }).written, false)
  prefs.setPaused(false)
  assert.equal(prefs.append({ event_id: 'p2', kind: 'manual_edit', t: 2 }).written, true)
  prefs.revert('p2')

  const restored = new PreferenceStore(new FileStorage(root))
  assert.equal(restored.snapshot().events[0].reverted, true)
  restored.clear()
  assert.equal(new PreferenceStore(new FileStorage(root)).snapshot().events.length, 0)
  assert.ok(fs.existsSync(path.join(root, 'preferences.json')))
})

test('paused learning suppresses select, verified patch edit, and export write paths', async () => {
  const root = tempDataDir('local-agent-pref-api-')
  const h = await startTestServer(1, { persist: true, dataDir: root })
  try {
    const paused = await postJson(h, '/api/preferences/pause', { paused: true })
    assert.equal(paused.res.status, 200)
    const created = await createTask(h, { csv: 'week,a,b\n1,2,3\n2,4,5\n', prompt: '比较 a 和 b 随 week 的变化趋势' })
    const task = await waitForSnapshot(h, created.json.taskId, (item) => item.state === 'PRESENT')
    await postJson(h, `/api/tasks/${task.taskId}/select`, { planId: task.plans[0].plan_id })
    const preview = await postJson(h, `/api/tasks/${task.taskId}/patches/preview`, {
      planId: task.plans[0].plan_id, parentVersion: task.currentRevision, targetKind: 'figure', targetId: 'figure',
      path: 'title', before: task.plans[0].spec.figure.title, after: '暂停学习时的编辑'
    })
    const applied = await postJson(h, `/api/tasks/${task.taskId}/patches/apply`, { token: preview.json.preview.token })
    assert.equal(applied.res.status, 200, JSON.stringify(applied.json))
    const exported = await getRaw(h, `/api/tasks/${task.taskId}/export?planId=${task.plans[0].plan_id}`)
    assert.equal(exported.res.status, 200)
    const snapshot = await fetch(`${h.base}/api/preferences`, { headers: { authorization: `Bearer ${h.token}` } }).then((res) => res.json())
    assert.equal(snapshot.paused, true)
    assert.equal(snapshot.events.length, 0)
  } finally {
    await h.close()
  }
})
