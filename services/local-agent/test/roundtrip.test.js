import test from 'node:test'
import assert from 'node:assert/strict'
import { generateCodeForSpec } from '../src/codegen.js'
import { previewSourceRevision } from '../src/sourceRevisions.js'

function plan(index) {
  const title = `Roundtrip ${index}`
  const spec = { figure: { figure_id: `f${index}`, title, rows: 1, cols: 1 }, panels: [{ panel_id: 'p0', title: 'Panel', row: 0, col: 0, layers: [{ layer_id: 'l0', kind: 'line', dataRef: 'series_1', label: 'a', color: '#315f4c' }], scales: [], annotations: [] }] }
  const code = generateCodeForSpec(spec, { fileName: 'data.csv', x: 'x', measures: ['a', 'b'], title, yLabel: 'value', outputBase: `rt_${index}` })
  return { plan_id: `plan_${index}`, strategy: 'clarity', spec, code }
}

test('100 supported code-to-spec title edits maintain at least 95% roundtrip consistency', () => {
  let consistent = 0
  for (let index = 0; index < 100; index += 1) {
    const item = plan(index)
    const task = { taskId: `task_${index}`, dataset: { fingerprint: `fp_${index}` }, plans: [item], planVersions: [{ version: 1, plans: [structuredClone(item)] }], currentRevision: 1 }
    const next = `${item.spec.figure.title} edited`
    const preview = previewSourceRevision(task, { planId: item.plan_id, engine: 'python', parentVersion: 1, source: item.code.python.replace(JSON.stringify(item.spec.figure.title), JSON.stringify(next)) })
    if (preview.mode === 'spec' && preview.spec?.figure?.title === next) consistent += 1
  }
  assert.ok(consistent / 100 >= 0.95, `roundtrip consistency was ${consistent}%`)
})
