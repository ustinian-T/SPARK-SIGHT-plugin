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
import { parseIntent, validateFieldSlots } from '../src/intent.js'

const csv = Buffer.from('group,sample,value\n对照组,1,2\n对照组,2,3\n对照组,3,4\n处理组,1,4\n处理组,2,5\n处理组,3,6\n')
const input = ingestFile('data.csv', csv)
const semanticModel = buildSemanticModel(input.profile, input.text, input.rawDelimiter)
const analysis = runDeterministicAnalysis({ ...input, fileName: 'data.csv', semanticModel })
const plans = buildPlans(analysis, { fileName: 'data.csv', titleBase: '处理组效果比较', userRequest: '分组柱状图 + 误差棒，均值±标准差；纵轴名称：测量值' })

test('Display axis titles are not missing data-field references', () => {
  assert.deepEqual(parseIntent('分组柱状图，纵轴名称：测量值，横轴标题：处理组', input.profile).missingFields, [])
  assert.ok(parseIntent('纵轴为 nonexistent', input.profile).missingFields.includes('nonexistent'))
  const natural = parseIntent('请把纵坐标希望分组，并展示各时间点趋势', input.profile)
  assert.deepEqual(natural.missingFields, [])
  assert.equal(natural.variables.includes('希望分组'), false)
  assert.ok(natural.axisHints.some((h) => h.intent === '希望分组'))
})

test('TaskSpec 字段槽位必须绑定真实列并满足类型约束', () => {
  const i = ingestFile('语义.csv', Buffer.from('周次,实验组别,响应指标\n第1周,对照组,2\n第2周,处理组,4\n'))
  const m = buildSemanticModel(i.profile, i.text, i.rawDelimiter)
  const valid = validateFieldSlots({ fieldSlots: { xField: '周次', yField: '响应指标', groupField: '实验组别' }, goal: '趋势折线图' }, i.profile, m)
  assert.equal(valid.ok, true)
  const invalid = validateFieldSlots({ fieldSlots: { xField: '不存在', yField: '实验组别' }, goal: '趋势折线图' }, i.profile, m)
  assert.equal(invalid.ok, false)
  assert.ok(invalid.errors.some((e) => e.code === 'UNKNOWN_FIELD'))
  assert.ok(invalid.errors.some((e) => e.code === 'NON_NUMERIC_Y'))
})

test('Chinese compound group and sample identifiers receive safe roles', () => {
  const i = ingestFile('实验.csv', Buffer.from('样本编号,时间,实验组别,重复编号,响应指标\nS01,1,对照组,1,2\nS02,2,处理组,1,4\n'))
  const m = buildSemanticModel(i.profile, i.text, i.rawDelimiter)
  assert.deepEqual(m.fieldRoles.id, ['样本编号'])
  assert.deepEqual(m.fieldRoles.xTime, ['时间'])
  assert.deepEqual(m.fieldRoles.group, ['实验组别'])
  assert.deepEqual(m.fieldRoles.replicate, ['重复编号'])
  assert.deepEqual(m.fieldRoles.measure, ['响应指标'])
})

test('Identifier and replicate columns are excluded from correlation tests', () => {
  const i = ingestFile('实验.csv', Buffer.from('样本编号,重复编号,响应指标,表达水平\n1,1,2,5\n2,2,4,6\n3,3,6,7\n'))
  const m = buildSemanticModel(i.profile, i.text, i.rawDelimiter)
  const a = runDeterministicAnalysis({ ...i, fileName: '实验.csv', semanticModel: m })
  const corrFields = a.evidence.filter(e => e.tool === 'stats.correlation').flatMap(e => e.fields)
  assert.ok(corrFields.every(field => ['响应指标', '表达水平'].includes(field)))
  assert.equal(corrFields.includes('样本编号'), false)
  assert.equal(corrFields.includes('重复编号'), false)
})

test('Time × group data are aggregated before plotting', () => {
  const csv = Buffer.from('样本编号,时间,实验组别,重复编号,响应指标\nS01,第1周,对照组,1,2\nS02,第1周,对照组,2,4\nS03,第1周,处理组,1,5\nS04,第2周,对照组,1,6\nS05,第2周,对照组,2,8\nS06,第2周,处理组,1,10\n')
  const i = ingestFile('time-group.csv', csv)
  const m = buildSemanticModel(i.profile, i.text, i.rawDelimiter)
  const a = runDeterministicAnalysis({ ...i, fileName: 'time-group.csv', semanticModel: m })
  assert.equal(a.summary.timeGrouped, true)
  assert.deepEqual(a.summary.x, ['第1周', '第2周'])
  assert.equal(a.summary.series.length, 2)
  assert.deepEqual(a.summary.series[0].y, [3, 7])
  assert.deepEqual(a.summary.series[0].n, [2, 2])
  assert.ok(a.processingTrace.operations.some(op => op.id === 'time_group_aggregate'))
})

test('科研演示数据默认优先选择响应指标，不把温湿度当作主图纵轴', () => {
  const i = ingestFile('科研演示.csv', Buffer.from('样本编号,时间,实验组别,重复编号,温度,湿度,响应指标,表达水平,存活率\nS01,第1周,对照组,1,23,50,68,1.0,89\nS02,第1周,对照组,2,24,51,70,1.1,90\nS03,第1周,处理组,1,25,52,78,1.3,92\nS04,第2周,对照组,1,23,51,72,1.1,90\nS05,第2周,对照组,2,24,52,74,1.2,91\nS06,第2周,处理组,1,25,53,82,1.4,93\n'))
  const m = buildSemanticModel(i.profile, i.text, i.rawDelimiter)
  const a = runDeterministicAnalysis({ ...i, fileName: '科研演示.csv', semanticModel: m })
  assert.equal(a.summary.measureLabel, '响应指标')
  assert.equal(a.processingTrace.operations.find(op => op.id === 'time_group_aggregate').measure, '响应指标')
})

test('显式字段槽位的时间×分组图真实出图不把组值误当列名', async () => {
  const i = ingestFile('time-group-explicit.csv', Buffer.from('时间,实验组别,响应指标\n第1周,对照组,2\n第1周,处理组,5\n第2周,对照组,4\n第2周,处理组,8\n'))
  const m = buildSemanticModel(i.profile, i.text, i.rawDelimiter)
  const a = runDeterministicAnalysis({ ...i, fileName: 'time-group-explicit.csv', semanticModel: m })
  const [plan] = buildPlans(a, {
    fileName: 'time-group-explicit.csv',
    titleBase: '响应指标趋势',
    engine: 'python',
    userRequest: '横轴为时间，纵轴为响应指标，按实验组别分组，折线图加标准误差棒',
    clarification: { chartType: 'line' },
    taskSpec: { fieldSlots: { xField: '时间', yField: '响应指标', groupField: '实验组别' }, pendingFields: [] }
  })
  const result = await runInSandbox({
    workdir: fs.mkdtempSync(path.join(os.tmpdir(), 'deep-imaging-explicit-')),
    engine: 'python',
    code: plan.code.python,
    csvBuffer: i.text,
    csvName: 'time-group-explicit.csv',
    expected: [`${plan.plan_id}.png`, `${plan.plan_id}.svg`]
  })
  assert.equal(result.status, 'success', result.stderr)
  assert.equal(plan.dataProcessingTrace.plottedFields.measures[0], '响应指标')
    assert.match(plan.code.python, /groupby\(\["时间", "实验组别"\], sort=False\)/)
  assert.doesNotMatch(plan.code.python, /df\[['"]对照组['"]\]/)
})

test('高级图型约束使用真实数值指标数与空间诊断，不把组数冒充三维/双轴输入', () => {
  const i = ingestFile('空间.csv', Buffer.from('x坐标,y坐标,z坐标,实验组别,响应指标\n0,0,1,对照组,2\n1,0,2,处理组,3\n0,1,3,对照组,4\n1,1,4,处理组,5\n2,0,5,对照组,6\n0,2,6,处理组,7\n2,1,7,对照组,8\n1,2,8,处理组,9\n2,2,9,对照组,10\n'))
  const m = buildSemanticModel(i.profile, i.text, i.rawDelimiter)
  const a = runDeterministicAnalysis({ ...i, fileName: '空间.csv', semanticModel: m })
  assert.equal(a.chartContext.numericMeasureCount, 4)
  assert.equal(a.chartContext.spatialReady, true)
  assert.equal(a.chartContext.spatialDiagnostics.varied, true)
  const oneMeasure = ingestFile('分组.csv', Buffer.from('时间,实验组别,响应指标\n第1周,对照组,2\n第1周,处理组,3\n第2周,对照组,4\n第2周,处理组,5\n'))
  const oneAnalysis = runDeterministicAnalysis({ ...oneMeasure, fileName: '分组.csv', semanticModel: buildSemanticModel(oneMeasure.profile, oneMeasure.text, oneMeasure.rawDelimiter) })
  assert.equal(oneAnalysis.chartContext.numericMeasureCount, 1)
  assert.equal(oneAnalysis.chartContext.spatialReady, false)
})

test('Unit metadata is inferred from explicit field suffixes', () => {
  const i = ingestFile('units.csv', Buffer.from('时间,温度/℃,成本/元\n1,20,10\n2,21,11\n'))
  const m = buildSemanticModel(i.profile, i.text, i.rawDelimiter)
  assert.equal(m.units['温度/℃'].original, '℃')
  assert.equal(m.units['成本/元'].original, '元')
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
      // Windows may retain R font handles briefly; asynchronous retries let
      // pending handle-close callbacks finish instead of blocking the event loop.
      if (!process.env.DEEP_IMAGING_QA_KEEP) await fs.promises.rm(workdir, { recursive: true, force: true, maxRetries: 25, retryDelay: 200 })
    }
  }
})
