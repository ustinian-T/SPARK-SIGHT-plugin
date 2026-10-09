// ChartSpec 补丁生命周期：预览令牌、乐观并发校验、追加式修订与指针恢复。
import { randomBytes } from 'node:crypto'
import { isDeepStrictEqual } from 'node:util'
import { ApiError, ERR } from './errors.js'

const previews = new Map()
const DEFAULT_TTL_MS = 5 * 60 * 1000
const SAFE_KEY = /^[A-Za-z_][A-Za-z0-9_-]*$/

function clone(value) {
  return structuredClone(value)
}

function currentVersion(task) {
  return task.currentRevision ?? task.planVersions?.at(-1)?.version ?? 0
}

function currentPlans(task) {
  const version = currentVersion(task)
  return task.planVersions?.find((item) => item.version === version)?.plans ?? task.plans
}

function locate(task, patch, plans = currentPlans(task)) {
  const planIndex = plans.findIndex((plan) => plan.plan_id === patch.planId)
  if (planIndex < 0) throw new ApiError(404, ERR.PLAN_NOT_FOUND, `方案不存在：${patch.planId}`)
  const spec = plans[planIndex].spec
  if (!spec || typeof spec !== 'object') throw new ApiError(409, ERR.PATCH_INVALID, '方案缺少可编辑 ChartSpec')
  if (patch.targetKind === 'figure') return { planIndex, root: spec.figure }
  if (patch.targetKind === 'panel') {
    const panelIndex = spec.panels?.findIndex((panel) => panel.id === patch.targetId || panel.panel_id === patch.targetId)
    if (panelIndex < 0) throw new ApiError(404, ERR.PATCH_TARGET_NOT_FOUND, `面板不存在：${patch.targetId}`)
    return { planIndex, panelIndex, root: spec.panels[panelIndex] }
  }
  throw new ApiError(400, ERR.PATCH_INVALID, 'targetKind 仅支持 figure 或 panel')
}

function pathParts(path) {
  const parts = String(path ?? '').split('.').filter(Boolean)
  if (!parts.length || parts.some((part) => !SAFE_KEY.test(part) || ['__proto__', 'prototype', 'constructor'].includes(part))) {
    throw new ApiError(400, ERR.PATCH_INVALID, '补丁 path 非法')
  }
  return parts
}

function readAt(root, parts) {
  let node = root
  for (const key of parts) {
    node = Array.isArray(node)
      ? node.find((item) => [item?.id, item?.panel_id, item?.layer_id, item?.scale_id, item?.legend_id, item?.annotation_id].includes(key))
      : node?.[key]
  }
  return node
}

function writeAt(root, parts, value) {
  let node = root
  for (const key of parts.slice(0, -1)) {
    if (Array.isArray(node)) {
      const item = node.find((candidate) => [candidate?.id, candidate?.panel_id, candidate?.layer_id, candidate?.scale_id, candidate?.legend_id, candidate?.annotation_id].includes(key))
      if (!item) throw new ApiError(404, ERR.PATCH_TARGET_NOT_FOUND, `补丁路径中的对象不存在：${key}`)
      node = item
      continue
    }
    if (!node[key] || typeof node[key] !== 'object') node[key] = {}
    node = node[key]
  }
  const last = parts.at(-1)
  if (Array.isArray(node)) {
    const index = node.findIndex((candidate) => [candidate?.id, candidate?.panel_id, candidate?.layer_id, candidate?.scale_id, candidate?.legend_id, candidate?.annotation_id].includes(last))
    if (index < 0) throw new ApiError(404, ERR.PATCH_TARGET_NOT_FOUND, `补丁路径中的对象不存在：${last}`)
    node[index] = clone(value)
  } else node[last] = clone(value)
}

function validatePatch(task, patch) {
  if (!patch || typeof patch !== 'object') throw new ApiError(400, ERR.PATCH_INVALID, '补丁不能为空')
  const parent = currentVersion(task)
  if (patch.parentVersion !== undefined && Number(patch.parentVersion) !== parent) {
    throw new ApiError(409, ERR.PATCH_STALE, '补丁父版本不是当前版本', { currentVersion: parent })
  }
  const parts = pathParts(patch.path)
  const located = locate(task, patch)
  const actual = readAt(located.root, parts)
  if ('before' in patch && !isDeepStrictEqual(actual, patch.before)) {
    throw new ApiError(409, ERR.PATCH_STALE, '补丁原值与当前规格不一致', { currentVersion: parent })
  }
  return { parent, parts, actual }
}

export function previewPatch(task, patch, now = Date.now(), ttlMs = DEFAULT_TTL_MS) {
  const { parent, parts, actual } = validatePatch(task, patch)
  const plans = clone(currentPlans(task))
  const located = locate(task, patch, plans)
  writeAt(located.root, parts, patch.after)
  const token = randomBytes(24).toString('base64url')
  const payload = {
    taskId: task.taskId,
    parentVersion: parent,
    fingerprint: task.dataset?.fingerprint,
    patch: clone({ ...patch, parentVersion: parent }),
    expiresAt: now + ttlMs
  }
  previews.set(token, payload)
  return {
    token,
    expiresAt: payload.expiresAt,
    parentVersion: parent,
    planId: patch.planId,
    targetKind: patch.targetKind,
    targetId: patch.targetId,
    path: patch.path,
    before: clone(actual),
    after: clone(patch.after),
    spec: plans[located.planIndex].spec
  }
}

export async function applyPatch(task, token, executeAndVerify, now = Date.now()) {
  const payload = previews.get(token)
  if (!payload) throw new ApiError(400, ERR.PATCH_TOKEN_INVALID, '补丁预览令牌无效或已使用')
  previews.delete(token)
  if (payload.expiresAt < now) throw new ApiError(410, ERR.PATCH_TOKEN_EXPIRED, '补丁预览令牌已过期')
  if (payload.taskId !== task.taskId || payload.fingerprint !== task.dataset?.fingerprint || payload.parentVersion !== currentVersion(task)) {
    throw new ApiError(409, ERR.PATCH_STALE, '任务数据或当前修订已变化，请重新预览补丁', { currentVersion: currentVersion(task) })
  }

  const plans = clone(currentPlans(task))
  const located = locate(task, payload.patch, plans)
  const parts = pathParts(payload.patch.path)
  const actual = readAt(located.root, parts)
  if ('before' in payload.patch && !isDeepStrictEqual(actual, payload.patch.before)) {
    throw new ApiError(409, ERR.PATCH_STALE, '补丁原值已变化，请重新预览')
  }
  writeAt(located.root, parts, payload.patch.after)
  const verifiedPlan = executeAndVerify ? await executeAndVerify(clone(plans[located.planIndex]), payload.patch) : plans[located.planIndex]
  plans[located.planIndex] = verifiedPlan
  const version = Math.max(0, ...(task.planVersions ?? []).map((item) => item.version)) + 1
  const revision = {
    version,
    parent: payload.parentVersion,
    at: now,
    reason: 'patch',
    patch: clone(payload.patch),
    plans,
    artifacts: clone(task.artifacts ?? {})
  }
  task.planVersions ??= []
  task.planVersions.push(revision)
  task.currentRevision = version
  task.plans = clone(plans)
  return revision
}

export function restoreVersion(task, version) {
  const revision = task.planVersions?.find((item) => item.version === Number(version))
  if (!revision) throw new ApiError(404, ERR.REVISION_NOT_FOUND, `修订不存在：${version}`)
  task.currentRevision = revision.version
  task.plans = clone(revision.plans)
  if (revision.artifacts) task.artifacts = clone(revision.artifacts)
  return revision
}

export function revertPatch(task) {
  const current = task.planVersions?.find((item) => item.version === currentVersion(task))
  if (!current) throw new ApiError(404, ERR.REVISION_NOT_FOUND, '当前修订不存在')
  const target = current.parent ?? Math.max(1, current.version - 1)
  return restoreVersion(task, target)
}
