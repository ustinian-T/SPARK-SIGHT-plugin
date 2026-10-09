// 决策算法测试：权重校验、效用评分、六维相似度、MMR 选择、偏好聚合、生产接线。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  UTILITY_WEIGHTS,
  SIMILARITY_WEIGHTS,
  EVENT_WEIGHTS,
  weightValidationErrors,
  utilityScore,
  candidateSimilarity,
  pairwiseMatrix,
  selectMMR,
  selectionStability,
  eventWeight,
  eventContribution,
  aggregatePreferences,
  recommend,
  buildCandidatePool,
  evaluateCandidates,
  DecisionError
} from '../src/decision/index.js'
import { buildPlans } from '../src/plans.js'
import {
  PALETTE_LIBRARY,
  paletteMetrics,
  recommendPalette,
  ciede2000,
  simulateProtan,
  simulateDeutan,
  simulateTritan,
  grayscaleDistance
} from '../src/palettes.js'
import { ndcgAtK, top1Acceptance, calibrationReport } from '../src/decision/metrics.js'
import { ingestFile } from '../src/csv.js'
import { runDeterministicAnalysis } from '../src/stats.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = fs.readFileSync(path.join(here, 'fixtures', 'nitrogen_response_demo.csv'))
const ingest = ingestFile('nitrogen.csv', fixture)
const analysis = runDeterministicAnalysis({
  profile: ingest.profile,
  text: ingest.text,
  rawDelimiter: ingest.rawDelimiter,
  fileName: 'nitrogen.csv'
})

const sub = (DataFit, TaskFit, Readability, ScientificConvention, PreferenceFit, Executability) => ({
  DataFit,
  TaskFit,
  Readability,
  ScientificConvention,
  PreferenceFit,
  Executability
})
const score = (s) => utilityScore(s)
const c = (id, features, sixArr, executable = true, infeasibleReason) => ({
  candidateId: id,
  features,
  score: score(sub(...sixArr)),
  executable,
  ...(infeasibleReason ? { infeasibleReason } : {})
})

const F_BAR = {
  chartType: 'grouped_bar',
  layout: { rows: 1, cols: 1, panels: 1 },
  encoding: { marks: ['bar'], xType: 'categorical', errorBars: false, normalized: false },
  statPresentation: { raw: true, errorBars: false, normalized: false, significance: false },
  color: { mode: 'categorical', monochromePrint: false },
  annotation: { kinds: [], count: 0 }
}
const F_LINE = {
  chartType: 'line_error',
  layout: { rows: 1, cols: 1, panels: 1 },
  encoding: { marks: ['line', 'marker'], xType: 'linear', errorBars: true, normalized: false },
  statPresentation: { raw: true, errorBars: true, normalized: false, significance: false },
  color: { mode: 'categorical', monochromePrint: false },
  annotation: { kinds: ['grid'], count: 1 }
}
const F_LINE_MONO = {
  ...F_LINE,
  color: { mode: 'mono', monochromePrint: true }
}
const F_DUAL = {
  chartType: 'dual_line_normalized',
  layout: { rows: 1, cols: 2, panels: 2 },
  encoding: { marks: ['line', 'marker'], xType: 'linear', errorBars: false, normalized: true },
  statPresentation: { raw: true, errorBars: false, normalized: true, significance: false },
  color: { mode: 'sequential', monochromePrint: false },
  annotation: { kinds: ['hline_baseline', 'panel_title'], count: 3 }
}

// ---------- 权重与效用 ----------
test('权重：效用/相似度默认权重和均为 1，且非负', () => {
  const usum = Object.values(UTILITY_WEIGHTS).reduce((a, b) => a + b, 0)
  const ssum = Object.values(SIMILARITY_WEIGHTS).reduce((a, b) => a + b, 0)
  assert.ok(Math.abs(usum - 1) < 1e-9)
  assert.ok(Math.abs(ssum - 1) < 1e-9)
  assert.deepEqual(weightValidationErrors(UTILITY_WEIGHTS), [])
})

test('权重：和≠1/负值/缺维/未知维均被拒绝', () => {
  assert.ok(weightValidationErrors({ ...UTILITY_WEIGHTS, DataFit: 0.4 }).length > 0)
  assert.ok(weightValidationErrors({ ...UTILITY_WEIGHTS, TaskFit: -0.2 }).length > 0)
  const { TaskFit, ...missing } = UTILITY_WEIGHTS
  assert.ok(weightValidationErrors(missing).length > 0)
  assert.ok(weightValidationErrors({ ...UTILITY_WEIGHTS, Extra: 0.1 }, ['DataFit']).some((e) => e.includes('未知')))
})

test('效用：说明书权重计算 canonical 分数，结果在 [0,1] 且保留三位小数', () => {
  // clarity: 0.3*0.86+0.2*0.82+0.15*0.92+0.15*0.74+0.1*0.7+0.1*0.95 = 0.836
  assert.equal(score(sub(0.86, 0.82, 0.92, 0.74, 0.7, 0.95)).total, 0.836)
  assert.equal(score(sub(0, 0, 0, 0, 0, 0)).total, 0)
  assert.equal(score(sub(1, 1, 1, 1, 1, 1)).total, 1)
})

test('效用：子分越界/缺失抛 INVALID_SCORE', () => {
  assert.throws(() => score(sub(1.2, 0.8, 0.8, 0.8, 0.8, 0.8)), (e) => e.code === 'INVALID_SCORE')
  assert.throws(() => score(sub(-0.1, 0.8, 0.8, 0.8, 0.8, 0.8)), (e) => e.code === 'INVALID_SCORE')
  assert.throws(() => utilityScore({ DataFit: 0.8 }), (e) => e.code === 'INVALID_SCORE')
})

// ---------- 相似度 ----------
test('相似度：相同特征为 1、无差异维度；计算对称', () => {
  const a = candidateSimilarity(F_BAR, F_BAR)
  assert.equal(a.total, 1)
  assert.deepEqual(a.diffDimensions, [])
  const ab = candidateSimilarity(F_BAR, F_LINE)
  const ba = candidateSimilarity(F_LINE, F_BAR)
  assert.equal(ab.total, ba.total)
  assert.ok(ab.total < 1)
  // 柱状 vs 误差折线至少在图型/编码/统计呈现上不同
  for (const dim of ['chartType', 'encoding', 'statPresentation']) {
    assert.ok(ab.diffDimensions.includes(dim), `应在 ${dim} 上不同`)
  }
})

test('相似度：单色变体仅配色维度不同；双面板至少布局/统计呈现不同', () => {
  const mono = candidateSimilarity(F_LINE, F_LINE_MONO)
  assert.deepEqual(mono.diffDimensions, ['color'])
  const dual = candidateSimilarity(F_LINE, F_DUAL)
  assert.ok(dual.diffDimensions.includes('layout'))
  assert.ok(dual.diffDimensions.includes('statPresentation'))
  assert.ok(pairwiseMatrix([{ features: F_BAR }, { features: F_LINE }])[0].similarity < 1)
})

// ---------- MMR ----------
test('MMR：λ=0 即按效用取 Top-K；首选为 argmax U', () => {
  const pool = [
    c('bar', F_BAR, [0.8, 0.8, 0.9, 0.7, 0.7, 0.9]),
    c('line', F_LINE, [0.9, 0.85, 0.8, 0.9, 0.7, 0.9]),
    c('dual', F_DUAL, [0.7, 0.7, 0.6, 0.8, 0.6, 0.8]),
    c('mono', F_LINE_MONO, [0.6, 0.6, 0.6, 0.6, 0.6, 0.6])
  ]
  const sel = selectMMR(pool, { k: 3, lambda: 0 })
  assert.deepEqual(sel.metrics.selectedIds, ['line', 'bar', 'dual'])
  assert.equal(sel.trace[0].candidateId, 'line')
  assert.equal(sel.trace[0].maxSimilarity, null)
})

test('MMR：λ 越大边际惩罚越强，近似重复候选不会同时入选', () => {
  const pool = [
    c('line1', F_LINE, [0.9, 0.85, 0.8, 0.9, 0.7, 0.9]),
    c('line1_near', F_LINE_MONO, [0.89, 0.84, 0.79, 0.9, 0.7, 0.9]),
    c('bar', F_BAR, [0.8, 0.8, 0.9, 0.7, 0.7, 0.9]),
    c('dual', F_DUAL, [0.78, 0.76, 0.66, 0.8, 0.68, 0.85])
  ]
  const sel = selectMMR(pool, { k: 3, lambda: 0.5, strict: false })
  assert.deepEqual(sel.metrics.selectedIds, ['line1', 'bar', 'dual'])
  assert.ok(!sel.metrics.selectedIds.includes('line1_near'))
  // λ=0 时第二名仍是高效用近似重复
  const sel0 = selectMMR(pool, { k: 3, lambda: 0, strict: false })
  assert.ok(sel0.metrics.selectedIds.includes('line1_near'))
})

test('MMR：同 id 重复候选去重并保留高效用者', () => {
  const pool = [
    c('dup', F_LINE, [0.7, 0.7, 0.7, 0.7, 0.7, 0.7]),
    c('dup', F_LINE, [0.9, 0.9, 0.9, 0.9, 0.9, 0.9]),
    c('bar', F_BAR, [0.8, 0.8, 0.9, 0.7, 0.7, 0.9]),
    c('dual', F_DUAL, [0.78, 0.76, 0.66, 0.8, 0.68, 0.85])
  ]
  const sel = selectMMR(pool, { k: 3, lambda: 0.5 })
  assert.deepEqual(sel.metrics.selectedIds, ['dup', 'bar', 'dual'])
  assert.ok(sel.warnings.join('').includes('重复'))
  assert.equal(sel.metrics.selectedUtility[0], score(sub(0.9, 0.9, 0.9, 0.9, 0.9, 0.9)).total)
})

test('MMR：不可执行候选被剔除并给出原因；无有效候选抛 NO_VALID_CANDIDATE', () => {
  const pool = [
    c('bar', F_BAR, [0.8, 0.8, 0.9, 0.7, 0.7, 0.9]),
    c('line', F_LINE, [0.82, 0.8, 0.78, 0.9, 0.7, 0.9]),
    c('dual', F_DUAL, [0.78, 0.76, 0.66, 0.8, 0.68, 0.85]),
    c('sig', F_LINE, [0.99, 0.99, 0.99, 0.99, 0.99, 0.2], false, 'SIGNIFICANCE_TEST_OUT_OF_SCOPE')
  ]
  const sel = selectMMR(pool, { k: 3 })
  assert.deepEqual(sel.metrics.selectedIds, ['line', 'bar', 'dual'])
  assert.deepEqual(sel.rejected, [{ candidateId: 'sig', reason: 'SIGNIFICANCE_TEST_OUT_OF_SCOPE' }])
  assert.throws(
    () => selectMMR([c('x', F_LINE, [0.9, 0.9, 0.9, 0.9, 0.9, 0.1], false, 'X')], { k: 3 }),
    (e) => e.code === 'NO_VALID_CANDIDATE'
  )
})

test('MMR：可执行候选不足 k 严格失败；诊断模式可返回 warning', () => {
  const twoCandidates = [c('bar', F_BAR, [0.8, 0.8, 0.9, 0.7, 0.7, 0.9]), c('line', F_LINE, [0.82, 0.8, 0.78, 0.9, 0.7, 0.9])]
  assert.throws(() => selectMMR(twoCandidates, { k: 3 }), (e) => e.code === 'INSUFFICIENT_CANDIDATES')
  const two = selectMMR(twoCandidates, { k: 3, strict: false })
  assert.equal(two.selected.length, 2)
  assert.ok(two.warnings.join('').includes('少于最终方案数'))
  // 三个几乎同构候选（仅注释数量微差）→ 差异维度不足
  const near = [
    c('a', { ...F_LINE, annotation: { kinds: ['grid'], count: 1 } }, [0.9, 0.9, 0.9, 0.9, 0.9, 0.9]),
    c('b', { ...F_LINE, annotation: { kinds: ['grid'], count: 2 } }, [0.88, 0.88, 0.88, 0.88, 0.88, 0.88]),
    c('cc', { ...F_LINE, annotation: { kinds: ['grid'], count: 3 } }, [0.86, 0.86, 0.86, 0.86, 0.86, 0.86])
  ]
  const sel = selectMMR(near, { k: 3, strict: false })
  assert.equal(sel.diversityOk, false)
  assert.ok(sel.warnings.join('').includes('差异维度'))
})

test('不同数据形态会改变候选效用与最终图型', () => {
  const fixtureAnalysis = ({ observations, measures }) => ({
    summary: {
      x: Array.from({ length: observations }, (_, index) => index + 1),
      series: Array.from({ length: measures }, (_, index) => ({
        id: `series_${index}`,
        label: `m${index}`,
        y: Array.from({ length: observations }, (_, row) => row + index + 1)
      }))
    }
  })
  const trend = evaluateCandidates(fixtureAnalysis({ observations: 12, measures: 3 }))
  const matrix = evaluateCandidates(fixtureAnalysis({ observations: 4, measures: 8 }))
  assert.notDeepEqual(trend.metrics.selectedIds, matrix.metrics.selectedIds)
  assert.ok(matrix.metrics.selectedIds.includes('c_convention_heatmap'))
  assert.notEqual(
    trend.pool.find((candidate) => candidate.candidateId === 'c_convention_heatmap').score.total,
    matrix.pool.find((candidate) => candidate.candidateId === 'c_convention_heatmap').score.total
  )
})

test('MMR：参数边界（k、λ、候选形状）稳定拒绝', () => {
  assert.throws(() => selectMMR([], { k: 3 }), (e) => e.code === 'NO_VALID_CANDIDATE')
  assert.throws(() => selectMMR([c('a', F_BAR, [0.8, 0.8, 0.8, 0.8, 0.8, 0.8])], { k: 0 }), (e) => e.code === 'INVALID_SELECT_COUNT')
  assert.throws(() => selectMMR([c('a', F_BAR, [0.8, 0.8, 0.8, 0.8, 0.8, 0.8])], { k: 2.5 }), (e) => e.code === 'INVALID_SELECT_COUNT')
  assert.throws(() => selectMMR([c('a', F_BAR, [0.8, 0.8, 0.8, 0.8, 0.8, 0.8])], { lambda: 1.5 }), (e) => e.code === 'INVALID_LAMBDA')
  assert.throws(() => selectMMR('nope'), (e) => e.code === 'INVALID_CANDIDATE')
  assert.throws(() => selectMMR([{ features: F_BAR, score: score(sub(0.8, 0.8, 0.8, 0.8, 0.8, 0.8)) }]), (e) => e.code === 'INVALID_CANDIDATE')
})

test('MMR：洗牌稳定性为 1（确定性 tie-break）', () => {
  const pool = buildCandidatePool(analysis)
  const stab = selectionStability(pool, { k: 3, lambda: 0.5, rng: mulberry(7) }, 30)
  assert.equal(stab.stability, 1)
})

function mulberry(seed) {
  return function () {
    seed |= 0
    seed = (seed + 0x6d2b79f5) | 0
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed)
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

// ---------- 偏好聚合（说明书 12.1/12.2） ----------
test('偏好：事件权重与说明书表 12-1 一致', () => {
  assert.equal(EVENT_WEIGHTS.set_default, 1.0)
  assert.equal(EVENT_WEIGHTS.select_plan, 0.7)
  assert.equal(EVENT_WEIGHTS.manual_edit, 0.6)
  assert.equal(EVENT_WEIGHTS.export, 0.45)
  assert.equal(EVENT_WEIGHTS.reject, -0.8)
  assert.equal(EVENT_WEIGHTS.browse, 0)
  assert.equal(eventWeight('browse'), 0)
  assert.throws(() => eventWeight('unknown'), (e) => e.code === 'INVALID_PREFERENCE_EVENT')
})

test('偏好：时间衰减、置信度、负向事件；browse 不计有效事件', () => {
  const now = 1_000_000
  const tau = 1000
  const fresh = eventContribution({ kind: 'select_plan', t: now }, now, tau)
  const old = eventContribution({ kind: 'select_plan', t: now - 1000 }, now, tau)
  assert.ok(fresh > old && old > 0)
  assert.ok(Math.abs(fresh - 0.7) < 1e-6)
  assert.ok(Math.abs(old - 0.7 * Math.exp(-1)) < 1e-3)
  const half = eventContribution({ kind: 'select_plan', t: now, confidence: 0.5 }, now, tau)
  assert.ok(Math.abs(half - 0.35) < 1e-6)
  assert.ok(eventContribution({ kind: 'reject', t: now }, now, tau) < 0)
  assert.equal(eventContribution({ kind: 'browse', t: now }, now, tau), 0)
})

test('偏好：不足 3 次有效事件或分差不够 → 不自动推荐（只给建议）', () => {
  const now = 1_000_000
  const ev2 = [
    { kind: 'select_plan', attribute: 'strategy', value: 'convention', t: now, scope: 'global' },
    { kind: 'browse', attribute: 'strategy', value: 'convention', t: now, scope: 'global' }
  ]
  const r1 = recommend(ev2, 'strategy', { now })
  assert.equal(r1.shouldRecommend, false)
  assert.ok(r1.reasons.join('').includes('少于阈值'))
  // 3 次但前两名分差不足
  const close = [
    { kind: 'select_plan', attribute: 'strategy', value: 'convention', t: now, scope: 'global' },
    { kind: 'select_plan', attribute: 'strategy', value: 'convention', t: now, scope: 'global' },
    { kind: 'select_plan', attribute: 'strategy', value: 'clarity', t: now, scope: 'global' },
    { kind: 'select_plan', attribute: 'strategy', value: 'clarity', t: now, scope: 'global' }
  ]
  const r2 = recommend(close, 'strategy', { now, margin: 0.5 })
  assert.equal(r2.shouldRecommend, false)
  assert.ok(r2.reasons.join('').includes('分差'))
})

test('偏好：≥3 次且分差超阈值才推荐；项目级覆盖全局；拒绝主导不推荐', () => {
  const now = 1_000_000
  const events = [
    { kind: 'set_default', attribute: 'strategy', value: 'convention', t: now, scope: 'global' },
    { kind: 'select_plan', attribute: 'strategy', value: 'convention', t: now, scope: 'global' },
    { kind: 'export', attribute: 'strategy', value: 'convention', t: now, scope: 'global' },
    // 项目级 3 次有效事件选择 clarity，覆盖全局结论
    { kind: 'set_default', attribute: 'strategy', value: 'clarity', t: now, scope: 'project' },
    { kind: 'select_plan', attribute: 'strategy', value: 'clarity', t: now, scope: 'project' },
    { kind: 'manual_edit', attribute: 'strategy', value: 'clarity', t: now, scope: 'project' }
  ]
  const r = recommend(events, 'strategy', { now, margin: 0.15 })
  assert.equal(r.shouldRecommend, true)
  assert.equal(r.value, 'clarity') // 项目级覆盖全局
  assert.equal(r.scope, 'project')
  // 全部为拒绝 → 不自动推荐
  const neg = [0, 1, 2].map((i) => ({ kind: 'reject', attribute: 'strategy', value: 'density', t: now, scope: 'global' }))
  const rn = recommend(neg, 'strategy', { now })
  assert.equal(rn.shouldRecommend, false)
  // 聚合按 (属性,值,作用域) 分组：全局 convention 与项目 clarity 各一行
  const agg = aggregatePreferences(events, { now })
  assert.equal(agg.size, 2)
  const projectRow = [...agg.values()].find((r) => r.scope === 'project')
  assert.equal(projectRow.value, 'clarity')
  assert.equal(projectRow.effectiveEvents, 3)
})

// ---------- 生产接线 ----------
test('生产：buildPlans 基于动态候选池（6~15）真实执行 MMR，审计字段完整且三方案共享证据', () => {
  const plans = buildPlans(analysis, { fileName: 'nitrogen.csv', titleBase: 'nitrogen', engine: 'python' })
  const audit = plans.selectionAudit
  // V2：候选池按数据信号动态 6~12，且全部可执行
  assert.ok(audit.K >= 6 && audit.K <= 15, `候选池数 K=${audit.K} 应在 [6,15]`)
  assert.equal(audit.executableCount, audit.K)
  assert.equal(audit.infeasibleCount, 0)
  assert.equal(audit.diversityOk, true)
  assert.deepEqual(audit.warnings, [])
  assert.equal(audit.selectedCandidateIds.length, 3)
  // V2：校准指标占位（需标注集校准）
  assert.equal(audit.calibrationMetrics.candidateCount, audit.K)
  assert.equal(audit.calibrationMetrics.executableCount, audit.executableCount)
  assert.equal(audit.calibrationMetrics.ndcgAt3Baseline, null)
  // 每套方案的 mmrScore 来自 MMR trace（不再是硬编码 0.86/0.81/0.74）
  const traceById = new Map(audit.mmrTrace.map((t) => [t.candidateId, t]))
  for (const p of plans) {
    assert.ok(audit.selectedCandidateIds.includes(p.candidateId))
    assert.equal(p.mmrScore, traceById.get(p.candidateId).mmrScore)
    assert.ok(p.diffDimensions.length >= 2, `${p.plan_id} 差异维度不足`)
    assert.equal(p.score.total, p.mmrUtility)
    // V2：每个方案 score 携带七维可解释 scoreBreakdown
    assert.ok(p.score.scoreBreakdown, `${p.plan_id} 缺少 scoreBreakdown`)
    for (const dim of ['taskMatch', 'informationLoss', 'occlusionRisk', 'colorCapacity', 'labelDensity', 'statisticalCorrectness', 'runtimeAvailability']) {
      assert.ok(typeof p.score.scoreBreakdown[dim] === 'number' && p.score.scoreBreakdown[dim] >= 0 && p.score.scoreBreakdown[dim] <= 1, `${p.plan_id}.${dim} 不在 [0,1]`)
    }
  }
  // 旧硬编码值已被真实计算替换
  assert.ok(plans.every((plan) => plan.score.total >= 0 && plan.score.total <= 1))
  assert.notEqual(plans.find((p) => p.plan_id === 'plan_clarity').mmrScore, 0.86)
  // 三方案共享同一次统计的证据集合
  const ids = plans.map((p) => JSON.stringify(p.evidenceIds))
  assert.equal(new Set(ids).size, 1)
  assert.ok(plans[0].evidenceIds.includes('ev_desc_0'))
})

test('生产：候选池为确定性输出（重复构建结果一致）', () => {
  const a = JSON.stringify(buildCandidatePool(analysis))
  const b = JSON.stringify(buildCandidatePool(analysis))
  assert.equal(a, b)
  assert.ok(a.includes('correlation_heatmap'))
  assert.ok(a.includes('panel_2x2'))
  assert.ok(a.includes('point_scatter'))
})

test('配色：五组用户预设可显式选择，并写入预览系列与三引擎源码', () => {
  const ids = ['user_ocean', 'user_garden', 'user_nature', 'user_macaron', 'user_pairs']
  for (const id of ids) {
    const plans = buildPlans(analysis, {
      fileName: 'nitrogen.csv', titleBase: '配色测试', engine: 'python',
      userRequest: `[制图规范]\n配色预设=${id}; DPI=300; 字体=SimHei`
    })
    for (const plan of plans) {
      assert.equal(plan.palette.id, id)
      assert.equal(plan.spec.figure.dpi, 300)
      assert.equal(plan.spec.figure.fontFamily, 'SimHei')
      assert.equal(plan.series[0].color, plan.palette.colors[0])
      assert.ok(plan.code.python.includes(plan.palette.colors[0]))
    }
  }
})

test('配色：历史选择提升对应色板推荐分，图表说明包含可追溯理由', () => {
  const plans = buildPlans(analysis, {
    fileName: 'nitrogen.csv', titleBase: '偏好测试', engine: 'python',
    userRequest: '比较多个分类',
    preferenceEvents: [
      { kind: 'select_plan', paletteId: 'user_garden', weight: 1, confidence: 1, t: Date.now() },
      { kind: 'select_plan', paletteId: 'user_garden', weight: 1, confidence: 1, t: Date.now() }
    ]
  })
  assert.ok(plans.some((plan) => plan.palette.id === 'user_garden'))
  assert.ok(plans.every((plan) => plan.insightSummary && plan.focusExplanation && plan.palette.reason))
})

test('配色：系列容量和感知色差优先于不适用的历史偏好', () => {
  const now = Date.UTC(2026, 8, 27)
  const events = Array.from({ length: 20 }, () => ({
    kind: 'select_plan', paletteId: 'brewer_sequential', weight: 1, confidence: 1, t: now
  }))
  const result = recommendPalette({
    prompt: '比较八个分类组别', chartType: 'bar_grouped', strategy: 'clarity',
    seriesCount: 8, preferenceEvents: events, now
  })
  assert.notEqual(result.id, 'brewer_sequential')
  assert.equal(result.metrics.overflow, 0)
  assert.ok(result.metrics.minDeltaE > 10)
  assert.ok(result.reason.includes('8 个系列'))
})

test('配色：黑白打印要求进入评分，结果保留可解释审计指标', () => {
  const result = recommendPalette({
    prompt: '用于论文黑白打印，比较四个处理组', chartType: 'line_errorbar',
    strategy: 'convention', seriesCount: 4, now: Date.UTC(2026, 8, 27)
  })
  assert.ok(result.scoreBreakdown.monochrome > 0)
  assert.ok(result.metrics.luminanceRange > 0.25)
  assert.ok(result.reason.includes('灰度打印'))
})

test('配色：显式预设始终服从；系列超出容量时不循环，改插值补色并启用冗余编码', () => {
  const result = recommendPalette({ prompt: '配色预设=user_pairs', chartType: 'line', seriesCount: 10 })
  assert.equal(result.id, 'user_pairs')
  assert.equal(result.metrics.overflow, 2)
  // V2：溢出不再循环复用颜色，而是 Lab 插值补色 + 冗余编码
  assert.equal(result.redundantEncoding.enabled, true)
  assert.ok(result.redundantEncoding.lineStyles.length > 0)
  assert.ok(result.redundantEncoding.markers.length > 0)
  assert.equal(result.colors.length, 10)
  assert.equal(result.interpolated, true)
  assert.ok(result.warnings.some((w) => w.includes('冗余编码')))
  assert.ok(!result.warnings.some((w) => w.includes('循环使用')))
})

test('配色：感知指标计算稳定且不修改原始色板', () => {
  const before = JSON.stringify(PALETTE_LIBRARY.seaborn_colorblind.colors)
  const metrics = paletteMetrics(PALETTE_LIBRARY.seaborn_colorblind, 6)
  assert.ok(metrics.minDeltaE > 0)
  assert.ok(metrics.minContrastOnWhite > 1)
  assert.equal(JSON.stringify(PALETTE_LIBRARY.seaborn_colorblind.colors), before)
})

// ---------- V2：CIEDE2000 / CVD / 灰度 ----------
test('V2 色差：CIEDE2000 相同颜色为 0，黑白≈100，对称性', () => {
  assert.equal(ciede2000('#1A2B3C', '#1A2B3C'), 0)
  assert.ok(Math.abs(ciede2000('#000000', '#FFFFFF') - 100) < 1, '黑白 ΔE00 应≈100')
  assert.ok(Math.abs(ciede2000('#FF0000', '#00FF00') - ciede2000('#00FF00', '#FF0000')) < 1e-9)
  assert.ok(ciede2000('#E64B35', '#4DBBD5') > 0)
})

test('V2 色觉缺陷：三种 CVD 模拟均输出合法 hex', () => {
  for (const c of ['#D55E00', '#0173B2', '#029E73', '#56B4E9']) {
    for (const sim of [simulateProtan, simulateDeutan, simulateTritan]) {
      const out = sim(c)
      assert.match(out, /^#[0-9A-F]{6}$/, `${c} 模拟结果 ${out} 不是合法 hex`)
    }
  }
  // 模拟必须真实改变颜色空间中的红/绿（红色盲下纯红应被映射到不同色）
  assert.notEqual(simulateProtan('#FF0000').toUpperCase(), '#FF0000')
  assert.notEqual(simulateDeutan('#00FF00').toUpperCase(), '#00FF00')
})

test('V2 灰度：WCAG 相对亮度距离黑白为 1，同色为 0', () => {
  assert.ok(Math.abs(grayscaleDistance('#000000', '#FFFFFF') - 1) < 1e-9)
  assert.equal(grayscaleDistance('#808080', '#808080'), 0)
  assert.ok(grayscaleDistance('#FFFFFF', '#000000') > grayscaleDistance('#888888', '#777777'))
})

test('V2 色板指标：含 CVD/灰度门槛字段', () => {
  const metrics = paletteMetrics(PALETTE_LIBRARY.seaborn_colorblind, 4)
  assert.ok(typeof metrics.minCvdDeltaE === 'number')
  assert.ok(typeof metrics.minGrayscaleGap === 'number')
  assert.equal(typeof metrics.cvdPass, 'boolean')
  assert.equal(typeof metrics.grayscalePass, 'boolean')
})

test('V2 溢出：seriesCount>capacity 时 redundantEncoding.enabled=true 且不循环', () => {
  const result = recommendPalette({ prompt: '比较十二个分组', chartType: 'bar', seriesCount: 12, now: Date.UTC(2026, 8, 27) })
  assert.equal(result.redundantEncoding.enabled, true)
  assert.ok(result.colors.length >= 12)
  assert.ok(result.warnings.some((w) => w.includes('冗余编码')))
})

test('V2 候选池：不同数据信号下候选数在 6~12 且七维 scoreBreakdown 齐全', () => {
  const fixtureAnalysis = ({ observations, measures }) => ({
    summary: {
      x: Array.from({ length: observations }, (_, index) => index + 1),
      series: Array.from({ length: measures }, (_, index) => ({
        id: `series_${index}`,
        label: `m${index}`,
        y: Array.from({ length: observations }, (_, row) => row + index + 1)
      }))
    }
  })
  for (const cfg of [
    { observations: 12, measures: 3 },
    { observations: 4, measures: 8 },
    { observations: 6, measures: 2 },
    { observations: 20, measures: 4 }
  ]) {
    const pool = buildCandidatePool(fixtureAnalysis(cfg))
    assert.ok(pool.length >= 6 && pool.length <= 15, `候选数 ${pool.length} 应在 [6,15]`)
    for (const c of pool) {
      assert.ok(c.executable !== false || c.infeasibleReason, '不可执行候选须给出原因')
      for (const dim of ['taskMatch', 'informationLoss', 'occlusionRisk', 'colorCapacity', 'labelDensity', 'statisticalCorrectness', 'runtimeAvailability']) {
        assert.ok(typeof c.scoreBreakdown?.[dim] === 'number', `${c.candidateId} 缺 scoreBreakdown.${dim}`)
      }
      assert.ok(c.features.statisticalCorrectness && typeof c.features.statisticalCorrectness.errorBarSemantics === 'string')
    }
  }
})

test('V2 校准指标：NDCG@3、Top-1 接受率与报告', () => {
  assert.equal(ndcgAtK([3, 2, 1], 3), 1)
  assert.ok(ndcgAtK([1, 2, 3], 3) > 0 && ndcgAtK([1, 2, 3], 3) < 1)
  assert.equal(ndcgAtK([2, 2, 2], 3), 1)
  assert.equal(top1Acceptance([['a', 'b'], ['c', 'd']], [['a', 'b'], ['x', 'y']]), 0.5)
  assert.equal(top1Acceptance([['a']], [['a']]), 1)
  const report = calibrationReport([['a', 'b', 'c'], ['x', 'y', 'z']], [['a', 'b', 'c'], ['z', 'y', 'x']])
  assert.equal(report.predictionCount, 2)
  assert.ok(report.ndcgAt3 > 0 && report.ndcgAt3 <= 1)
  assert.equal(report.top1Acceptance, 0.5)
})