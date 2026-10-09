// 三方案组装（浏览器内 Mock 演示）：仅构造 K=3 个演示候选，经与真实后端同构的
// 效用评分（lib/decision.ts utilityTotal）与 MMR 选择（selectMMR）产出 mmrScore/差异维度。
// 注意：说明书 8.1 要求 K=6~9，Mock 不满足该规模；真实后端 K=8（见 selectionAudit）。
// 评分权重为初始配置（UTILITY_WEIGHTS），须经用户测试调整，不宣称训练所得。
import type {
  ChartSpec,
  FigureSpec,
  LayerKind,
  LayerSpec,
  PanelSpec,
  PlotPlan,
  PlanStrategy,
  PreviewSeries,
  ScaleSpec,
  LegendSpec,
  UtilityScore
} from '../types'
import { makePreviewSeries, type SummarizeResult } from '../lib/summarize'
import { generateCode } from '../lib/codegen'
import { utilityTotal, candidateSimilarity, selectMMR, type CandidateFeatures, type ScoredCandidate } from '../lib/decision'

const PALETTE: Record<PlanStrategy, string[]> = {
  clarity: ['#99BC99', '#FFCC99', '#99BBDE', '#B6B6FF', '#136764', '#FFA579', '#3E85C5', '#A2A2FF'],
  convention: ['#6E8FB2', '#7DA494', '#EAB67A', '#E5A79A', '#C16E71', '#ABC8E5', '#D8A0C1', '#9F8DB8'],
  density: ['#DDF2F0', '#A6EBDD', '#88C9D0', '#5E8CBE', '#3E5682', '#0F1633']
}

function legend(id: string, position: LegendSpec['position'], title?: string): LegendSpec {
  return { legend_id: id, visible: true, position, title }
}

function scales(xLabel: string, yLabel: string, grid: boolean): ScaleSpec[] {
  return [
    { scale_id: 'scale_x', axis: 'x', label: xLabel, type: 'linear', grid: false },
    { scale_id: 'scale_y', axis: 'y', label: yLabel, type: 'linear', grid }
  ]
}

function layers(kind: LayerKind, series: PreviewSeries[], prefix: string, errors: boolean): LayerSpec[] {
  return series.map((s, i) => ({
    layer_id: `${prefix}_layer_${i}`,
    kind,
    dataRef: s.id,
    label: s.label,
    color: s.color,
    marker: kind === 'line' ? ['o', 's', '^', 'D'][i % 4] : undefined,
    lineWidth: kind === 'line' ? 1.4 : undefined,
    linestyle: '-',
    showErrorBars: errors && !!s.yerr,
    alpha: 0.92
  }))
}

function makeSpec(
  strategy: PlanStrategy,
  title: string,
  subtitle: string | undefined,
  xLabel: string,
  yLabel: string,
  series: PreviewSeries[]
): ChartSpec {
  const common: Omit<FigureSpec, 'widthIn' | 'heightIn' | 'rows' | 'cols' | 'theme'> = {
    figure_id: `fig_${strategy}`,
    title,
    subtitle,
    dpi: 300,
    minFontSize: 10,
    avoidOverlap: true,
    background: '#FFFFFF',
    fontFamily: strategy === 'convention' ? 'serif' : 'sans-serif'
  }
  const hasErr = series.some((s) => !!s.yerr)

  if (strategy === 'clarity') {
    const panel: PanelSpec = {
      panel_id: 'panel_0',
      title: '',
      row: 0,
      col: 0,
      layers: layers('bar', series, 'clarity', false),
      scales: scales(xLabel, yLabel, false),
      legend: legend('legend_0', 'top'),
      annotations: []
    }
    return {
      figure: { ...common, widthIn: 7.2, heightIn: 4.4, rows: 1, cols: 1, theme: 'clarity' },
      panels: [panel]
    }
  }
  if (strategy === 'convention') {
    const panel: PanelSpec = {
      panel_id: 'panel_0',
      title: '',
      row: 0,
      col: 0,
      layers: layers('line', series, 'conv', true),
      scales: scales(xLabel, yLabel, true),
      legend: legend('legend_0', 'top'),
      annotations: []
    }
    return {
      figure: { ...common, widthIn: 6.8, heightIn: 4.6, rows: 1, cols: 1, theme: 'convention' },
      panels: [panel]
    }
  }
  const p1: PanelSpec = {
    panel_id: 'panel_raw',
    title: '原始趋势',
    row: 0,
    col: 0,
    layers: layers('line', series, 'dens_raw', false),
    scales: scales(xLabel, yLabel, true),
    legend: legend('legend_raw', 'bottom'),
    annotations: []
  }
  const p2: PanelSpec = {
    panel_id: 'panel_norm',
    title: '相对首点变化 (%)',
    row: 0,
    col: 1,
    layers: layers('line', series, 'dens_norm', false),
    scales: scales(xLabel, '相对首点变化 (%)', true),
    legend: legend('legend_norm', 'bottom'),
    annotations: [{ annotation_id: 'ann_baseline', kind: 'hline', y: 100, color: '#888888', text: '基准 100%' }]
  }
  return {
    figure: { ...common, widthIn: 10.2, heightIn: 4.2, rows: 1, cols: 2, theme: 'density' },
    panels: [p1, p2]
  }
}

export function buildPlans(
  result: SummarizeResult,
  fileName: string,
  titleBase: string,
  dataProcessingSummary: string
): PlotPlan[] {
  const xLabel = result.xLabel
  const yLabel = '测量值 (response)'
  const measures = result.series.map((s) => s.label)

  const meta: Record<
    PlanStrategy,
    { name: string; rationale: string; chartType: string; scene: string; deps: string[]; s: Omit<UtilityScore, 'total'> }
  > = {
    clarity: {
      name: '方案一 · 分组对比柱状图',
      rationale: '信息清晰优先：以分组柱状直接对比各处理在每个观测点的差异，减少装饰元素，字号与对比更强，适合快速读出组间高低。',
      chartType: '分组柱状图（含误差棒）',
      scene: '需要快速比较组间差异、用于汇报开场或结论页',
      deps: ['pandas', 'numpy', 'matplotlib'],
      s: { DataFit: 0.86, TaskFit: 0.82, Readability: 0.92, ScientificConvention: 0.74, PreferenceFit: 0.7, Executability: 0.95 }
    },
    convention: {
      name: '方案二 · 趋势误差棒折线图',
      rationale: '论文惯例优先：衬线字体、淡网格、折线加误差棒与可受控显著性注释，黑白打印仍可辨，最贴合期刊正文图习惯。',
      chartType: '多系列折线图（误差棒）',
      scene: '论文正文图、强调随时间/剂量趋势与不确定性',
      deps: ['pandas', 'matplotlib'],
      s: { DataFit: 0.88, TaskFit: 0.8, Readability: 0.8, ScientificConvention: 0.94, PreferenceFit: 0.72, Executability: 0.92 }
    },
    density: {
      name: '方案三 · 双面板趋势与相对变化',
      rationale: '信息密度优先：单图并排呈现原始趋势与相对首点变化率，兼顾绝对水平与增长幅度，适合在有限版面承载更多可比信息。',
      chartType: '1×2 复合子图（折线 + 归一化）',
      scene: '技术报告/附录，需要同时呈现绝对量与相对变化',
      deps: ['pandas', 'matplotlib'],
      s: { DataFit: 0.84, TaskFit: 0.78, Readability: 0.66, ScientificConvention: 0.8, PreferenceFit: 0.68, Executability: 0.85 }
    }
  }

  // 三个演示候选的六类设计特征签名（与后端 decision/features.js 同构）
  const features: Record<PlanStrategy, CandidateFeatures> = {
    clarity: {
      chartType: 'grouped_bar',
      layout: { rows: 1, cols: 1, panels: 1 },
      encoding: { marks: ['bar'], xType: 'categorical', errorBars: false, normalized: false },
      statPresentation: { raw: true, errorBars: false, normalized: false, significance: false },
      color: { mode: 'categorical', monochromePrint: false },
      annotation: { kinds: [], count: 0 }
    },
    convention: {
      chartType: 'line_error',
      layout: { rows: 1, cols: 1, panels: 1 },
      encoding: { marks: ['line', 'marker'], xType: 'linear', errorBars: true, normalized: false },
      statPresentation: { raw: true, errorBars: true, normalized: false, significance: false },
      color: { mode: 'categorical', monochromePrint: false },
      annotation: { kinds: ['grid'], count: 1 }
    },
    density: {
      chartType: 'dual_line_normalized',
      layout: { rows: 1, cols: 2, panels: 2 },
      encoding: { marks: ['line', 'marker'], xType: 'linear', errorBars: false, normalized: true },
      statPresentation: { raw: true, errorBars: false, normalized: true, significance: false },
      color: { mode: 'sequential', monochromePrint: false },
      annotation: { kinds: ['hline_baseline', 'panel_title'], count: 3 }
    }
  }

  // Mock 只有 K=3 个演示候选；仍真实执行效用评分 + MMR（与真实后端同算法）
  const candidates: ScoredCandidate[] = (['clarity', 'convention', 'density'] as PlanStrategy[]).map((strategy) => ({
    candidateId: `plan_${strategy}`,
    features: features[strategy],
    score: { ...meta[strategy].s, total: utilityTotal(meta[strategy].s) },
    executable: true
  }))
  const mmr = selectMMR(candidates, 3)
  const lastValues = result.series.map((series) => ({
    label: series.label,
    value: [...series.y].reverse().find((value) => value !== null)
  })).filter((item): item is { label: string; value: number } => typeof item.value === 'number')
  lastValues.sort((a, b) => b.value - a.value)
  const insight = lastValues[0]
    ? `在最后一个观测点，“${lastValues[0].label}”数值最高，为 ${lastValues[0].value.toFixed(2)}；同时可比较各组在整个观测过程中的差距和变化方向。`
    : `图中同时呈现 ${result.series.length} 个系列在 ${result.x.length} 个观测点上的差异与变化。`

  const order: PlanStrategy[] = ['clarity', 'convention', 'density']
  return order.map((strategy) => {
    const m = meta[strategy]
    const planId = `plan_${strategy}`
    const series: PreviewSeries[] = makePreviewSeries(result, strategy === 'clarity' ? 'bar' : 'line', PALETTE[strategy])
    const title =
      strategy === 'clarity'
        ? `${titleBase}（分组对比）`
        : strategy === 'convention'
          ? `${titleBase}（趋势与误差棒）`
          : `${titleBase}（趋势与相对变化）`
    const spec = makeSpec(strategy, title, undefined, xLabel, yLabel, series)
    const code = generateCode(strategy, { fileName, x: xLabel, measures, title, yLabel })
    // 差异维度：与另外两套候选的六维特征比较实时计算
    const diffSet = new Set<string>()
    for (const other of order.filter((s) => s !== strategy)) {
      for (const d of candidateSimilarity(features[strategy], features[other]).diffLabels) diffSet.add(d)
    }
    return {
      plan_id: planId,
      strategy,
      name: m.name,
      rationale: m.rationale,
      chartType: m.chartType,
      engine: 'python',
      spec,
      series,
      score: { ...m.s, total: utilityTotal(m.s) },
      mmrScore: mmr.trace.get(planId)?.mmrScore ?? utilityTotal(m.s),
      diffDimensions: [...diffSet],
      code,
      dependencies: m.deps,
      dataProcessingSummary,
      applicableScene: m.scene,
      insightSummary: insight,
      focusExplanation: strategy === 'clarity'
        ? '重点先看同一观测点各组柱子的高低；排版参数不作为数据结论。'
        : strategy === 'convention'
          ? '重点看折线方向、误差范围以及组间是否持续分离；排版参数不作为数据结论。'
          : '左图看真实数值，右图看相对起点的变化幅度；排版参数不作为数据结论。',
      palette: {
        id: strategy === 'clarity' ? 'user_garden' : strategy === 'convention' ? 'user_nature' : 'user_ocean',
        name: strategy === 'clarity' ? '用户预设二·柔和分类' : strategy === 'convention' ? '用户预设三·自然低饱和' : '用户预设一·青蓝递进',
        source: 'user', colors: PALETTE[strategy], reason: '按当前方案的分类比较或连续趋势用途选择，并保留用户预设优先级。'
      }
    } satisfies PlotPlan
  })
}
