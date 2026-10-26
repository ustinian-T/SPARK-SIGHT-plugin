// 数据语义模型：从列画像 + 原始文本推断表格形态、字段角色与研究设计。
// 对应阶段 C：统计门禁的语义前置层。所有推断均为“弱信号”，置信度不足时一律退回 unknown，
// 把确认责任交还给用户（禁止在研究设计未确认时输出推断统计结论）。
import { parseCsv, toNumber, isSdColumn } from './csv.js'

// 字段角色全集（与任务约定一致）
const ROLES = ['id', 'xTime', 'group', 'facet', 'measure', 'error', 'weight', 'replicate', 'subject', 'label']

// 列名 → 角色的命名模式（中文/英文常见命名，大小写不敏感）
const PATTERN = {
  id: /(^|_|-)(id|编号|序号|no|sample[_ -]?(id|no|number)|样本编号|样本序号)$/i,
  subject: /subject|被试|受试|participant|^s\d*$/i,
  group: /(^|_|-)(group|分组|组别|condition|treatment|arm)$/i,
  facet: /facet|panel|分面|子图/i,
  weight: /weight|权重/i,
  replicate: /replicate|重复|_rep$|^rep\d*$|^sample$|^重复编号$/i,
  label: /label|^name$|标签|名称/i,
  xTime: /(time|date|week|day|year|month|timestamp|时间|日期|周次|月次|季度)/i
}

// 中文实验表格经常使用复合列名，如“实验组别”“处理条件”“对照组别”。
// 这些列不能依赖英文式的分隔符匹配，否则会被误当作普通分类变量。
const COMPOUND_GROUP = /(?:实验|处理|对照|干预|治疗|剂量|条件).*(?:组别|分组|处理组|条件|批次)|(?:组别|分组|处理组)$|^(?:组别|分组)$/i

const typeOf = (col) => col.userType ?? col.inferredType
const inferUnit = (name) => {
  const m = String(name).match(/[（(]\s*([^()（）]+?)\s*[)）]|[/／]\s*([\u4e00-\u9fa5A-Za-z%℃°μµ]+)\s*$/)
  return (m?.[1] ?? m?.[2] ?? '').trim() || null
}

// 统计设计推断所用规则数（固定 5 条，置信度 = 命中数 / 5）
const DESIGN_RULE_COUNT = 5

/**
 * 构建数据语义模型。
 * @param {object} profile ingestFile 产出的列画像
 * @param {string} text 已解码 CSV 文本
 * @param {string} rawDelimiter 分隔符
 */
export function buildSemanticModel(profile, text, rawDelimiter) {
  const columns = profile.columns ?? []
  const header = columns.map((c) => c.name)
  const matrix = parseCsv(text, rawDelimiter)
  const rows = matrix.slice(1)
  const colIndex = new Map(header.map((name, i) => [name, i]))
  const cell = (name, row) => row[colIndex.get(name)] ?? ''

  // ---------- 1. 字段角色识别（列名模式 + 列类型） ----------
  const fieldRoles = Object.fromEntries(ROLES.map((r) => [r, []]))
  for (const col of columns) {
    const name = col.name
    const t = typeOf(col)
    if (isSdColumn(name)) { fieldRoles.error.push(name); continue }
    if (PATTERN.subject.test(name)) { fieldRoles.subject.push(name); continue }
    if (PATTERN.id.test(name)) { fieldRoles.id.push(name); continue }
    // “treatment_a” 等数值测量列不能仅因列名含 treatment 就被当作分组；
    // 分组/分面默认必须是分类列，中文实验组别等字段仍按真实类型识别。
    if ((PATTERN.group.test(name) || COMPOUND_GROUP.test(name)) && t === 'categorical') { fieldRoles.group.push(name); continue }
    if (PATTERN.facet.test(name) && t === 'categorical') { fieldRoles.facet.push(name); continue }
    if (PATTERN.weight.test(name)) { fieldRoles.weight.push(name); continue }
    if (PATTERN.replicate.test(name)) { fieldRoles.replicate.push(name); continue }
    if (PATTERN.label.test(name)) { fieldRoles.label.push(name); continue }
    if (t === 'datetime' || PATTERN.xTime.test(name)) { fieldRoles.xTime.push(name); continue }
    if (t === 'numeric') { fieldRoles.measure.push(name); continue }
    // 其余分类列暂不指定角色，避免过度承诺
  }

  // ---------- 2. 表格形态识别 ----------
  const hasErrorPair = columns.some((c) => isSdColumn(c.name))
  const longVarCol = header.find((h) => /^(variable|measure|name|variable|key)$/i.test(h))
  const longValCol = header.find((h) => /^(value|measurement|result|outcome|val)$/i.test(h))
  const hasLongPattern = Boolean(longVarCol && longValCol)
  const hasDateTime = columns.some((c) => typeOf(c) === 'datetime' || fieldRoles.xTime.includes(c.name))
  const hasEventType = columns.some(
    (c) => typeOf(c) === 'categorical' && /(event|type|事件|类型)/i.test(c.name)
  )
  const allNumeric = columns.every((c) => typeOf(c) === 'numeric' || isSdColumn(c.name))

  let tableShape
  if (hasLongPattern) tableShape = 'long'
  else if (hasErrorPair) tableShape = 'wide'
  else if (hasDateTime) tableShape = 'time-series'
  else if (hasEventType) tableShape = 'event'
  else if (allNumeric) tableShape = 'matrix'
  else tableShape = 'wide'

  // ---------- 3. 研究设计推断 + 置信度 ----------
  // 规则：①有被试列 ②有时间点列 ③有分组列 ④有标识符列 ⑤有聚合误差列
  const ruleHits = [
    fieldRoles.subject.length > 0,
    fieldRoles.xTime.length > 0,
    fieldRoles.group.length > 0,
    fieldRoles.id.length > 0,
    hasErrorPair
  ]
  const matched = ruleHits.filter(Boolean).length
  let designConfidence = matched / DESIGN_RULE_COUNT

  // 多时间点唯一取值数（重复测量需要 ≥2 个时间点）
  let timePointCount = 0
  if (fieldRoles.xTime.length > 0) {
    const timeCol = fieldRoles.xTime[0]
    timePointCount = new Set(rows.map((r) => String(cell(timeCol, r)).trim())).size
  }

  let researchDesign = 'unknown'
  if (fieldRoles.subject.length > 0 && timePointCount >= 2) {
    researchDesign = 'repeated-measures'
    designConfidence = Math.max(designConfidence, 0.8) // 被试+多时间点是强信号
  } else if (fieldRoles.subject.length > 0 && fieldRoles.group.length > 0) {
    researchDesign = 'clustered'
    designConfidence = Math.max(designConfidence, 0.7)
  } else if (fieldRoles.group.length > 0 && fieldRoles.subject.length === 0) {
    researchDesign = 'independent'
    designConfidence = Math.max(designConfidence, 0.6)
  }

  // 置信度阈值：低于 0.6 一律退回 unknown（推断统计暂停）
  const warnings = []
  if (designConfidence < 0.6) {
    researchDesign = 'unknown'
    warnings.push('研究设计置信度不足（<0.6），已暂推断为 unknown；请用户确认独立/配对/重复测量/聚类设计后再执行推断统计')
  }

  const roleConfidence = Object.fromEntries(ROLES.map((role) => [role, fieldRoles[role].map(name => ({ field: name, confidence: role === 'measure' ? 0.75 : 0.9 }))]))
  const fieldDictionary = columns.map((col) => ({
    field: col.name,
    type: typeOf(col),
    roles: ROLES.filter(role => fieldRoles[role].includes(col.name)),
    unit: null,
    missingRate: col.missingRate ?? 0
  }))

  // ---------- 4. 单位元数据（自动解析不可靠，original 留空待用户确认） ----------
  const units = {}
  for (const col of columns) {
    const isNumeric = typeOf(col) === 'numeric'
    units[col.name] = {
      original: inferUnit(col.name),
      confirmed: null,
      allowNormalize: isNumeric,
      allowLog: isNumeric && Number.isFinite(col.min) && col.min > 0
    }
  }

  // ---------- 5. 缺失机制：只能给出 unknown，MCAR/MAR/MNAR 需用户确认 ----------
  const perColumn = {}
  for (const col of columns) {
    perColumn[col.name] = {
      count: col.missing ?? 0,
      rate: col.missingRate ?? 0,
      decision: 'keep'
    }
  }

  return {
    tableShape,
    fieldRoles,
    researchDesign,
    designConfidence: Math.round(designConfidence * 100) / 100,
    roleConfidence,
    fieldDictionary,
    units,
    missingness: { mechanism: 'unknown', perColumn },
    warnings
  }
}
