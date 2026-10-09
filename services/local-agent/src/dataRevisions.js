import { createHash, randomBytes } from 'node:crypto'
import { ingestFile } from './csv.js'
import { ApiError, ERR } from './errors.js'

const previews = new Map()
const TYPES = new Set(['numeric', 'categorical', 'datetime', 'boolean', 'unknown'])
const TTL_MS = 5 * 60 * 1000
const sha256 = (value) => createHash('sha256').update(value).digest('hex')

function qualityRisks(profile) {
  const risks = []
  if (profile.rows < 3) risks.push({ code: 'VERY_SMALL_SAMPLE', message: `仅 ${profile.rows} 行，统计结果不稳定` })
  for (const item of profile.quality?.mixedTypeColumns ?? []) risks.push({ code: 'MIXED_TYPE', field: item.field, message: `${item.field} 含混合类型` })
  for (const item of profile.quality?.highMissingColumns ?? []) risks.push({ code: 'HIGH_MISSING', field: item.field, message: `${item.field} 缺失率过高` })
  for (const field of profile.quality?.constantColumns ?? []) risks.push({ code: 'CONSTANT_COLUMN', field, message: `${field} 为常量列` })
  return risks
}

function derivedFingerprint(profile) {
  const overrides = profile.columns.map((column) => [column.name, column.userType ?? null])
  return sha256(`${profile.fingerprint}\0${JSON.stringify(overrides)}`)
}

export function previewDataRevision(task, input, now = Date.now()) {
  if (!input || typeof input !== 'object') throw new ApiError(400, ERR.DATA_REVISION_INVALID, '数据修订不能为空')
  let nextProfile
  let nextBytes = task.bytes
  let nextFileName = task.fileName
  const risks = []
  if (input.kind === 'type_override') {
    if (!TYPES.has(input.type)) throw new ApiError(400, ERR.DATA_REVISION_INVALID, `不支持的列类型：${input.type}`)
    nextProfile = structuredClone(task.dataset)
    const column = nextProfile.columns.find((item) => item.name === input.field)
    if (!column) throw new ApiError(404, ERR.UNKNOWN_FIELD, `字段不存在：${input.field}`)
    if ((column.userType ?? column.inferredType) === input.type) throw new ApiError(409, ERR.DATA_REVISION_INVALID, '列类型没有变化')
    risks.push({ code: 'TYPE_OVERRIDE', field: input.field, message: `将 ${input.field} 从 ${column.userType ?? column.inferredType} 改为 ${input.type} 会重新计算全部统计与方案` })
    column.userType = input.type
    nextProfile.fingerprint = derivedFingerprint(nextProfile)
  } else if (input.kind === 'replace') {
    if (typeof input.contentBase64 !== 'string' || !input.contentBase64) throw new ApiError(400, ERR.DATA_REVISION_INVALID, '替换数据缺少 contentBase64')
    nextBytes = Buffer.from(input.contentBase64, 'base64')
    nextFileName = String(input.fileName ?? 'replacement.csv')
    nextProfile = ingestFile(nextFileName, nextBytes).profile
    risks.push({ code: 'DATA_REPLACEMENT', message: '替换数据会使所有旧图标记为基于旧数据版本' }, ...qualityRisks(nextProfile))
  } else {
    throw new ApiError(400, ERR.DATA_REVISION_INVALID, 'kind 仅支持 type_override 或 replace')
  }
  const token = randomBytes(24).toString('base64url')
  const payload = {
    taskId: task.taskId, kind: input.kind, previousFingerprint: task.dataset.fingerprint,
    profile: nextProfile, bytes: nextBytes, fileName: nextFileName, risks,
    requiresConfirmation: risks.length > 0, expiresAt: now + TTL_MS
  }
  previews.set(token, payload)
  return {
    token, expiresAt: payload.expiresAt, kind: payload.kind,
    previousFingerprint: payload.previousFingerprint, nextFingerprint: nextProfile.fingerprint,
    profile: structuredClone(nextProfile), risks: structuredClone(risks), requiresConfirmation: payload.requiresConfirmation
  }
}

export function consumeDataRevision(task, token, confirmed, now = Date.now()) {
  const payload = previews.get(token)
  if (!payload) throw new ApiError(400, ERR.DATA_TOKEN_INVALID, '数据修订预览令牌无效或已使用')
  previews.delete(token)
  if (payload.expiresAt < now) throw new ApiError(410, ERR.DATA_TOKEN_EXPIRED, '数据修订预览令牌已过期')
  if (payload.taskId !== task.taskId || payload.previousFingerprint !== task.dataset?.fingerprint) {
    throw new ApiError(409, ERR.DATA_REVISION_STALE, '数据基线已变化，请重新预览')
  }
  if (payload.requiresConfirmation && confirmed !== true) {
    throw new ApiError(409, ERR.DATA_CONFIRMATION_REQUIRED, '该数据修订存在风险，必须显式确认后继续', { risks: payload.risks })
  }
  return payload
}
