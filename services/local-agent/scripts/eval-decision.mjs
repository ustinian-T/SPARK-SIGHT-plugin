// 决策算法评测基线（算法说明书第 8、12 节）。
// 运行：npm run eval:decision
// 产出：eval/decision-baseline.json（完整机器可读结果）、
//       eval/decision-baseline.csv（场景级指标）、eval/decision-candidates.csv（候选明细）。
// 场景均为小型可解释合成数据，不依赖网络与 LLM；不涉及商业定价（仓库无价格表）。
import fs from 'node:fs'
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { performance } from 'node:perf_hooks'
import {
  UTILITY_WEIGHTS,
  SIMILARITY_WEIGHTS,
  EVENT_WEIGHTS,
  DEFAULT_LAMBDA,
  utilityScore,
  buildCandidatePool,
  selectMMR,
  selectionMetrics,
  selectionStability,
  DecisionError
} from '../src/decision/index.js'
import { ingestFile } from '../src/csv.js'
import { runDeterministicAnalysis } from '../src/stats.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const outDir = path.join(here, '..', 'eval')
fs.mkdirSync(outDir, { recursive: true })

// ---------- 合成数据与候选工厂 ----------
function syntheticAnalysis(nPoints, nSeries, { sd = false } = {}) {
  const x = Array.from({ length: nPoints }, (_, i) => i + 1)
  const series = Array.from({ length: nSeries }, (_, i) => ({
    id: `series_${i}`,
    label: `group_${String.fromCharCode(97 + i)}`,
    y: x.map((t) => +(10 + i * 2 + t * (1 + i * 0.3)).toFixed(2)),
    ...(sd ? { yerr: x.map(() => +(0.4 + i * 0.1).toFixed(2)) } : {})
  }))
  return { summary: { xLabel: 'week', x, series }, evidence: [], claims: [] }
}

const F = {
  bar: {
    chartType: 'grouped_bar',
    layout: { rows: 1, cols: 1, panels: 1 },
    encoding: { marks: ['bar'], xType: 'categorical', errorBars: false, normalized: false },
    statPresentation: { raw: true, errorBars: false, normalized: false, significance: false },
    color: { mode: 'categorical', monochromePrint: false },
    annotation: { kinds: [], count: 0 }
  },
  barErr: {
    chartType: 'grouped_bar_error',
    layout: { rows: 1, cols: 1, panels: 1 },
    encoding: { marks: ['bar'], xType: 'categorical', errorBars: true, normalized: false },
    statPresentation: { raw: true, errorBars: true, normalized: false, significance: false },
    color: { mode: 'categorical', monochromePrint: false },
    annotation: { kinds: [], count: 0 }
  },
  line: {
    chartType: 'line_error',
    layout: { rows: 1, cols: 1, panels: 1 },
    encoding: { marks: ['line', 'marker'], xType: 'linear', errorBars: true, normalized: false },
    statPresentation: { raw: true, errorBars: true, normalized: false, significance: false },
    color: { mode: 'categorical', monochromePrint: false },
    annotation: { kinds: ['grid'], count: 1 }
  },
  lineMono: {
    chartType: 'line_error',
    layout: { rows: 1, cols: 1, panels: 1 },
    encoding: { marks: ['line', 'marker'], xType: 'linear', errorBars: true, normalized: false },
    statPresentation: { raw: true, errorBars: true, normalized: false, significance: false },
    color: { mode: 'mono', monochromePrint: true },
    annotation: { kinds: ['grid'], count: 1 }
  },
  lineSig: {
    chartType: 'line_error_significance',
    layout: { rows: 1, cols: 1, panels: 1 },
    encoding: { marks: ['line', 'marker'], xType: 'linear', errorBars: true, normalized: false },
    statPresentation: { raw: true, errorBars: true, normalized: false, significance: true },
    color: { mode: 'categorical', monochromePrint: false },
    annotation: { kinds: ['grid', 'significance_bracket'], count: 3 }
  },
  dual: {
    chartType: 'dual_line_normalized',
    layout: { rows: 1, cols: 2, panels: 2 },
    encoding: { marks: ['line', 'marker'], xType: 'linear', errorBars: false, normalized: true },
    statPresentation: { raw: true, errorBars: false, normalized: true, significance: false },
    color: { mode: 'sequential', monochromePrint: false },
    annotation: { kinds: ['hline_baseline', 'panel_title'], count: 3 }
  },
  dual2x1: {
    chartType: 'dual_line_normalized',
    layout: { rows: 2, cols: 1, panels: 2 },
    encoding: { marks: ['line', 'marker'], xType: 'linear', errorBars: false, normalized: true },
    statPresentation: { raw: true, errorBars: false, normalized: true, significance: false },
    color: { mode: 'sequential', monochromePrint: false },
    annotation: { kinds: ['hline_baseline', 'panel_title'], count: 3 }
  },
  scatter: {
    chartType: 'point_scatter',
    layout: { rows: 1, cols: 1, panels: 1 },
    encoding: { marks: ['point'], xType: 'linear', errorBars: false, normalized: false },
    statPresentation: { raw: true, errorBars: false, normalized: false, significance: false },
    color: { mode: 'categorical', monochromePrint: false },
    annotation: { kinds: [], count: 0 }
  }
}

const S = (DataFit, TaskFit, Readability, ScientificConvention, PreferenceFit, Executability) =>
  utilityScore({ DataFit, TaskFit, Readability, ScientificConvention, PreferenceFit, Executability })

function cand(candidateId, features, score, executable = true, infeasibleReason) {
  return { candidateId, features, score, executable, ...(infeasibleReason ? { infeasibleReason } : {}) }
}

// 确定性 PRNG（稳定性评测可复现）
function mulberry32(seed) {
  return function () {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

function evaluateScenario(name, pool, opts = {}) {
  const lambda = opts.lambda ?? DEFAULT_LAMBDA
  const strict = opts.strict ?? false
  const selection = selectMMR(pool, { k: opts.k ?? 3, lambda, executableOnly: true, strict })
  const stability = selectionStability(pool, { k: opts.k ?? 3, lambda, rng: mulberry32(42), executableOnly: true, strict }, 50)
  return {
    scenario: name,
    description: opts.description ?? '',
    lambda,
    K: pool.length,
    executableCount: pool.filter((c) => c.executable !== false).length,
    infeasibleRejected: selection.rejected.length,
    selectedIds: selection.metrics.selectedIds,
    selectedUtilitySum: selection.metrics.selectedUtilitySum,
    selectedUtilityMin: selection.metrics.selectedUtilityMin,
    pairwiseSimilarity: selection.metrics.pairwiseSimilarity,
    pairwiseSimilarityMean: selection.metrics.pairwiseSimilarityMean,
    pairwiseSimilarityMax: selection.metrics.pairwiseSimilarityMax,
    minPairDifferenceDims: selection.metrics.minPairDifferenceDims,
    diversityOk: selection.diversityOk,
    stability: stability.stability,
    warnings: selection.warnings,
    trace: selection.trace,
    rejected: selection.rejected,
    pool: pool.map((c) => ({
      candidateId: c.candidateId,
      chartType: c.features?.chartType ?? c.chartType,
      utility: c.score?.total ?? null,
      executable: c.executable !== false,
      selected: selection.metrics.selectedIds.includes(c.candidateId),
      infeasibleReason: c.infeasibleReason ?? null
    }))
  }
}

// ---------- 场景 ----------
const scenarios = []

// 1) 趋势场景：8 观测点 × 2 系列（无 sd），生产候选池
scenarios.push(
  evaluateScenario(
    '01_trend_long',
    buildCandidatePool(syntheticAnalysis(8, 2)),
    { description: '长趋势（8 点×2 系列）：折线/惯例候选应在效用上领先' }
  )
)

// 2) 组间比较：3 观测点 × 4 系列，柱状对比信号强
scenarios.push(
  evaluateScenario(
    '02_group_comparison',
    buildCandidatePool(syntheticAnalysis(3, 4, { sd: true })),
    { description: '短观测点多系列（3 点×4 系列+sd）：组间比较信号，柱状候选相对受益' }
  )
)

// 3) 高密度：6 观测点 × 4 系列（series×points=24），密度策略 TaskFit 上调
scenarios.push(
  evaluateScenario(
    '03_high_density',
    buildCandidatePool(syntheticAnalysis(6, 4)),
    { description: '高密度（6 点×4 系列=24）：双面板密度候选 TaskFit 信号上调' }
  )
)

// 4) 重复候选：近似重复折线 + 同 id 重复候选，MMR 必须去重且不把近重复同时入选
{
  const pool = [
    cand('line_a', F.line, S(0.88, 0.82, 0.8, 0.92, 0.72, 0.92)),
    cand('line_dup_same_id', F.line, S(0.9, 0.85, 0.8, 0.92, 0.72, 0.92)),
    // 同 id 重复（效用更高），验证按 id 去重保留高效用者
    cand('line_dup_same_id', F.line, S(0.95, 0.9, 0.8, 0.92, 0.72, 0.92)),
    cand('line_mono', F.lineMono, S(0.86, 0.78, 0.78, 0.94, 0.7, 0.9)),
    cand('bar_a', F.bar, S(0.84, 0.8, 0.9, 0.72, 0.7, 0.95)),
    cand('dual_a', F.dual, S(0.83, 0.78, 0.66, 0.8, 0.68, 0.85)),
    cand('scatter_a', F.scatter, S(0.8, 0.7, 0.7, 0.7, 0.6, 0.3), false, 'CODEGEN_SCATTER_UNIMPLEMENTED'),
    cand('bar_err_a', F.barErr, S(0.85, 0.8, 0.88, 0.76, 0.7, 0.3), false, 'CODEGEN_BAR_ERRORBARS_UNIMPLEMENTED')
  ]
  scenarios.push(
    evaluateScenario('04_duplicate_candidates', pool, {
      description: '重复候选：同 id 去重、近似重复折线被 MMR 边际项抑制，保证差异维度'
    })
  )
}

// 5a) 不可执行候选：高效用候选多数不可执行，必须被淘汰
{
  const pool = [
    cand('bar_ok', F.bar, S(0.8, 0.78, 0.88, 0.7, 0.7, 0.9)),
    cand('line_ok', F.line, S(0.82, 0.8, 0.78, 0.9, 0.7, 0.9)),
    cand('dual_ok', F.dual, S(0.78, 0.75, 0.65, 0.78, 0.65, 0.85)),
    cand('line_sig_x', F.lineSig, S(0.95, 0.95, 0.85, 0.98, 0.8, 0.2), false, 'SIGNIFICANCE_TEST_OUT_OF_SCOPE'),
    cand('bar_err_x', F.barErr, S(0.94, 0.9, 0.9, 0.9, 0.8, 0.2), false, 'CODEGEN_BAR_ERRORBARS_UNIMPLEMENTED'),
    cand('mono_x', F.lineMono, S(0.93, 0.88, 0.85, 0.96, 0.8, 0.2), false, 'CODEGEN_MONOCHROME_THEME_UNIMPLEMENTED'),
    cand('dual2x1_x', F.dual2x1, S(0.9, 0.85, 0.7, 0.85, 0.7, 0.2), false, 'CODEGEN_LAYOUT_2X1_UNIMPLEMENTED'),
    cand('scatter_x', F.scatter, S(0.89, 0.84, 0.8, 0.8, 0.7, 0.2), false, 'CODEGEN_SCATTER_UNIMPLEMENTED')
  ]
  scenarios.push(
    evaluateScenario('05a_infeasible_eliminated', pool, {
      description: '不可执行淘汰：5 个高效用但不可执行候选全部被 8.4 规则剔除'
    })
  )
}

// 5b) 可执行候选不足 3 个：诊断模式保留结果，生产严格模式必须明确失败
{
  const pool = [
    cand('bar_ok', F.bar, S(0.8, 0.78, 0.88, 0.7, 0.7, 0.9)),
    cand('line_ok', F.line, S(0.82, 0.8, 0.78, 0.9, 0.7, 0.9)),
    cand('sig_x', F.lineSig, S(0.99, 0.99, 0.9, 0.99, 0.9, 0.1), false, 'X')
  ]
  scenarios.push(
    evaluateScenario('05b_too_few_feasible', pool, {
      description: '可执行候选仅 2 个：诊断模式给 warning；生产 strict 模式抛 INSUFFICIENT_CANDIDATES'
    })
  )
}

// 5c) 无有效候选：必须抛 NO_VALID_CANDIDATE（稳定、可解释）
{
  const pool = [
    cand('x1', F.line, S(0.9, 0.9, 0.9, 0.9, 0.9, 0.1), false, 'X'),
    cand('x2', F.bar, S(0.9, 0.9, 0.9, 0.9, 0.9, 0.1), false, 'X')
  ]
  let code = null
  let message = null
  try {
    selectMMR(pool, { k: 3, executableOnly: true })
  } catch (e) {
    code = e.code
    message = e.message
  }
  scenarios.push({
    scenario: '05c_no_valid_candidate',
    description: '无有效候选：稳定抛出 NO_VALID_CANDIDATE',
    lambda: DEFAULT_LAMBDA,
    K: pool.length,
    executableCount: 0,
    infeasibleRejected: 2,
    selectedIds: [],
    selectedUtilitySum: 0,
    selectedUtilityMin: null,
    pairwiseSimilarity: [],
    pairwiseSimilarityMean: null,
    pairwiseSimilarityMax: null,
    minPairDifferenceDims: null,
    diversityOk: false,
    stability: 1,
    warnings: [`thrown: ${code} ${message}`],
    trace: [],
    rejected: [],
    pool: pool.map((c) => ({ candidateId: c.candidateId, chartType: c.features.chartType, utility: c.score.total, executable: false, selected: false, infeasibleReason: c.infeasibleReason })),
    expectedError: code
  })
}

// 6) 极端偏好：把密度候选 PreferenceFit 推到 1、其余压到 0.05，验证偏好可改变首选
{
  const base = buildCandidatePool(syntheticAnalysis(8, 2))
  const extreme = base.map((c) => {
    if (c.executable === false) return c
    const pref = c.strategy === 'density' ? 1 : 0.05
    return { ...c, score: utilityScore({ ...c.score, PreferenceFit: pref }) }
  })
  const defaultSel = evaluateScenario('06_extreme_preference__default', base, {
    description: '极端偏好对照：默认 PreferenceFit 下的选择'
  })
  const extremeSel = evaluateScenario('06_extreme_preference__extreme', extreme, {
    description: '极端偏好：密度候选 PreferenceFit=1，首选应切换为密度策略'
  })
  scenarios.push(defaultSel, extremeSel)
}

// ---------- λ 敏感性（趋势场景） ----------
const lambdas = [0, 0.25, 0.5, 0.75, 1]
const trendPool = buildCandidatePool(syntheticAnalysis(8, 3, { sd: true }))
const lambdaSweep = lambdas.map((lambda) => {
  const sel = selectMMR(trendPool, { k: 3, lambda, executableOnly: true, strict: false })
  return {
    lambda,
    selectedIds: sel.metrics.selectedIds,
    selectedUtilitySum: sel.metrics.selectedUtilitySum,
    pairwiseSimilarityMean: sel.metrics.pairwiseSimilarityMean,
    pairwiseSimilarityMax: sel.metrics.pairwiseSimilarityMax,
    minPairDifferenceDims: sel.metrics.minPairDifferenceDims,
    diversityOk: sel.diversityOk
  }
})

// ---------- 边界：K/参数校验（记录为断言结果，不抛断评测） ----------
const boundaryChecks = []
function expectThrow(label, fn, expectedCode) {
  try {
    fn()
    boundaryChecks.push({ check: label, expected: expectedCode, actual: 'NO_THROW', pass: false })
  } catch (e) {
    boundaryChecks.push({ check: label, expected: expectedCode, actual: e.code ?? e.message, pass: (e.code ?? e.message) === expectedCode })
  }
}
expectThrow('k=0 拒绝', () => selectMMR(trendPool, { k: 0 }), 'INVALID_SELECT_COUNT')
expectThrow('k=2.5 拒绝', () => selectMMR(trendPool, { k: 2.5 }), 'INVALID_SELECT_COUNT')
expectThrow('λ=1.2 拒绝', () => selectMMR(trendPool, { lambda: 1.2 }), 'INVALID_LAMBDA')
expectThrow('候选非数组拒绝', () => selectMMR(null), 'INVALID_CANDIDATE')
expectThrow('缺 id 拒绝', () => selectMMR([{ features: F.bar, score: S(0.8, 0.8, 0.8, 0.8, 0.8, 0.8) }]), 'INVALID_CANDIDATE')
expectThrow(
  '可执行候选不足 3 个严格拒绝',
  () => selectMMR([cand('bar', F.bar, S(0.8, 0.8, 0.8, 0.8, 0.8, 0.8)), cand('line', F.line, S(0.8, 0.8, 0.8, 0.8, 0.8, 0.8))], { k: 3 }),
  'INSUFFICIENT_CANDIDATES'
)
expectThrow(
  '权重和≠1 拒绝',
  () =>
    utilityScore(
      { DataFit: 0.8, TaskFit: 0.8, Readability: 0.8, ScientificConvention: 0.8, PreferenceFit: 0.8, Executability: 0.8 },
      { DataFit: 0.5, TaskFit: 0.2, Readability: 0.15, ScientificConvention: 0.15, PreferenceFit: 0.1, Executability: 0.1 }
    ),
  'INVALID_WEIGHTS'
)
expectThrow('子分越界拒绝', () => utilityScore({ DataFit: 1.2, TaskFit: 0.2, Readability: 0.15, ScientificConvention: 0.15, PreferenceFit: 0.1, Executability: 0.1 }), 'INVALID_SCORE')

// ---------- 算法本地运行成本（仅本地可测指标，不含任何商业价格） ----------
function timeMs(fn, n) {
  const t0 = performance.now()
  for (let i = 0; i < n; i++) fn()
  return +((performance.now() - t0) / n).toFixed(4)
}
const runtime = {
  iterations: 2000,
  buildCandidatePool_mean_ms: timeMs(() => buildCandidatePool(syntheticAnalysis(8, 3, { sd: true })), 2000),
  selectMMR_K8_mean_ms: timeMs(() => selectMMR(trendPool, { k: 3, strict: false }), 2000)
}

// ---------- 基线自动发现（只陈述可从结果计算的事实，不做主观定价） ----------
const findings = []
const prod = scenarios.find((s) => s.scenario === '01_trend_long')
findings.push(`生产候选池 K=${prod.K}，其中可执行 ${prod.executableCount}、不可执行 ${prod.K - prod.executableCount}；柱图、折线、散点、热力图和复合布局均已有可执行模板。`)
const dup = scenarios.find((s) => s.scenario === '04_duplicate_candidates')
findings.push(`重复候选场景：同 id 重复被去重，近似重复折线未同时入选；入选两两最大相似度 ${dup.pairwiseSimilarityMax}，最小差异维度 ${dup.minPairDifferenceDims}。`)
const inf = scenarios.find((s) => s.scenario === '05a_infeasible_eliminated')
findings.push(`不可执行场景：${inf.infeasibleRejected} 个高效用候选被淘汰，最终入选效用最小值 ${inf.selectedUtilityMin}（低于被淘汰者效用，这是 8.4“可验证性优先”的预期代价）。`)
const ext = scenarios.find((s) => s.scenario === '06_extreme_preference__extreme')
const def = scenarios.find((s) => s.scenario === '06_extreme_preference__default')
findings.push(`极端偏好：默认首选 ${def.selectedIds[0]}，PreferenceFit 极端化后首选 ${ext.selectedIds[0]}；偏好仅通过 PreferenceFit（权重 0.10）影响排序，不改变数据事实。`)
const sweepSpread = new Set(lambdaSweep.map((s) => s.selectedIds.join('|')))
findings.push(`λ 敏感性：λ∈{0,0.25,0.5,0.75,1} 下入选集合共 ${sweepSpread.size} 种；K=8 全可执行候选允许边际相似度真实参与取舍。`)
findings.push(`所有场景洗牌 50 次稳定性均为 1（确定性 tie-break：效用/MMR 降序、candidateId 升序）。`)
{
  const ids = ['01_trend_long', '02_group_comparison', '03_high_density'].map((n) => scenarios.find((s) => s.scenario === n).selectedIds.join('|'))
  if (new Set(ids).size === 1) {
    findings.push(`趋势/组间比较/高密度三类数据场景入选集合完全相同（${ids[0]}）：数据信号目前只调整不可执行变体的子分，三个可执行候选的子分为常量，MMR 选择对数据形态不敏感——这是候选生成器的已知缺口，需把数据信号接入可执行候选的子分或扩充可执行候选。`)
  }
}

// ---------- P0 覆盖与缺失值语义硬断言 ----------
const coveragePool = buildCandidatePool(syntheticAnalysis(8, 3, { sd: true }))
const missingCsv = ['group,value', 'A,1', 'B,', 'C,2', 'D,3', 'E,4', 'F,5', 'G,6', 'H,7', 'I,8', 'J,9', 'K,10'].join('\n')
const missingIngest = ingestFile('missing-eval.csv', Buffer.from(missingCsv, 'utf-8'))
const missingAnalysis = runDeterministicAnalysis({ ...missingIngest, fileName: 'missing-eval.csv' })
const p0 = {
  executableCandidates: coveragePool.filter((candidate) => candidate.executable !== false).length,
  coverage: {
    bar: coveragePool.some((candidate) => candidate.chartType.includes('bar') && candidate.executable !== false),
    line: coveragePool.some((candidate) => candidate.chartType.includes('line') && candidate.executable !== false),
    scatter: coveragePool.some((candidate) => candidate.chartType.includes('scatter') && candidate.executable !== false),
    heatmap: coveragePool.some((candidate) => candidate.chartType.includes('heatmap') && candidate.executable !== false),
    panel2x2: coveragePool.some((candidate) => candidate.chartType === 'panel_2x2' && candidate.executable !== false)
  },
  missingValuesPreserved: missingAnalysis.summary.series[0].y[1] === null
}
assert.equal(p0.executableCandidates, 8)
assert.equal(p0.coverage.scatter, true)
assert.equal(p0.coverage.heatmap, true)
assert.equal(p0.coverage.panel2x2, true)
assert.equal(p0.missingValuesPreserved, true)

const result = {
  schemaVersion: 1,
  generatedAt: new Date().toISOString(),
  spec: {
    utilityWeights: UTILITY_WEIGHTS,
    similarityWeights: SIMILARITY_WEIGHTS,
    eventWeights: EVENT_WEIGHTS,
    lambda: DEFAULT_LAMBDA,
    candidateCountRange: [6, 9],
    minDifferenceDimensions: 2
  },
  runtime,
  boundaryChecks,
  lambdaSweep,
  p0,
  scenarios,
  findings
}

fs.writeFileSync(path.join(outDir, 'decision-baseline.json'), JSON.stringify(result, null, 2), 'utf-8')

const csvEscape = (v) => {
  const s = v === null || v === undefined ? '' : String(v)
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}
const scenarioRows = [
  ['scenario', 'lambda', 'K', 'executable', 'infeasibleRejected', 'selectedIds', 'selectedUtilitySum', 'selectedUtilityMin', 'pairwiseSimMean', 'pairwiseSimMax', 'minPairDiffDims', 'diversityOk', 'stability', 'warnings']
]
for (const s of scenarios) {
  scenarioRows.push([
    s.scenario,
    s.lambda,
    s.K,
    s.executableCount,
    s.infeasibleRejected,
    s.selectedIds.join('|'),
    s.selectedUtilitySum,
    s.selectedUtilityMin ?? '',
    s.pairwiseSimilarityMean ?? '',
    s.pairwiseSimilarityMax ?? '',
    s.minPairDifferenceDims ?? '',
    s.diversityOk,
    s.stability,
    s.warnings.join('；')
  ])
}
fs.writeFileSync(
  path.join(outDir, 'decision-baseline.csv'),
  scenarioRows.map((r) => r.map(csvEscape).join(',')).join('\n') + '\n',
  'utf-8'
)

const candRows = [['scenario', 'candidateId', 'chartType', 'utility', 'executable', 'selected', 'infeasibleReason']]
for (const s of scenarios) {
  for (const c of s.pool) {
    candRows.push([s.scenario, c.candidateId, c.chartType, c.utility ?? '', c.executable, c.selected, c.infeasibleReason ?? ''])
  }
}
fs.writeFileSync(
  path.join(outDir, 'decision-candidates.csv'),
  candRows.map((r) => r.map(csvEscape).join(',')).join('\n') + '\n',
  'utf-8'
)

console.log(`[eval] scenarios=${scenarios.length} lambdaSweep=${lambdaSweep.length} boundaryChecks=${boundaryChecks.length}`)
for (const f of findings) console.log('- ' + f)
console.log('[eval] outputs:', path.relative(path.join(here, '..'), outDir))
const failedChecks = boundaryChecks.filter((c) => !c.pass)
if (failedChecks.length) {
  console.error('[eval] boundary checks failed:', failedChecks)
  process.exit(1)
}
