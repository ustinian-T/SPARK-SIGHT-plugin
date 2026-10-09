import test from 'node:test'
import assert from 'node:assert/strict'
import { createTask, postJson, startTestServer, waitForSnapshot } from './helpers.js'

const SAMPLE = `week,a,b\n1,10,12\n2,13,15\n3,17,18\n4,20,23\n`
const REPLACEMENT = `week,a,b\n1,100,120\n2,130,150\n3,170,180\n4,200,230\n`

test('type overrides are persisted by the server and require explicit confirmation', async () => {
  const h = await startTestServer()
  try {
    const created = await createTask(h, { csv: SAMPLE, prompt: '比较 a 和 b 随 week 的变化趋势' })
    const initial = await waitForSnapshot(h, created.json.taskId, (task) => task.state === 'PRESENT')
    const preview = await postJson(h, `/api/tasks/${initial.taskId}/data/preview`, {
      kind: 'type_override', field: 'week', type: 'categorical'
    })
    assert.equal(preview.res.status, 200)
    assert.equal(preview.json.preview.requiresConfirmation, true)
    const denied = await postJson(h, `/api/tasks/${initial.taskId}/data/apply`, { token: preview.json.preview.token, confirmed: false })
    assert.equal(denied.res.status, 409)
    assert.equal(denied.json.error.code, 'DATA_CONFIRMATION_REQUIRED')

    const preview2 = await postJson(h, `/api/tasks/${initial.taskId}/data/preview`, {
      kind: 'type_override', field: 'week', type: 'categorical'
    })
    const applied = await postJson(h, `/api/tasks/${initial.taskId}/data/apply`, { token: preview2.json.preview.token, confirmed: true })
    assert.equal(applied.res.status, 200, JSON.stringify(applied.json))
    const after = await waitForSnapshot(h, initial.taskId, (task) => task.state === 'PRESENT' && task.dataVersions?.length === 2, { timeout: 5000 })
    assert.equal(after.dataset.columns.find((column) => column.name === 'week').userType, 'categorical')
    assert.notEqual(after.dataset.fingerprint, initial.dataset.fingerprint)
    assert.ok(after.planVersions.slice(0, initial.planVersions.length).every((revision) => revision.basedOnOldData === true))
    assert.ok(after.planVersions.slice(initial.planVersions.length).every((revision) => revision.basedOnOldData !== true))
  } finally {
    await h.close()
  }
})

test('replacement data creates lineage and recomputes evidence instead of overwriting history', async () => {
  const h = await startTestServer()
  try {
    const created = await createTask(h, { csv: SAMPLE, prompt: '比较 a 和 b 随 week 的变化趋势' })
    const initial = await waitForSnapshot(h, created.json.taskId, (task) => task.state === 'PRESENT')
    const preview = await postJson(h, `/api/tasks/${initial.taskId}/data/preview`, {
      kind: 'replace', fileName: 'replacement.csv', contentBase64: Buffer.from(REPLACEMENT).toString('base64')
    })
    assert.equal(preview.res.status, 200)
    const applied = await postJson(h, `/api/tasks/${initial.taskId}/data/apply`, { token: preview.json.preview.token, confirmed: true })
    assert.equal(applied.res.status, 200, JSON.stringify(applied.json))
    const after = await waitForSnapshot(h, initial.taskId, (task) => task.state === 'PRESENT' && task.dataVersions?.length === 2, { timeout: 5000 })
    assert.equal(after.dataset.fileName, 'replacement.csv')
    assert.notEqual(after.dataset.fingerprint, initial.dataset.fingerprint)
    assert.match(after.evidence.find((item) => item.evidence_id === 'ev_n').scope, new RegExp(after.dataset.fingerprint.slice(0, 12)))
    assert.equal(after.dataVersions[0].current, false)
    assert.equal(after.dataVersions[1].current, true)
  } finally {
    await h.close()
  }
})
