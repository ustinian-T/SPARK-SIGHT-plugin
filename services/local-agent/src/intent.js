// 意图解析（确定性规则，无模型）：从自然语言需求抽取字段引用与歧义。
// LLM 适配器（llm.js）在配置时作为增强入口，输出仍必须经过本模块同等的真实字段校验。
const CJK = '\\u4e00-\\u9fa5'

function extractFieldRefs(text, columns) {
  const refs = new Set()
  const axisHints = []
  const naturalCue = /^(?:希望|需要|用于|用来|进行|做|作为|按照|按|根据|分组|比较|展示|显示|绘制|趋势|变化|相关|均值|误差|图表|图形|变量|名称|标题|标签|数据|结果|对比|分析|自动|推荐)(?:[\u4e00-\u9fa5A-Za-z]*)$/i
  const add = (raw) => {
    const t = (raw ?? '').trim()
    if (!t) return
    // 引号内：仅像字段标识才采信（ASCII 标识符，或 ≤8 个中日韩字符/单词字符）
    if (/^[A-Za-z_][\w]*$/.test(t) || /^[\u4e00-\u9fa5\w]{1,8}$/.test(t)) refs.add(t)
  }
  let m
  // 引号引用：“x” "x" ‘x’
  const quoteRe = /[“"‘’']([^“”"‘’']{1,24})[”"‘’']/g
  while ((m = quoteRe.exec(text))) add(m[1])
  // 字段X / 字段名：X / 列X / X字段 / X列
  const fwdRe = new RegExp(`(?:字段|列)(?:名)?\\s*(?:是|为|=|：|:)?\\s*[“"‘’']?([A-Za-z_${CJK}][\\w${CJK}]{0,20})`, 'g')
  while ((m = fwdRe.exec(text))) add(m[1])
  const revRe = new RegExp(`([A-Za-z_${CJK}][\\w${CJK}]{0,20})\\s*(?:字段|列)`, 'g')
  while ((m = revRe.exec(text))) add(m[1])
  // x轴/横轴/自变量 是 X；y轴/因变量 是 X
  const axisRe = new RegExp(`(?:x轴|y轴|横轴|纵轴|横坐标|纵坐标|自变量|因变量)\\s*(?:名称|标题)?\\s*(?:是|为|=|：|:)?\\s*[“"‘’']?([A-Za-z_${CJK}][\\w${CJK}]{0,20})`, 'g')
  while ((m = axisRe.exec(text))) {
    const raw = (m[1] ?? '').trim()
    // “纵坐标希望分组”表达的是绘图意图，不是字段名。只有已知列名，
    // 或带引号/明确“字段/列”语法的值才进入字段引用集合。
    const axisName = m[0].match(/(?:x轴|y轴|横轴|纵轴|横坐标|纵坐标|自变量|因变量)/i)?.[0] ?? 'axis'
    if (!raw || naturalCue.test(raw)) {
      axisHints.push({ axis: axisName, intent: raw || 'unspecified' })
      continue
    }
    if (columns.includes(raw)) add(raw)
    else {
      // “纵轴名称/标题”通常是展示文案，不等于字段引用；只有“纵轴为/是”或
      // 明确的字段/列语法才把未知值升级为 UNKNOWN_FIELD。
      const labelOnly = /名称|标题/.test(m[0])
      if (!labelOnly) add(raw)
      axisHints.push({ axis: axisName, requested: raw, unresolved: true })
    }
  }

  const known = new Set(columns)
  const rawMissing = [...refs].filter((r) => !known.has(r))
  const unresolved = rawMissing
    // 同一句“纵轴名称：不存在的测量字段”可能同时命中轴向规则和“X字段”规则，
    // 只保留最长候选，避免上层收到两个虚假的缺失字段。
    .filter((r) => !rawMissing.some((other) => other !== r && other.startsWith(r) && other.length > r.length))
  return {
    matched: [...refs].filter((r) => known.has(r)),
    missing: unresolved,
    axisHints
  }
}

export function parseIntent(prompt, profile) {
  const columns = profile.columns.map((c) => c.name)
  const categorical = (column) => /^(?:string|text|category|categorical|boolean)$/i.test(String(column.inferredType ?? column.type ?? ''))
  const trimmed = prompt.trim()
  const { matched, missing, axisHints } = extractFieldRefs(trimmed, columns)
  const known = new Set(matched)
  const mentionedNumeric = profile.columns
    .filter(c => /^(?:number|numeric|integer|float|double|decimal)$/i.test(String(c.inferredType ?? c.type ?? '')))
    .filter(c => trimmed.includes(c.name))
    .map(c => c.name)
  const explicit3d = /三维|3d|曲面|空间曲面/i.test(trimmed)
  const hintFor = (axes) => axisHints.find(h => axes.includes(h.axis) && h.requested && known.has(h.requested))?.requested ?? null
  const fieldSlots = {
    xField: hintFor(['x轴', '横轴', '横坐标']) ?? null,
    yField: hintFor(['y轴', '纵轴', '纵坐标']) ?? null,
    groupField: profile.columns.find(c => categorical(c) && /分组|组别|实验组|处理组|condition|treatment/i.test(c.name))?.name ?? null,
    facetField: profile.columns.find(c => categorical(c) && /分面|facet|panel/i.test(c.name))?.name ?? null,
    errorField: profile.columns.find(c => /(?:^|_)(sd|se|ci|误差|标准差|标准误)/i.test(c.name))?.name ?? null
  }
  if (explicit3d && mentionedNumeric.length >= 3) {
    fieldSlots.xField = fieldSlots.xField ?? mentionedNumeric[0]
    fieldSlots.yField = fieldSlots.yField ?? mentionedNumeric[1]
    fieldSlots.zField = mentionedNumeric[2]
  }
  const pending = []
  if (/趋势|时间|周次|日期|时序/i.test(trimmed) && !fieldSlots.xField) pending.push('xField')
  if (/响应|指标|纵轴|因变量|测量/i.test(trimmed) && !fieldSlots.yField) pending.push('yField')
  if (/分组|组别|处理组|对照组/i.test(trimmed) && !fieldSlots.groupField) pending.push('groupField')
  return {
    goal: trimmed,
    rawRequest: trimmed,
    variables: matched,
    axisHints,
    fieldSlots,
    pendingFields: pending,
    ambiguities: trimmed.length < 6 ? ['需求过短，目标不明确'] : [],
    missingFields: missing,
    engine: 'python'
  }
}

/**
 * 将 TaskSpec 中的字段槽位绑定到真实数据字典。
 * 自然语言中的展示意图不得绕过该门禁成为 ChartSpec 字段。
 */
export function validateFieldSlots(spec, profile, semanticModel = null) {
  const columns = (profile?.columns ?? []).map((column) => ({
    name: column.name,
    inferredType: column.inferredType ?? column.type ?? 'unknown'
  }))
  const byName = new Map(columns.map((column) => [column.name, column]))
  const roles = semanticModel?.fieldRoles ?? {}
  const errors = []
  const slots = spec?.fieldSlots ?? {}
  const slotNames = ['xField', 'yField', 'zField', 'groupField', 'facetField', 'errorField']
  for (const slot of slotNames) {
    const value = slots[slot]
    if (value == null || value === '') continue
    if (!byName.has(value)) {
      errors.push({ code: 'UNKNOWN_FIELD', slot, field: value, message: `${slot} 引用了不存在的数据列「${value}」` })
    }
  }
  const isNumeric = (name) => {
    const column = byName.get(name)
    return Boolean(column && /^(?:number|numeric|integer|float|double|decimal)$/i.test(String(column.inferredType)))
  }
  const isCategorical = (name) => {
    const column = byName.get(name)
    return Boolean(column && /^(?:string|text|category|categorical|boolean)$/i.test(String(column.inferredType)))
  }
  const x = slots.xField
  const y = slots.yField
  const z = slots.zField
  const group = slots.groupField
  const facet = slots.facetField
  const chartType = String(spec?.chartType ?? spec?.requestedChartType ?? '').toLowerCase()
  if (y && byName.has(y) && !isNumeric(y)) errors.push({ code: 'NON_NUMERIC_Y', slot: 'yField', field: y, message: `纵轴字段「${y}」不是数值列，不能作为测量指标` })
  if (z && byName.has(z) && !isNumeric(z)) errors.push({ code: 'NON_NUMERIC_Z', slot: 'zField', field: z, message: `三维 Z 轴字段「${z}」不是数值列，不能作为测量指标` })
  if (group && byName.has(group) && !isCategorical(group) && !(roles.group ?? []).includes(group)) errors.push({ code: 'NON_CATEGORICAL_GROUP', slot: 'groupField', field: group, message: `分组字段「${group}」不是分类列` })
  if (facet && byName.has(facet) && !isCategorical(facet) && !(roles.facet ?? []).includes(facet)) errors.push({ code: 'NON_CATEGORICAL_FACET', slot: 'facetField', field: facet, message: `分面字段「${facet}」不是分类列` })
  const trendRequested = /trend|line|时间|趋势|时序|周次|日期/.test(`${chartType} ${spec?.goal ?? ''} ${spec?.rawRequest ?? ''}`)
  if (x && byName.has(x) && trendRequested && !(roles.xTime ?? []).includes(x) && !/datetime|date|time|week|month|year/i.test(String(byName.get(x).inferredType))) {
    errors.push({ code: 'INVALID_TREND_X', slot: 'xField', field: x, message: `趋势图横轴「${x}」不是时间或有序字段` })
  }
  return { ok: errors.length === 0, errors, availableFields: columns.map((column) => column.name), slots }
}
