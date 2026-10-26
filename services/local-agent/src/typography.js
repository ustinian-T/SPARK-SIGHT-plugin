// 排版与美观参数解析（面向"绘图前询问用户 → 无要求按科研制图默认值执行"）。
// 默认值来自《数模国赛MATLAB制图规则 v0.4》§4.3 字号表与 §12 字体规则：
//   - 中文正式字体 SimHei（Python 端自动探测 Microsoft YaHei / SimHei 等候选）；
//   - 标题 14–16pt 加粗居中；轴标签 12–13pt；刻度/图例 10–11pt；任何文字 ≥10pt；
//   - 图注（题注）独立于图面文字，按「图X-X 对象方法功能」无括号格式生成。
// 用户可在需求澄清（三轮轮询）中显式指定字体/字色/字号/字距；未指定一律取默认。

import { PLOT_RULES, isValidHex } from './plotRules.js'

export const FONT_FAMILIES = Object.freeze({
  simhei: 'SimHei',
  yahei: 'Microsoft YaHei',
  song: 'SimSun',
  kai: 'KaiTi',
  sans: 'sans-serif',
  serif: 'serif'
})

/**
 * 科研制图默认排版（§4.3 / §12.1）。单位 pt；字距为相对 1 的倍数（matplotlib letter-spacing 语义为文本间距因子）。
 */
export const SCIENTIFIC_TYPOGRAPHY_DEFAULTS = Object.freeze({
  fontFamily: FONT_FAMILIES.simhei,
  title: { font: FONT_FAMILIES.simhei, color: '#000000', size: 15, weight: 'bold', spacing: 1.15, align: 'center' },
  caption: { font: FONT_FAMILIES.simhei, color: '#000000', size: 10.5, weight: 'normal', spacing: 1.1 },
  axisLabel: { font: FONT_FAMILIES.simhei, color: '#000000', size: 12.5 },
  tick: { font: FONT_FAMILIES.simhei, color: '#000000', size: 11 },
  legend: { font: FONT_FAMILIES.simhei, color: '#000000', size: 11 },
  annotation: { font: FONT_FAMILIES.simhei, color: '#C16E71', size: 10.5 },
  background: PLOT_RULES.background,
  exportDpi: 300,
  gridAlpha: 0.3
})

const clampSize = (v, { min, max, def }) => {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return def
  return Math.min(max, Math.max(min, n))
}

const pickFont = (v) => {
  const key = String(v ?? '').trim().toLowerCase()
  if (FONT_FAMILIES[key]) return FONT_FAMILIES[key]
  if (v && typeof v === 'string' && v.trim()) return v.trim() // 允许用户自报字体名
  return SCIENTIFIC_TYPOGRAPHY_DEFAULTS.fontFamily
}

const pickColor = (v, fallback) => (isValidHex(v) ? v.trim() : fallback)

function parseSpacing(v, fallback) {
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return fallback
  return Math.min(2.5, Math.max(0.8, n))
}

/**
 * 从三轮澄清回答（clarification.typography）解析最终排版参数。
 * @param {object} [user] 用户提供：{fontFamily?, title?, caption?, axisLabel?, tick?, legend?, dpi?}
 *                        每项可为字符串或 {font?, color?, size?, spacing?}
 * @returns {object} 与 SCIENTIFIC_TYPOGRAPHY_DEFAULTS 同构的完整排版对象（含 source 标注）
 */
export function resolveTypography(user = null) {
  const u = user && typeof user === 'object' ? user : {}
  const pick = (part, fallback) => {
    const p = typeof part === 'string' ? { font: part } : part && typeof part === 'object' ? part : {}
    return {
      font: pickFont(p.font ?? fallback.font),
      color: pickColor(p.color, fallback.color),
      size: clampSize(p.size, { min: PLOT_RULES.fontSizes.title.min, max: PLOT_RULES.fontSizes.title.max, def: fallback.size }),
      weight: /bold/i.test(String(p.weight ?? '')) ? 'bold' : fallback.weight,
      spacing: parseSpacing(p.spacing, fallback.spacing),
      align: p.align === 'left' || p.align === 'right' ? p.align : fallback.align
    }
  }
  const D = SCIENTIFIC_TYPOGRAPHY_DEFAULTS
  const resolved = {
    fontFamily: pickFont(u.fontFamily ?? D.fontFamily),
    title: pick(u.title, D.title),
    caption: {
      ...pick(u.caption, D.caption),
      // 图注字号遵循 §4.3 图内标注档（10–11pt）
      size: clampSize(u.caption?.size, { min: PLOT_RULES.fontSizes.annotation.min, max: PLOT_RULES.fontSizes.annotation.max, def: D.caption.size })
    },
    axisLabel: { ...pick(u.axisLabel, D.axisLabel), size: clampSize(u.axisLabel?.size, { min: PLOT_RULES.fontSizes.axisLabel.min, max: PLOT_RULES.fontSizes.axisLabel.max, def: D.axisLabel.size }) },
    tick: { ...pick(u.tick, D.tick), size: clampSize(u.tick?.size, { min: PLOT_RULES.fontSizes.tick.min, max: PLOT_RULES.fontSizes.tick.max, def: D.tick.size }) },
    legend: { ...pick(u.legend, D.legend), size: clampSize(u.legend?.size, { min: PLOT_RULES.fontSizes.legend.min, max: PLOT_RULES.fontSizes.legend.max, def: D.legend.size }) },
    annotation: { ...pick(u.annotation, D.annotation), size: clampSize(u.annotation?.size, { min: PLOT_RULES.fontSizes.annotation.min, max: PLOT_RULES.fontSizes.annotation.max, def: D.annotation.size }) },
    background: PLOT_RULES.background,
    exportDpi: clampSize(u.exportDpi ?? u.dpi, { min: PLOT_RULES.exportDpi.min, max: PLOT_RULES.exportDpi.max, def: PLOT_RULES.exportDpi.default }),
    gridAlpha: parseSpacing(u.gridAlpha, D.gridAlpha),
    source: u.source ?? 'default'
  }
  return resolved
}

/**
 * 将排版对象合并进 ChartSpec.figure（新增字段），供 codegen 与前端展示。
 */
export function applyTypographyToSpec(spec, typography) {
  const t = typography ?? SCIENTIFIC_TYPOGRAPHY_DEFAULTS
  spec.figure.fontFamily = t.fontFamily
  spec.figure.titleFont = t.title.font
  spec.figure.titleColor = t.title.color
  spec.figure.titleFontSize = t.title.size
  spec.figure.titleFontWeight = t.title.weight
  spec.figure.titleSpacing = t.title.spacing
  // 布局契约：代码生成器据此使用 constrained/loose 布局并为总标题留出空间。
  spec.figure.layoutEngine = PLOT_RULES.layout.engine
  spec.figure.titleReserve = PLOT_RULES.layout.defaultTitleReserve
  spec.figure.axisLabelSize = t.axisLabel.size
  spec.figure.tickSize = t.tick.size
  spec.figure.legendSize = t.legend.size
  spec.figure.annotationSize = t.annotation.size
  spec.figure.background = t.background
  spec.figure.minFontSize = Math.min(t.title.size, t.axisLabel.size, t.tick.size, t.legend.size, t.annotation.size)
  return spec
}

/**
 * 便捷：从三轮澄清对象整体解析（含标题与图注文本）。
 * @param {object} clarification 澄清对象 {title?, caption?, typography?}
 * @returns {{title:string, caption:string, typography:object}}
 */
export function resolvePresentation(clarification = null, fallback = {}) {
  const c = clarification && typeof clarification === 'object' ? clarification : {}
  const title = sanitizeFigureTitle(c.title ?? fallback.title, fallback.title)
  const captionRaw = String(c.caption ?? fallback.caption ?? '').trim()
  const captionClean = captionRaw ? sanitizeFigureTitle(captionRaw, '') : ''
  const caption = captionClean
    ? (/^图\d+-\d+\s/.test(captionClean) ? captionClean : `图${fallback.figureIndex ?? 1}-1 ${captionClean}`)
    : `图${fallback.figureIndex ?? 1}-1 ${title}`
  const typography = resolveTypography(c.typography)
  return { title, caption, typography }
}

/** Remove layout/rendering metadata accidentally copied into a figure title. */
export function sanitizeFigureTitle(value, fallback = '') {
  let title = String(value ?? '').trim().replace(/[「」“”\"]+/g, '')
  const explicitTitle = /(?:^|\s)title\s*[=：:]\s*([^;；\n]+)/i.exec(title)?.[1]?.trim()
  title = title.replace(/【(?:制图规范|绘图规范|排版规范)】/g, '')
  title = title.replace(/(?:字体|字号|标题字号|图注字号|字色|字距|DPI|配色|输出模式|背景|最小字号|标题|图注|图例)\s*[=：:]\s*[^；;，,]+/gi, '')
  // 结构化提示词的控制键不得泄漏到图题（例如 file=... x=... group=...）。
  title = title.replace(/(?:file|chart|x|y|z|group|extra|error|replicates|plans|plan1|plan2|plan3|font|background|legend|caption|task|run|export|preference_action|palette|apply_to|keep_history|source|edit|value|confirm)\s*=\s*[^;；\n]+/gi, '')
  title = title.replace(/\s*[；;，,]+\s*/g, ' ').replace(/\s{2,}/g, ' ').trim()
  return explicitTitle || title || String(fallback ?? '').trim()
}
