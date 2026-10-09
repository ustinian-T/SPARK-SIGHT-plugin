import test from 'node:test'
import assert from 'node:assert/strict'
import { applySourceRevision, previewSourceRevision } from '../src/sourceRevisions.js'
import { createTask, postJson, startTestServer, waitForSnapshot } from './helpers.js'

const SAMPLE = `week,a,b\n1,10,12\n2,13,15\n3,17,18\n4,20,23\n`

function fixture() {
  const plan = {
    plan_id: 'plan_clarity',
    strategy: 'clarity',
    spec: { figure: { title: 'Original' }, panels: [{ panel_id: 'panel_1', title: 'Panel' }] },
    code: {
      python: '# @deep-imaging-spec:eyJmaWd1cmUiOnsidGl0bGUiOiJPcmlnaW5hbCJ9LCJwYW5lbHMiOlt7InBhbmVsX2lkIjoicGFuZWxfMSIsInRpdGxlIjoiUGFuZWwifV19\nfig.suptitle("Original")\nfig.savefig("plan_clarity.svg")',
      r: '', matlab: ''
    }
  }
  return {
    taskId: 'task_source', dataset: { fingerprint: 'fp_1' }, plans: [plan],
    planVersions: [{ version: 1, reason: 'initial', plans: structuredClone([plan]) }], currentRevision: 1,
    artifacts: {}
  }
}

test('mapped title-only source edit returns to ChartSpec while arbitrary edits enter code mode', () => {
  const mappedTask = fixture()
  const original = mappedTask.plans[0].code.python
  const mapped = previewSourceRevision(mappedTask, {
    planId: 'plan_clarity', engine: 'python', parentVersion: 1,
    baseHash: undefined, source: original.replace('"Original"', '"Edited"')
  })
  assert.equal(mapped.mode, 'spec')
  assert.equal(mapped.spec.figure.title, 'Edited')
  assert.ok(mapped.sourceMap.some((entry) => entry.path === 'figure.title'))

  const customTask = fixture()
  const custom = previewSourceRevision(customTask, {
    planId: 'plan_clarity', engine: 'python', parentVersion: 1,
    source: `${customTask.plans[0].code.python}\n# custom calculation`
  })
  assert.equal(custom.mode, 'code')
  assert.equal(custom.spec, undefined)
})

test('source preview tokens are single-use and reject stale revisions', async () => {
  const task = fixture()
  const preview = previewSourceRevision(task, {
    planId: 'plan_clarity', engine: 'python', parentVersion: 1,
    source: `${task.plans[0].code.python}\n# edit`
  })
  task.currentRevision = 2
  await assert.rejects(() => applySourceRevision(task, preview.token, async (plan) => plan), { code: 'SOURCE_STALE' })
})

test('HTTP arbitrary source edit is previewable but weak local sandbox refuses execution', async () => {
  const previousSandbox = process.env.DEEP_IMAGING_SANDBOX
  process.env.DEEP_IMAGING_SANDBOX = 'off'
  const h = await startTestServer()
  try {
    const created = await createTask(h, { csv: SAMPLE, prompt: '比较 a 和 b 随 week 的变化趋势' })
    const initial = await waitForSnapshot(h, created.json.taskId, (task) => task.state === 'PRESENT')
    const plan = initial.plans[0]
    const source = `${plan.code.python}\n# user-approved edit`
    const preview = await postJson(h, `/api/tasks/${initial.taskId}/source/preview`, {
      planId: plan.plan_id, engine: 'python', parentVersion: initial.currentRevision, source
    })
    assert.equal(preview.res.status, 200, JSON.stringify(preview.json))
    assert.equal(preview.json.preview.mode, 'code')
    assert.ok(preview.json.preview.sourceMap.length > 0)

    const applied = await postJson(h, `/api/tasks/${initial.taskId}/source/apply`, { token: preview.json.preview.token })
    assert.equal(applied.res.status, 503, JSON.stringify(applied.json))
    assert.equal(applied.json.error.code, 'STRONG_SANDBOX_REQUIRED')
    const after = await waitForSnapshot(h, initial.taskId, (task) => task.state === 'PRESENT')
    assert.equal(after.currentRevision, initial.currentRevision)
  } finally {
    await h.close()
    if (previousSandbox === undefined) delete process.env.DEEP_IMAGING_SANDBOX
    else process.env.DEEP_IMAGING_SANDBOX = previousSandbox
  }
})
