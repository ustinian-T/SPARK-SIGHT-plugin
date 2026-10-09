// 候选方案的六类设计特征签名与相似度（算法说明书 8.3）。
// 纯函数：候选只依赖一个可序列化的特征签名 CandidateFeatures，不依赖 UI、文件系统或运行状态。
import { SIMILARITY_WEIGHTS, SIMILARITY_DIMENSIONS, SIMILARITY_DIM_LABELS, DecisionError } from './weights.js'

/**
 * @typedef {object} CandidateFeatures
 * @property {string} candidateId      候选稳定标识
 * @property {string} [strategy]       clarity|convention|density
 * @property {string} chartType        图型标识，如 grouped_bar / line_error / dual_line_normalized
 * @property {{rows:number, cols:number, panels:number}} layout 布局
 * @property {{marks:string[], xType:string, errorBars:boolean, normalized:boolean}} encoding 视觉编码
 * @property {{raw:boolean, errorBars:boolean, normalized:boolean, significance:boolean}} statPresentation 统计呈现
 * @property {{mode:string, monochromePrint:boolean}} color 配色（mono/categorical/sequential）
 * @property {{kinds:string[], count:number}} annotation 注释
 * @property {boolean} [executable=true] 是否可真实执行（8.4：无法验证的方案不得进入最终三套）
 * @property {string} [infeasibleReason] 不可执行原因
 */

const jaccard = (a, b) => {
  const sa = new Set(a)
  const sb = new Set(b)
  if (sa.size === 0 && sb.size === 0) return 1
  let inter = 0
  for (const x of sa) if (sb.has(x)) inter++
  const union = new Set([...sa, ...sb]).size
  return union === 0 ? 1 : inter / union
}

const boolEq = (a, b) => (a === b ? 1 : 0)

/** 各维度 0~1 相似度；返回 perDim（含每维比较明细） */
function featureSimilarityPerDim(a, b) {
  if (!a || !b) throw new DecisionError('INVALID_CANDIDATE', '相似度计算缺少候选特征')
  const chartType = a.chartType === b.chartType ? 1 : 0

  const panelsA = a.layout?.panels ?? 1
  const panelsB = b.layout?.panels ?? 1
  const layoutSame = a.layout?.rows === b.layout?.rows && a.layout?.cols === b.layout?.cols && panelsA === panelsB
  const layout = layoutSame ? 1 : 1 - Math.abs(panelsA - panelsB) / Math.max(panelsA, panelsB, 2)

  const marksA = a.encoding?.marks ?? []
  const marksB = b.encoding?.marks ?? []
  const encoding =
    0.4 * jaccard(marksA, marksB) +
    0.2 * boolEq(a.encoding?.xType, b.encoding?.xType) +
    0.2 * boolEq(!!a.encoding?.errorBars, !!b.encoding?.errorBars) +
    0.2 * boolEq(!!a.encoding?.normalized, !!b.encoding?.normalized)

  const statKeys = (s) =>
    [
      s?.raw ? 'raw' : null,
      s?.errorBars ? 'errorBars' : null,
      s?.normalized ? 'normalized' : null,
      s?.significance ? 'significance' : null
    ].filter(Boolean)
  const statPresentation = jaccard(statKeys(a.statPresentation), statKeys(b.statPresentation))

  const color =
    0.6 * boolEq(a.color?.mode, b.color?.mode) +
    0.4 * boolEq(!!a.color?.monochromePrint, !!b.color?.monochromePrint)

  const kindsA = a.annotation?.kinds ?? []
  const kindsB = b.annotation?.kinds ?? []
  const countA = a.annotation?.count ?? kindsA.length
  const countB = b.annotation?.count ?? kindsB.length
  const annotation =
    0.7 * jaccard(kindsA, kindsB) +
    0.3 * (Math.max(countA, countB) === 0 ? 1 : 1 - Math.abs(countA - countB) / Math.max(countA, countB))

  return { chartType, layout, encoding, statPresentation, color, annotation }
}

/**
 * 六维加权相似度 Sim(a,b) ∈ [0,1]，对称。
 * @returns {{total:number, perDim:object, diffDimensions:string[]}}
 */
export function candidateSimilarity(a, b, weights = SIMILARITY_WEIGHTS) {
  const perDim = featureSimilarityPerDim(a, b)
  let total = 0
  const diffDimensions = []
  for (const dim of SIMILARITY_DIMENSIONS) {
    total += weights[dim] * perDim[dim]
    // 差异判定：该维相似度低于 0.99 即视为设计维度不同（布尔/集合比较基本只有 0 与 1，少量为比例值）
    if (perDim[dim] < 0.99) diffDimensions.push(dim)
  }
  return { total: Math.round(total * 1000) / 1000, perDim, diffDimensions }
}

/** 差异维度中文标签（供 mmrScore/diffDimensions 展示） */
export function diffDimensionLabels(dims) {
  return dims.map((d) => SIMILARITY_DIM_LABELS[d] ?? d)
}

/** 候选集合两两相似度矩阵与差异维度，用于评测基线 */
export function pairwiseMatrix(candidates, weights = SIMILARITY_WEIGHTS) {
  const pairs = []
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const sim = candidateSimilarity(candidates[i].features ?? candidates[i], candidates[j].features ?? candidates[j], weights)
      pairs.push({
        a: candidates[i].candidateId ?? candidates[i].id,
        b: candidates[j].candidateId ?? candidates[j].id,
        similarity: sim.total,
        diffDimensions: sim.diffDimensions
      })
    }
  }
  return pairs
}

// ---- V2：可解释特征评分（阶段 C，说明书 8.5） ----
// 七个维度均为 0~1 的启发式子分（非训练所得），与六维效用评分并存：
// 效用分决定排序，本 breakdown 向用户解释"为什么这个图型可被理解"。
// informationLoss / occlusionRisk / colorCapacity 等为"越低越好"的风险维度，按定义直接输出。

const clamp01 = (v) => Math.min(1, Math.max(0, v))

/**
 * 统计表达正确性对象（写入 candidate.features.statisticalCorrectness）。
 * @returns {{errorBarSemantics:string, designAppropriate:boolean, notes:string[]}}
 */
export function buildStatisticalCorrectness(chartType, signals) {
  const supportsErrorBars = /line_error|bar_error/.test(chartType)
  const notes = []
  let errorBarSemantics = '无误差棒'
  if (signals.hasErrorBars && supportsErrorBars) {
    const kinds = signals.errorBarKinds ?? []
    const label = kinds.length === 1 && kinds[0] === 'sd' ? 'SD' : kinds.length === 1 && kinds[0] === 'se' ? 'SE' : '数据列定义的误差量（未知语义）'
    errorBarSemantics = `误差棒按 ±${label} 绘制；不得将其解读为置信区间或显著性检验`
    notes.push(kinds.includes('unknown') ? '误差列未能判定为 SD、SE 或 CI；应在图注/方法中注明来源，系统不推断其统计语义。' : `误差棒保留其数据定义（${label}），不将其转换为置信区间或显著性。`)
  } else if (signals.hasErrorBars && !supportsErrorBars) {
    errorBarSemantics = '误差棒在当前图型中不直接呈现，改用分布/汇总通道表达不确定性'
    notes.push('数据含 yerr，但本图型以分布/趋势为主，未叠加误差棒。')
  }
  const distributionChart = /box_plot|violin_plot/.test(chartType)
  if (distributionChart) {
    notes.push('分布类图型汇总分位数/密度，不直接展示单点读数。')
  }
  const normalizedChart = /normalized|stacked/.test(chartType)
  if (normalizedChart) {
    notes.push('归一化/堆叠表达相对量，绝对水平需配合原始面板阅读。')
  }
  // 科研规则 §10.5/§10.6：热力图与三维图/双轴图的统计表达注意事项
  if (/heatmap/.test(chartType)) {
    notes.push('相关性热力图使用蓝白红发散色带，白为 0，色轴范围 [-1, 1]。')
  }
  if (/surface3d|scatter3d/.test(chartType)) {
    notes.push('三维图透视会引入遮挡与读数偏差，需配合旋转视图或补充二维投影。')
  }
  if (/dual_axis/.test(chartType)) {
    notes.push('双 Y 轴须在标题/图注中声明左右轴量纲，避免误导性比较。')
  }
  return { errorBarSemantics, designAppropriate: true, notes }
}

/**
 * 可解释七维评分。
 * @param {object} candidate 候选（含 chartType/features）
 * @param {ReturnType<import('./candidates.js').dataSignals>} signals 数据信号
 * @param {{seriesCount?:number, paletteCapacity?:number}} context 配色/系列上下文
 * @returns {{taskMatch:number, informationLoss:number, occlusionRisk:number, colorCapacity:number, labelDensity:number, statisticalCorrectness:number, runtimeAvailability:number}}
 */
export function explainableScore(candidate, signals, context = {}) {
  const chartType = candidate.chartType ?? candidate.features?.chartType ?? ''
  const seriesCount = context.seriesCount ?? signals.seriesCount
  const paletteCapacity = context.paletteCapacity ?? 8

  // 任务匹配：图型与数据任务（趋势/比较/分布/相关/组成）的契合度
  let taskMatch = 0.6
  if (/line/.test(chartType)) taskMatch = signals.trend ? 0.92 : 0.55
  else if (/heatmap/.test(chartType)) taskMatch = signals.matrixLike ? 0.95 : signals.seriesCount >= 3 ? 0.6 : 0.4
  else if (/surface3d/.test(chartType)) taskMatch = signals.seriesCount >= 3 && signals.obsCount >= 8 ? 0.88 : 0.45
  else if (/scatter3d/.test(chartType)) taskMatch = signals.seriesCount >= 3 ? 0.8 : 0.5
  else if (/dual_axis/.test(chartType)) taskMatch = signals.trend && signals.seriesCount >= 2 ? 0.86 : 0.55
  else if (/scatter|paired_dot/.test(chartType)) taskMatch = signals.trend || seriesCount === 2 ? 0.82 : 0.6
  else if (/box_plot|violin_plot/.test(chartType)) taskMatch = seriesCount >= 3 ? 0.85 : 0.6
  else if (/stacked_area/.test(chartType)) taskMatch = signals.trend && seriesCount >= 3 ? 0.82 : 0.5
  else if (/bar/.test(chartType)) taskMatch = signals.groupComparison || signals.matrixLike ? 0.9 : 0.7

  // 信息损失：0=无损失，1=高损失（归一化/堆叠/分布汇总/相关矩阵会损失原始读数）
  let informationLoss = 0.1
  if (/normalized/.test(chartType)) informationLoss = 0.35
  else if (/stacked/.test(chartType)) informationLoss = 0.3
  else if (/heatmap/.test(chartType)) informationLoss = 0.4
  else if (/box_plot|violin_plot/.test(chartType)) informationLoss = 0.25
  else if (/scatter/.test(chartType)) informationLoss = 0.12
  else if (/surface3d|scatter3d/.test(chartType)) informationLoss = 0.28
  else if (/dual_axis/.test(chartType)) informationLoss = 0.12

  // 遮挡风险：0=几乎不重叠，1=严重重叠（散点/点图随数据量上升）
  const pointVolume = signals.obsCount * seriesCount
  let occlusionRisk = 0.1
  if (/scatter3d|surface3d/.test(chartType)) occlusionRisk = clamp01(pointVolume / 50)
  else if (/scatter|paired_dot/.test(chartType)) occlusionRisk = clamp01(pointVolume / 60)
  else if (/line/.test(chartType)) occlusionRisk = clamp01(pointVolume / 120)
  else if (/box_plot|violin_plot/.test(chartType)) occlusionRisk = 0.15

  // 颜色容量适配：系列数 vs 色板容量（溢出时需冗余编码，容量适配下降）
  const colorCapacity = seriesCount <= paletteCapacity ? 0.95 : 0.4

  // 标签密度：观测点×系列数越多，刻度/图例越密
  const labelDensity = pointVolume > 24 ? 0.4 : pointVolume >= 12 ? 0.7 : 0.9

  // 统计表达正确性：误差棒语义与图型适配
  const sc = buildStatisticalCorrectness(chartType, signals)
  const statisticalCorrectness = signals.hasErrorBars && /line_error|bar_error/.test(chartType) ? 0.92
    : sc.designAppropriate ? 0.8 : 0.5

  // runtime 可用性：Python(materials/R) 真实可渲染度
  const runtimeAvailability = /box_plot/.test(chartType) ? 0.9
    : /violin_plot|stacked_area/.test(chartType) ? 0.75
    : /scatter3d/.test(chartType) ? 0.85
    : /surface3d/.test(chartType) ? 0.8
    : /dual_axis/.test(chartType) ? 0.92
    : /heatmap|scatter|bar|line/.test(chartType) ? 0.95 : 0.8

  return {
    taskMatch: clamp01(Math.round(taskMatch * 1000) / 1000),
    informationLoss: clamp01(Math.round(informationLoss * 1000) / 1000),
    occlusionRisk: clamp01(Math.round(occlusionRisk * 1000) / 1000),
    colorCapacity: clamp01(colorCapacity),
    labelDensity: clamp01(labelDensity),
    statisticalCorrectness: clamp01(Math.round(statisticalCorrectness * 1000) / 1000),
    runtimeAvailability: clamp01(runtimeAvailability)
  }
}
