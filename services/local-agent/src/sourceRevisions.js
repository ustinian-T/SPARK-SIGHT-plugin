// Source revision lifecycle: optimistic preview tokens, narrow code-to-spec mapping,
// and explicit code-dominant fallback when a safe reverse mapping is not possible.
import { createHash, randomBytes } from 'node:crypto'
import { ApiError, ERR } from './errors.js'

const previews = new Map()
const DEFAULT_TTL_MS = 5 * 60 * 1000
const ENGINES = new Set(['python', 'r', 'matlab'])

const clone = (value) => structuredClone(value)
const hash = (value) => createHash('sha256').update(String(value)).digest('hex')
const currentVersion = (task) => task.currentRevision ?? task.planVersions?.at(-1)?.version ?? 0
const currentPlans = (task) => task.planVersions?.find((item) => item.version === currentVersion(task))?.plans ?? task.plans

function locatePlan(task, planId, plans = currentPlans(task)) {
  const index = plans.findIndex((plan) => plan.plan_id === planId)
  if (index < 0) throw new ApiError(404, ERR.PLAN_NOT_FOUND, `方案不存在：${planId}`)
  return { index, plan: plans[index] }
}

function literal(value, engine) {
  if (engine === 'matlab') return `'${String(value).replace(/'/g, "''")}'`
  return JSON.stringify(String(value))
}

function decodeLiteral(value, engine) {
  try {
    if (engine === 'matlab') {
      if (!value.startsWith("'") || !value.endsWith("'")) return undefined
      return value.slice(1, -1).replace(/''/g, "'")
    }
    return JSON.parse(value)
  } catch {
    return undefined
  }
}

function buildSourceMap(plan, engine) {
  const source = plan?.code?.[engine] ?? ''
  const title = plan?.spec?.figure?.title
  if (typeof title !== 'string') return []
  const needle = literal(title, engine)
  const lines = source.split('\n')
  const entries = []
  for (let index = 0; index < lines.length; index += 1) {
    let column = lines[index].indexOf(needle)
    while (column >= 0) {
      entries.push({ path: 'figure.title', line: index + 1, column: column + 1, length: needle.length, originalLiteral: needle })
      column = lines[index].indexOf(needle, column + needle.length)
    }
  }
  return entries
}

function mapSupportedEdit(plan, engine, source, sourceMap) {
  const before = String(plan.code[engine]).split('\n')
  const after = String(source).split('\n')
  if (before.length !== after.length) return undefined
  const changed = before.map((line, index) => line === after[index] ? -1 : index).filter((index) => index >= 0)
  if (changed.length !== 1) return undefined
  const lineIndex = changed[0]
  for (const entry of sourceMap.filter((item) => item.line === lineIndex + 1 && item.path === 'figure.title')) {
    const start = entry.column - 1
    const prefix = before[lineIndex].slice(0, start)
    const suffix = before[lineIndex].slice(start + entry.length)
    const candidate = after[lineIndex]
    if (!candidate.startsWith(prefix) || !candidate.endsWith(suffix)) continue
    const nextLiteral = candidate.slice(prefix.length, candidate.length - suffix.length)
    const nextTitle = decodeLiteral(nextLiteral, engine)
    if (typeof nextTitle !== 'string' || nextTitle.length === 0 || nextTitle.length > 200) continue
    const spec = clone(plan.spec)
    spec.figure.title = nextTitle
    return spec
  }
  return undefined
}

function validate(task, input) {
  if (!input || typeof input !== 'object') throw new ApiError(400, ERR.SOURCE_INVALID, '源码修订不能为空')
  if (!ENGINES.has(input.engine)) throw new ApiError(400, ERR.INVALID_ENGINE, `不支持的引擎：${input.engine}`)
  if (typeof input.source !== 'string' || input.source.length === 0 || input.source.length > 2_000_000) {
    throw new ApiError(400, ERR.SOURCE_INVALID, '源码必须为 1 至 2000000 个字符')
  }
  const parent = currentVersion(task)
  if (input.parentVersion !== undefined && Number(input.parentVersion) !== parent) {
    throw new ApiError(409, ERR.SOURCE_STALE, '源码父版本不是当前版本', { currentVersion: parent })
  }
  const located = locatePlan(task, input.planId)
  const currentSource = located.plan.code?.[input.engine]
  if (typeof currentSource !== 'string') throw new ApiError(409, ERR.SOURCE_INVALID, '当前方案没有该引擎源码')
  const baseHash = hash(currentSource)
  if (input.baseHash && input.baseHash !== baseHash) {
    throw new ApiError(409, ERR.SOURCE_STALE, '源码基线已变化，请重新加载', { currentVersion: parent, baseHash })
  }
  return { parent, located, currentSource, baseHash }
}

export function previewSourceRevision(task, input, now = Date.now(), ttlMs = DEFAULT_TTL_MS) {
  const { parent, located, currentSource, baseHash } = validate(task, input)
  const sourceMap = buildSourceMap(located.plan, input.engine)
  const mappedSpec = mapSupportedEdit(located.plan, input.engine, input.source, sourceMap)
  const token = randomBytes(24).toString('base64url')
  const payload = {
    taskId: task.taskId,
    parentVersion: parent,
    fingerprint: task.dataset?.fingerprint,
    planId: input.planId,
    engine: input.engine,
    source: input.source,
    baseHash,
    sourceHash: hash(input.source),
    sourceMap,
    mode: mappedSpec ? 'spec' : 'code',
    mappedSpec,
    expiresAt: now + ttlMs
  }
  previews.set(token, payload)
  return {
    token,
    expiresAt: payload.expiresAt,
    parentVersion: parent,
    planId: payload.planId,
    engine: payload.engine,
    baseHash,
    sourceHash: payload.sourceHash,
    mode: payload.mode,
    sourceMap,
    ...(mappedSpec ? { spec: clone(mappedSpec) } : {}),
    changedLines: Math.max(currentSource.split('\n').length, input.source.split('\n').length)
  }
}

export async function applySourceRevision(task, token, executeAndVerify, now = Date.now()) {
  const payload = previews.get(token)
  if (!payload) throw new ApiError(400, ERR.SOURCE_TOKEN_INVALID, '源码预览令牌无效或已使用')
  previews.delete(token)
  if (payload.expiresAt < now) throw new ApiError(410, ERR.SOURCE_TOKEN_EXPIRED, '源码预览令牌已过期')
  if (payload.taskId !== task.taskId || payload.fingerprint !== task.dataset?.fingerprint || payload.parentVersion !== currentVersion(task)) {
    throw new ApiError(409, ERR.SOURCE_STALE, '任务数据或当前修订已变化，请重新预览源码', { currentVersion: currentVersion(task) })
  }
  const plans = clone(currentPlans(task))
  const located = locatePlan(task, payload.planId, plans)
  if (hash(located.plan.code?.[payload.engine] ?? '') !== payload.baseHash) {
    throw new ApiError(409, ERR.SOURCE_STALE, '源码基线已变化，请重新预览')
  }
  if (payload.mappedSpec) located.plan.spec = clone(payload.mappedSpec)
  located.plan.code[payload.engine] = payload.source
  located.plan.sourceMode = payload.mode
  located.plan.sourceMap = clone(payload.sourceMap)
  const verified = executeAndVerify ? await executeAndVerify(clone(located.plan), clone(payload)) : located.plan
  plans[located.index] = verified
  const version = Math.max(0, ...(task.planVersions ?? []).map((item) => item.version)) + 1
  const revision = {
    version, parent: payload.parentVersion, at: now, reason: 'source', mode: payload.mode,
    source: { planId: payload.planId, engine: payload.engine, baseHash: payload.baseHash, sourceHash: payload.sourceHash, sourceMap: clone(payload.sourceMap) },
    plans, artifacts: clone(task.artifacts ?? {})
  }
  task.planVersions ??= []
  task.planVersions.push(revision)
  task.currentRevision = version
  task.plans = clone(plans)
  return revision
}
