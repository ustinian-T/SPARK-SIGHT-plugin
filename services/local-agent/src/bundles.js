// DatasetBundle and RecommendationDecision domain layer (PRD V1.2 AGT-011..013).
// Relationship discovery is deterministic and evidence-based. It never joins
// datasets or runs statistics before an explicit accept/modify decision.
import { createHash, randomUUID } from 'node:crypto'
import { ApiError, ERR } from './errors.js'
import { csvEncode } from './formats.js'

const now = () => Date.now()
const id = (prefix) => `${prefix}_${Date.now().toString(36)}_${randomUUID().replace(/-/g, '').slice(0, 8)}`

function normalizeField(name) {
  return String(name).toLowerCase().replace(/[（(][^）)]*[）)]/g, '').replace(/\[[^\]]+\]/g, '').replace(/[_\-\s/]+/g, '')
}

function unitOf(name) {
  return /[（(]([^）)]+)[）)]/.exec(String(name))?.[1]?.trim().toLowerCase()
    ?? /\[([^\]]+)\]/.exec(String(name))?.[1]?.trim().toLowerCase()
    ?? null
}

function column(dataset, name) { return dataset.profile.columns.find((item) => item.name === name) }
function header(dataset) { return dataset.rows[0] ?? [] }
function body(dataset) { return dataset.rows.slice(1) }

function overlap(left, right, leftIndex, rightIndex) {
  const a = new Set(body(left).map((row) => String(row[leftIndex] ?? '').trim()).filter(Boolean))
  const b = new Set(body(right).map((row) => String(row[rightIndex] ?? '').trim()).filter(Boolean))
  if (!a.size || !b.size) return 0
  let shared = 0
  for (const value of a) if (b.has(value)) shared++
  return shared / Math.max(1, Math.min(a.size, b.size))
}

function duplicateRate(dataset, index) {
  const values = body(dataset).map((row) => String(row[index] ?? '').trim()).filter(Boolean)
  return values.length ? 1 - new Set(values).size / values.length : 1
}

function relationCandidate(left, right, index) {
  const leftHeader = header(left)
  const rightHeader = header(right)
  const matches = []
  for (let li = 0; li < leftHeader.length; li++) {
    for (let ri = 0; ri < rightHeader.length; ri++) {
      if (normalizeField(leftHeader[li]) && normalizeField(leftHeader[li]) === normalizeField(rightHeader[ri])) {
        const leftCol = column(left, leftHeader[li])
        const rightCol = column(right, rightHeader[ri])
        const typeMatch = leftCol?.inferredType === rightCol?.inferredType
        const valueOverlap = overlap(left, right, li, ri)
        const name = normalizeField(leftHeader[li])
        const roleBoost = /(id|编号|时间|日期|time|date|week|year|month|day|批次|组)/i.test(name) ? 0.18 : 0
        const score = 0.42 + (typeMatch ? 0.16 : 0) + 0.24 * valueOverlap + roleBoost
        matches.push({ left: leftHeader[li], right: rightHeader[ri], leftIndex: li, rightIndex: ri, typeMatch, valueOverlap, score })
      }
    }
  }
  matches.sort((a, b) => b.score - a.score || a.left.localeCompare(b.left))
  const key = matches[0]
  const leftMetrics = left.profile.columns.filter((item) => item.inferredType === 'numeric' && item.name !== key?.left).map((item) => item.name)
  const rightMetrics = right.profile.columns.filter((item) => item.inferredType === 'numeric' && item.name !== key?.right).map((item) => item.name)
  const risks = []
  if (!key || key.valueOverlap < 0.25) risks.push({ code: 'NO_RELIABLE_KEY', message: '没有可靠且值域重叠充分的对齐键' })
  if (key && !key.typeMatch) risks.push({ code: 'KEY_TYPE_MISMATCH', message: '候选键的数据类型不一致' })
  const units = [...leftMetrics.map((name) => unitOf(name)), ...rightMetrics.map((name) => unitOf(name))].filter(Boolean)
  if (new Set(units).size > 1) risks.push({ code: 'UNIT_MISMATCH', message: `检测到不同单位：${[...new Set(units)].join(' / ')}` })
  if (key) {
    const dl = duplicateRate(left, key.leftIndex)
    const dr = duplicateRate(right, key.rightIndex)
    if (Math.abs(dl - dr) > 0.25 || Math.max(dl, dr) > 0.5) risks.push({ code: 'GRAIN_MISMATCH', message: '候选键重复率差异较大，可能存在聚合粒度不一致' })
  }
  if (!leftMetrics.length || !rightMetrics.length) risks.push({ code: 'NO_COMPARABLE_METRICS', message: '两侧缺少可比较数值指标' })
  const confidence = Math.max(0, Math.min(1, (key?.score ?? 0.08) - risks.length * 0.08))
  return {
    recommendationId: `rec_${index + 1}`,
    datasets: [left.datasetId, right.datasetId],
    sources: [
      { datasetId: left.datasetId, fileName: left.sourceFileName, sheetName: left.sheetName, fields: leftMetrics },
      { datasetId: right.datasetId, fileName: right.sourceFileName, sheetName: right.sheetName, fields: rightMetrics }
    ],
    alignment: key ? { kind: 'key', leftField: key.left, rightField: key.right, valueOverlap: Number(key.valueOverlap.toFixed(4)) } : null,
    unitHandling: risks.some((risk) => risk.code === 'UNIT_MISMATCH') ? 'requires_user_mapping' : 'none',
    grainHandling: risks.some((risk) => risk.code === 'GRAIN_MISMATCH') ? 'requires_user_choice' : 'preserve',
    chartType: key && ['datetime', 'numeric'].includes(column(left, key.left)?.inferredType) ? 'multi_line' : 'grouped_bar',
    objective: `对比 ${left.name} 与 ${right.name} 的共同变化`,
    rationale: key ? `字段「${key.left}」名称、类型和值域可用于对齐；两侧数值字段分别为 ${leftMetrics.join('、') || '无'} / ${rightMetrics.join('、') || '无'}。` : '未发现能够安全对齐的共同字段，不建议自动组合。',
    confidence: Number(confidence.toFixed(4)),
    risks,
    estimatedRows: key ? Math.min(left.profile.rows, right.profile.rows) : 0,
    executable: !!key && key.valueOverlap >= 0.25 && leftMetrics.length > 0 && rightMetrics.length > 0 && !risks.some((risk) => ['UNIT_MISMATCH', 'GRAIN_MISMATCH'].includes(risk.code)),
    status: 'pending'
  }
}

function discoverRelations(datasets) {
  const recommendations = []
  for (let i = 0; i < datasets.length; i++) {
    for (let j = i + 1; j < datasets.length; j++) {
      if (datasets[i].sourceFileId === datasets[j].sourceFileId) continue
      recommendations.push(relationCandidate(datasets[i], datasets[j], recommendations.length))
    }
  }
  return recommendations.sort((a, b) => b.confidence - a.confidence || a.recommendationId.localeCompare(b.recommendationId))
}

function mergeRecommendation(bundle, recommendation, modification = {}) {
  const [leftId, rightId] = recommendation.datasets
  const left = bundle.datasets.find((item) => item.datasetId === leftId)
  const right = bundle.datasets.find((item) => item.datasetId === rightId)
  if (!left || !right) throw new ApiError(409, ERR.RECOMMENDATION_STALE, '推荐引用的数据集已变化')
  const leftKey = modification.leftField ?? recommendation.alignment?.leftField
  const rightKey = modification.rightField ?? recommendation.alignment?.rightField
  if (!leftKey || !rightKey) throw new ApiError(422, ERR.RECOMMENDATION_CONFLICT, '必须明确选择对齐字段后才能执行')
  const li = header(left).indexOf(leftKey)
  const ri = header(right).indexOf(rightKey)
  if (li < 0 || ri < 0) throw new ApiError(422, ERR.RECOMMENDATION_CONFLICT, '对齐字段不存在于当前数据版本')
  if (recommendation.risks.some((risk) => risk.code === 'UNIT_MISMATCH') && !modification.unitConversion) {
    throw new ApiError(422, ERR.RECOMMENDATION_CONFLICT, '存在单位冲突，必须明确 unitConversion 后才能执行')
  }
  if (recommendation.risks.some((risk) => risk.code === 'GRAIN_MISMATCH') && !modification.grainStrategy) {
    throw new ApiError(422, ERR.RECOMMENDATION_CONFLICT, '存在粒度冲突，必须明确 grainStrategy 后才能执行')
  }
  const rightMap = new Map()
  for (const row of body(right)) {
    const key = String(row[ri] ?? '').trim()
    if (!key) continue
    if (!rightMap.has(key)) rightMap.set(key, row)
  }
  const outHeader = [leftKey]
  const leftFields = left.profile.columns.filter((item, idx) => idx !== li && item.inferredType === 'numeric').map((item) => item.name)
  const rightFields = right.profile.columns.filter((item, idx) => idx !== ri && item.inferredType === 'numeric').map((item) => item.name)
  outHeader.push(...leftFields.map((name) => `${left.name}:${name}`), ...rightFields.map((name) => `${right.name}:${name}`))
  const leftIndexes = leftFields.map((name) => header(left).indexOf(name))
  const rightIndexes = rightFields.map((name) => header(right).indexOf(name))
  const rows = [outHeader]
  for (const row of body(left)) {
    const key = String(row[li] ?? '').trim()
    const peer = rightMap.get(key)
    if (!peer) continue
    rows.push([key, ...leftIndexes.map((index) => row[index] ?? ''), ...rightIndexes.map((index) => peer[index] ?? '')])
  }
  if (rows.length < 2) throw new ApiError(422, ERR.RECOMMENDATION_CONFLICT, '按确认规则对齐后没有共同数据行')
  return Buffer.from(csvEncode(rows), 'utf8')
}

export class BundleStore {
  constructor() { this.bundles = new Map() }
  create({ prompt, files, datasets }) {
    if (files.length < 1 || files.length > 5) throw new ApiError(400, ERR.BUNDLE_FILE_COUNT, '单个数据包必须包含 1—5 份文件')
    const bundleId = id('bundle')
    const recommendations = discoverRelations(datasets)
    const bundle = {
      bundleId, prompt, createdAt: now(), updatedAt: now(), version: 1,
      state: recommendations.length ? 'WAITING_RECOMMENDATION' : 'READY_SINGLE_DATASET',
      files: files.map(({ buffer, ...file }) => ({ ...file, sizeBytes: buffer.length, fingerprint: createHash('sha256').update(buffer).digest('hex') })),
      datasets, recommendations, decisions: [], branches: []
    }
    this.bundles.set(bundleId, bundle)
    return bundle
  }
  get(bundleId) { return this.bundles.get(bundleId) }
  snapshot(bundle) {
    const copy = structuredClone(bundle)
    for (const dataset of copy.datasets) { delete dataset.csvBuffer; delete dataset.rows; delete dataset.rawDelimiter }
    return copy
  }
  async decide(bundle, decisions, createBranch) {
    if (!Array.isArray(decisions) || !decisions.length) throw new ApiError(400, ERR.BAD_REQUEST, 'decisions 必须为非空数组')
    const accepted = []
    for (const raw of decisions) {
      const recommendation = bundle.recommendations.find((item) => item.recommendationId === raw.recommendationId)
      if (!recommendation) throw new ApiError(404, ERR.RECOMMENDATION_NOT_FOUND, `推荐不存在：${raw.recommendationId}`)
      const action = ['accept', 'modify', 'reject', 'withdraw'].includes(raw.action) ? raw.action : null
      if (!action) throw new ApiError(400, ERR.BAD_REQUEST, `非法推荐决策：${raw.action}`)
      const decision = { decisionId: id('decision'), recommendationId: recommendation.recommendationId, action, modification: raw.modification, at: now() }
      bundle.decisions.push(decision)
      recommendation.status = action === 'withdraw' ? 'withdrawn' : action === 'reject' ? 'rejected' : 'confirmed'
      if (action === 'accept' || action === 'modify') {
        if (!recommendation.executable && action === 'accept') throw new ApiError(422, ERR.RECOMMENDATION_CONFLICT, '该推荐存在未解决风险，请使用 modify 明确处理规则', { risks: recommendation.risks })
        const csvBuffer = mergeRecommendation(bundle, recommendation, raw.modification ?? {})
        const branch = await createBranch({ bundle, recommendation, decision, csvBuffer })
        bundle.branches.push(branch)
        accepted.push(branch)
      }
    }
    bundle.updatedAt = now()
    bundle.version++
    bundle.state = accepted.length ? 'EXECUTING_CONFIRMED_BRANCHES' : 'RECOMMENDATIONS_REVIEWED'
    return { decisions: bundle.decisions.slice(-decisions.length), branches: accepted }
  }
}
