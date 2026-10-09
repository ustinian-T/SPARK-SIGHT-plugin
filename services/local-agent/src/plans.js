// 方案生成层：基于同一次确定性统计结果（ANALYZE 仅执行一次）构造候选池并经 MMR 选出三套差异化方案。
// 对应算法说明书第 8 节：K=6~9 候选（当前 K=8）、清晰/惯例/密度三策略、六维效用评分、
// 六类设计特征相似度与 Score(c)=U(c)-λ·max Sim 的 MMR 选择、最终三套至少两个维度不同；
// 三方案共享同一 evidenceIds，禁止重复统计（ADR-04）。
// 注意：权重/λ/子分均为初始启发式配置（非训练所得），评测基线见 scripts/eval-decision.mjs。
import { attachSourceMetadata, generateCode, generateCodeForSpec } from './codegen.js'
import {
  DEFAULT_LAMBDA,
  buildCandidatePool,
  selectMMR,
  candidateSimilarity,
  diffDimensionLabels
} from './decision/index.js'
import { recommendPalette } from './palettes.js'
import { buildColorProfile } from './colorLearning.js'
import { applyTypographyToSpec, resolvePresentation, sanitizeFigureTitle } from './typography.js'
import { defaultCaption } from './plotRules.js'
import { buildInterpretation } from './interpretation.js'
import { applyPresentationChoices } from './presentationChoices.js'


const legend = (id, position, title) => ({ legend_id: id, visible: true, position, title })
const scales = (xLabel, yLabel, grid) => [
  { scale_id: 'scale_x', axis: 'x', label: xLabel, type: 'linear', grid: false },
  { scale_id: 'scale_y', axis: 'y', label: yLabel, type: 'linear', grid }
]
function layers(kind, series, prefix, errors) {
  return series.map((s, i) => ({
    layer_id: `${prefix}_layer_${i}`,
    kind,
    dataRef: s.id,
    label: s.label,
    color: s.color,
    // 冗余编码启用时优先使用系列自带的线型/点型；否则按 kind 默认
    marker: s.marker ?? (kind === 'line' ? ['o', 's', '^', 'D'][i % 4] : undefined),
    lineWidth: kind === 'line' ? 1.4 : undefined,
    linestyle: s.linestyle ?? '-',
    showErrorBars: errors && !!s.yerr,
    alpha: 0.92
  }))
}

function makeSpec(strategy, title, subtitle, xLabel, yLabel, series) {
  const common = {
    figure_id: `fig_${strategy}`,
    title,
    subtitle,
    dpi: 160,
    background: '#FFFFFF',
    fontFamily: strategy === 'convention' ? 'serif' : 'sans-serif'
  }
  if (strategy === 'clarity') {
    return {
      figure: { ...common, widthIn: 7.2, heightIn: 4.4, rows: 1, cols: 1, theme: 'clarity' },
      panels: [
        {
          panel_id: 'panel_0',
          title: '',
          row: 0,
          col: 0,
          layers: layers('bar', series, 'clarity', false),
          scales: scales(xLabel, yLabel, false),
          legend: legend('legend_0', 'top'),
          annotations: []
        }
      ]
    }
  }
  if (strategy === 'convention') {
    return {
      figure: { ...common, widthIn: 6.8, heightIn: 4.6, rows: 1, cols: 1, theme: 'convention' },
      panels: [
        {
          panel_id: 'panel_0',
          title: '',
          row: 0,
          col: 0,
          layers: layers('line', series, 'conv', true),
          scales: scales(xLabel, yLabel, true),
          legend: legend('legend_0', 'top'),
          annotations: []
        }
      ]
    }
  }
  return {
    figure: { ...common, widthIn: 10.2, heightIn: 4.2, rows: 1, cols: 2, theme: 'density' },
    panels: [
      {
        panel_id: 'panel_raw',
        title: '原始趋势',
        row: 0,
        col: 0,
        layers: layers('line', series, 'dens_raw', false),
        scales: scales(xLabel, yLabel, true),
        legend: legend('legend_raw', 'bottom'),
        annotations: []
      },
      {
        panel_id: 'panel_norm',
        title: '相对首点变化 (%)',
        row: 0,
        col: 1,
        layers: layers('line', series, 'dens_norm', false),
        scales: scales(xLabel, '相对首点变化 (%)', true),
        legend: legend('legend_norm', 'bottom'),
        annotations: [{ annotation_id: 'ann_baseline', kind: 'hline', y: 100, color: '#888888', text: '基准 100%' }]
      }
    ]
  }
}

function panelFor(kind, id, row, col, xLabel, yLabel, series, { normalized = false, errors = false } = {}) {
  return {
    panel_id: id,
    title: kind === 'heatmap' ? '相关性矩阵' : kind === 'scatter' ? '变量关系' : normalized ? '相对首点变化 (%)' : '',
    row,
    col,
    layers: layers(kind, series, id, errors),
    scales: scales(xLabel, normalized ? '相对首点变化 (%)' : yLabel, true),
    legend: legend(`${id}_legend`, 'bottom'),
    annotations: normalized ? [{ annotation_id: `${id}_baseline`, kind: 'hline', y: 100, color: '#888888', text: '基准 100%' }] : []
  }
}

function makeCandidateSpec(candidate, strategy, title, xLabel, yLabel, series, extra = {}) {
  if (candidate.candidateId === 'c_clarity_bar') return makeSpec('clarity', title, undefined, xLabel, yLabel, series)
  if (candidate.candidateId === 'c_convention_line_err') return makeSpec('convention', title, undefined, xLabel, yLabel, series)
  if (candidate.candidateId === 'c_density_dual') return makeSpec('density', title, undefined, xLabel, yLabel, series)
  const layout = candidate.features.layout
  const common = {
    figure_id: `fig_${candidate.candidateId}`,
    title,
    dpi: 160,
    background: '#FFFFFF',
    fontFamily: strategy === 'convention' ? 'serif' : 'sans-serif',
    widthIn: layout.cols > 1 ? 10.2 : 7.2,
    heightIn: layout.rows > 1 ? 8 : 4.6,
    rows: layout.rows,
    cols: layout.cols,
    theme: strategy
  }
  if (candidate.chartType === 'grouped_bar_error') {
    return { figure: common, panels: [panelFor('bar', 'panel_0', 0, 0, xLabel, yLabel, series, { errors: true })] }
  }
  if (candidate.chartType === 'point_scatter') {
    return { figure: common, panels: [panelFor('scatter', 'panel_0', 0, 0, xLabel, yLabel, series)] }
  }
  if (candidate.chartType === 'correlation_heatmap') {
    return { figure: common, panels: [panelFor('heatmap', 'panel_0', 0, 0, xLabel, yLabel, series)] }
  }
  // v0.4.2 真图型：箱线+抖动 / 小提琴 / 误差棒点图（分组语义由 applyGroupAnnotations 注入）
  if (candidate.chartType === 'box_plot') {
    return { figure: common, panels: [panelFor('box_jitter', 'panel_0', 0, 0, xLabel, yLabel, series)] }
  }
  if (candidate.chartType === 'violin_plot') {
    return { figure: common, panels: [panelFor('violin', 'panel_0', 0, 0, xLabel, yLabel, series)] }
  }
  if (candidate.chartType === 'dot_plot') {
    return { figure: common, panels: [panelFor('dotplot', 'panel_0', 0, 0, xLabel, yLabel, series)] }
  }
  // v0.4.2：堆叠柱状（多系列正值累加）
  if (candidate.chartType === 'stacked_area') {
    return { figure: common, panels: [panelFor('stacked', 'panel_0', 0, 0, xLabel, yLabel, series)] }
  }
  // v0.4.2：配对连线图（两列等长逐观测配对，配对 t 检验证据注入 panel.pairedNote）
  if (candidate.chartType === 'paired_dot') {
    const panel = panelFor('paired', 'panel_0', 0, 0, xLabel, yLabel, series)
    if (extra.pairedColumns) panel.paired = extra.pairedColumns
    if (extra.pairedNote) panel.pairedNote = extra.pairedNote
    return { figure: common, panels: [panel] }
  }
  // v0.4.2：森林图（逐条目均值 ± 95% CI + 参考线；CI 列缺失时按 _sd/_se 后缀近似）
  if (candidate.chartType === 'forest') {
    const panel = panelFor('forest', 'panel_0', 0, 0, xLabel, yLabel, series)
    if (extra.forest) panel.forest = extra.forest
    return { figure: common, panels: [panel] }
  }
  if (candidate.chartType === 'dual_line_normalized_2x1') {
    return {
      figure: common,
      panels: [
        panelFor('line', 'panel_raw', 0, 0, xLabel, yLabel, series),
        panelFor('line', 'panel_norm', 1, 0, xLabel, yLabel, series, { normalized: true })
      ]
    }
  }
  // 扩展图型：双 Y 轴 / 三维曲面 / 三维散点（v0.4 §10.5-10.6）
  if (candidate.chartType === 'dual_axis') {
    return { figure: common, panels: [panelFor('dual_axis', 'panel_0', 0, 0, xLabel, yLabel, series)] }
  }
  if (candidate.chartType === 'surface3d') {
    return { figure: common, panels: [panelFor('surface3d', 'panel_0', 0, 0, xLabel, yLabel, series)] }
  }
  if (candidate.chartType === 'scatter3d') {
    return { figure: common, panels: [panelFor('scatter3d', 'panel_0', 0, 0, xLabel, yLabel, series)] }
  }
  return {
    figure: common,
    panels: [
      panelFor('line', 'panel_line', 0, 0, xLabel, yLabel, series),
      panelFor('bar', 'panel_bar', 0, 1, xLabel, yLabel, series),
      panelFor('scatter', 'panel_scatter', 1, 0, xLabel, yLabel, series),
      panelFor('heatmap', 'panel_heatmap', 1, 1, xLabel, yLabel, series)
    ]
  }
}

const CHART_LABEL = {
  grouped_bar: '分组柱状图',
  grouped_bar_error: '分组柱状图（误差棒）',
  line_error: '多系列折线图（误差棒）',
  point_scatter: '双变量散点图',
  correlation_heatmap: '相关性热力图',
  dual_line_normalized: '1×2 趋势与归一化复合图',
  dual_line_normalized_2x1: '2×1 趋势与归一化复合图',
  panel_2x2: '2×2 多视图复合图',
  box_plot: '箱线图（含抖动散点）',
  violin_plot: '小提琴图',
  dot_plot: '误差棒点图',
  stacked_area: '堆叠柱状图',
  paired_dot: '配对连线图',
  forest: '森林图（均值 ± 95% CI）',
  dual_axis: '双 Y 轴图',
  surface3d: '三维曲面图',
  scatter3d: '三维散点图'
}

// 用户澄清中的图型偏好 → 候选 chartType（buildPlans 据此强制候选进入对应策略）
const CLARIFY_CHARTTYPE_TO_CANDIDATE = Object.freeze({
  heatmap: 'correlation_heatmap',
  dual_axis: 'dual_axis',
  surface3d: 'surface3d',
  scatter3d: 'scatter3d',
  line: 'line_error',
  bar: 'grouped_bar',
  grouped_bar: 'grouped_bar',
  scatter: 'point_scatter',
  box: 'box_plot',
  // v0.4.2：新图型可显式点名（clarify 结构化表单的图型偏好映射）
  violin: 'violin_plot',
  dot_plot: 'dot_plot',
  stacked_area: 'stacked_area',
  paired_dot: 'paired_dot',
  forest: 'forest'
})

function requestedRules(text = '') {
  const dpi = Math.min(600, Math.max(150, Number(/DPI\s*=\s*(\d+)/i.exec(text)?.[1] ?? 300)))
  const font = /字体\s*=\s*([^;\n]+)/.exec(text)?.[1]?.trim() || 'SimHei'
  const minFontSize = Math.min(16, Math.max(10, Number(/最小字号\s*=\s*(\d+)/.exec(text)?.[1] ?? 10)))
  return { dpi, font, minFontSize }
}

// v0.4.2：配对连线/森林图的面板附加信息（pairedColumns/pairedNote/forest 列名）。
// 配对 t 检验数字来自证据账本 ev_ttest_paired；森林图 CI 列缺失时由 codegen 按 _sd/_se 后缀近似。
function buildChartExtra(chartType, measures, evidence) {
  if (chartType === 'paired_dot' && measures.length >= 2) {
    const extra = { pairedColumns: { left: measures[0], right: measures[1] } }
    const pairedEv = evidence.find((e) => e.evidence_id === 'ev_ttest_paired')
    if (pairedEv?.details?.performed) {
      extra.pairedNote = `配对 t 检验：p=${pairedEv.details.pValue}（df=${pairedEv.details.df}，Δmean=${pairedEv.details.meanDiff}）`
    }
    return extra
  }
  if (chartType === 'forest' && measures.length >= 1) {
    return { forest: { mean: measures[0], ciLow: null, ciHigh: null } }
  }
  return {}
}

// v0.4.1/v0.4.2：长表分组形态下，把组均值/标准误与 Holm 校正后的显著配对注入 spec.panel，
// 驱动 codegen 的分组误差棒（默认标准误）与图上显著性星号标注；可注入图型=分组柱/折线/箱线+抖动/小提琴/误差棒点图。
function applyGroupAnnotations(spec, summary, evidence) {
  if (!summary?.groups) return spec
  const pairs = (evidence ?? [])
    .filter((e) => e.tool === 'stats.t_test' && e.evidence_id?.startsWith('ev_ttest_group_') && e.details?.performed && (e.details.pAdjusted ?? 1) < 0.05)
    .map((e) => ({ left: e.details.left, right: e.details.right, stars: e.details.stars ?? '*', pValue: e.details.pAdjusted }))
  for (const panel of spec.panels ?? []) {
    const kind = panel.layers?.[0]?.kind
    if (kind === 'bar' || kind === 'line' || kind === 'box_jitter' || kind === 'violin' || kind === 'dotplot') {
      panel.groups = { groupCol: summary.groups.groupCol, measure: summary.groups.measure }
      panel.errorBarMode = 'se'
      panel.confidenceBand = kind === 'line'
      if (pairs.length) panel.significance = pairs
    }
  }
  return spec
}

/**
 * 三方案组装（确定性，无随机种子）。
 * @param {object} analysis runDeterministicAnalysis 的输出（summary/evidence/claims）
 * @param {object} opts {fileName, titleBase, engine, executed}
 */
export function buildPlans(analysis, opts) {
  const { summary, evidence, claims } = analysis
  const { fileName, titleBase, engine = 'python', executed = false, userRequest = '', preferenceEvents = [], clarification = null, userProfile = null } = opts
  const xLabel = summary.xLabel
  const requestedXLabel = /(?:横轴|[xX]轴)(?:名称|标题)?\s*(?:为|是|=|：|:)\s*([^，,。;；\n]+)/.exec(userRequest)?.[1]?.trim()
  const yLabel = /(?:纵轴|[yY]轴)(?:名称|标题)?\s*(?:为|是|=|：|:)\s*([^，,。;；\n]+)/.exec(userRequest)?.[1]?.trim() || '测量值'
  const measures = summary.series.map((s) => s.label)
  const evidenceIds = evidence.map((e) => e.evidence_id)
  const sharedSummary =
    `${summary.series.length} 个测量系列 × ${summary.x.length} 个观测点；统计仅执行一次，三方案共享证据账本。` +
    `关键结论（均绑定证据）：${claims.map((claim) => `${claim.text} [${claim.evidenceId}]`).join('；')}。` +
    (executed
      ? '代码已在受控沙箱执行并通过验证。'
      : '代码将在受控沙箱中真实执行，SVG/PNG 产物经独立验证（规格/证据/差异）后展示；初次执行失败会按七类错误签名自动修复（最多 3 次）。')

  const meta = {
    clarity: {
      name: '方案一 · 分组对比柱状图',
      rationale: '信息清晰优先：以分组柱状直接对比各处理在每个观测点的差异，减少装饰元素，字号与对比更强，适合快速读出组间高低。',
      chartType: '分组柱状图（含误差棒）',
      scene: '需要快速比较组间差异、用于汇报开场或结论页',
      deps: ['pandas', 'numpy', 'matplotlib']
    },
    convention: {
      name: '方案二 · 趋势误差棒折线图',
      rationale: '论文惯例优先：衬线字体、淡网格、折线加误差棒与可受控显著性注释，黑白打印仍可辨，最贴合期刊正文图习惯。',
      chartType: '多系列折线图（误差棒）',
      scene: '论文正文图、强调随时间/剂量趋势与不确定性',
      deps: ['pandas', 'matplotlib']
    },
    density: {
      name: '方案三 · 双面板趋势与相对变化',
      rationale: '信息密度优先：单图并排呈现原始趋势与相对首点变化率，兼顾绝对水平与增长幅度，适合在有限版面承载更多可比信息。',
      chartType: '1×2 复合子图（折线 + 归一化）',
      scene: '技术报告/附录，需要同时呈现绝对量与相对变化',
      deps: ['pandas', 'matplotlib']
    }
  }

  // 8.1/8.3：K=6~12 候选池 → 六维效用评分 → MMR（仅可执行候选可入选，8.4）
  const pool = buildCandidatePool(analysis)
  // An explicit plot family is a constraint, not a preference competing with MMR.
  // Three alternatives vary presentation while preserving the requested marks.
  const explicitBar = /(?:分组|簇状|柱状|柱形|条形)图|grouped\s*bar|bar\s*(?:chart|plot)/i.test(userRequest)
    || ['bar', 'grouped_bar'].includes(clarification?.chartType)
  const lambda = opts.lambda ?? DEFAULT_LAMBDA
  const order = ['clarity', 'convention', 'density']
  // 用户澄清明确指定图型时：强制该候选进入对应策略（数据不满足则跳过并在审计中说明）
  const clarifyTarget = clarification?.chartType && clarification.chartType !== 'auto'
    ? CLARIFY_CHARTTYPE_TO_CANDIDATE[clarification.chartType] : null
  const clarifyCandidate = clarifyTarget ? pool.find((c) => c.candidateId === clarifyTarget || c.chartType === clarifyTarget) : null
  const clarifyForced = clarifyCandidate && clarifyCandidate.executable !== false
  const preferenceCandidateId = clarifyForced ? clarifyCandidate.candidateId : null
  // 每个策略先由全候选池按数据效用选出代表，再执行严格 MMR；保证三套策略各一、图型随数据变化。
  const finalists = order
    .map((strategy) => {
      if (explicitBar) {
        const base = pool.find(c => c.chartType.includes('bar') && c.executable !== false)
        if (base) return {
          ...base, candidateId: `requested_bar_${strategy}`, canonicalPlanId: undefined,
          strategy, chartType: 'grouped_bar_error',
          features: { ...base.features, chartType: 'grouped_bar_error',
            layout: { rows: 1, cols: 1, panels: 1 },
            color: { mode: strategy === 'density' ? 'sequential' : 'categorical', monochromePrint: strategy === 'convention' },
            annotation: { kinds: strategy === 'clarity' ? [] : [strategy === 'convention' ? 'grid' : 'sample_size'], count: strategy === 'clarity' ? 0 : 1 }
          }
        }
      }
      if (preferenceCandidateId) {
        const pref = pool.find((c) => c.strategy === strategy && c.candidateId === preferenceCandidateId)
        if (pref) return pref
      }
      return pool
        .filter((candidate) => candidate.strategy === strategy && candidate.executable !== false && candidate.candidateId !== preferenceCandidateId)
        .sort((a, b) => b.score.total - a.score.total || a.candidateId.localeCompare(b.candidateId))[0]
    })
    .filter(Boolean)
  const selection = selectMMR(finalists, { k: 3, lambda, executableOnly: true, strict: true })
  const mmrByCandidate = new Map(selection.trace.map((t) => [t.candidateId, t]))
  const selectedByStrategy = new Map(selection.selected.map((candidate) => [candidate.strategy, candidate]))

  // 展示顺序固定为清晰→惯例→密度；MMR 实际入选顺序与分数记录在 selectionAudit
  const selectedFeaturesByStrategy = new Map(selection.selected.map((candidate) => [candidate.strategy, candidate.features]))
  const safeTitleBase = sanitizeFigureTitle(titleBase, fileName.replace(/\.csv$/i, ''))
  const plans = order.map((strategy) => {
    const m = meta[strategy]
    const candidate = selectedByStrategy.get(strategy)
    const planId = `plan_${strategy}`
    // 配色学习先验：userProfile 由历史偏好事件在线学习（colorLearning），仅作有界微调
    const learnedProfile = userProfile ?? buildColorProfile(preferenceEvents)
    const palette = recommendPalette({ prompt: clarification?.paletteId ? `配色预设=${clarification.paletteId}; ${userRequest}` : userRequest, chartType: candidate.chartType, strategy, preferenceEvents, seriesCount: summary.series.length, userProfile: learnedProfile })
    // 冗余编码：色板溢出/灰度/CVD 不通过时，为不同系列分配可区分的线型与点型（不再循环复用颜色）
    const redEnc = palette.redundantEncoding ?? { enabled: false, lineStyles: [], markers: [] }
    // v0.4.2：chartType → codegen kind 映射（真图型而非占位）
    const codegenKindOf = (chartType) => chartType.includes('bar') ? 'bar'
      : chartType === 'box_plot' ? 'box_jitter'
        : chartType === 'violin_plot' ? 'violin'
          : chartType === 'dot_plot' ? 'dotplot'
            : chartType === 'stacked_area' ? 'stacked'
              : chartType === 'paired_dot' ? 'paired'
                : chartType === 'forest' ? 'forest'
                  : chartType.includes('heatmap') ? 'heatmap'
                    : chartType === 'dual_axis' ? 'dual_axis'
                      : chartType === 'surface3d' ? 'surface3d'
                        : chartType === 'scatter3d' ? 'scatter3d'
                          : chartType.includes('scatter') ? 'scatter'
                            : 'line'
    // v0.4.1/v0.4.2：长表分组形态（分组列+数值列）→ 系列即组均值 ± 标准误（组间比较的标准形态）；
    // 否则保持宽表多测量系列（含 _sd 误差棒）。
    // 复合多面板方案（density：趋势+归一化）与逐行/逐列图型（森林/配对连线/堆叠柱）不采用组均值聚合：
    // forest 需要逐条目 CI、paired 需要逐行配对、stacked 需要逐行多系列累加，保持原始行语义。
    const groupsShape = summary.groups && (strategy !== 'density' || explicitBar) && !['forest', 'paired_dot', 'stacked_area'].includes(candidate.chartType)
      ? summary.groups : null
    const series = groupsShape
      ? groupsShape.series.map((g, i) => ({
          id: g.id,
          label: g.label,
          color: palette.colors[i] ?? palette.colors[palette.colors.length - 1],
          x: groupsShape.x,
          y: groupsShape.x.map(label => label === g.label ? g.y : null),
          yerr: groupsShape.x.map(label => label === g.label ? (/标准差|standard\s*deviation|(?:^|[^a-z])sd(?:[^a-z]|$)/i.test(userRequest) ? g.sd : g.yerr) : null),
          n: g.n,
          sd: g.sd,
          ciLow: g.ciLow,
          ciHigh: g.ciHigh,
          values: g.values,
          kind: codegenKindOf(candidate.chartType),
          ...(redEnc.enabled ? {
            linestyle: redEnc.lineStyles[i % redEnc.lineStyles.length],
            marker: redEnc.markers[i % redEnc.markers.length]
          } : {})
        }))
      : summary.series.map((s, i) => ({
          id: s.id,
          label: s.label,
          // V2：色板已按 seriesCount 插值扩展，直接按下标取色，不再 i % length 循环
          color: palette.colors[i] ?? palette.colors[palette.colors.length - 1],
          x: summary.x,
          y: s.y,
          yerr: s.yerr,
          values: s.values,
          kind: codegenKindOf(candidate.chartType),
          ...(redEnc.enabled ? {
            linestyle: redEnc.lineStyles[i % redEnc.lineStyles.length],
            marker: redEnc.markers[i % redEnc.markers.length]
          } : {})
        }))
    const chartLabel = CHART_LABEL[candidate.chartType] ?? candidate.chartType
    const defaultTitle = safeTitleBase
    // 澄清结果 → 标题/图注/排版：用户未提供时按科研制图默认
    const { title, caption, typography } = resolvePresentation(clarification, { title: defaultTitle, figureIndex: 1 })
    const spec = groupsShape
      ? applyGroupAnnotations(makeCandidateSpec(candidate, strategy, title, xLabel, yLabel, series), summary, evidence)
      : makeCandidateSpec(candidate, strategy, title, xLabel, yLabel, series, buildChartExtra(candidate.chartType, measures, evidence))
    if (explicitBar) for (const panel of spec.panels) {
      if (strategy === 'convention') {
        panel.barHatch = '//'
        for (const layer of panel.layers) layer.color = '#777777'
      }
      if (strategy === 'density' && groupsShape) { panel.showObservations = true; panel.barAlpha = 0.65 }
    }
    if (groupsShape && /标准差|standard\s*deviation|(?:^|[^a-z])sd(?:[^a-z]|$)/i.test(userRequest)) {
      for (const panel of spec.panels) panel.errorBarMode = 'sd'
      for (const panel of spec.panels) for (const layer of panel.layers ?? []) {
        if (layer.yerr !== undefined) layer.yerr = groupsShape.series.map(g => g.sd)
      }
    }
    if (requestedXLabel) for (const panel of spec.panels) {
      if (panel.layers.some(layer => layer.kind === 'line' || layer.kind === 'bar')) for (const scale of panel.scales) if (scale.axis === 'x') scale.label = requestedXLabel
    }
    const rules = requestedRules(userRequest)
    spec.figure.dpi = rules.dpi
    spec.figure.fontFamily = rules.font
    spec.figure.minFontSize = rules.minFontSize
    spec.figure.avoidOverlap = true
    applyTypographyToSpec(spec, typography)
    const spatialMeasures = candidate.chartType === 'surface3d' || candidate.chartType === 'scatter3d'
      ? (analysis.chartContext?.spatialFields ?? []).slice(0, 3)
      : measures
    const codegenInput = { fileName, x: xLabel, xLabel: requestedXLabel || xLabel, measures: spatialMeasures.length >= 3 ? spatialMeasures : measures, title, yLabel, outputBase: planId, dpi: rules.dpi, fontFamily: rules.font, minFontSize: rules.minFontSize, colors: explicitBar && strategy === 'convention' ? ['#777777'] : palette.colors }
    // v0.4.1：分组形态（spec.panel.groups 已注入）必须走 spec 驱动生成（含组聚合/误差棒/显著性标注）；
    // 宽表 canonical 方案保持既有模板路径（已验证基线）。
    const hasGroupPanels = (spec.panels ?? []).some((panel) => panel.groups)
    applyPresentationChoices(spec, clarification)
    const hasPresentationChoice = clarification?.legendPosition && clarification.legendPosition !== 'auto' || clarification?.labelLanguage && clarification.labelLanguage !== 'auto'
    const code = candidate.canonicalPlanId && !hasGroupPanels && !hasPresentationChoice
      ? attachSourceMetadata(generateCode(strategy, codegenInput), spec)
      : generateCodeForSpec(spec, codegenInput)
    // 与其余两套入选方案的差异维度（六类特征签名实时计算，非手写常量）
    const diffSet = new Set()
    for (const otherStrategy of order.filter((s) => s !== strategy)) {
      const otherFeatures = selectedFeaturesByStrategy.get(otherStrategy)
      if (!otherFeatures) continue
      const sim = candidateSimilarity(candidate.features, otherFeatures)
      for (const d of sim.diffDimensions) diffSet.add(d)
    }
    const mmrTrace = mmrByCandidate.get(candidate.candidateId)
    // v0.4.1：图表解读文案（结构化要点 + 可改写分析段落 + 图注建议），全部数字来自证据账本
    const interpretation = buildInterpretation({
      summary, evidence, claims,
      clarification, chartType: candidate.chartType, strategy,
      title, caption
    })
    const dataProcessingTrace = analysis.processingTrace ? {
      ...analysis.processingTrace,
      plottedFields: {
        x: groupsShape?.groupCol ?? summary.xLabel,
        measures: groupsShape ? [groupsShape.measure] : series.map((item) => item.label)
      },
      operations: [
        ...(analysis.processingTrace.operations ?? []),
        ...(groupsShape ? [{ id: 'plot_group_mean', scope: 'chart', groupField: groupsShape.groupCol, measure: groupsShape.measure, description: '该方案按分组绘制均值与标准误；原始组内观测随 data.csv 保留' }] : [])
      ],
      series: series.map((item) => ({
        field: item.label,
        sourceField: groupsShape ? groupsShape.measure : item.label,
        observed: Array.isArray(item.values) ? item.values.length : 0,
        missing: groupsShape ? null : Math.max(0, (item.y?.length ?? 0) - (item.values?.length ?? 0)),
        plottedRows: groupsShape ? 1 : (item.y?.length ?? 0),
        aggregation: groupsShape ? 'group_mean' : 'none'
      }))
    } : null
    return {
      plan_id: planId,
      candidateId: candidate.candidateId,
      strategy,
      name: `${m.name.split('·')[0].trim()} · ${chartLabel}`,
      rationale: explicitBar
        ? `遵循指定柱状图：${strategy === 'clarity' ? '突出组均值与误差棒，便于快速比较' : strategy === 'convention' ? '灰度呈现，便于论文黑白打印' : '保留均值误差棒并展示组内原始观测，便于检查数据分布'}。`
        : `${m.rationale} 本次根据数据形态选择 ${chartLabel}。`,
      chartType: chartLabel,
      engine,
      spec,
      series,
      score: { ...candidate.score, scoreBreakdown: candidate.scoreBreakdown },
      mmrScore: mmrTrace ? mmrTrace.mmrScore : candidate.score.total,
      mmrUtility: mmrTrace ? mmrTrace.utility : null,
      mmrMaxSimilarity: mmrTrace ? mmrTrace.maxSimilarity : null,
      diffDimensions: diffDimensionLabels([...diffSet]),
      code,
      dependencies: m.deps,
      dataProcessingSummary: sharedSummary,
      dataProcessingTrace,
      dataSuitability: {
        ...(analysis.suitabilityAudit ?? {}),
        chartType: candidate.chartType,
        executable: candidate.executable !== false,
        warnings: [
          ...(analysis.suitabilityAudit?.warnings ?? []),
          ...(candidate.infeasibleReason ? [candidate.infeasibleReason] : []),
          ...(candidate.features?.statisticalCorrectness?.notes ?? [])
        ]
      },
      statisticalCorrectness: candidate.features?.statisticalCorrectness ?? null,
      applicableScene: m.scene,
      palette: { id: palette.id, name: palette.name, source: palette.source, colors: palette.colors, reason: palette.reason, metrics: palette.metrics, warnings: palette.warnings, scoreBreakdown: palette.scoreBreakdown, redundantEncoding: palette.redundantEncoding ?? { enabled: false, lineStyles: [], markers: [] }, interpolated: palette.interpolated ?? false },
      // 标题/图注/排版（科研制图规则）：用户未指定时取默认
      caption,
      typography: {
        fontFamily: typography.fontFamily,
        title: typography.title,
        caption: typography.caption,
        axisLabel: typography.axisLabel,
        tick: typography.tick,
        legend: typography.legend,
        annotation: typography.annotation,
        exportDpi: typography.exportDpi,
        source: typography.source
      },
      insightSummary: interpretation.summaryText,
      focusExplanation: `本方案重点阅读${strategy === 'clarity' ? '组间高低差异' : strategy === 'convention' ? '趋势、误差与不确定性' : '绝对量与相对变化的对应关系'}；字体、DPI、配色等排版参数已单独记录，不作为图表结论。`,
      // 三方案共享同一次统计的证据集合（ADR-04：一次分析、三方案分支）
      evidenceIds,
      // v0.4.1：图表解读文案（结构化要点 + 可改写分析段落 + 图注建议），数字全部可溯源
      interpretation,
      executionStatus: executed ? 'verified' : 'code_generated_not_executed'
    }
  })

  // 候选池审计随数组带出（orchestrator 挂到任务快照）：诚实暴露 K、可执行数、淘汰原因与差异约束
  plans.selectionAudit = {
    K: pool.length,
    lambda,
    executableCount: pool.filter((c) => c.executable !== false).length,
    infeasibleCount: pool.filter((c) => c.executable === false).length,
    selectedCandidateIds: selection.metrics.selectedIds,
    mmrTrace: selection.trace,
    rejected: [
      ...pool.filter((candidate) => candidate.executable === false).map((candidate) => ({ candidateId: candidate.candidateId, reason: candidate.infeasibleReason ?? 'NOT_EXECUTABLE' })),
      ...selection.rejected
    ],
    diversityOk: selection.diversityOk,
    warnings: selection.warnings,
    // 澄清偏好强制结果：用户指定的图型是否进入三套方案
    clarification: {
      chartType: clarification?.chartType ?? 'auto',
      forcedCandidate: clarifyCandidate ? { candidateId: clarifyCandidate.candidateId, chartType: clarifyCandidate.chartType, strategy: clarifyCandidate.strategy } : null,
      forced: Boolean(clarifyForced),
      infeasible: Boolean(clarifyTarget) && !clarifyForced ? (clarifyCandidate?.infeasibleReason ?? 'CANDIDATE_NOT_FOUND') : null,
      note: clarifyTarget && !clarifyForced
        ? `用户指定的图型 ${clarifyTarget} 当前数据不可执行，已回退按数据自动选择`
        : clarifyForced
          ? `用户指定的图型 ${clarifyCandidate.chartType} 已作为对应策略代表进入三套方案`
          : '未指定图型偏好，按数据自动选择'
    },
    // V2 校准指标占位：NDCG@3 基线需人工标注集计算，当前为 null
    calibrationMetrics: {
      candidateCount: pool.length,
      executableCount: pool.filter((c) => c.executable !== false).length,
      ndcgAt3Baseline: null,
      note: '需标注集校准'
    },
    pool: pool.map((c) => ({
      candidateId: c.candidateId,
      strategy: c.strategy,
      chartType: c.chartType,
      utility: c.score.total,
      executable: c.executable !== false,
      infeasibleReason: c.infeasibleReason ?? null
    }))
  }
  return plans
}
