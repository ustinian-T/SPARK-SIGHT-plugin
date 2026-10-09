import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ingestFile } from '../src/csv.js'
import { buildSemanticModel } from '../src/semanticModel.js'
import { runDeterministicAnalysis } from '../src/stats.js'
import { buildPlans } from '../src/plans.js'
import { runInSandbox } from '../src/sandbox.js'
import { probePython, probeR } from '../src/engines.js'
import { parseIntent } from '../src/intent.js'

const csv = Buffer.from('group,sample,value\n对照组,1,2\n对照组,2,3\n对照组,3,4\n处理组,1,4\n处理组,2,5\n处理组,3,6\n')
const input = ingestFile('data.csv', csv)
const semanticModel = buildSemanticModel(input.profile, input.text, input.rawDelimiter)
const analysis = runDeterministicAnalysis({ ...input, fileName: 'data.csv', semanticModel })
const plans = buildPlans(analysis, { fileName: 'data.csv', titleBase: '处理组效果比较', userRequest: '分组柱状图 + 误差棒，均值±标准差；纵轴名称：测量值' })

test('Display axis titles are not missing data-field references', () => {
  assert.deepEqual(parseIntent('分组柱状图，纵轴名称：测量值，横轴标题：处理组', input.profile).missingFields, [])
  assert.ok(parseIntent('纵轴为 nonexistent', input.profile).missingFields.includes('nonexistent'))
})

test('No LLM: repeated sample IDs never become measurements or paired subjects', () => {
  assert.deepEqual(semanticModel.fieldRoles.measure, ['value'])
  assert.deepEqual(semanticModel.fieldRoles.replicate, ['sample'])
  assert.deepEqual(semanticModel.fieldRoles.subject, [])
  assert.deepEqual(analysis.summary.series.map(s => s.label), ['value'])
  assert.deepEqual(analysis.summary.groups.series.map(s => [s.n, s.y, s.sd]), [[3, 3, 1], [3, 5, 1]])
})

test('No LLM: all three variants honor explicit bar and SD errors', () => {
  assert.equal(plans.length, 3)
  for (const plan of plans) {
    assert.ok(plan.series.every(s => Array.isArray(s.y) && Array.isArray(s.yerr)))
    assert.ok(plan.spec.panels.every(p => p.layers.every(l => l.kind === 'bar')))
    assert.equal(plan.spec.panels[0].errorBarMode, 'sd')
    assert.equal(plan.spec.panels[0].groups.measure, 'value')
    assert.match(plan.code.python, /yerr=grouped\["std"\]/)
    assert.doesNotMatch(plan.code.python, /df\["sample"\]/)
    assert.match(plan.code.r, /geom_col|barplot/)
  }
})

test('Identifier recognition does not swallow sample_size or sample_weight measures', () => {
  const i = ingestFile('wide.csv', Buffer.from('group,sample_size,response\na,3,1\nb,4,2\n'))
  const m = buildSemanticModel(i.profile, i.text, i.rawDelimiter)
  assert.ok(m.fieldRoles.measure.includes('sample_size'))
})

for (const engine of ['python', 'r']) test(`Real ${engine}: Chinese grouped bar SVG/PNG from the shipped font`, { timeout: 240000 }, async t => {
  const probe = engine === 'python' ? probePython() : probeR()
  if (!probe.available || (engine === 'python' && !probe.dependencies?.pandas)) return t.skip('Interpreter dependencies unavailable')
  for (const plan of plans) {
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-plot-quality-'))
    try {
      const code = engine === 'python' ? plan.code.python.replace('def _setup_cjk_font():',
        'def _setup_cjk_font():\n    _fm.fontManager.ttflist = [f for f in _fm.fontManager.ttflist if f.name.startswith("DejaVu")]') : plan.code.r
      const result = await runInSandbox({ workdir, engine, code, csvBuffer: csv, csvName: 'data.csv',
        expected: [`${plan.plan_id}.svg`, `${plan.plan_id}.png`], timeoutMs: 90000 })
      assert.equal(result.status, 'success', JSON.stringify({ stderr: result.stderr, violations: result.safetyViolations }))
      assert.doesNotMatch(`${result.stdout}\n${result.stderr}`, /CJK_FONT_|Glyph .*missing from font/)
      const svg = result.artifacts.find(a => a.name.endsWith('.svg')).svg
      if (engine === 'python') assert.match(svg, /NotoSansCJKsc-Regular/)
      assert.ok(result.artifacts.find(a => a.name.endsWith('.png')).png.width >= 900)
      if (process.env.DEEP_IMAGING_QA_OUTPUT) {
        fs.mkdirSync(process.env.DEEP_IMAGING_QA_OUTPUT, { recursive: true })
        fs.copyFileSync(path.join(workdir, `${plan.plan_id}.png`), path.join(process.env.DEEP_IMAGING_QA_OUTPUT, `${engine}_${plan.plan_id}.png`))
      }
    } finally {
      if (!process.env.DEEP_IMAGING_QA_KEEP) fs.rmSync(workdir, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 })
    }
  }
})
