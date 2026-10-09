// 意图解析（确定性规则，无模型）：从自然语言需求抽取字段引用与歧义。
// LLM 适配器（llm.js）在配置时作为增强入口，输出仍必须经过本模块同等的真实字段校验。
const CJK = '\\u4e00-\\u9fa5'

function extractFieldRefs(text, columns) {
  const refs = new Set()
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
  const axisRe = new RegExp(`(?:x轴|y轴|横轴|纵轴|横坐标|纵坐标|自变量|因变量)(?!\\s*(?:名称|标题))\\s*(?:是|为|=|：|:)?\\s*[“"‘’']?([A-Za-z_${CJK}][\\w${CJK}]{0,20})`, 'g')
  while ((m = axisRe.exec(text))) add(m[1])

  const known = new Set(columns)
  return {
    matched: [...refs].filter((r) => known.has(r)),
    missing: [...refs].filter((r) => !known.has(r))
  }
}

export function parseIntent(prompt, profile) {
  const columns = profile.columns.map((c) => c.name)
  const trimmed = prompt.trim()
  const { matched, missing } = extractFieldRefs(trimmed, columns)
  return {
    goal: trimmed,
    variables: matched,
    ambiguities: trimmed.length < 6 ? ['需求过短，目标不明确'] : [],
    missingFields: missing,
    engine: 'python'
  }
}
