// 候选方案池生成 V2（算法说明书 8.1：K=6~12，至少覆盖清晰/惯例/密度三种策略）。
// V2：候选数由固定 8 改为按数据信号动态 6~12；新增箱线/小提琴/堆叠面积/配对点四类图型；
// 每个候选附带七维可解释 scoreBreakdown 与 statisticalCorrectness 元数据。
// 子分为初始启发式配置（非训练所得）；数据信号只影响与数据相关的维度，不改动权重。
import { utilityScore, round3 } from './weights.js'
import { selectMMR } from './mmr.js'
import { explainableScore, buildStatisticalCorrectness } from './features.js'

export const CANONICAL_IDS = Object.freeze(['c_clarity_bar', 'c_convention_line_err', 'c_density_dual'])

const clamp01 = (v) => Math.min(1, Math.max(0, v))

// 候选池规模上限（算法说明书 8.1：K=6~12；v0.4.2 图型库扩至 15 种后上限放宽至 15，
// 保证用户可显式点名的图型不被池裁剪静默吞掉），超限时按效用分裁剪条件候选
const MAX_POOL_SIZE = 15

/**
 * 从确定性统计结果提取候选生成所需的数据信号。
 */
export function dataSignals(analysis) {
  const seriesCount = analysis.summary.series.length
  const obsCount = analysis.summary.x.length
  const hasErrorBars = analysis.summary.series.some((s) => Array.isArray(s.yerr)) || Boolean(analysis.summary.groups?.series?.some((s) => Array.isArray(s.yerr)))
  const errorBarKinds = analysis.summary.groups
    ? ['se']
    : [...new Set(analysis.summary.series.filter((s) => Array.isArray(s.yerr)).map((s) => s.yerrKind ?? 'unknown'))]
  // 高密度判定（启发式）：系列×观测点较多时，密度策略更契合
  const highDensity = seriesCount * obsCount >= 18
  // 组间比较判定（启发式）：观测点少（≤4）且系列多，柱状对比更契合
  const groupComparison = obsCount <= 4 && seriesCount >= 2
  // 趋势判定（启发式）：观测点 ≥5
  const trend = obsCount >= 5
  const matrixLike = seriesCount >= 4 && obsCount <= 8
  // v0.4.2：长表分组形态（分组列 + 数值列）→ 箱线+抖动/小提琴/误差棒点图天然契合
  const grouped = Boolean(analysis.summary.groups)
  const spatialReady = analysis.chartContext?.spatialReady === true && obsCount >= 4
  return { seriesCount, obsCount, hasErrorBars, errorBarKinds, highDensity, groupComparison, trend, matrixLike, grouped, spatialReady }
}

export function candidateSubscores(candidate, signals, base) {
  const chartType = candidate.chartType
  let DataFit = base.DataFit
  let TaskFit = base.TaskFit
  if (chartType.includes('heatmap')) {
    DataFit = signals.matrixLike ? 0.98 : signals.seriesCount >= 3 ? 0.72 : 0.25
    TaskFit = signals.matrixLike ? 0.96 : 0.62
  } else if (chartType.includes('scatter3d')) {
    DataFit = signals.seriesCount >= 3 ? 0.82 : 0.4
    TaskFit = signals.seriesCount >= 3 ? 0.8 : 0.45
  } else if (chartType.includes('surface3d')) {
    DataFit = signals.seriesCount >= 3 && signals.obsCount >= 8 ? 0.88 : 0.42
    TaskFit = signals.seriesCount >= 3 && signals.obsCount >= 8 ? 0.86 : 0.5
  } else if (chartType.includes('dual_axis')) {
    DataFit = signals.trend && signals.seriesCount >= 2 ? 0.86 : 0.55
    TaskFit = signals.trend && signals.seriesCount >= 2 ? 0.84 : 0.58
  } else if (chartType.includes('scatter')) {
    DataFit = signals.trend && signals.seriesCount >= 2 ? 0.9 : 0.64
    TaskFit = signals.trend ? 0.86 : 0.68
  } else if (chartType.includes('paired_dot')) {
    DataFit = signals.seriesCount === 2 ? 0.95 : 0.5
    TaskFit = signals.seriesCount === 2 ? 0.92 : 0.55
  } else if (chartType.includes('box_plot')) {
    DataFit = signals.grouped || signals.groupComparison || signals.seriesCount >= 3 ? 0.9 : 0.6
    TaskFit = signals.grouped || signals.groupComparison || signals.seriesCount >= 3 ? 0.88 : 0.6
  } else if (chartType.includes('violin_plot')) {
    DataFit = signals.grouped || signals.seriesCount >= 3 ? 0.87 : 0.55
    TaskFit = signals.grouped || signals.seriesCount >= 3 ? 0.86 : 0.58
  } else if (chartType === 'dot_plot') {
    // 误差棒点图：分组形态（组均值±SE）或宽表多系列（系列均值±SE）
    DataFit = signals.grouped || (signals.trend && signals.seriesCount >= 2) ? 0.9 : 0.6
    TaskFit = signals.grouped || signals.seriesCount >= 3 ? 0.88 : 0.62
  } else if (chartType === 'forest') {
    // 森林图：需逐条目均值 + CI（_sd/_se 后缀列提供），适合效应量/指标对比数据
    DataFit = signals.hasErrorBars ? 0.88 : 0.45
    TaskFit = signals.hasErrorBars ? 0.84 : 0.5
  } else if (chartType.includes('stacked_area')) {
    DataFit = signals.trend && signals.seriesCount >= 3 ? 0.86 : 0.55
    TaskFit = signals.trend && signals.seriesCount >= 3 ? 0.82 : 0.55
  } else if (chartType.includes('bar')) {
    DataFit = signals.groupComparison || signals.matrixLike ? 0.94 : signals.trend ? 0.58 : 0.78
    TaskFit = signals.groupComparison || signals.matrixLike ? 0.92 : 0.66
  } else if (chartType === 'line_error') {
    DataFit = signals.trend ? 0.96 : 0.58
    TaskFit = signals.trend ? 0.94 : 0.55
  } else if (chartType === 'panel_2x2') {
    DataFit = signals.matrixLike || signals.highDensity ? 0.94 : 0.7
    TaskFit = signals.matrixLike ? 0.95 : 0.74
  } else if (chartType.includes('dual_line_normalized')) {
    DataFit = signals.trend ? 0.88 : 0.66
    TaskFit = signals.highDensity ? 0.9 : signals.trend ? 0.84 : 0.65
  }
  return {
    ...base,
    DataFit: round3(DataFit),
    TaskFit: round3(TaskFit),
    Executability: candidate.infeasibleReason ? 0 : Math.max(base.Executability, 0.9)
  }
}

/**
 * 构造 K=6~12 候选池。每个候选包含六类设计特征签名、七维可解释子分与可执行性标记。
 * @returns {Array<{candidateId,strategy,chartType,features,score,scoreBreakdown,executable,canonicalPlanId?}>}
 */
export function buildCandidatePool(analysis) {
  const sig = dataSignals(analysis)

  // 三个 canonical 候选：子分沿用 plans.js 的初始配置（未经用户测试，不声称训练所得）
  const canonical = [
    {
      candidateId: 'c_clarity_bar',
      canonicalPlanId: 'plan_clarity',
      strategy: 'clarity',
      chartType: 'grouped_bar',
      features: {
        chartType: 'grouped_bar',
        layout: { rows: 1, cols: 1, panels: 1 },
        encoding: { marks: ['bar'], xType: 'categorical', errorBars: false, normalized: false },
        statPresentation: { raw: true, errorBars: false, normalized: false, significance: false },
        color: { mode: 'categorical', monochromePrint: false },
        annotation: { kinds: [], count: 0 }
      },
      sub: { DataFit: 0.86, TaskFit: 0.82, Readability: 0.92, ScientificConvention: 0.74, PreferenceFit: 0.7, Executability: 0.95 }
    },
    {
      candidateId: 'c_convention_line_err',
      canonicalPlanId: 'plan_convention',
      strategy: 'convention',
      chartType: 'line_error',
      features: {
        chartType: 'line_error',
        layout: { rows: 1, cols: 1, panels: 1 },
        encoding: { marks: ['line', 'marker'], xType: 'linear', errorBars: true, normalized: false },
        statPresentation: { raw: true, errorBars: true, normalized: false, significance: false },
        color: { mode: 'categorical', monochromePrint: false },
        annotation: { kinds: ['grid'], count: 1 }
      },
      sub: { DataFit: 0.88, TaskFit: 0.8, Readability: 0.8, ScientificConvention: 0.94, PreferenceFit: 0.72, Executability: 0.92 }
    },
    {
      candidateId: 'c_density_dual',
      canonicalPlanId: 'plan_density',
      strategy: 'density',
      chartType: 'dual_line_normalized',
      features: {
        chartType: 'dual_line_normalized',
        layout: { rows: 1, cols: 2, panels: 2 },
        encoding: { marks: ['line', 'marker'], xType: 'linear', errorBars: false, normalized: true },
        statPresentation: { raw: true, errorBars: false, normalized: true, significance: false },
        color: { mode: 'sequential', monochromePrint: false },
        annotation: { kinds: ['hline_baseline', 'panel_title'], count: 3 }
      },
      sub: { DataFit: 0.84, TaskFit: 0.78, Readability: 0.66, ScientificConvention: 0.8, PreferenceFit: 0.68, Executability: 0.85 }
    }
  ]

  // 五个设计层候选（codegen 可执行；子分按数据信号做启发式调整）
  const coreVariants = [
    {
      candidateId: 'c_clarity_bar_err',
      strategy: 'clarity',
      chartType: 'grouped_bar_error',
      features: {
        chartType: 'grouped_bar_error',
        layout: { rows: 1, cols: 1, panels: 1 },
        encoding: { marks: ['bar'], xType: 'categorical', errorBars: true, normalized: false },
        statPresentation: { raw: true, errorBars: true, normalized: false, significance: false },
        color: { mode: 'categorical', monochromePrint: false },
        annotation: { kinds: [], count: 0 }
      },
      base: 'c_clarity_bar',
      adjust: { DataFit: sig.hasErrorBars ? 0.03 : -0.12, ScientificConvention: sig.hasErrorBars ? 0.04 : -0.05 },
      infeasibleReason: null
    },
    {
      candidateId: 'c_density_2x1',
      strategy: 'density',
      chartType: 'dual_line_normalized_2x1',
      features: {
        chartType: 'dual_line_normalized',
        layout: { rows: 2, cols: 1, panels: 2 },
        encoding: { marks: ['line', 'marker'], xType: 'linear', errorBars: false, normalized: true },
        statPresentation: { raw: true, errorBars: false, normalized: true, significance: false },
        color: { mode: 'sequential', monochromePrint: false },
        annotation: { kinds: ['hline_baseline', 'panel_title'], count: 3 }
      },
      base: 'c_density_dual',
      adjust: { Readability: -0.06, TaskFit: sig.highDensity ? 0.02 : -0.02 },
      infeasibleReason: null
    },
    {
      candidateId: 'c_convention_heatmap',
      strategy: 'convention',
      chartType: 'correlation_heatmap',
      features: {
        chartType: 'correlation_heatmap',
        layout: { rows: 1, cols: 1, panels: 1 },
        encoding: { marks: ['heatmap'], xType: 'categorical', errorBars: false, normalized: false },
        statPresentation: { raw: false, errorBars: false, normalized: false, significance: false },
        color: { mode: 'diverging', monochromePrint: false },
        annotation: { kinds: ['colorbar'], count: 1 }
      },
      base: 'c_convention_line_err',
      adjust: { DataFit: sig.seriesCount >= 2 ? 0.04 : -0.3, TaskFit: sig.seriesCount >= 3 ? 0.03 : -0.08 },
      infeasibleReason: sig.seriesCount >= 2 ? null : 'HEATMAP_REQUIRES_TWO_NUMERIC_MEASURES'
    },
    {
      candidateId: 'c_clarity_scatter',
      strategy: 'clarity',
      chartType: 'point_scatter',
      features: {
        chartType: 'point_scatter',
        layout: { rows: 1, cols: 1, panels: 1 },
        encoding: { marks: ['point'], xType: 'linear', errorBars: false, normalized: false },
        statPresentation: { raw: true, errorBars: false, normalized: false, significance: false },
        color: { mode: 'categorical', monochromePrint: false },
        annotation: { kinds: [], count: 0 }
      },
      base: 'c_clarity_bar',
      adjust: { TaskFit: sig.trend ? -0.04 : 0.02, Readability: -0.08, ScientificConvention: -0.06 },
      infeasibleReason: sig.seriesCount >= 2 ? null : 'SCATTER_REQUIRES_TWO_NUMERIC_MEASURES'
    }
  ]

  // V2 新增四类图型候选（按数据信号条件进入池，保证池规模动态 6~12）
  const conditionalVariants = [
    {
      candidateId: 'c_density_2x2',
      strategy: 'density',
      chartType: 'panel_2x2',
      // v0.4.2：panel_2x2 的 fallback 面板含 heatmap/scatter，至少需要 2 个测量系列；单系列数据下不进入（防 heatmap 面板空绘）
      condition: sig.seriesCount >= 2,
      features: {
        chartType: 'panel_2x2',
        layout: { rows: 2, cols: 2, panels: 4 },
        encoding: { marks: ['line', 'bar', 'point', 'heatmap'], xType: 'linear', errorBars: false, normalized: false },
        statPresentation: { raw: true, errorBars: false, normalized: false, significance: false },
        color: { mode: 'diverging', monochromePrint: false },
        annotation: { kinds: ['panel_title'], count: 4 }
      },
      base: 'c_density_dual',
      adjust: { Readability: -0.12, TaskFit: sig.highDensity ? 0.06 : -0.04 },
      infeasibleReason: sig.seriesCount >= 2 ? null : 'PANEL_2X2_REQUIRES_TWO_NUMERIC_MEASURES'
    },
    {
      candidateId: 'c_clarity_box',
      strategy: 'clarity',
      chartType: 'box_plot',
      condition: sig.grouped || sig.groupComparison || sig.seriesCount >= 3,
      features: {
        chartType: 'box_plot',
        layout: { rows: 1, cols: 1, panels: 1 },
        encoding: { marks: ['box', 'point'], xType: 'categorical', errorBars: false, normalized: false },
        statPresentation: { raw: true, errorBars: false, normalized: false, significance: false },
        color: { mode: 'categorical', monochromePrint: false },
        annotation: { kinds: [], count: 0 }
      },
      base: 'c_clarity_bar',
      adjust: { TaskFit: 0.04, Readability: 0.05, ScientificConvention: 0.08 },
      infeasibleReason: null
    },
    {
      candidateId: 'c_convention_violin',
      strategy: 'convention',
      chartType: 'violin_plot',
      condition: sig.grouped || sig.seriesCount >= 3,
      features: {
        chartType: 'violin_plot',
        layout: { rows: 1, cols: 1, panels: 1 },
        encoding: { marks: ['violin'], xType: 'categorical', errorBars: false, normalized: false },
        statPresentation: { raw: true, errorBars: false, normalized: false, significance: false },
        color: { mode: 'categorical', monochromePrint: false },
        annotation: { kinds: [], count: 0 }
      },
      base: 'c_convention_line_err',
      adjust: { TaskFit: 0.02, Readability: -0.04, ScientificConvention: 0.05 },
      infeasibleReason: null
    },
    {
      candidateId: 'c_clarity_dot_plot',
      strategy: 'clarity',
      chartType: 'dot_plot',
      condition: sig.grouped || (sig.trend && sig.seriesCount >= 2),
      features: {
        chartType: 'dot_plot',
        layout: { rows: 1, cols: 1, panels: 1 },
        encoding: { marks: ['point', 'errorbar'], xType: 'categorical', errorBars: true, normalized: false },
        statPresentation: { raw: false, errorBars: true, normalized: false, significance: false },
        color: { mode: 'categorical', monochromePrint: false },
        annotation: { kinds: [], count: 0 }
      },
      base: 'c_clarity_bar',
      adjust: { TaskFit: 0.03, ScientificConvention: 0.1, Readability: 0.02 },
      infeasibleReason: null
    },
    {
      candidateId: 'c_convention_forest',
      strategy: 'convention',
      chartType: 'forest',
      condition: sig.hasErrorBars && sig.seriesCount >= 1,
      features: {
        chartType: 'forest',
        layout: { rows: 1, cols: 1, panels: 1 },
        encoding: { marks: ['point', 'errorbar'], xType: 'categorical', errorBars: true, normalized: false },
        statPresentation: { raw: false, errorBars: true, normalized: false, significance: false },
        color: { mode: 'categorical', monochromePrint: false },
        annotation: { kinds: ['vline_ref'], count: 1 }
      },
      base: 'c_convention_line_err',
      adjust: { TaskFit: 0.02, Readability: -0.05, ScientificConvention: 0.08 },
      infeasibleReason: null
    },
    {
      candidateId: 'c_density_stacked_area',
      strategy: 'density',
      chartType: 'stacked_area',
      // v0.4.2：堆叠柱不要求趋势（多系列正值即可），放宽为系列数 ≥3
      condition: sig.seriesCount >= 3,
      features: {
        chartType: 'stacked_area',
        layout: { rows: 1, cols: 1, panels: 1 },
        encoding: { marks: ['area'], xType: 'linear', errorBars: false, normalized: false },
        statPresentation: { raw: true, errorBars: false, normalized: false, significance: false },
        color: { mode: 'sequential', monochromePrint: false },
        annotation: { kinds: ['panel_title'], count: 1 }
      },
      base: 'c_density_dual',
      adjust: { TaskFit: 0.03, Readability: -0.05, InformationLoss: 0 },
      infeasibleReason: null
    },
    {
      candidateId: 'c_clarity_paired_dot',
      strategy: 'clarity',
      chartType: 'paired_dot',
      condition: sig.seriesCount === 2,
      features: {
        chartType: 'paired_dot',
        layout: { rows: 1, cols: 1, panels: 1 },
        encoding: { marks: ['point', 'line'], xType: 'categorical', errorBars: false, normalized: false },
        statPresentation: { raw: true, errorBars: false, normalized: false, significance: false },
        color: { mode: 'paired', monochromePrint: false },
        annotation: { kinds: [], count: 0 }
      },
      base: 'c_clarity_bar',
      adjust: { TaskFit: 0.06, ScientificConvention: 0.04 },
      infeasibleReason: null
    },
    // ---- 扩展图型：双 Y 轴 / 三维曲面 / 三维散点（v0.4 §10.5-10.6 通用精华）----
    {
      candidateId: 'c_clarity_dual_axis',
      strategy: 'clarity',
      chartType: 'dual_axis',
      condition: sig.trend && sig.seriesCount >= 2,
      features: {
        chartType: 'dual_axis',
        layout: { rows: 1, cols: 1, panels: 1 },
        encoding: { marks: ['line', 'line'], xType: 'linear', errorBars: false, normalized: false, dualAxis: true },
        statPresentation: { raw: true, errorBars: false, normalized: false, significance: false },
        color: { mode: 'paired', monochromePrint: false },
        annotation: { kinds: [], count: 0 }
      },
      base: 'c_convention_line_err',
      adjust: { TaskFit: 0.06, Readability: -0.06, ScientificConvention: 0.05 },
      infeasibleReason: sig.seriesCount >= 2 ? null : 'DUAL_AXIS_REQUIRES_TWO_MEASURES'
    },
    {
      candidateId: 'c_density_surface3d',
      strategy: 'density',
      chartType: 'surface3d',
      condition: sig.spatialReady && sig.obsCount >= 8,
      features: {
        chartType: 'surface3d',
        layout: { rows: 1, cols: 1, panels: 1 },
        encoding: { marks: ['surface'], xType: 'linear', errorBars: false, normalized: false, dimension: '3d' },
        statPresentation: { raw: true, errorBars: false, normalized: false, significance: false },
        color: { mode: 'sequential', monochromePrint: false },
        annotation: { kinds: ['colorbar'], count: 1 }
      },
      base: 'c_density_dual',
      adjust: { TaskFit: sig.trend ? 0.05 : -0.1, Readability: -0.15, ScientificConvention: -0.04 },
      infeasibleReason: sig.spatialReady && sig.obsCount >= 8 ? null : 'SURFACE_REQUIRES_SPATIAL_COORDINATES_AND_THREE_NUMERIC_MEASURES'
    },
    {
      candidateId: 'c_clarity_scatter3d',
      strategy: 'clarity',
      chartType: 'scatter3d',
      condition: sig.spatialReady,
      features: {
        chartType: 'scatter3d',
        layout: { rows: 1, cols: 1, panels: 1 },
        encoding: { marks: ['point'], xType: 'linear', errorBars: false, normalized: false, dimension: '3d' },
        statPresentation: { raw: true, errorBars: false, normalized: false, significance: false },
        color: { mode: 'sequential', monochromePrint: false },
        annotation: { kinds: ['colorbar'], count: 1 }
      },
      base: 'c_clarity_bar',
      adjust: { TaskFit: 0.03, Readability: -0.12, ScientificConvention: -0.04 },
      infeasibleReason: sig.spatialReady ? null : 'SCATTER3D_REQUIRES_SPATIAL_COORDINATES_AND_THREE_NUMERIC_MEASURES'
    }
  ]

  const baseById = new Map(canonical.map((c) => [c.candidateId, c]))
  const pool = canonical.map((c) => {
    const features = { ...c.features, statisticalCorrectness: buildStatisticalCorrectness(c.chartType, sig) }
    const candidate = {
      candidateId: c.candidateId,
      strategy: c.strategy,
      chartType: c.chartType,
      features,
      score: utilityScore(candidateSubscores(c, sig, c.sub)),
      executable: true,
      canonicalPlanId: c.canonicalPlanId
    }
    candidate.scoreBreakdown = explainableScore(candidate, sig, { paletteCapacity: 8 })
    return candidate
  })

  const coreIds = new Set(coreVariants.map((v) => v.candidateId))
  const variants = [...coreVariants, ...conditionalVariants.filter((v) => v.condition !== false)]
  for (const v of variants) {
    const base = baseById.get(v.base)
    if (!base) continue
    const sub = { ...base.sub }
    for (const [dim, delta] of Object.entries(v.adjust ?? {})) {
      if (!(dim in sub)) continue // 跳过非六维效用维度（如 InformationLoss）
      sub[dim] = round3(clamp01(sub[dim] + delta))
    }
    const features = { ...v.features, statisticalCorrectness: buildStatisticalCorrectness(v.chartType, sig) }
    const candidate = {
      candidateId: v.candidateId,
      strategy: v.strategy,
      chartType: v.chartType,
      features,
      score: utilityScore(candidateSubscores(v, sig, sub)),
      executable: !v.infeasibleReason,
      // 条件候选标记：池超限时按效用分确定性裁剪（canonical/core 恒保留）
      ...(coreIds.has(v.candidateId) ? {} : { conditional: true }),
      ...(v.infeasibleReason ? { infeasibleReason: v.infeasibleReason } : {})
    }
    candidate.scoreBreakdown = explainableScore(candidate, sig, { paletteCapacity: 8 })
    pool.push(candidate)
  }
  // 候选池规模约束 K ∈ [6,15]：条件候选过多时按效用分从低到高确定性裁剪。
  // v0.4.2：用户可显式点名的图型（热力/双Y轴/三维/箱线/小提琴/误差棒点图/堆叠/配对/森林）恒保留，
  // 保证 clarify 强制点名不被池裁剪静默吞掉；只裁剩余条件候选（如复合面板降级项）。
  const KEEP_CHART_TYPES = new Set(['dual_axis', 'surface3d', 'scatter3d', 'panel_2x2', 'box_plot', 'violin_plot', 'dot_plot', 'stacked_area', 'paired_dot', 'forest', 'correlation_heatmap'])
  if (pool.length > MAX_POOL_SIZE) {
    const excess = pool.length - MAX_POOL_SIZE
    const droppable = pool.filter((c) => c.conditional && !KEEP_CHART_TYPES.has(c.chartType))
    droppable.sort((a, b) => b.score.total - a.score.total)
    const drop = new Set(droppable.slice(-excess).map((c) => c.candidateId))
    for (let i = pool.length - 1; i >= 0; i--) {
      if (drop.has(pool[i].candidateId)) pool.splice(i, 1)
    }
  }
  return pool
}

/**
 * 候选池 → MMR 选择（生产默认：仅可执行候选可入选，8.4）。
 */
export function evaluateCandidates(analysis, opts = {}) {
  const pool = opts.pool ?? buildCandidatePool(analysis)
  const selection = selectMMR(pool, { k: opts.k ?? 3, lambda: opts.lambda, executableOnly: opts.executableOnly ?? true })
  return { pool, ...selection }
}
