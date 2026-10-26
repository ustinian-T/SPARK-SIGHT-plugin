// 科研制图通用规则库（从《数模国赛MATLAB制图规则 v0.4》提炼的通用精华，跨引擎适用）。
// 只保留"与数据无关、与科研发表通用"的硬约束与默认值：
//   §4 图面与导出（纯白底 / 标题居中 / 字号下限）、§5 配色（Nature 低饱和 + 三种渐变、禁 jet）、
//   §3 命名（中文、无括号、单位斜杠、标题公式"对象+方法+功能"）、§11 图注格式、§13 视觉验收要点。
// 本模块只提供规则与校验，不承担数据解读；禁止把论文风格规则强加为数据结论。
//
// 默认值口径（v0.4 §4.3）：
//   标题 14–16pt 加粗居中；轴标签 12–13pt；刻度 10–11pt；图例 10–11pt；图内标注 10–11pt；任何文字 ≥10pt。

export const PLOT_RULES = Object.freeze({
  // §4.1 纯白底（figure/axes/导出三层）
  background: '#FFFFFF',
  // §4.2 标题居中
  titleAlign: 'center',
  // §4.3 字号（pt）
  fontSizes: {
    title: { min: 14, max: 16, default: 15 },
    axisLabel: { min: 12, max: 13, default: 12.5 },
    tick: { min: 10, max: 11, default: 11 },
    legend: { min: 10, max: 11, default: 11 },
    annotation: { min: 10, max: 11, default: 10.5 },
    minimum: 10
  },
  // §4.3 导出分辨率
  exportDpi: { min: 300, default: 300, max: 600 },
  // 标题布局：多面板图必须由布局引擎预留标题区，禁止把标题压到绘图区上方
  layout: { engine: 'constrained', minTitleSpacing: 1.05, defaultTitleReserve: 0.08 },
  // §3.3 命名：单位一律斜杠、禁止括号（标题/轴标签/图例/图内标注）
  unitSeparator: '/',
  forbidParentheses: true,
  // §3.1 标题公式：对象 + 方法/变量 + 图表功能
  titleFormula: '对象+方法/变量+图表功能',
  // §11 图注格式：图X-X 对象方法功能（无括号）
  captionFormat: /^图\d+(?:-\d+)?\s+.+$/,
  // §5.1 Nature 低饱和基础色板（9 色，v0.4 §5.1 原样）
  naturePalette: ['#6E8FB2', '#7DA494', '#EAB67A', '#E5A79A', '#C16E71', '#ABC8E5', '#D8A0C1', '#9F8DB8', '#D0D08A'],
  // §5.4 禁彩虹色
  forbiddenColormaps: ['jet', 'hsv', 'rainbow', 'turbo', 'gist_rainbow'],
  // §5.3 主色上限（不含灰度/低透明度辅助色）
  maxDistinctColors: 4,
  // §6.2 同一样式整篇最多出现次数
  styleReuseLimit: 2
})

/**
 * 解析 Hex 颜色并校验是否合法；非法返回 null。
 */
export function isValidHex(hex) {
  return typeof hex === 'string' && /^#(?:[0-9a-f]{6}|[0-9a-f]{3})$/i.test(hex.trim())
}

/**
 * 标题/轴标签等文本的括号校验（§3.3）。
 * @param {string} text
 * @returns {{ok: boolean, reason?: string}}
 */
export function checkNoParentheses(text) {
  if (!text) return { ok: true }
  if (/[()（）]/.test(text)) {
    return { ok: false, reason: `文本含括号：${text}；单位请改用斜杠（如 日均发电量/kWh）` }
  }
  return { ok: true }
}

/**
 * 图注格式校验（§11：图X-X 对象方法功能，无括号）。
 */
export function checkCaption(caption) {
  if (!caption || !String(caption).trim()) return { ok: false, reason: '图注不能为空（格式：图X-X 对象方法功能）' }
  if (!PLOT_RULES.captionFormat.test(String(caption).trim())) {
    return { ok: false, reason: `图注格式不符：${caption}；应为「图X-X 对象方法功能」` }
  }
  return checkNoParentheses(String(caption))
}

/**
 * 依据规则校验 ChartSpec（图面/命名/字号/配色），返回违规清单（全部项）。
 * @param {object} spec ChartSpec
 * @returns {Array<{rule:string, level:'error'|'warn', message:string}>}
 */
export function validateSpecAgainstRules(spec) {
  const violations = []
  if (!spec?.figure) return [{ rule: 'figure', level: 'error', message: '规格缺少 figure 节点' }]

  if (!String(spec.figure.title ?? '').trim()) {
    violations.push({ rule: 'title_required', level: 'error', message: '正式科研图必须有总标题，不能只依赖图注' })
  }
  const panelCount = (Number(spec.figure.rows) || 1) * (Number(spec.figure.cols) || 1)
  if (panelCount > 1 && spec.figure.layoutEngine === 'tight') {
    violations.push({ rule: 'title_overlap_risk', level: 'error', message: '多面板图禁止使用 tight 布局；它可能把总标题压到子图标题或刻度上' })
  } else if (panelCount > 1 && !spec.figure.layoutEngine) {
    violations.push({ rule: 'title_layout_unspecified', level: 'warn', message: '多面板图未声明标题布局引擎；导出前必须使用 constrained/loose 布局并做 PNG 视觉验收' })
  }
  if (Number.isFinite(Number(spec.figure.titleSpacing)) && Number(spec.figure.titleSpacing) < PLOT_RULES.layout.minTitleSpacing) {
    violations.push({ rule: 'title_spacing', level: 'warn', message: `标题字距 ${spec.figure.titleSpacing} 过小，长标题更容易与图面重叠` })
  }

  // 纯白底（§4.1）
  if (spec.figure.background && String(spec.figure.background).toUpperCase() !== '#FFFFFF') {
    violations.push({ rule: 'white_background', level: 'error', message: `图底必须纯白（当前 ${spec.figure.background}）` })
  }
  // 标题居中（§4.2）
  if (spec.figure.titleAlign && spec.figure.titleAlign !== 'center') {
    violations.push({ rule: 'title_center', level: 'warn', message: `标题应水平居中（当前 ${spec.figure.titleAlign}）` })
  }
  // 字号（§4.3）
  const min = Number(spec.figure.minFontSize)
  if (Number.isFinite(min) && min > 0 && min < PLOT_RULES.fontSizes.minimum) {
    violations.push({ rule: 'min_font_size', level: 'error', message: `最小字号 ${min}pt 低于 10pt 下限` })
  }
  const titleSize = Number(spec.figure.titleFontSize)
  if (Number.isFinite(titleSize) && titleSize > 0 && titleSize < PLOT_RULES.fontSizes.title.min) {
    violations.push({ rule: 'title_font_size', level: 'warn', message: `标题字号 ${titleSize}pt 低于推荐 14pt` })
  }
  // 命名无括号（§3.3）：产品内部标题含「标题（图型名）」复合、轴标签含英文注释时为正常产品约定，
  // 因此该规则在验证层为建议级（warn）；硬阻断仅保留：非白底、字号<10、热力图彩虹色。
  const titleCheck = checkNoParentheses(spec.figure.title)
  if (!titleCheck.ok) violations.push({ rule: 'no_parentheses_title', level: 'warn', message: titleCheck.reason })
  for (const panel of spec.panels ?? []) {
    const categoryCount = Number(panel.categoryCount ?? panel.xCategoryCount ?? spec.figure.xCategoryCount)
    if (Number.isFinite(categoryCount) && categoryCount > 24) {
      violations.push({ rule: 'x_label_density', level: 'error', message: `横轴包含 ${categoryCount} 个类别，标签将难以辨认；请按时间/分组聚合、分面或改用点图` })
    } else if (Number.isFinite(categoryCount) && categoryCount > 12) {
      violations.push({ rule: 'x_label_density', level: 'warn', message: `横轴包含 ${categoryCount} 个类别，建议旋转标签或改用更稀疏的展示方式` })
    }
    const scaleUnits = (panel.scales ?? []).filter(s => s?.unit).map(s => `${s.axis ?? 'unknown'}:${s.unit}`)
    const yUnits = (panel.scales ?? []).filter(s => s?.axis === 'y' && s?.unit).map(s => s.unit)
    if (new Set(yUnits).size > 1 && !['dual_axis', 'dual_y'].includes(String(panel.type ?? panel.chartType))) {
      violations.push({ rule: 'mixed_units_single_axis', level: 'error', message: `同一纵轴混用了不同单位（${[...new Set(yUnits)].join('、')}），请拆分面板或明确使用双 Y 轴` })
    }
    if (panel.chartType === 'dual_axis' || panel.type === 'dual_axis') {
      const axisCount = new Set((panel.scales ?? []).filter(s => /^y/.test(String(s.axis))).map(s => s.axis)).size
      if (axisCount > 2) violations.push({ rule: 'dual_axis_limit', level: 'error', message: '双 Y 轴图最多允许两个明确的 Y 轴' })
    }
    for (const scale of panel.scales ?? []) {
      const sc = checkNoParentheses(scale.label)
      if (!sc.ok) violations.push({ rule: 'no_parentheses_axis', level: 'warn', message: sc.reason })
    }
    for (const layer of panel.layers ?? []) {
      if (layer.kind === 'heatmap') {
        const cm = String(spec.figure.colormap ?? '').toLowerCase()
        if (PLOT_RULES.forbiddenColormaps.some((name) => cm.includes(name))) {
          violations.push({ rule: 'no_rainbow_colormap', level: 'error', message: `热力图禁止使用彩虹色（${cm}）` })
        }
      }
    }
  }
  // 配色数量（§5.3，仅提示：颜色来自推荐器时通常已合规）
  const colors = spec.figure.paletteColors ?? spec.panels?.flatMap((p) => p.layers ?? []).map((l) => l.color).filter(Boolean) ?? []
  const distinct = new Set(colors)
  if (distinct.size > PLOT_RULES.maxDistinctColors) {
    violations.push({ rule: 'max_colors', level: 'warn', message: `高区分度颜色 ${distinct.size} 种超过推荐上限 ${PLOT_RULES.maxDistinctColors} 种` })
  }
  return violations
}

/** 将用户明确点名的图型与最终渲染图型做硬一致性校验。 */
export function checkRequestedChartType(requested, actual) {
  const req = String(requested ?? '').trim().toLowerCase()
  const got = String(actual ?? '').trim().toLowerCase()
  if (!req || req === 'auto' || !got) return { ok: true }
  const aliases = {
    bar: ['bar', 'grouped_bar', 'grouped_bar_error'],
    grouped_bar: ['grouped_bar', 'grouped_bar_error'],
    line: ['line', 'line_error', 'multi_line'],
    heatmap: ['heatmap', 'correlation_heatmap'],
    dual_axis: ['dual_axis'],
    surface3d: ['surface3d'],
    scatter3d: ['scatter3d'],
    scatter: ['scatter', 'point_scatter']
  }
  const accepted = aliases[req] ?? [req]
  return accepted.includes(got)
    ? { ok: true }
    : { ok: false, reason: `用户明确选择 ${requested}，最终图型为 ${actual}；不得静默替换，请重新筛选候选或提示用户确认` }
}

/** 标题、坐标轴、图例与实际图层的显式元数据一致性门禁。 */
export function validateTitleLayerConsistency(spec = {}) {
  const errors = []
  const displayed = new Set((spec.figure?.displayedFields ?? []).filter(Boolean).map(String))
  for (const field of spec.figure?.titleFields ?? []) {
    if (displayed.size && !displayed.has(String(field))) errors.push(`标题声明字段「${field}」未出现在实际图层`)
  }
  const groupField = spec.figure?.groupField
  if (groupField) {
    const hasLegend = (spec.panels ?? []).some((panel) => (panel.layers ?? []).some((layer) => layer.groupField === groupField || layer.seriesField === groupField))
    const hasGroups = (spec.panels ?? []).some((panel) => panel.groups?.groupCol === groupField)
    if (!hasLegend && !hasGroups) errors.push(`图例/分组声明字段「${groupField}」未绑定到图层`)
  }
  for (const panel of spec.panels ?? []) {
    const yLabels = (panel.scales ?? []).filter((scale) => /^y/.test(String(scale.axis))).map((scale) => scale.label).filter(Boolean)
    if (new Set(yLabels).size > 1 && !['dual_axis', 'dual_y'].includes(String(panel.type ?? panel.chartType))) {
      errors.push('单纵轴面板存在多个不同纵轴标签')
    }
    if (panel.errorBarMode && !panel.errorBarDefinition) errors.push(`面板 ${panel.panelId ?? 'panel'} 使用误差棒但未声明 SD、SE、CI 或范围定义`)
  }
  return { ok: errors.length === 0, errors }
}

/**
 * 样式复用追踪器（§6.2）：同一图表样式（chartType 大类）整篇论文最多出现 2 次。
 * 单任务实例可立即使用；跨任务项目级追踪由调用方持久化 usage 表。
 */
export class StyleUsageTracker {
  constructor(initial = null) {
    // usage: { [styleKey]: number }；styleKey 为图型大类（chartType 去掉 _error/_normalized 等变体后的基名）
    this.usage = initial ? { ...initial } : {}
  }

  static styleKey(chartType = '') {
    return String(chartType)
      .replace(/_(error|normalized|2x1|2x2|err|3d)$/gi, '')
      .replace(/_plot$/gi, '')
      .replace(/^dual_/gi, '')
  }

  canUse(chartType) {
    return (this.usage[StyleUsageTracker.styleKey(chartType)] ?? 0) < PLOT_RULES.styleReuseLimit
  }

  record(chartType) {
    const key = StyleUsageTracker.styleKey(chartType)
    this.usage[key] = (this.usage[key] ?? 0) + 1
    return { key, count: this.usage[key], ok: this.usage[key] <= PLOT_RULES.styleReuseLimit }
  }

  snapshot() {
    return { ...this.usage }
  }
}

/**
 * 生成默认图注（§11 图X-X 格式）：用户未提供时按「图X-X 对象+方法+功能」生成。
 * @param {object} opts {index, title}
 * @returns {string}
 */
export function defaultCaption({ index = 1, title = '' } = {}) {
  const t = String(title ?? '').trim()
  return `图${index}-1 ${t}`
}
