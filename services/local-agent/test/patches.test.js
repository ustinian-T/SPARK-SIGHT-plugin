import test from 'node:test'
import assert from 'node:assert/strict'
import { previewPatch, applyPatch, restoreVersion, revertPatch } from '../src/patches.js'
import { createTask, postJson, startTestServer, waitForSnapshot } from './helpers.js'

const SAMPLE = `week,a,b\n1,10,12\n2,13,15\n3,17,18\n4,20,23\n`

function fixture() {
  const plans = [{
    plan_id: 'plan_clarity',
    spec: {
      figure: { title: 'Original', rows: 1, cols: 2 },
      panels: [
        { id: 'panel_1', kind: 'line', legend: { position: 'right' }, x: 'week', y: ['a'] },
        { id: 'panel_2', kind: 'bar', legend: { position: 'bottom' }, x: 'week', y: ['b'] }
      ]
    }
  }]
  return {
    taskId: 'task_patch',
    dataset: { fingerprint: 'fp_123' },
    plans: structuredClone(plans),
    planVersions: [{ version: 1, reason: 'initial', plans: structuredClone(plans) }],
    currentRevision: 1
  }
}

test('preview and apply a panel patch without changing sibling panels', async () => {
  const task = fixture()
  const siblingBefore = JSON.stringify(task.plans[0].spec.panels[1])
  const preview = previewPatch(task, {
    planId: 'plan_clarity', parentVersion: 1, targetKind: 'panel', targetId: 'panel_1',
    path: 'legend.position', before: 'right', after: 'top'
  })
  assert.equal(task.plans[0].spec.panels[0].legend.position, 'right', 'preview must not mutate the task')

  const revision = await applyPatch(task, preview.token, async (plan) => ({ ...plan, executionStatus: 'verified' }))
  assert.equal(revision.parent, 1)
  assert.equal(revision.reason, 'patch')
  assert.equal(revision.plans[0].spec.panels[0].legend.position, 'top')
  assert.equal(JSON.stringify(revision.plans[0].spec.panels[1]), siblingBefore)
})

test('rejects stale preview tokens after a newer revision exists', async () => {
  const task = fixture()
  const preview = previewPatch(task, {
    planId: 'plan_clarity', parentVersion: 1, targetKind: 'figure', targetId: 'figure',
    path: 'title', before: 'Original', after: 'New title'
  })
  task.planVersions.push({ version: 2, parent: 1, reason: 'feedback', plans: structuredClone(task.plans) })
  task.currentRevision = 2
  await assert.rejects(() => applyPatch(task, preview.token, async (plan) => plan), { code: 'PATCH_STALE' })
})

test('revert and restore move the current pointer without deleting history', () => {
  const task = fixture()
  task.planVersions.push({ version: 2, parent: 1, reason: 'patch', plans: structuredClone(task.plans) })
  task.currentRevision = 2
  const reverted = revertPatch(task)
  assert.equal(reverted.version, 1)
  assert.equal(task.planVersions.length, 2)
  const restored = restoreVersion(task, 2)
  assert.equal(restored.version, 2)
  assert.equal(task.planVersions.length, 2)
})

test('nested layer paths navigate ChartSpec arrays by stable ids', async () => {
  const task = fixture()
  task.plans[0].spec.panels[0] = {
    panel_id: 'panel_1',
    layers: [{ layer_id: 'layer_a', color: '#111111' }, { layer_id: 'layer_b', color: '#222222' }]
  }
  task.planVersions[0].plans = structuredClone(task.plans)
  const preview = previewPatch(task, {
    planId: 'plan_clarity', parentVersion: 1, targetKind: 'panel', targetId: 'panel_1',
    path: 'layers.layer_a.color', before: '#111111', after: '#C0392B'
  })
  const revision = await applyPatch(task, preview.token, async (plan) => plan)
  assert.equal(revision.plans[0].spec.panels[0].layers[0].color, '#C0392B')
  assert.equal(revision.plans[0].spec.panels[0].layers[1].color, '#222222')
})

test('HTTP patch preview applies through real sandbox verification and stale tokens fail', async () => {
  const h = await startTestServer()
  try {
    const created = await createTask(h, { csv: SAMPLE, prompt: '比较 a 和 b 随 week 的变化趋势' })
    assert.equal(created.res.status, 201)
    const initial = await waitForSnapshot(h, created.json.taskId, (task) => task.state === 'PRESENT')
    const plan = initial.plans[0]
    const originalTitle = plan.spec.figure.title
    const desiredTitle = '已验证的补丁标题'
    const preview = await postJson(h, `/api/tasks/${initial.taskId}/patches/preview`, {
      planId: plan.plan_id,
      parentVersion: initial.currentRevision,
      targetKind: 'figure',
      targetId: 'figure',
      path: 'title',
      before: originalTitle,
      after: desiredTitle
    })
    assert.equal(preview.res.status, 200)
    assert.equal(preview.json.preview.spec.figure.title, desiredTitle)

    const applied = await postJson(h, `/api/tasks/${initial.taskId}/patches/apply`, { token: preview.json.preview.token })
    assert.equal(applied.res.status, 200, JSON.stringify(applied.json))
    assert.equal(applied.json.revision.reason, 'patch')
    assert.equal(applied.json.revision.plans.find((item) => item.plan_id === plan.plan_id).executionStatus, 'verified')
    const after = await waitForSnapshot(h, initial.taskId, (task) => task.state === 'PRESENT' && task.currentRevision === applied.json.revision.version)
    assert.equal(after.plans.find((item) => item.plan_id === plan.plan_id).spec.figure.title, desiredTitle)

    const stalePreview = await postJson(h, `/api/tasks/${initial.taskId}/patches/preview`, {
      planId: plan.plan_id,
      parentVersion: after.currentRevision,
      targetKind: 'figure', targetId: 'figure', path: 'title', before: desiredTitle, after: 'stale'
    })
    const restored = await postJson(h, `/api/tasks/${initial.taskId}/patches/restore`, { version: initial.currentRevision })
    assert.equal(restored.res.status, 200)
    const staleApply = await postJson(h, `/api/tasks/${initial.taskId}/patches/apply`, { token: stalePreview.json.preview.token })
    assert.equal(staleApply.res.status, 409)
    assert.equal(staleApply.json.error.code, 'PATCH_STALE')
  } finally {
    await h.close()
  }
})
