// 多轮需求澄清引擎：绘图前至少三轮轮询确定用户需求（第1轮 图表任务 → 第2轮 图型偏好 → 第3轮 标题/图注/排版配色）。
// 原则（对应《数模国赛MATLAB制图规则 v0.4》§2.2）：无要求按科研制图默认执行（SimHei、标题15pt加粗居中、
// 正文≥10pt、白底、300dpi、图注「图X-X 对象方法功能」），用户要求优先、且不牺牲数据正确性。
// 接入方式：任务创建时携带 clarify=true 则执行交互轮询（逐轮 need_input，/answer 应答）；
// 未启用时保持既有行为（短 prompt 单问、长 prompt 直连），保证向后兼容。prefill（clarifyAnswers）
// 可跳过已回答轮次，剩余轮次继续询问。

import { resolveTypography, SCIENTIFIC_TYPOGRAPHY_DEFAULTS } from './typography.js'
import { defaultCaption } from './plotRules.js'
import { PALETTE_LIBRARY, paletteMetrics } from './palettes.js'
import { buildColorProfile, profilePaletteScore, chartTypeBase } from './colorLearning.js'
import { normalizeChartType } from './chartTypes.js'
import { profileClarificationDefaults } from './userProfile.js'

const isHexColor = (value) => /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/.test(String(value ?? '').trim())

export const CLARIFY_ROUNDS = Object.freeze([
  { round: 1, key: 'goal', title: '图表任务与焦点' },
  { round: 2, key: 'chartType', title: '图型偏好' },
  { round: 3, key: 'presentation', title: '标题、图注与排版' }
])

const DEFAULT_KEYWORDS = /^(默认|无要求|没有|不用|随便|都行|跳过|自动|auto|default|none|n\/a|$)/i

/** 第1轮：图表任务 */
export function goalQuestion(ctx = {}) {
  return {
    question: '第 1/3 轮 · 图表任务：这份数据最想突出哪类信息？',
    options: ['组间直接对比', '随时间/顺序的趋势与不确定性', '变量间相关关系（热力图）', '分布与离群情况'],
    hint: '可直接回答选项关键词，或说明研究问题、目标变量和读者。暂不确定可选择“自动推荐”，Agent 将依据数据解释建议。',
    context: { researchField: ctx.userProfile?.researchField, outputPurpose: ctx.userProfile?.outputPurpose },
    choiceGroups: [{ key: 'goal', label: '分析目标', options: ['组间直接对比', '随时间/顺序的趋势与不确定性', '变量间相关关系（热力图）', '分布与离群情况', '自动推荐'] }]
  }
}

/** 第2轮：图型偏好（含热力图、双Y轴、三维曲面/散点） */
export function chartTypeQuestion(ctx = {}) {
  const numeric = (ctx.columns ?? []).filter((column) => (column.userType ?? column.inferredType) === 'numeric')
  const coordCount = numeric.filter((column) => /^(x|y|z|lat|latitude|lon|long|longitude|east(?:ing)?|north(?:ing)?|depth|elevation|height)$/i.test(String(column.name).trim())).length
  const suitabilityHint = numeric.length < 3
    ? `当前数据识别到 ${numeric.length} 个数值字段，三维图至少需要 3 个可解释的数值坐标；建议选择二维图型。`
    : coordCount < 3
      ? '虽然数值字段不少，但未识别到 3 个明确空间坐标字段；自动推荐会避免把普通处理组误当作 X/Y/Z。若确有空间/三维坐标，请在需求中说明字段含义。'
      : '检测到可能的三维坐标字段；曲面图还要求坐标覆盖足够且可插值的空间网格，稀疏/非空间数据建议散点或二维分布图。'
  return {
    question: '第 2/3 轮 · 图型偏好：倾向使用哪种图型？（可选：热力图、双Y轴图、三维曲面图、三维散点图，或常规折线/柱状/散点/箱线）',
    options: ['自动选择（推荐）', '分组柱状图（均值+误差棒）', '趋势与不确定性（折线+误差棒）', '分布与离群值（箱线+散点/小提琴）', '效应量与置信区间（森林图）', '相关结构（热力图）', '双Y轴图', '三维曲面图', '三维散点图'],
    hint: `回答“自动/默认”按数据结构推荐并说明依据；${suitabilityHint} 常见选择：趋势/时序用折线+误差棒，分布比较用箱线+原始散点或小提琴，效应量及置信区间用森林图；热力图/双Y轴需≥2个数值列。`
  }
}

/** 图型 → 推荐角色（决定色板语义偏好） */
function roleOfChartType(chartType = '') {
  const base = chartTypeBase(normalizeChartType(String(chartType).toLowerCase()))
  if (/heat|corr/.test(base)) return 'diverging'
  if (/surface|3d/.test(base)) return 'sequential'
  if (/line|dual|trend/.test(base)) return 'sequential'
  if (/scatter|box|bar|distribution/.test(base)) return 'categorical'
  return ''
}

/**
 * 为第三轮澄清计算推荐色板（top3）：可读性硬约束（容量）过滤后，
 * 按「用户历史配色学习先验 + 图型角色语义匹配 + 色板感知质量」综合排序。
 * @param {object} opts
 * @param {object[]} [opts.preferenceEvents] 全局偏好事件（含 paletteId 的才进入画像）
 * @param {string} [opts.chartType] 第 2 轮确定的图型偏好（heatmap/dual_axis/surface3d/…）
 * @param {number} [opts.seriesCount] 预计系列数（决定容量下限）
 * @param {number} [opts.limit] 返回数量
 */
export function recommendPresentationPalettes({ preferenceEvents = [], chartType = '', seriesCount = 1, limit = 3 } = {}) {
  const profile = buildColorProfile(preferenceEvents)
  const role = roleOfChartType(chartType)
  const learnedCount = Object.keys(profile.paletteAffinity ?? {}).length
  const scored = Object.values(PALETTE_LIBRARY)
    .filter((p) => (p.capacity ?? 8) >= Math.max(1, seriesCount))
    .map((p) => {
      const metrics = paletteMetrics(p, seriesCount)
      const learned = profilePaletteScore(profile, p.id, chartType)
      // 图型角色语义匹配：色板 roles 含当前图型推荐角色 → 加分（连续/发散/成对/分类）
      const roleMatch = role && (p.roles ?? []).includes(role) ? 0.8 : 0
      const quality = Math.min(1, (metrics.minDeltaE ?? 0) / 12)
      const accessibility = (metrics.cvdPass ? 0.7 : 0) + (metrics.grayscalePass ? 0.4 : 0)
      return { id: p.id, name: p.name, colors: (p.colors ?? []).slice(0, 8), metrics, reason: '', score: learned * 2 + roleMatch + quality * 0.5 + accessibility }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, Math.max(1, limit))
  const hasSignal = learnedCount > 0
  return scored.map((item, index) => ({
    id: item.id,
    name: item.name,
    colors: item.colors,
    metrics: item.metrics,
    reason: index === 0
      ? (hasSignal ? `依据你的历史配色偏好动态调整（已学习 ${learnedCount} 个色板信号）` : '综合可读性/图型语义推荐')
      : (hasSignal ? '参考你的历史配色偏好' : '科研期刊常见色系备选')
  }))
}

/** 第3轮：标题、图注与排版（字体/字色/字号/字距）；ctx.recommendedPalettes 注入推荐色板 */
export function presentationQuestion(ctx = {}) {
  const recommended = Array.isArray(ctx.recommendedPalettes) ? ctx.recommendedPalettes : []
  const recHint = recommended.length
    ? `；推荐配色（依据你的历史偏好）：${recommended.map((p) => `${p.name}(${p.id})`).join('、')}`
    : ''
  return {
    question: '第 3/3 轮 · 标题、图注与排版：请给出图表标题与图注文字，以及字体/字色/字号/字距要求；没有要求将按科研制图默认执行（SimHei、标题15pt加粗居中、正文≥10pt、白底、300dpi）。',
    options: ['全部按科研默认', '只改标题/图注，排版默认'],
    choiceGroups: [
      { key: 'labelLanguage', label: '标注语言', options: ['保持原始字段语言（推荐）', '中文', '英文', '中英双语'] },
      { key: 'legendPosition', label: '图例位置', options: ['自动避让（推荐）', '图外右侧', '图外顶部', '图外底部', '图内右上角'] }
    ],
    defaults: profileClarificationDefaults(ctx.userProfile),
    hint: `格式示例：标题=各处理组日均产量；图注=图1-1 各处理组日均产量对比；字体=SimHei；标题字号=15；标题字色=#000000；图注字号=10.5；字距=1.1；配色=user_nature${recHint}`,
    recommendedPalettes: recommended
  }
}

/** 从回答解析出第1轮字段 */
export function parseGoal(answer) {
  const a = String(answer ?? '').trim()
  if (DEFAULT_KEYWORDS.test(a)) return { goal: 'auto', defaulted: true }
  if (/相关|相关关系|热力|相关系数|相关性/i.test(a)) return { goal: 'correlation' }
  if (/趋势|随时间|变化过程|时序|增长/i.test(a)) return { goal: 'trend' }
  if (/分布|离群|箱线|密度|方差/i.test(a)) return { goal: 'distribution' }
  if (/对比|比较|组间|差异|高低/i.test(a)) return { goal: 'comparison' }
  return { goal: a.slice(0, 40) || 'auto' }
}

/** 从回答解析出第2轮字段（映射到候选图型） */
export function parseChartType(answer) {
  const a = String(answer ?? '').trim()
  if (DEFAULT_KEYWORDS.test(a)) return { chartType: 'auto', defaulted: true }
  if (/分组柱状|簇状柱|grouped[ _-]?bar/i.test(a)) return { chartType: 'grouped_bar' }
  if (/双.?y|双轴|双纵轴|twin/i.test(a)) return { chartType: 'dual_axis' }
  if (/三维曲面|3d曲面|曲面|surf/i.test(a)) return { chartType: 'surface3d' }
  if (/三维散点|3d散点|三维点|scatter3/i.test(a)) return { chartType: 'scatter3d' }
  if (/小提琴/i.test(a)) return { chartType: 'violin' }
  if (/森林|效应量.*置信区间|置信区间.*森林/i.test(a)) return { chartType: 'forest' }
  if (/分布|离群|箱线|原始散点/i.test(a)) return { chartType: 'box' }
  if (/热力|相关系数矩阵|相关矩阵/i.test(a)) return { chartType: 'heatmap' }
  if (/折线|趋势线|line/i.test(a)) return { chartType: 'line' }
  if (/柱状|柱形|条形|bar/i.test(a)) return { chartType: 'bar' }
  if (/散点|scatter/i.test(a)) return { chartType: 'scatter' }
  if (/箱线|盒须|box/i.test(a)) return { chartType: 'box' }
  return { chartType: 'auto', defaulted: true }
}

/**
 * 从回答解析第3轮（标题/图注/排版键值对）。
 * 支持键：标题、图注、字体、标题字号、标题字色、标题字距、图注字号、图注字色、图注字距、
 *        轴标签字号、刻度字号、图例字号、DPI、配色（paletteId/色板中文名/「推荐」）。
 * @param {string} answer 用户作答（键值对，如「标题=…；图注=…；标题字色=#6E8FB2；配色=自然低饱和」）
 * @param {object} [ctx] { recommendedPalettes } 第三轮下发的推荐色板（配色=推荐 时取第一个）
 */
export function parsePresentation(answer, ctx = {}) {
  const a = String(answer ?? '').trim()
  if (DEFAULT_KEYWORDS.test(a) || /全部按科研默认|全部默认|按默认/.test(a)) {
    return { presentation: { source: 'default' }, defaulted: true }
  }
  const out = { typography: {} }
  const kv = (key) => {
    const m = new RegExp(`${key}\\s*[=：:]\\s*([^；;，,]+)`).exec(a)
    return m ? m[1].trim() : undefined
  }
  const title = kv('标题')
  const caption = kv('图注')
  if (title) out.title = title.replace(/[「」“”"]/g, '')
  if (caption) out.caption = caption.replace(/[「」“”"]/g, '')
  const font = kv('字体')
  if (font) out.typography.fontFamily = font
  const num = (key) => { const v = kv(key); const n = Number(v); return Number.isFinite(n) ? n : undefined }
  const titleSize = num('标题字号') ?? num('标题大小')
  const captionSize = num('图注字号') ?? num('图注大小')
  const titleColor = kv('标题字色')
  const captionColor = kv('图注字色')
  const titleSpacing = num('标题字距')
  const captionSpacing = num('图注字距')
  // 全局「字距」兼容（前端表单/用户口语）：须锚定在行首或分隔符后，避免误匹配「标题字距/图注字距」
  const globalSpacingMatch = /(?:^|[；;，,])\s*字距\s*[=：:]\s*([^；;，,]+)/.exec(a)
  const globalSpacingValue = globalSpacingMatch ? Number(globalSpacingMatch[1].trim()) : NaN
  const globalSpacing = Number.isFinite(globalSpacingValue) ? globalSpacingValue : undefined
  const resolvedTitleSpacing = titleSpacing ?? globalSpacing
  // 颜色必须为合法十六进制，否则忽略（防注入/错值），回落到排版默认
  if (titleSize) out.typography.title = { size: titleSize }
  if (isHexColor(titleColor)) out.typography.title = { ...(out.typography.title ?? {}), color: titleColor.trim() }
  if (resolvedTitleSpacing) out.typography.title = { ...(out.typography.title ?? {}), spacing: resolvedTitleSpacing }
  if (captionSize) out.typography.caption = { ...(out.typography.caption ?? {}), size: captionSize }
  if (isHexColor(captionColor)) out.typography.caption = { ...(out.typography.caption ?? {}), color: captionColor.trim() }
  if (captionSpacing) out.typography.caption = { ...(out.typography.caption ?? {}), spacing: captionSpacing }
  const dpi = num('DPI')
  if (dpi) out.typography.exportDpi = dpi
  const paletteId = kv('配色')
  if (paletteId) out.paletteId = resolvePaletteId(paletteId, ctx.recommendedPalettes)
  const axisLabelSize = num('轴标签字号')
  if (axisLabelSize) out.typography.axisLabel = { size: axisLabelSize }
  const tickSize = num('刻度字号')
  if (tickSize) out.typography.tick = { size: tickSize }
  const legendSize = num('图例字号')
  if (legendSize) out.typography.legend = { size: legendSize }
  const language = kv('标注语言') ?? kv('标签语言')
  const languages = { '中文': 'zh', '英文': 'en', '中英双语': 'bilingual', '保持原始字段语言（推荐）': 'auto', '自动': 'auto', zh: 'zh', en: 'en', bilingual: 'bilingual', auto: 'auto' }
  if (Object.hasOwn(languages, language)) out.labelLanguage = languages[language]
  const position = kv('图例位置')
  const positions = { '图外右侧': 'right', '图外顶部': 'top', '图外底部': 'bottom', '图内右上角': 'inside', '自动避让（推荐）': 'auto', '自动': 'auto', right: 'right', top: 'top', bottom: 'bottom', inside: 'inside', auto: 'auto' }
  if (Object.hasOwn(positions, position)) out.legendPosition = positions[position]
  return out
}

/**
 * 把用户对「配色」的作答解析为色板 id：
 * - 「推荐」→ 第三轮下发的第一个推荐色板；
 * - 直接命中库内 id → 原样；
 * - 中文名/前缀（含别名，如 自然低饱和/低饱和 匹配 user_nature）→ 唯一匹配返回 id，多匹配/无匹配返回原值由上层校验。
 */
export function resolvePaletteId(raw, recommendedPalettes = []) {
  const value = String(raw ?? '').trim()
  if (!value) return ''
  if (/推荐|自动|auto/i.test(value)) return recommendedPalettes?.[0]?.id ?? ''
  if (PALETTE_LIBRARY[value]) return value
  const hits = Object.values(PALETTE_LIBRARY).filter((p) => p.name === value || p.name.includes(value) || value.includes(p.name))
  return hits.length === 1 ? hits[0].id : value
}

/** 默认（无交互）澄清结果：全部按科研默认执行 */
export function defaultClarification(now = Date.now()) {
  return {
    goal: 'auto',
    chartType: 'auto',
    title: '',
    caption: '',
    typography: resolveTypography({ source: 'default' }),
    paletteId: '',
    complete: true,
    source: 'default',
    answeredAt: now,
    answers: [
      { round: 1, defaulted: true },
      { round: 2, defaulted: true },
      { round: 3, defaulted: true }
    ]
  }
}

/** 将 prefill（客户端随建任务提交）合并为初始澄清 */
export function mergePrefill(prefill = {}) {
  const p = prefill && typeof prefill === 'object' ? prefill : {}
  const typography = p.typography && typeof p.typography === 'object' ? p.typography : null
  return {
    goal: p.goal ?? 'auto',
    chartType: p.chartType ?? 'auto',
    title: String(p.title ?? '').trim(),
    caption: String(p.caption ?? '').trim(),
    typography: typography ? resolveTypography({ ...typography, source: 'prefilled' }) : null,
    paletteId: String(p.paletteId ?? ''),
    ...profileClarificationDefaults(p),
    complete: false,
    source: 'prefilled',
    prefillRounds: Array.isArray(p.answeredRounds) ? p.answeredRounds : []
  }
}

/**
 * 交互式三轮澄清：逐轮 need_input，由 ask 回调获取用户回答（返回 null 表示该轮默认）。
 * @param {object} task 任务对象（写入 task.clarification）
 * @param {object} opts
 * @param {(round:number, payload:object) => Promise<string|null>} opts.ask 每轮向用户提问并等待回答
 * @param {object} [opts.prefill] 已预先回答的字段
 * @returns {Promise<object>} 完整澄清对象
 */
export async function runClarification(task, opts = {}) {
  const { ask, prefill, decorate, context = {} } = opts
  const merged = mergePrefill({ ...profileClarificationDefaults(context.userProfile), ...prefill })
  const answers = [...(merged.answers ?? [])]
  const skipped = new Set(merged.prefillRounds ?? [])
  if (context.userProfile?.clarificationMode === 'minimal') { skipped.add(2); skipped.add(3) }

  const clarify = { ...merged }
  for (const def of CLARIFY_ROUNDS) {
    if (skipped.has(def.round) || merged.complete) {
      answers.push({ round: def.round, defaulted: true, reason: 'prefilled' })
      continue
    }
    let parsed
    let answered = null
    let recommendedPalettesOfRound = []
    if (typeof ask === 'function') {
      const payload = def.round === 1 ? goalQuestion(context) : def.round === 2 ? chartTypeQuestion(context) : presentationQuestion(context)
      // decorate：让调用方按当前澄清进度动态增强本轮（如第三轮注入推荐色板）
      const final = typeof decorate === 'function' ? ((await decorate(def.round, payload, clarify)) ?? payload) : payload
      recommendedPalettesOfRound = Array.isArray(final.recommendedPalettes) ? final.recommendedPalettes : []
      answered = await ask(def.round, { ...final, key: def.key })
    }
    if (answered == null) {
      parsed = def.round === 1 ? { goal: 'auto', defaulted: true }
        : def.round === 2 ? { chartType: 'auto', defaulted: true }
        : { presentation: { source: 'default' }, defaulted: true }
    } else if (def.round === 1) parsed = parseGoal(answered)
    else if (def.round === 2) parsed = parseChartType(answered)
    else parsed = parsePresentation(answered, { recommendedPalettes: recommendedPalettesOfRound })

    if (def.round === 1) clarify.goal = parsed.goal ?? clarify.goal
    if (def.round === 2) clarify.chartType = parsed.chartType ?? clarify.chartType
    if (def.round === 3) {
      if (parsed.title) clarify.title = parsed.title
      if (parsed.caption) clarify.caption = parsed.caption
      if (parsed.paletteId) clarify.paletteId = parsed.paletteId
      if (parsed.labelLanguage) clarify.labelLanguage = parsed.labelLanguage
      if (parsed.legendPosition) clarify.legendPosition = parsed.legendPosition
      if (parsed.typography && Object.keys(parsed.typography).length) {
        clarify.typography = resolveTypography({ ...parsed.typography, source: 'interactive' })
      }
      // 第三轮下发的推荐色板写入澄清结果，供前端回显「依据历史配色动态推荐」的决策依据
      clarify.recommendedPalettes = recommendedPalettesOfRound
    }
    answers.push({ round: def.round, answer: answered ?? '', defaulted: Boolean(parsed.defaulted ?? answered == null) })
  }

  clarify.typography = clarify.typography ?? resolveTypography({ source: 'default' })
  clarify.caption = clarify.caption || defaultCaption({ index: 1, title: clarify.title })
  clarify.complete = true
  clarify.source = 'interactive'
  clarify.answeredAt = Date.now()
  clarify.answers = answers
  task.clarification = clarify
  return clarify
}

export { SCIENTIFIC_TYPOGRAPHY_DEFAULTS }
