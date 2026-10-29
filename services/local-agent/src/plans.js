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
        title: '趋势 + 分布散点',
        row: 0,
        col: 1,
        layers: layers('scatter', series, 'dens_scatter', false),
        scales: scales(xLabel, yLabel, true),
        legend: legend('legend_norm', 'bottom'),
        annotations: []
      }
    ]
  }
}

function panelFor(kind, id, row, col, xLabel, yLabel, series, { normalized = false, errors = false } = {}) {
  return {
    panel_id: id,
    // 单面板图已经有 figure.title；重复绘制“变量关系/相关性矩阵”会与主标题
    // 叠在一起，尤其在中文字体回退时形成遮挡。仅保留归一化复合面板的语义标题。
    title: normalized ? '相对首点变化 (%)' : '',
    row,
    col,
    layers: layers(kind, series, id, errors),
    scales: scales(xLabel, normalized ? '相对首点变化 (%)' : yLabel, true),
    legend: legend(`${id}_legend`, 'bottom'),
    annotations: normalized ? [{ annotation_id: `${id}_baseline`, kind: 'hline', y: 100, color: '#888888', text: '基准 100%' }] : [],
    ...(errors ? { errorBarMode: 'se', errorBarDefinition: '标准误 SE；每个时间点/分组同时记录有效样本量 n' } : {})
  }
}

function makeCandidateSpec(candidate, strategy, title, xLabel, yLabel, series, extra = {}) {
  // 候选方案在显式图型约束下会复制并改写 candidateId；因此不能只依赖
  // canonical id，否则复制出的折线方案会落入默认四联图并误触发热力图门禁。
  if (candidate.candidateId === 'c_clarity_bar' || candidate.chartType === 'grouped_bar' || candidate.chartType === 'grouped_bar_error') {
    return makeSpec('clarity', title, undefined, xLabel, yLabel, series)
  }
  if (candidate.candidateId === 'c_convention_line_err' || candidate.chartType === 'line_error') {
    return makeSpec('convention', title, undefined, xLabel, yLabel, series)
  }
  if (candidate.candidateId === 'c_density_dual' || candidate.chartType === 'dual_line_normalized') {
    return makeSpec('density', title, undefined, xLabel, yLabel, series)
  }
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
  if (candidate.chartType === 'bubble') {
    return { figure: common, panels: [panelFor('bubble', 'panel_0', 0, 0, xLabel, yLabel, series)] }
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
  if (candidate.chartType === 'lollipop') {
    return { figure: common, panels: [panelFor('lollipop', 'panel_0', 0, 0, xLabel, yLabel, series)] }
  }
  if (candidate.chartType === 'waterfall') {
    return { figure: common, panels: [panelFor('waterfall', 'panel_0', 0, 0, xLabel, yLabel, series)] }
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
  if (candidate.chartType === 'surface3d' || candidate.chartType === 'cone3d' || candidate.chartType === 'line3d' || candidate.chartType === 'filled_line3d') {
    return { figure: common, panels: [panelFor(candidate.chartType, 'panel_0', 0, 0, xLabel, yLabel, series)] }
  }
  if (candidate.chartType === 'scatter3d') {
    return { figure: common, panels: [panelFor('scatter3d', 'panel_0', 0, 0, xLabel, yLabel, series)] }
  }
  // 长表/时间×分组数据只有一个真实测量列时，不能套用宽表 2×2
  // （其中的 heatmap/scatter 会要求两个真实数值字段）。保留信息密度角色，
  // 改为“趋势 + 分布”双面板，两个面板都绑定同一真实测量列。
  if (extra.grouped) {
    return {
      figure: { ...common, rows: 1, cols: 2, widthIn: 10.2, heightIn: 4.2 },
      panels: [
        panelFor('line', 'panel_trend', 0, 0, xLabel, yLabel, series),
        panelFor('box_jitter', 'panel_distribution', 0, 1, xLabel, yLabel, series)
      ]
    }
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
  bubble: '气泡图',
  correlation_heatmap: '相关性热力图',
  dual_line_normalized: '1×2 趋势与归一化复合图',
  dual_line_normalized_2x1: '2×1 趋势与归一化复合图',
  panel_2x2: '2×2 多视图复合图',
  box_plot: '箱线图（含抖动散点）',
  violin_plot: '小提琴图',
  dot_plot: '误差棒点图',
  lollipop: '排名棒棒糖图',
  waterfall: '贡献瀑布图',
  stacked_area: '堆叠柱状图',
  paired_dot: '配对连线图',
  forest: '森林图（均值 ± 95% CI）',
  dual_axis: '双 Y 轴图',
  surface3d: '三维曲面图',
  scatter3d: '三维散点图',
  cone3d: '三维锥状图'
}

// 用户澄清中的图型偏好 → 候选 chartType（buildPlans 据此强制候选进入对应策略）
const CLARIFY_CHARTTYPE_TO_CANDIDATE = Object.freeze({
  heatmap: 'correlation_heatmap',
  dual_axis: 'dual_axis',
  surface3d: 'surface3d',
  scatter3d: 'scatter3d',
  cone3d: 'cone3d',
  line3d: 'line3d',
  filled_line3d: 'filled_line3d',
  line: 'line_error',
  bar: 'grouped_bar',
  grouped_bar: 'grouped_bar',
  scatter: 'point_scatter',
  bubble: 'bubble',
  box: 'box_plot',
  // v0.4.2：新图型可显式点名（clarify 结构化表单的图型偏好映射）
  violin: 'violin_plot',
  dot_plot: 'dot_plot',
  stacked_area: 'stacked_area',
  paired_dot: 'paired_dot',
  forest: 'forest',
  lollipop: 'lollipop',
  waterfall: 'waterfall'
})

// 反馈确认也可能携带用户界面展示的中文图型名称；统一归一化后再进入候选池，
// 避免把“采用二维散点图”当作普通自然语言而丢失图型约束。
export function normalizeRequestedChartType(value) {
  const text = String(value ?? '').trim()
  if (!text) return null
  const direct = Object.keys(CLARIFY_CHARTTYPE_TO_CANDIDATE).find((key) => key === text)
  if (direct) return direct
  if (/三维曲面/.test(text)) return 'surface3d'
  if (/三维散点/.test(text)) return 'scatter3d'
  if (/三维锥|锥状/.test(text)) return 'cone3d'
  if (/三维填充折线|3d.*填充折线/i.test(text)) return 'filled_line3d'
  if (/三维折线|3d.*折线/i.test(text)) return 'line3d'
  if (/热力/.test(text)) return 'heatmap'
  if (/双.?Y轴/.test(text)) return 'dual_axis'
  if (/小提琴/.test(text)) return 'violin'
  if (/箱线/.test(text)) return 'box'
  if (/森林/.test(text)) return 'forest'
  if (/排名|棒棒糖|lollipop/i.test(text)) return 'lollipop'
  if (/瀑布|waterfall/i.test(text)) return 'waterfall'
  if (/堆叠/.test(text)) return 'stacked_area'
  if (/配对.*点|配对连线/.test(text)) return 'paired_dot'
  if (/散点/.test(text)) return 'scatter'
  if (/气泡|bubble/i.test(text)) return 'bubble'
  if (/点图|点状/.test(text)) return 'dot_plot'
  if (/柱|条形/.test(text)) return 'grouped_bar'
  if (/折线/.test(text)) return 'line'
  return null
}

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
      panel.groups = { groupCol: summary.groups.groupCol, measure: summary.groups.measure, xCol: summary.groups.xCol ?? null }
      panel.errorBarMode = 'se'
      panel.errorBarDefinition = '标准误 SE；每个时间点/分组记录有效样本量 n'
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
  const { fileName, titleBase, engine = 'python', executed = false, userRequest = '', preferenceEvents = [], clarification = null, userProfile = null, taskSpec = null } = opts
  const requestedChartType = normalizeRequestedChartType(opts.requestedChartType)
    ?? ((!clarification?.chartType || clarification.chartType === 'auto') ? normalizeRequestedChartType(userRequest) : null)
  const effectiveClarification = requestedChartType ? { ...(clarification ?? {}), chartType: requestedChartType } : clarification
  const requestedXField = taskSpec?.fieldSlots?.xField ?? null
  const requestedYField = taskSpec?.fieldSlots?.yField ?? null
  const requestedZField = taskSpec?.fieldSlots?.zField ?? null
  const xLabel = requestedXField || summary.xLabel
  const requestedXLabel = /(?:横轴|[xX]轴)(?:名称|标题)?\s*(?:为|是|=|：|:)\s*([^，,。;；\n]+)/.exec(userRequest)?.[1]?.trim()
  const yLabel = requestedYField || /(?:纵轴|[yY]轴)(?:名称|标题)?\s*(?:为|是|=|：|:)\s*([^，,。;；\n]+)/.exec(userRequest)?.[1]?.trim() || '测量值'
  const explicit3dFields = ['surface3d', 'scatter3d', 'cone3d', 'line3d', 'filled_line3d'].includes(effectiveClarification?.chartType)
  const measures = explicit3dFields && requestedXField && requestedYField && requestedZField
    ? [requestedXField, requestedYField, requestedZField]
    : requestedYField && summary.series.some((s) => s.label === requestedYField)
    ? [requestedYField]
    : summary.series.map((s) => s.label)
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
      name: '方案三 · 趋势与分布散点',
      rationale: '信息密度优先：并排呈现原始趋势与观测分布散点，既保留时间变化，也直接暴露离散程度和异常点，适合技术报告比较。',
      chartType: '1×2 复合子图（趋势 + 分布散点）',
      scene: '技术报告/附录，需要同时呈现绝对量与相对变化',
      deps: ['pandas', 'matplotlib']
    }
  }

  // 8.1/8.3：K=6~12 候选池 → 六维效用评分 → MMR（仅可执行候选可入选，8.4）
  // 自动推荐仍要求明确的空间坐标；用户明确点名三维图并提供至少三个真实数值字段时，
  // 允许使用“温度×湿度×响应指标”等科研坐标语义，不把普通组别误判为空间坐标。
  const explicit3d = ['surface3d', 'scatter3d', 'cone3d', 'line3d', 'filled_line3d'].includes(effectiveClarification?.chartType)
  // 结构化三方案提示词明确要求“用户方案 + 系统推荐”时，才允许后两套切换图型；
  // 普通澄清流程继续保持显式图型约束，避免旧任务静默变更。
  const structuredComparison = /(?:plan1\s*=\s*user_request|system_recommended|用户要求.*系统推荐|按用户要求.*系统推荐)/i.test(userRequest)
  const explicit3dReady = explicit3d && Number(analysis.chartContext?.numericMeasureCount ?? 0) >= 3
  const candidateAnalysis = explicit3dReady
    ? { ...analysis, chartContext: { ...analysis.chartContext, spatialReady: true, spatialDiagnostics: { ...(analysis.chartContext?.spatialDiagnostics ?? {}), source: 'explicit_user_request', requiredNumericFields: 3 } } }
    : { ...analysis, chartContext: { ...analysis.chartContext, requestedChartType: effectiveClarification?.chartType } }
  // 长表/时间×分组数据的 summary.series 是“组均值系列”，标签不是原始数值列。
  // 热力图需要至少两个真实数值字段；若直接把组标签传入 codegen，会在真实执行阶段
  // 才触发 HEATMAP_REQUIRES_TWO_NUMERIC_MEASURES。规划阶段提前排除该候选，改由
  // 散点、双 Y 轴或分布图承担多变量表达，避免把可预见的数据形态错误暴露给用户。
  const pool = buildCandidatePool(candidateAnalysis).filter((candidate) => {
    if (candidate.chartType === 'correlation_heatmap' && (summary.groups || summary.timeGrouped)) return false
    // Numeric source fields include the x coordinate; code generation consumes only
    // selected measures. Filter against that same input before choosing candidates.
    const required = ['surface3d', 'scatter3d', 'cone3d', 'line3d', 'filled_line3d'].includes(candidate.chartType) ? 3
      : ['bubble', 'dual_axis', 'paired_dot', 'stacked_area', 'correlation_heatmap'].includes(candidate.chartType) ? 2 : 1
    return measures.length >= required
  })
  // An explicit plot family is a constraint, not a preference competing with MMR.
  // Three alternatives vary presentation while preserving the requested marks.
  const explicitBar = /(?:分组|簇状|柱状|柱形|条形)图|grouped\s*bar|bar\s*(?:chart|plot)/i.test(userRequest)
    || ['bar', 'grouped_bar'].includes(effectiveClarification?.chartType)
  const lambda = opts.lambda ?? DEFAULT_LAMBDA
  const order = ['clarity', 'convention', 'density']
  // 用户澄清明确指定图型时：强制该候选进入对应策略（数据不满足则跳过并在审计中说明）
  const clarifyTarget = effectiveClarification?.chartType && effectiveClarification.chartType !== 'auto'
    ? CLARIFY_CHARTTYPE_TO_CANDIDATE[effectiveClarification.chartType] : null
  const clarifyCandidate = clarifyTarget ? pool.find((c) => c.candidateId === clarifyTarget || c.chartType === clarifyTarget) : null
  const clarifyForced = clarifyCandidate && clarifyCandidate.executable !== false
  const preferenceCandidateId = clarifyForced ? clarifyCandidate.candidateId : null
  const strategyFeatures = (candidate, strategy) => {
    const base = candidate.features ?? {}
    const marks = base.encoding?.marks?.length ? base.encoding.marks : [candidate.chartType]
    const overrides = {
      clarity: {
        layout: { rows: 1, cols: 1, panels: 1 },
        encoding: { ...base.encoding, marks, normalized: false },
        statPresentation: { ...base.statPresentation, raw: false, normalized: false, significance: false },
        color: { mode: 'categorical', monochromePrint: false },
        annotation: { kinds: [], count: 0 }
      },
      convention: {
        layout: { rows: 1, cols: 1, panels: 1 },
        encoding: { ...base.encoding, marks, errorBars: true, normalized: false },
        statPresentation: { ...base.statPresentation, errorBars: true, normalized: false },
        color: { mode: 'categorical', monochromePrint: true },
        annotation: { kinds: ['grid'], count: 1 }
      },
      density: {
        layout: { ...(base.layout ?? { rows: 1, cols: 1, panels: 1 }) },
        encoding: { ...base.encoding, marks },
        statPresentation: { ...base.statPresentation, raw: true },
        color: { mode: 'sequential', monochromePrint: false },
        annotation: { kinds: ['sample_size'], count: 1 }
      }
    }
    return { ...base, chartType: candidate.chartType, strategy, ...overrides[strategy] }
  }
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
      if (preferenceCandidateId && (strategy === 'clarity' || !structuredComparison)) {
        // 第一张严格按用户点名的图型；其余两张是保持同一数据与字段约束的系统推荐替代方案。
        const sameType = pool.find((c) => c.strategy === strategy && c.chartType === clarifyCandidate.chartType && c.executable !== false)
        if (sameType) return { ...sameType, features: strategyFeatures(sameType, strategy) }
        const compatible = pool.find((c) => c.chartType === clarifyCandidate.chartType && c.executable !== false)
        if (compatible) return {
          ...compatible,
          candidateId: `${compatible.candidateId}_${strategy}`,
          strategy,
          features: strategyFeatures(compatible, strategy)
        }
      }
      const picked = pool
        .filter((candidate) => candidate.strategy === strategy && candidate.executable !== false && candidate.candidateId !== preferenceCandidateId)
        .sort((a, b) => b.score.total - a.score.total || a.candidateId.localeCompare(b.candidateId))[0]
      if (structuredComparison && summary.timeGrouped && strategy === 'convention') {
        const base = pool.find((candidate) => candidate.chartType === 'grouped_bar' && candidate.executable !== false)
        if (base) return { ...base, candidateId: 'requested_group_box_convention', chartType: 'box_plot', strategy: 'convention', features: strategyFeatures({ ...base, chartType: 'box_plot' }, 'convention') }
      }
      // 长表只有一个真实测量列时，密度推荐不能退回双指标复合图；
      // 复制可执行的分组柱候选并保留 density 角色，避免把组名当成 CSV 列名。
      if (structuredComparison && strategy === 'density' && (summary.groups || summary.timeGrouped)) {
        const groupedAlternative = pool.find((candidate) => candidate.chartType === 'grouped_bar' && candidate.executable !== false)
        if (groupedAlternative) return { ...groupedAlternative, candidateId: 'requested_group_bar_density', chartType: 'grouped_bar_error', strategy: 'density', features: strategyFeatures({ ...groupedAlternative, chartType: 'grouped_bar_error' }, 'density') }
      }
      return picked
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
      : chartType === 'lollipop' ? 'lollipop'
        : chartType === 'waterfall' ? 'waterfall'
      : chartType === 'box_plot' ? 'box_jitter'
        : chartType === 'violin_plot' ? 'violin'
          : chartType === 'dot_plot' ? 'dotplot'
            : chartType === 'stacked_area' ? 'stacked'
              : chartType === 'paired_dot' ? 'paired'
                : chartType === 'forest' ? 'forest'
                  : chartType.includes('heatmap') ? 'heatmap'
                    : chartType === 'dual_axis' ? 'dual_axis'
                      : chartType === 'surface3d' ? 'surface3d'
                      : chartType === 'cone3d' || chartType === 'line3d' || chartType === 'filled_line3d' ? chartType
                        : chartType === 'scatter3d' ? 'scatter3d'
                            : chartType === 'bubble' ? 'bubble'
                            : chartType.includes('scatter') ? 'scatter'
                            : 'line'
    // v0.4.1/v0.4.2：长表分组形态（分组列+数值列）→ 系列即组均值 ± 标准误（组间比较的标准形态）；
    // 否则保持宽表多测量系列（含 _sd 误差棒）。
    // 复合多面板方案（density：趋势+归一化）与逐行/逐列图型（森林/配对连线/堆叠柱）不采用组均值聚合：
    // forest 需要逐条目 CI、paired 需要逐行配对、stacked 需要逐行多系列累加，保持原始行语义。
    const timeGroupedShape = summary.timeGrouped
      ? {
          groupCol: summary.groupLabel,
          measure: summary.measureLabel,
          xCol: summary.xLabel,
          x: summary.x,
          series: (summary.series ?? []).map((item) => ({
            id: item.id,
            label: item.label,
            y: item.y,
            yerr: item.yerr,
            sd: item.sd,
            n: item.n,
            ciLow: item.ciLow,
            ciHigh: item.ciHigh,
            values: item.values
          }))
        }
      : null
    // 分组/时间聚合是数据语义，不应因展示策略切换而丢失。此前 density
    // 策略跳过 groupsShape，导致系列标签（如“对照组”）被当成 CSV 列名。
    // 只有逐行语义的森林图、配对图和堆叠图例外保留原始行结构。
    // 复合密度方案也必须沿用长表的真实分组聚合；否则会把“对照组”等组值
    // 当作 CSV 列名传给折线/散点代码，导致 FIELD/field.missing 并让第三套方案
    // 在真实执行阶段失效。逐条目图型仍保留原始行语义。
    const keepGroupedDensity = summary.timeGrouped || strategy !== 'density' || explicitBar || structuredComparison
    const groupsShape = (summary.groups ?? timeGroupedShape) && keepGroupedDensity && !['forest', 'paired_dot', 'stacked_area', 'lollipop', 'waterfall'].includes(candidate.chartType)
      ? (summary.groups ?? timeGroupedShape) : null
    const isTimeGrouped = Boolean(summary.timeGrouped && groupsShape?.xCol)
    const series = groupsShape
      ? groupsShape.series.map((g, i) => ({
          id: g.id,
          label: g.label,
          color: palette.colors[i] ?? palette.colors[palette.colors.length - 1],
          x: groupsShape.x,
          y: isTimeGrouped ? g.y : groupsShape.x.map(label => label === g.label ? g.y : null),
          yerr: isTimeGrouped
            ? (/标准差|standard\s*deviation|(?:^|[^a-z])sd(?:[^a-z]|$)/i.test(userRequest) ? g.sd : g.yerr)
            : groupsShape.x.map(label => label === g.label ? (/标准差|standard\s*deviation|(?:^|[^a-z])sd(?:[^a-z]|$)/i.test(userRequest) ? g.sd : g.yerr) : null),
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
    const { title, caption, typography } = resolvePresentation(effectiveClarification, { title: defaultTitle, figureIndex: 1 })
    const chartExtraMeasures = (summary.groups ?? timeGroupedShape) && candidate.chartType === 'forest' ? [(summary.groups ?? timeGroupedShape).measure] : measures
    const spec = groupsShape
      ? applyGroupAnnotations(makeCandidateSpec(candidate, strategy, title, xLabel, yLabel, series, { grouped: true }), { ...summary, groups: groupsShape }, evidence)
      : makeCandidateSpec(candidate, strategy, title, xLabel, yLabel, series, buildChartExtra(candidate.chartType, chartExtraMeasures, evidence))
    const spatialMeasures = ['surface3d', 'scatter3d', 'cone3d', 'line3d', 'filled_line3d'].includes(candidate.chartType)
      ? (requestedZField && requestedXField && requestedYField
        ? [requestedXField, requestedYField, requestedZField]
        : (analysis.chartContext?.spatialFields ?? []).slice(0, 3))
      : measures
    const isSpatialCandidate = ['surface3d', 'scatter3d', 'cone3d', 'line3d', 'filled_line3d'].includes(candidate.chartType)
    // 保持原始测量系列顺序，避免证据账本按序号绑定时发生错位；三维 X 轴补充系列放在末尾，
    // verify 仍可读取前三个完整轴值，同时温度/湿度/响应指标的描述统计证据保持原绑定。
    const planSeries = isSpatialCandidate
      ? [...series, { id: 'spatial_x', label: requestedXField || xLabel, y: (summary.x ?? []).map(Number), values: (summary.x ?? []).map(Number), synthetic: true }]
      : series
    spec.figure.displayedFields = [xLabel, ...(isSpatialCandidate ? spatialMeasures : measures)].filter(Boolean)
    // 热力图使用项目内置“用户预设一·青蓝递进”：低饱和、色阶柔和，
    // 同时保持从浅青到深蓝的明暗层级，适合 PPT 与报告页面。
    if (candidate.chartType === 'correlation_heatmap') spec.figure.colormap = 'user_ocean'
    // 仅记录真实数据字段；“测量值”等展示性泛称不应被当作字段参与一致性校验。
    spec.figure.titleFields = [requestedYField].filter(Boolean)
    spec.figure.groupField = taskSpec?.fieldSlots?.groupField ?? groupsShape?.groupCol ?? null
    spec.figure.errorField = taskSpec?.fieldSlots?.errorField ?? null
    spec.figure.zField = requestedZField ?? null
    const units = analysis.semanticModel?.units ?? {}
    for (const panel of spec.panels ?? []) for (const scale of panel.scales ?? []) {
      const field = scale.axis === 'x' ? xLabel : yLabel
      const unit = units[field]?.confirmed ?? units[field]?.original
      if (unit) scale.unit = unit
    }
    // 将实际横轴类别数写入规格，供视觉质量门禁阻断“36 个样本编号挤在横轴”的不可读图。
    for (const panel of spec.panels ?? []) {
      const panelKinds = (panel.layers ?? []).map((layer) => layer.kind)
      const needsCategoryDensityGate = panelKinds.some((kind) => ['bar', 'line', 'box_jitter', 'violin', 'lollipop', 'waterfall', 'stacked'].includes(kind))
      if (panel.categoryCount == null && !isSpatialCandidate && needsCategoryDensityGate) {
        panel.categoryCount = Array.isArray(summary.x) ? new Set(summary.x.map(String)).size : undefined
      }
    }
    if (explicitBar) for (const panel of spec.panels) {
      if (strategy === 'convention') {
        panel.barHatch = '//'
        for (const layer of panel.layers) layer.color = '#777777'
      }
      if (strategy === 'density' && groupsShape) { panel.showObservations = true; panel.barAlpha = 0.65 }
    }
    if (groupsShape && /标准差|standard\s*deviation|(?:^|[^a-z])sd(?:[^a-z]|$)/i.test(userRequest)) {
      for (const panel of spec.panels) { panel.errorBarMode = 'sd'; panel.errorBarDefinition = '标准差 SD；每个时间点/分组同时记录有效样本量 n' }
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
    // 三维图的二次处理仅作用于绘图派生数据，原始数据与证据链保持不变。
    if (effectiveClarification?.secondaryProcessing) spec.figure.secondaryProcessing = effectiveClarification.secondaryProcessing
    applyTypographyToSpec(spec, typography)
    // 长表/时间×分组聚合时，series label 是“对照组/处理组”等组值，
    // 真实 CSV 列仍只有 groupsShape.measure（如“响应指标”）。代码生成必须使用后者，
    // 防止把组值误当成不存在的数据列。
    const plottedMeasures = groupsShape
      ? [groupsShape.measure]
      : ((summary.groups ?? timeGroupedShape) && ['forest', 'paired_dot', 'stacked_area'].includes(candidate.chartType) ? [(summary.groups ?? timeGroupedShape).measure] : measures)
    const codegenMeasures = spatialMeasures.length >= 3 && !groupsShape ? spatialMeasures : plottedMeasures
    const codegenInput = {
      fileName, x: xLabel, xLabel: requestedXLabel || xLabel, measures: codegenMeasures,
      title, yLabel, outputBase: planId, dpi: rules.dpi, fontFamily: rules.font,
      minFontSize: rules.minFontSize,
      colors: explicitBar && strategy === 'convention' ? ['#777777'] : palette.colors,
      caption: groupsShape ? '点表示组均值，误差线表示系统识别的离散程度；每个时间点按实验组聚合。' : '图表由灵感视界依据数据字段、图表意图与展示偏好自动生成。'
    }
    spec.figure.caption = codegenInput.caption
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
      clarification: effectiveClarification, chartType: candidate.chartType, strategy,
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
          series: planSeries.map((item) => ({
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
      comparisonRole: strategy === 'clarity' && preferenceCandidateId ? 'user_request' : `system_recommended_${strategy}`,
      name: `${m.name.split('·')[0].trim()} · ${chartLabel}`,
      rationale: explicitBar
        ? `遵循指定柱状图：${strategy === 'clarity' ? '突出组均值与误差棒，便于快速比较' : strategy === 'convention' ? '灰度呈现，便于论文黑白打印' : '保留均值误差棒并展示组内原始观测，便于检查数据分布'}。`
        : `${m.rationale} 本次根据数据形态选择 ${chartLabel}。`,
      chartType: chartLabel,
      requestedChartType: effectiveClarification?.chartType ?? 'auto',
      taskSpec: taskSpec ? { fieldSlots: taskSpec.fieldSlots ?? {}, pendingFields: taskSpec.pendingFields ?? [] } : null,
      engine,
      spec,
      series: planSeries,
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
      chartType: effectiveClarification?.chartType ?? 'auto',
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
