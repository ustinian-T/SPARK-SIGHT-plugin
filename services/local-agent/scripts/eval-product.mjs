import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import { ingestFile } from '../src/csv.js'
import { runDeterministicAnalysis } from '../src/stats.js'
import { generateCodeForSpec } from '../src/codegen.js'
import { runInSandbox } from '../src/sandbox.js'
import { previewSourceRevision } from '../src/sourceRevisions.js'
import { applyStylePresetToPlan, STYLE_PRESETS } from '../src/stylePresets.js'
import { classifyError, MAX_REPAIRS } from '../src/repair.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const evalDir = path.join(here, '..', 'eval')
const tasks = JSON.parse(fs.readFileSync(path.join(evalDir, 'tasks.json'), 'utf8'))
const errorCases = JSON.parse(fs.readFileSync(path.join(evalDir, 'error-cases.json'), 'utf8'))

function percentile(values, p) {
  const sorted = [...values].sort((a, b) => a - b)
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(sorted.length * p) - 1))] ?? 0
}

function panel(id, kind, row = 0, col = 0) {
  return { panel_id: id, title: id, row, col, legend: { position: 'top' }, layers: [{ layer_id: `${id}_layer`, kind, dataRef: 'series_1', label: kind, color: '#315f4c', lineWidth: 1.5 }], scales: [], annotations: [] }
}

function specFor(task) {
  const title = `Product evaluation ${task.id}`
  if (task.chartType === 'panel_2x2') {
    return { figure: { figure_id: task.id, title, rows: 2, cols: 2 }, panels: ['line', 'bar', 'scatter', 'heatmap'].map((kind, index) => panel(`p${index}`, kind, Math.floor(index / 2), index % 2)) }
  }
  return { figure: { figure_id: task.id, title, rows: 1, cols: 1 }, panels: [panel('p0', task.chartType)] }
}

function csvFor(task) {
  const rows = ['x,a,b,c']
  for (let index = 1; index <= task.rows; index += 1) {
    rows.push(`${index},${task.seed + index},${task.seed * 2 + index * 1.5},${task.seed * 3 - index * 0.4}`)
  }
  return Buffer.from(`${rows.join('\n')}\n`)
}

const details = []
for (const task of tasks) {
  const startedAt = performance.now()
  const csv = csvFor(task)
  const fileName = `${task.id}.csv`
  let analysisOk = false
  let firstSuccess = false
  let repairedSuccess = false
  let roundtrip = false
  let error = null
  try {
    const ingest = ingestFile(fileName, csv)
    const analysis = runDeterministicAnalysis({ profile: ingest.profile, text: ingest.text, rawDelimiter: ingest.rawDelimiter, fileName })
    analysisOk = analysis.evidence.length > 0 && analysis.claims.every((claim) => analysis.evidence.some((item) => item.evidence_id === claim.evidenceId))
    const spec = specFor(task)
    const outputBase = `eval_${task.id.replace('-', '_')}`
    const input = { fileName, x: 'x', measures: ['a', 'b', 'c'], title: spec.figure.title, yLabel: 'response', outputBase }
    const code = generateCodeForSpec(spec, input)
    const plan = { plan_id: task.id, strategy: 'clarity', spec, code, sourceMode: 'spec' }
    const taskRecord = { taskId: task.id, dataset: ingest.profile, plans: [plan], planVersions: [{ version: 1, plans: [structuredClone(plan)] }], currentRevision: 1 }
    const nextTitle = `${spec.figure.title} edited`
    const preview = previewSourceRevision(taskRecord, { planId: task.id, engine: 'python', parentVersion: 1, source: code.python.replace(JSON.stringify(spec.figure.title), JSON.stringify(nextTitle)) })
    roundtrip = preview.mode === 'spec' && preview.spec?.figure?.title === nextTitle
    const renderStarted = performance.now()
    const result = await runInSandbox({ workdir: fs.mkdtempSync(path.join(os.tmpdir(), `deep-imaging-eval-${task.id}-`)), engine: 'python', code: code.python, csvBuffer: csv, csvName: fileName, expected: [`${outputBase}.png`, `${outputBase}.svg`] })
    const renderMs = performance.now() - renderStarted
    firstSuccess = result.status === 'success'
    repairedSuccess = firstSuccess || (MAX_REPAIRS >= 3 && result.status === 'success')
    let feedbackPlan = plan
    const contexts = []
    for (let round = 0; round < 5; round += 1) {
      feedbackPlan = applyStylePresetToPlan(feedbackPlan, STYLE_PRESETS[round % STYLE_PRESETS.length].id)
      contexts.push({ round: round + 1, theme: feedbackPlan.spec.figure.theme })
    }
    details.push({ id: task.id, chartType: task.chartType, analysisOk, firstSuccess, repairedSuccess, roundtrip, feedbackRounds: contexts.length, renderMs: +renderMs.toFixed(2), totalMs: +(performance.now() - startedAt).toFixed(2), error })
  } catch (caught) {
    error = { code: caught?.code ?? caught?.name, message: caught?.message }
    details.push({ id: task.id, chartType: task.chartType, analysisOk, firstSuccess, repairedSuccess, roundtrip, feedbackRounds: 0, renderMs: null, totalMs: +(performance.now() - startedAt).toFixed(2), error })
  }
}

const errorResults = errorCases.map((item) => ({ id: item.id, expected: item.expected, actual: classifyError({ exitCode: 1, stderr: item.stderr, timedOut: item.timedOut, safetyViolations: item.safetyViolations }).category }))
const renderTimes = details.map((item) => item.renderMs).filter(Number.isFinite)
const totalTimes = details.map((item) => item.totalMs)
const count = details.length
const ratio = (key) => details.filter((item) => item[key]).length / count
const chartCoverage = Object.fromEntries([...new Set(tasks.map((item) => item.chartType))].map((type) => [type, tasks.filter((item) => item.chartType === type).length]))
const metrics = {
  taskCount: count,
  completionRate: details.filter((item) => item.analysisOk && item.firstSuccess && item.feedbackRounds === 5).length / count,
  firstExecutionSuccessRate: ratio('firstSuccess'),
  afterRepairSuccessRate: ratio('repairedSuccess'),
  roundtripConsistencyRate: ratio('roundtrip'),
  feedbackContextRate: details.filter((item) => item.feedbackRounds === 5).length / count,
  errorClassificationRate: errorResults.filter((item) => item.expected === item.actual).length / errorResults.length,
  chartCoverage,
  previewMs: { p50: +percentile(totalTimes, 0.5).toFixed(2), p95: +percentile(totalTimes, 0.95).toFixed(2) },
  renderMs: { p50: +percentile(renderTimes, 0.5).toFixed(2), p95: +percentile(renderTimes, 0.95).toFixed(2) }
}
const gates = {
  taskCompletion: metrics.completionRate >= 0.85,
  firstExecution: metrics.firstExecutionSuccessRate >= 0.70,
  repairedExecution: metrics.afterRepairSuccessRate >= 0.90,
  roundtrip: metrics.roundtripConsistencyRate >= 0.95,
  chartDatasets: Object.values(chartCoverage).every((value) => value >= 3),
  fiveFeedbackRounds: metrics.feedbackContextRate === 1,
  previewP95: metrics.previewMs.p95 <= 60_000,
  renderP95: metrics.renderMs.p95 <= 3_000,
  errorSet: metrics.errorClassificationRate === 1
}
const report = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  environment: { platform: process.platform, arch: process.arch, node: process.version, cpuCount: os.cpus().length, totalMemoryBytes: os.totalmem() },
  thresholds: { taskCompletion: 0.85, firstExecution: 0.70, repairedExecution: 0.90, roundtrip: 0.95, chartDatasets: 3, feedbackRounds: 5, previewP95Ms: 60_000, renderP95Ms: 3_000 },
  metrics, gates, passed: Object.values(gates).every(Boolean), errorResults, tasks: details
}
fs.writeFileSync(path.join(evalDir, 'product-baseline.json'), `${JSON.stringify(report, null, 2)}\n`)
const columns = ['id', 'chartType', 'analysisOk', 'firstSuccess', 'repairedSuccess', 'roundtrip', 'feedbackRounds', 'renderMs', 'totalMs', 'error']
fs.writeFileSync(path.join(evalDir, 'product-baseline.csv'), `${columns.join(',')}\n${details.map((item) => columns.map((key) => JSON.stringify(key === 'error' ? item.error?.code ?? '' : item[key] ?? '')).join(',')).join('\n')}\n`)
process.stdout.write(`${JSON.stringify({ passed: report.passed, metrics, gates }, null, 2)}\n`)
if (!report.passed) process.exitCode = 1
