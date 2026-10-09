// Agent 编排层：可观察 12 态状态机。
// 真实推进：INGEST → UNDERSTAND（必要时 NEED_INPUT）→ PLAN → ANALYZE → DESIGN
//          → EXECUTE（沙箱真实运行，含七类错误自动修复，初次执行后最多修复 3 次）
//          → VERIFY（规格/证据/差异三项独立检查）→ PRESENT。
import { createHash, randomUUID } from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { runDeterministicAnalysis, buildDataOverview } from './stats.js'
import { buildPlans } from './plans.js'
import { applyPreference, preferenceSummary, PreferenceStore } from './preferences.js'
import { parseIntent } from './intent.js'
import { parseIntentWithLlm } from './llm.js'
import { runClarification, recommendPresentationPalettes, defaultClarification } from './clarify.js'
import { normalizeUserProfile, profileClarificationDefaults } from './userProfile.js'
import { runInSandbox, assertExecutionAllowed } from './sandbox.js'
import { classifyError, repair, repairVisualLayout, MAX_REPAIRS } from './repair.js'
import { verifyPlan, verifyAllPlans, checkSvgRenderQuality, checkSvgTextLayout } from './verify.js'
import { verifyClaims } from './claims.js'
import { expectedArtifacts, generateCodeForSpec, generateFallbackCode } from './codegen.js'
import { probeEngines } from './engines.js'
import { ApiError, ERR, ERROR_SIGNATURE } from './errors.js'
import { redactText } from './safe.js'
import { previewPatch as buildPatchPreview, applyPatch as applySpecPatch, revertPatch as revertSpecPatch, restoreVersion as restoreSpecVersion } from './patches.js'
import { previewSourceRevision as buildSourcePreview, applySourceRevision } from './sourceRevisions.js'
import { consumeDataRevision, previewDataRevision } from './dataRevisions.js'
import { applyStylePresetToPlan, buildPresetPatches } from './stylePresets.js'

const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const now = () => Date.now()
const sha256 = (s) => createHash('sha256').update(s).digest('hex')
const ENGINE_KINDS = new Set(['python', 'r', 'matlab'])

function enforceVerifiedClaims(analysis) {
  const result = verifyClaims(analysis.claims, analysis.evidence)
  if (!result.passed) {
    throw new ApiError(422, ERR.CLAIM_UNVERIFIED, '存在无法由确定性证据支持的结论，已停止方案发布', {
      rejected: result.rejected.map((item) => ({ claimId: item.claim.claimId, code: item.code }))
    })
  }
  analysis.claims = result.accepted
  analysis.claimVerification = result
  return result
}

// 12 态状态机守卫（架构表 6-1）
const TERMINAL_STATES = new Set(['FAILED', 'COMPLETE', 'CANCELLED']) // 终态：拒绝一切变更操作
const ITERATABLE_STATES = new Set(['PRESENT', 'ITERATE']) // 仅待选择/迭代中允许 select/feedback
// 删除后在途运行用于静默中止的内部信号（不对外、不写 FAILED 事件）
class TaskDeletedError extends Error {
  constructor() {
    super('task deleted')
    this.name = 'TaskDeletedError'
  }
}
class TaskCancelledError extends Error {
  constructor() {
    super('task cancelled')
    this.name = 'TaskCancelledError'
    this.code = 'TASK_CANCELLED'
  }
}

// ---------- 编排器 ----------
export class Orchestrator {
  /**
   * @param {import('./taskStore.js').TaskStore} store
   * @param {{stepDelayMs?:number, storage?:object, probeEngines?:Function}} [options]
   */
  constructor(store, options = {}) {
    this.store = store
    this.stepDelayMs = options.stepDelayMs ?? 40
    this.storage = options.storage ?? null
    this._probe = options.probeEngines ?? probeEngines
    // 沙箱执行器：默认模块级串行队列；服务器可注入独立队列（测试隔离）
    this._runSandbox = options.runSandbox ?? runInSandbox
    this._caps = null
    this.preferenceStore = options.preferenceStore ?? new PreferenceStore(this.storage)
    this.getUserProfile = options.getUserProfile ?? (task => task.userProfile ?? {})
  }

  async capabilities() {
    if (!this._caps) this._caps = await Promise.resolve(this._probe())
    return this._caps
  }

  cancel(task) {
    if (task.state === 'CANCELLED') return { state: 'CANCELLED', cancelledAt: task.cancelledAt }
    if (TERMINAL_STATES.has(task.state)) return { state: task.state, cancelledAt: task.cancelledAt }
    task.cancelledAt = now()
    task.abortController.abort(new TaskCancelledError())
    this.emit(task, { type: 'execution_update', execution: { status: 'cancelled', finishedAt: task.cancelledAt, logs: [] } })
    this.emit(task, { type: 'state_delta', state: 'CANCELLED', cancelledAt: task.cancelledAt })
    this.emit(task, { type: 'done', state: 'CANCELLED', message: '任务已取消；排队工作已移除，运行中的解释器进程树已终止。' })
    return { state: 'CANCELLED', cancelledAt: task.cancelledAt }
  }

  recordPreference(task, preference) {
    const result = this.preferenceStore.append(preference)
    if (result.written) this.emit(task, { type: 'preference', preference: result.event })
    return result
  }

  previewPatch(task, patch) {
    if (TERMINAL_STATES.has(task.state)) throw new ApiError(409, ERR.TASK_TERMINAL, `任务已处于终态 ${task.state}，不能编辑规格`)
    if (!ITERATABLE_STATES.has(task.state)) throw new ApiError(409, ERR.TASK_BUSY, `任务当前处于 ${task.state}，请等待方案呈现`)
    return buildPatchPreview(task, patch)
  }

  async applyPatch(task, token) {
    if (TERMINAL_STATES.has(task.state)) throw new ApiError(409, ERR.TASK_TERMINAL, `任务已处于终态 ${task.state}，不能应用补丁`)
    if (!ITERATABLE_STATES.has(task.state) || task.iterating) throw new ApiError(409, ERR.TASK_BUSY, `任务当前处于 ${task.state}，不能应用补丁`)
    task.iterating = true
    this.emit(task, { type: 'state_delta', state: 'ITERATE' })
    try {
      const csv = await this.#csvText(task)
      const analysis = runDeterministicAnalysis({ profile: task.dataset, text: csv.text, rawDelimiter: csv.rawDelimiter, fileName: task.fileName })
      const revision = await applySpecPatch(task, token, async (plan) => {
        const input = {
          fileName: task.fileName,
          x: analysis.summary.xLabel,
          measures: analysis.summary.series.map((series) => series.label),
          title: plan.spec.figure.title,
          yLabel: plan.spec.panels[0]?.yLabel ?? '测量值',
          outputBase: plan.plan_id
        }
        plan.code = generateCodeForSpec(plan.spec, input)
        plan.executionStatus = 'code_generated_not_executed'
        this.emit(task, { type: 'state_delta', state: 'EXECUTE' })
        const out = await this.#executeOneWithRepair(task, plan, await this.capabilities(), input)
        const verification = verifyPlan(plan, out.result, { evidence: task.evidence, text: csv.text, rawDelimiter: csv.rawDelimiter })
        if (out.result.status !== 'success' || !verification.passed) {
          throw new ApiError(422, ERR.SANDBOX_EXECUTION_FAILED, '补丁后的规格未通过真实执行与独立验证')
        }
        plan.verification = { passed: true, checks: verification.checks, quality: verification.quality, artifactHash: verification.artifactHash, codeHash: sha256(plan.code?.[out.engine] ?? ''), dataFingerprint: task.dataset?.fingerprint ?? null, revision: task.currentRevision ?? 0, engine: out.engine, attempts: out.attempts }
        plan.executionStatus = 'verified'
        this.#attachArtifacts(task, plan, out, verification)
        return plan
      })
      this.emit(task, { type: 'revision_applied', revision })
      this.recordPreference(task, {
        event_id: `pref_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
        kind: 'manual_edit', weight: 0.7, scope: 'task', confidence: 0.8,
        summary: '用户应用并验证 ChartSpec 补丁', planId: revision.patch.planId, t: now()
      })
      this.emit(task, { type: 'state_delta', state: 'PRESENT' })
      this.emit(task, { type: 'done', message: `补丁已应用为修订 ${revision.version}，并通过真实执行与独立验证。` })
      return revision
    } catch (err) {
      if (task.state !== 'FAILED') this.emit(task, { type: 'state_delta', state: 'PRESENT' })
      throw err
    } finally {
      task.iterating = false
    }
  }

  previewSource(task, input) {
    if (TERMINAL_STATES.has(task.state)) throw new ApiError(409, ERR.TASK_TERMINAL, `任务已处于终态 ${task.state}，不能编辑源码`)
    if (!ITERATABLE_STATES.has(task.state)) throw new ApiError(409, ERR.TASK_BUSY, `任务当前处于 ${task.state}，请等待方案呈现`)
    return buildSourcePreview(task, input)
  }

  async applySource(task, token) {
    if (TERMINAL_STATES.has(task.state)) throw new ApiError(409, ERR.TASK_TERMINAL, `任务已处于终态 ${task.state}，不能应用源码`)
    if (!ITERATABLE_STATES.has(task.state) || task.iterating) throw new ApiError(409, ERR.TASK_BUSY, `任务当前处于 ${task.state}，不能应用源码`)
    task.iterating = true
    this.emit(task, { type: 'state_delta', state: 'ITERATE' })
    try {
      const csv = await this.#csvText(task)
      const analysis = runDeterministicAnalysis({ profile: task.dataset, text: csv.text, rawDelimiter: csv.rawDelimiter, fileName: task.fileName })
      const revision = await applySourceRevision(task, token, async (plan, payload) => {
        const input = {
          fileName: task.fileName,
          x: analysis.summary.xLabel,
          measures: analysis.summary.series.map((series) => series.label),
          title: plan.spec.figure.title,
          yLabel: plan.spec.panels[0]?.yLabel ?? '测量值',
          outputBase: plan.plan_id
        }
        if (payload.mode === 'spec') plan.code = generateCodeForSpec(plan.spec, input)
        else plan.code[payload.engine] = payload.source
        this.emit(task, { type: 'state_delta', state: 'EXECUTE' })
        const caps = await this.capabilities()
        const matlabAllowed = payload.engine !== 'matlab' || (caps.matlab?.available && process.env.LOCAL_AGENT_ENABLE_MATLAB === '1')
        if (!caps[payload.engine]?.available || !matlabAllowed) {
          throw new ApiError(422, ERR.SANDBOX_EXECUTION_FAILED, `${payload.engine} 本地运行时不可用或未授权；源码已保留但不能伪造预览`)
        }
        try {
          assertExecutionAllowed({ sourceKind: payload.mode === 'code' ? 'custom' : 'generated' })
        } catch (error) {
          throw new ApiError(503, error?.code ?? 'STRONG_SANDBOX_REQUIRED', error?.message ?? '用户自定义代码需要强沙箱')
        }
        const result = await this._runSandbox({
          workdir: this.#workdir(task, plan.plan_id, 1), engine: payload.engine,
          code: plan.code[payload.engine], csvBuffer: task.bytes, csvName: task.fileName,
          expected: expectedArtifacts(plan.strategy, payload.engine), signal: task.abortController.signal,
          sourceKind: payload.mode === 'code' ? 'custom' : 'generated'
        })
        const verification = verifyPlan(plan, result, { evidence: task.evidence, text: csv.text, rawDelimiter: csv.rawDelimiter })
        if (result.status !== 'success' || !verification.passed) {
          this.#cleanupWorkdir(result)
          throw new ApiError(422, ERR.SANDBOX_EXECUTION_FAILED, '修改后的源码未通过真实执行与独立验证', {
            status: result.status, missingArtifacts: result.missingArtifacts, safetyViolations: result.safetyViolations
          })
        }
        plan.verification = { passed: true, checks: verification.checks, quality: verification.quality, artifactHash: verification.artifactHash, codeHash: sha256(plan.code?.[payload.engine] ?? ''), dataFingerprint: task.dataset?.fingerprint ?? null, revision: task.currentRevision ?? 0, engine: payload.engine, attempts: 1 }
        plan.executionStatus = 'verified'
        this.#attachArtifacts(task, plan, { result, engine: payload.engine, attempts: 1 }, verification)
        return plan
      })
      this.emit(task, { type: 'revision_applied', revision })
      this.emit(task, { type: 'state_delta', state: 'PRESENT' })
      this.emit(task, { type: 'done', message: `源码已应用为修订 ${revision.version}，并通过真实执行与独立验证。` })
      return revision
    } catch (error) {
      if (task.state !== 'FAILED') this.emit(task, { type: 'state_delta', state: 'PRESENT' })
      throw error
    } finally {
      task.iterating = false
    }
  }

  previewData(task, input) {
    if (TERMINAL_STATES.has(task.state)) throw new ApiError(409, ERR.TASK_TERMINAL, `任务已处于终态 ${task.state}，不能修订数据`)
    if (!ITERATABLE_STATES.has(task.state)) throw new ApiError(409, ERR.TASK_BUSY, `任务当前处于 ${task.state}，请等待方案呈现`)
    return previewDataRevision(task, input)
  }

  async applyData(task, token, confirmed) {
    if (TERMINAL_STATES.has(task.state)) throw new ApiError(409, ERR.TASK_TERMINAL, `任务已处于终态 ${task.state}，不能修订数据`)
    const payload = consumeDataRevision(task, token, confirmed)
    const previousFingerprint = task.dataset.fingerprint
    task.planVersions.forEach((revision) => { revision.basedOnOldData = true })
    task.bytes = Buffer.from(payload.bytes)
    task.fileName = payload.fileName
    task.dataset = structuredClone(payload.profile)
    task._csvCache = undefined
    task.artifacts = {}
    task.evidence = []
    task.acceptedClaimIds = []
    const previous = (task.dataVersions ?? []).map((item) => ({ ...item, current: false }))
    if (!previous.length) previous.push({ version: 1, fingerprint: previousFingerprint, current: false, createdAt: task.createdAt })
    task.dataVersions = [...previous, {
      version: previous.length + 1, fingerprint: task.dataset.fingerprint, current: true,
      createdAt: Date.now(), reason: payload.kind, fileName: task.fileName, previousFingerprint
    }]
    this.storage?.replaceDataset?.(task.taskId, { fileName: task.fileName }, task.bytes)
    this.emit(task, { type: 'dataset_revised', dataset: task.dataset, dataVersions: task.dataVersions, markOldData: true })
    this.prepareFeedback(task, { feedback: `数据修订：${payload.kind}`, kind: 'data_revision' })
    await this.replan(task, { feedback: `数据修订：${payload.kind}`, kind: 'data_revision', reason: 'data' })
    return { dataVersion: task.dataVersions.at(-1), state: task.state }
  }

  async applyStylePreset(task, { planId, presetId, parentVersion } = {}) {
    if (TERMINAL_STATES.has(task.state)) throw new ApiError(409, ERR.TASK_TERMINAL, `任务已处于终态 ${task.state}，不能切换样式`)
    if (!ITERATABLE_STATES.has(task.state) || task.iterating) throw new ApiError(409, ERR.TASK_BUSY, `任务当前处于 ${task.state}，不能切换样式`)
    if (Number(parentVersion) !== Number(task.currentRevision)) throw new ApiError(409, ERR.PATCH_STALE, '样式预设基线已变化')
    const plans = structuredClone(task.plans)
    const index = plans.findIndex((plan) => plan.plan_id === planId)
    if (index < 0) throw new ApiError(404, ERR.PLAN_NOT_FOUND, `方案不存在：${planId}`)
    const patches = buildPresetPatches(plans[index], presetId)
    plans[index] = applyStylePresetToPlan(plans[index], presetId)
    task.iterating = true
    this.emit(task, { type: 'state_delta', state: 'ITERATE' })
    try {
      const csv = await this.#csvText(task)
      const analysis = runDeterministicAnalysis({ profile: task.dataset, text: csv.text, rawDelimiter: csv.rawDelimiter, fileName: task.fileName })
      const plan = plans[index]
      const input = { fileName: task.fileName, x: analysis.summary.xLabel, measures: analysis.summary.series.map((series) => series.label), title: plan.spec.figure.title, yLabel: plan.spec.panels[0]?.yLabel ?? '测量值', outputBase: plan.plan_id }
      plan.code = generateCodeForSpec(plan.spec, input)
      this.emit(task, { type: 'state_delta', state: 'EXECUTE' })
      const out = await this.#executeOneWithRepair(task, plan, await this.capabilities(), input)
      const verification = verifyPlan(plan, out.result, { evidence: task.evidence, text: csv.text, rawDelimiter: csv.rawDelimiter })
      if (out.result.status !== 'success' || !verification.passed) throw new ApiError(422, ERR.SANDBOX_EXECUTION_FAILED, '样式预设未通过真实执行与验证')
      plan.verification = { passed: true, checks: verification.checks, quality: verification.quality, artifactHash: verification.artifactHash, codeHash: sha256(plan.code?.[out.engine] ?? ''), dataFingerprint: task.dataset?.fingerprint ?? null, revision: task.currentRevision ?? 0, engine: out.engine, attempts: out.attempts }
      plan.executionStatus = 'verified'
      this.#attachArtifacts(task, plan, out, verification)
      const version = Math.max(0, ...task.planVersions.map((item) => item.version)) + 1
      const revision = { version, parent: task.currentRevision, at: Date.now(), reason: 'style_preset', stylePreset: presetId, patches, plans, artifacts: structuredClone(task.artifacts) }
      task.planVersions.push(revision)
      task.currentRevision = version
      task.plans = structuredClone(plans)
      this.emit(task, { type: 'revision_applied', revision })
      this.emit(task, { type: 'state_delta', state: 'PRESENT' })
      return revision
    } finally {
      task.iterating = false
    }
  }

  revertPatch(task) {
    if (TERMINAL_STATES.has(task.state)) throw new ApiError(409, ERR.TASK_TERMINAL, `任务已处于终态 ${task.state}，不能回退修订`)
    const revision = revertSpecPatch(task)
    this.emit(task, { type: 'revision_restored', version: revision.version })
    return revision
  }

  restoreVersion(task, version) {
    if (TERMINAL_STATES.has(task.state)) throw new ApiError(409, ERR.TASK_TERMINAL, `任务已处于终态 ${task.state}，不能恢复修订`)
    const revision = restoreSpecVersion(task, version)
    this.emit(task, { type: 'revision_restored', version: revision.version })
    return revision
  }

  saveCode(task, { planId, engine, code }) {
    if (TERMINAL_STATES.has(task.state)) throw new ApiError(409, ERR.TASK_TERMINAL, `任务已处于终态 ${task.state}，不能编辑代码`)
    if (!ITERATABLE_STATES.has(task.state) || task.iterating) throw new ApiError(409, ERR.TASK_BUSY, `任务当前处于 ${task.state}，请等待方案呈现`)
    if (!ENGINE_KINDS.has(engine)) throw new ApiError(400, ERR.INVALID_ENGINE, `未知引擎：${engine}`)
    if (typeof code !== 'string' || !code.trim()) throw new ApiError(400, ERR.BAD_REQUEST, '代码不能为空')
    if (Buffer.byteLength(code, 'utf8') > 512 * 1024) throw new ApiError(413, ERR.BAD_REQUEST, '代码草稿不能超过 512KB')
    if (/(?:ark|sk)-[A-Za-z0-9_-]{20,}|(?:api[_-]?key|token|secret)\s*[=:]\s*["'][^"']{12,}/i.test(code)) {
      throw new ApiError(400, ERR.BAD_REQUEST, '检测到疑似密钥；请改用环境变量，不要把密钥写入代码')
    }
    const plans = structuredClone(task.plans)
    const plan = plans.find((item) => item.plan_id === planId)
    if (!plan) throw new ApiError(404, ERR.PLAN_NOT_FOUND, `方案不存在：${planId}`)
    plan.code[engine] = code
    plan.executionStatus = 'code_edited_unverified'
    delete plan.verification
    delete task.artifacts[planId]
    const version = Math.max(0, ...(task.planVersions ?? []).map((item) => item.version)) + 1
    const revision = {
      version,
      parent: task.currentRevision ?? 0,
      at: now(),
      reason: 'code_edit',
      selectedPlanId: planId,
      plans,
      artifacts: structuredClone(task.artifacts ?? {})
    }
    task.planVersions.push(revision)
    task.currentRevision = version
    task.plans = plans
    this.emit(task, { type: 'revision_applied', revision })
    this.recordPreference(task, {
      event_id: `pref_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      kind: 'manual_edit', weight: 0.7, scope: 'task', confidence: 0.85,
      summary: `用户编辑 ${engine.toUpperCase()} 代码草稿`, planId, paletteId: plan.palette?.id, t: now()
    })
    this.log(task, 'info', `${planId} 的 ${engine} 代码已保存为修订 ${version}；运行产物已失效，需重新执行验证`)
    return revision
  }

  emit(task, event) {
    this.store.emit(task, event)
  }

  log(task, level, text, location) {
    const line = { t: now(), level, text, ...(location ? { location } : {}) }
    this.emit(task, { type: 'log', log: line })
  }

  async step(task, s, run, ms = this.stepDelayMs) {
    const started = now()
    s.status = 'running'
    this.emit(task, { type: 'step_update', step: { ...s } })
    if (ms) await delay(ms)
    try {
      this.#alive(task)
      await run?.(s)
    } catch (err) {
      s.status = 'failed'
      s.durationMs = now() - started
      s.outputSummary = err.message
      this.emit(task, { type: 'step_update', step: { ...s } })
      throw err
    }
    s.durationMs = now() - started
    if (s.status !== 'failed' && s.status !== 'skipped') s.status = 'done'
    this.emit(task, { type: 'step_update', step: { ...s } })
  }

  fail(task, code, rawMessage, step) {
    // 对外错误消息统一脱敏：不泄露绝对路径/令牌/密钥（如底层 fs 异常携带路径）
    const message = redactText(rawMessage ?? '任务执行失败', { label: 'agent' })
    if (step) {
      step.status = 'failed'
      step.outputSummary = message
      this.emit(task, { type: 'step_update', step: { ...step } })
    }
    this.log(task, 'error', message)
    this.emit(task, { type: 'state_delta', state: 'FAILED' })
    this.emit(task, { type: 'error', code, message })
  }

  async run(task, ingest, modelConfig) {
    try {
      await this.#runInner(task, ingest, modelConfig)
    } catch (err) {
      if (err instanceof TaskDeletedError || err instanceof TaskCancelledError || task.abortController.signal.aborted) return
      const code = typeof err?.code === 'string' ? err.code : 'INTERNAL'
      this.fail(task, code, err.message || '任务执行失败')
    }
  }

  /** 阶段边界：任务被删除则静默中止 */
  #alive(task) {
    if (task.deleted) throw new TaskDeletedError()
    if (task.abortController.signal.aborted || task.state === 'CANCELLED') throw new TaskCancelledError()
  }

  /**
   * SELECT（架构 6-1：PRESENT 等待 SELECT/FEEDBACK → ITERATE）。
   * 只记录显式偏好并重排序，三套方案全部保留为可恢复分支；不删除、不重执行。
   * 前置条件不满足时抛 ApiError（HTTP 层返回 4xx，不产生状态事件）。
   */
  selectPlan(task, planId, { weight = 0.7, scope = 'project' } = {}) {
    if (TERMINAL_STATES.has(task.state)) {
      throw new ApiError(409, ERR.TASK_TERMINAL, `任务已处于终态 ${task.state}，不能再选择方案`)
    }
    if (!task.plans.length) {
      throw new ApiError(409, ERR.TASK_NOT_WAITING, '方案尚未生成，无法选择')
    }
    const plan = task.plans.find((p) => p.plan_id === planId)
    if (!plan) {
      throw new ApiError(404, ERR.PLAN_NOT_FOUND, `方案 ${planId} 不存在`, { available: task.plans.map((p) => p.plan_id) })
    }
    const pref = {
      event_id: `pref_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      kind: 'select_plan',
      weight,
      scope,
      summary: preferenceSummary('select_plan', plan),
      confidence: 0.8,
      t: now(),
      planId,
      paletteId: plan.palette?.id
    }
    const reranked = applyPreference(task.plans, pref)
    const preferenceResult = this.recordPreference(task, pref)
    // 排序变化只下发 preference 原因的 plans_ready，不产生新 PlotRevision 版本
    this.emit(task, { type: 'plans_ready', plans: reranked, reason: 'preference' })
    if (task.state === 'PRESENT') this.emit(task, { type: 'state_delta', state: 'ITERATE' })
    this.log(task, 'info', `已选择 ${planId}，其他方案保留为可恢复分支（可随时切回，旧版本在 planVersions 中可追溯）`)
    return { state: task.state, selectedPlanId: planId, ranking: reranked.map((p) => p.plan_id), preference: preferenceResult.event, preferenceWritten: preferenceResult.written, plans: reranked }
  }

  /**
   * FEEDBACK（ITERATE → 限定作用域更新规格/代码 → 重新执行与验证 → 新 PlotRevision → PRESENT）。
   * 同步部分只做前置校验与状态迁移并立即返回（202），重执行在后台进行。
   */
  prepareFeedback(task, { feedback = '', kind = 'manual_edit', planId } = {}) {
    if (TERMINAL_STATES.has(task.state)) {
      throw new ApiError(409, ERR.TASK_TERMINAL, `任务已处于终态 ${task.state}，不能再提交反馈`)
    }
    if (!task.dataset || !task.plans.length) {
      throw new ApiError(409, ERR.TASK_NOT_WAITING, '任务尚未完成首轮方案呈现，无法提交反馈')
    }
    if (!ITERATABLE_STATES.has(task.state)) {
      throw new ApiError(409, ERR.TASK_BUSY, `任务当前处于 ${task.state}，请等待当前执行轮次结束后再提交反馈`)
    }
    if (task.iterating) {
      throw new ApiError(409, ERR.TASK_BUSY, '上一轮反馈仍在执行，请等待其完成后再提交')
    }
    if (!feedback || !feedback.trim()) {
      throw new ApiError(400, ERR.BAD_REQUEST, '反馈内容不能为空')
    }
    if (planId && !task.plans.some((p) => p.plan_id === planId)) {
      throw new ApiError(404, ERR.PLAN_NOT_FOUND, `方案 ${planId} 不存在`, { available: task.plans.map((p) => p.plan_id) })
    }
    task.iterating = true
    if (task.state === 'PRESENT') this.emit(task, { type: 'state_delta', state: 'ITERATE' })
    this.log(task, 'tool', `接收反馈（${kind}${planId ? `，作用于 ${planId}` : '，项目级作用域'}）：${feedback.trim()}`)
    return { state: task.state }
  }

  /**
   * COMPLETE（架构 6-1：用户确认或导出 → 冻结版本、写偏好事件与复现清单，任务结束）。
   * 幂等：已 COMPLETE 时不重复发事件。
   */
  complete(task, { trigger = 'export' } = {}) {
    if (task.state === 'COMPLETE') return { state: 'COMPLETE', frozen: true }
    if (task.state === 'FAILED') {
      throw new ApiError(409, ERR.TASK_TERMINAL, '任务已失败，不能完成')
    }
    if (!ITERATABLE_STATES.has(task.state)) {
      throw new ApiError(409, ERR.TASK_NOT_WAITING, `任务当前处于 ${task.state}，尚未呈现可冻结的方案`)
    }
    const pref = {
      event_id: `pref_${randomUUID().replace(/-/g, '').slice(0, 12)}`,
      kind: 'export',
      weight: 0.45,
      scope: 'project',
      summary: trigger === 'confirm' ? '用户确认方案，冻结版本' : '用户导出复现包，冻结当前版本',
      confidence: 0.8,
      t: now()
    }
    this.recordPreference(task, pref)
    this.emit(task, { type: 'state_delta', state: 'COMPLETE' })
    this.emit(task, { type: 'done', message: '版本已冻结，任务完成；快照、Trace 与复现清单仍可查看与下载。' })
    return { state: 'COMPLETE', frozen: true }
  }

  /** 偏好反馈后重规划（REPLAN）：保留数据与证据，重新生成方案并真实执行 */
  async replan(task, { feedback = '', kind = 'manual_edit', planId, reason = 'feedback' } = {}) {
    try {
      this.#alive(task)
      const profile = task.dataset
      // 从原始字节重放确定性统计（结果与首次一致；证据账本不重复追加）
      const csv = await this.#csvText(task)
      const analysis = runDeterministicAnalysis({ profile, text: csv.text, rawDelimiter: csv.rawDelimiter, fileName: task.fileName })
      const claimVerification = enforceVerifiedClaims(analysis)
      task.acceptedClaimIds = claimVerification.accepted.map((claim) => claim.claimId)
      if (reason === 'data') {
        task.evidence = []
        for (const evidence of analysis.evidence) this.emit(task, { type: 'evidence', evidence })
      }

      this.emit(task, { type: 'state_delta', state: 'DESIGN' })
      this.log(task, 'tool', `按反馈重规划：${feedback || '（无附加说明）'}，偏好类型 ${kind}`)
      const titleBase = feedback.trim() ? feedback.trim().slice(0, 22) : task.fileName.replace(/\.csv$/i, '')
      const plans = buildPlans(analysis, {
        fileName: task.fileName,
        titleBase,
        engine: task.execution.engine,
        executed: false,
        userRequest: `${task.prompt}\n${feedback}`,
        preferenceEvents: this.preferenceStore.snapshot().events,
        clarification: task.clarification
      })
      // feedback 触发的 plans_ready 生成新 PlotRevision 版本记录（旧版本保留在 planVersions）
      this.emit(task, { type: 'plans_ready', plans, reason, feedback: feedback.trim(), selectedPlanId: planId ?? task.selectedPlanId, selectionAudit: plans.selectionAudit, dataFingerprint: task.dataset.fingerprint })
      await this.#executeAndVerify(task, plans, analysis, {
        reason,
        feedback: feedback.trim(),
        codegenInput: {
          fileName: task.fileName,
          x: analysis.summary.xLabel,
          measures: analysis.summary.series.map((s) => s.label),
          title: titleBase,
          yLabel: '测量值'
        }
      })
    } catch (err) {
      if (err instanceof TaskDeletedError) return
      const code = typeof err?.code === 'string' ? err.code : 'INTERNAL'
      this.fail(task, code, err.message || '重规划失败')
    } finally {
      task.iterating = false
    }
  }

  async #runInner(task, ingest, modelConfig) {
    const { profile, text, rawDelimiter } = ingest
    task.dataset = profile
    if (!task.dataVersions.length) task.dataVersions.push({ version: 1, fingerprint: profile.fingerprint, current: true, createdAt: task.createdAt, reason: 'initial', fileName: task.fileName })
    const sizeKb = (profile.sizeBytes / 1024).toFixed(1)
    // ---- INGEST ----
    this.emit(task, { type: 'state_delta', state: 'INGEST' })
    const load = { step_id: 'csv_load', tool: 'csv.load', title: '读取数据文件', status: 'pending', dependsOn: [], inputSummary: task.fileName }
    await this.step(task, load, (s) => {
      s.outputSummary = `${sizeKb} KB 已读入受控工作目录（持久化于 .data，默认 24h 清理）`
    })
    const enc = { step_id: 'csv_encoding', tool: 'csv.detect_encoding', title: '编码与分隔符探测', status: 'pending', dependsOn: ['csv_load'] }
    await this.step(task, enc, (s) => {
      s.outputSummary = `编码 ${profile.encoding}；分隔符 "${profile.delimiter}"；表头 ${profile.hasHeader ? '有' : '无'}`
    })
    const prof = { step_id: 'data_profile', tool: 'data.profile', title: '数据体检与内容指纹', status: 'pending', dependsOn: ['csv_encoding'] }
    await this.step(task, prof, (s) => {
      s.outputSummary = `${profile.rows} 行 × ${profile.cols} 列；指纹 ${profile.fingerprint.slice(0, 12)}…；${profile.warnings.length} 条质量提示`
    })
    profile.warnings.forEach((w) => this.log(task, 'warn', `数据质量提示：${w}`))
    // v0.4.2：上传后立即生成数据概览（列类型/缺失率/数值范围/异常值提示/前几行预览），澄清轮询前随快照下发；异常值仅提示不改数据（数据包不变）。
    task.dataOverview = buildDataOverview(text, rawDelimiter, profile)
    this.#alive(task)

    // ---- UNDERSTAND（确定性规则；配置 LLM 时优先 LLM，失败自动回退） ----
    this.emit(task, { type: 'state_delta', state: 'UNDERSTAND' })
    const intentStep = { step_id: 'intent_parse', tool: 'intent.parse', title: '意图解析为 TaskSpec', status: 'pending', dependsOn: ['data_profile'] }
    let question = task.prompt.trim()

    const confirmIntent = async (q) => {
      const r = await parseIntentWithLlm(q, profile, { config: modelConfig })
      const spec = r.source === 'llm' ? r.spec : parseIntent(q, profile)
      if (r.source === 'llm') this.log(task, 'info', '意图解析来源：LLM（统计与结论仍由确定性管线产出）')
      else if (r.llmError) this.log(task, 'warn', `LLM 意图解析不可用（${r.llmError}），回退确定性规则`)
      if (spec.missingFields.length > 0) {
        const msg = `数据中不存在字段：${spec.missingFields.map((f) => `「${f}」`).join('、')}；已停止生成结论，不虚构字段（AGT-002 / 真实数据约束）`
        throw new ApiError(422, ERR.UNKNOWN_FIELD, msg, { availableFields: profile.columns.map((c) => c.name) })
      }
      return { spec, source: r.source }
    }

    let spec
    let intentSource = 'rule'
    let userProfile = {}
    try { userProfile = normalizeUserProfile(await this.getUserProfile(task)) }
    catch { this.log(task, 'warn', '账号偏好暂不可用，本次按默认设置继续；可在任务中指定图例、语言与配色。') }
    const profileDefaults = profileClarificationDefaults(userProfile)
    if ((task.clarify !== true || userProfile.clarificationMode === 'off') && (Object.keys(profileDefaults).length || userProfile.clarificationMode === 'off')) task.clarification = { ...defaultClarification(), ...profileDefaults }
    if (task.clarify === true && userProfile.clarificationMode !== 'off') {
      // ---- 多轮需求澄清（≥3 轮）：意图解析（字段映射）→ 逐轮提问（图型任务/图型偏好/标题图注排版）----
      intentStep.status = 'running'
      this.emit(task, { type: 'step_update', step: { ...intentStep } })
      try {
        const r = await confirmIntent(question)
        spec = r.spec
        intentSource = r.source
      } catch (err) {
        intentStep.status = 'failed'
        intentStep.outputSummary = err.message
        this.emit(task, { type: 'state_delta', state: 'UNDERSTAND' })
        this.emit(task, { type: 'step_update', step: { ...intentStep } })
        throw err
      }
      const ask = async (round, payload) => {
        this.emit(task, { type: 'state_delta', state: 'NEED_INPUT' })
        this.emit(task, { type: 'need_input', ...payload, round, total: 3 })
        return new Promise((resolve, reject) => {
          task.answerResolver = (answer) => {
            task.answerResolver = null
            if (!answer || !answer.trim()) reject(new ApiError(400, ERR.BAD_REQUEST, '澄清回答不能为空'))
            else resolve(answer.trim())
          }
        })
      }
      const clarification = await runClarification(task, {
        ask,
        prefill: task.clarifyAnswers,
        context: { columns: task.dataset?.columns ?? [], userProfile },
        // 第三轮注入推荐色板：综合用户历史配色学习先验 + 图型角色语义 + 可读性质量，top3 供表单点选
        decorate: async (round, payload, clarify) => {
          if (round !== 3) return payload
          const recommended = recommendPresentationPalettes({
            preferenceEvents: this.preferenceStore.snapshot().events,
            chartType: clarify.chartType ?? '',
            seriesCount: task.dataset?.columns?.filter((c) => c.inferredType === 'numeric').length ?? 1
          })
          return { ...payload, recommendedPalettes: recommended }
        }
      })
      task.clarification = clarification
      this.log(task, 'info', `三轮需求澄清完成：目标=${clarification.goal}；图型偏好=${clarification.chartType}；标题=${clarification.title || '（按默认）'}；排版来源=${clarification.typography?.source ?? 'default'}`)
      intentStep.status = 'done'
      intentStep.durationMs = now()
      intentStep.outputSummary = `[${intentSource}] TaskSpec：${(question.slice(0, 24) || '按默认映射')}；三轮澄清：图型偏好 ${clarification.chartType}，排版来源 ${clarification.typography?.source ?? 'default'}`
      this.emit(task, { type: 'state_delta', state: 'UNDERSTAND' })
      this.emit(task, { type: 'step_update', step: { ...intentStep } })
    } else if (question.length < 6 && userProfile.clarificationMode !== 'off') {
      this.emit(task, { type: 'state_delta', state: 'NEED_INPUT' })
      intentStep.status = 'running'
      this.emit(task, { type: 'step_update', step: { ...intentStep } })
      this.emit(task, {
        type: 'need_input',
        question: '希望图表突出哪类信息？（最少追问，仅在关键歧义时提出）',
        options: ['各组之间的直接对比', '随观测顺序的趋势与不确定性', '在有限版面承载更多信息']
      })
      question = await new Promise((resolve, reject) => {
        task.answerResolver = (answer) => {
          task.answerResolver = null
          if (!answer || !answer.trim()) reject(new ApiError(400, ERR.BAD_REQUEST, '澄清回答不能为空'))
          else resolve(answer.trim())
        }
      })
      try {
        const r = await confirmIntent(question)
        spec = r.spec
        intentSource = r.source
      } catch (err) {
        intentStep.status = 'failed'
        intentStep.outputSummary = err.message
        this.emit(task, { type: 'state_delta', state: 'UNDERSTAND' })
        this.emit(task, { type: 'step_update', step: { ...intentStep } })
        throw err
      }
      intentStep.status = 'done'
      intentStep.durationMs = now()
      intentStep.outputSummary = `[${intentSource}] TaskSpec：${question.slice(0, 36)}；引用字段 ${spec.variables.join('、') || '按默认映射'}`
      this.emit(task, { type: 'state_delta', state: 'UNDERSTAND' })
      this.emit(task, { type: 'step_update', step: { ...intentStep } })
    } else {
      await this.step(task, intentStep, async (s) => {
        const r = await confirmIntent(question)
        spec = r.spec
        intentSource = r.source
        s.outputSummary = `[${intentSource}] TaskSpec：${question.slice(0, 36)}；引用字段 ${spec.variables.join('、') || '按默认映射'}`
      })
    }

    // ---- PLAN ----
    this.#alive(task)
    this.emit(task, { type: 'state_delta', state: 'PLAN' })
    const dag = [
      { step_id: 'stats_summarize', tool: 'stats.summarize', title: '确定性统计分析（仅执行一次）', status: 'pending', dependsOn: ['intent_parse'], inputSummary: '描述统计 / 趋势 / 极值 / 缺失率' },
      { step_id: 'claim_bind', tool: 'claim.bind_evidence', title: '结论与证据绑定', status: 'pending', dependsOn: ['stats_summarize'] },
      { step_id: 'plan_candidates', tool: 'plan.generate_candidates', title: '生成候选 ChartSpec（清晰/惯例/密度三策略）', status: 'pending', dependsOn: ['claim_bind'] },
      { step_id: 'plan_mmr', tool: 'plan.score_mmr', title: '效用评分与 MMR 去重', status: 'pending', dependsOn: ['plan_candidates'] },
      { step_id: 'code_execute', tool: 'code.execute', title: '沙箱执行三引擎代码（含自动修复）', status: 'pending', dependsOn: ['plan_mmr'], inputSummary: 'Python 真实执行；R/MATLAB 不可用时自动切换' },
      { step_id: 'render_output', tool: 'render.output', title: '渲染并回收 SVG/PNG 预览', status: 'pending', dependsOn: ['code_execute'] },
      { step_id: 'verify_validate', tool: 'verify.validate', title: '独立验证（规格/证据/差异）', status: 'pending', dependsOn: ['render_output'] }
    ]
    dag.forEach((s) => this.emit(task, { type: 'step_update', step: { ...s } }))
    const planBuild = {
      step_id: 'plan_build', tool: 'plan.build', title: '构建 PlanGraph 执行计划', status: 'done',
      dependsOn: ['intent_parse'], outputSummary: `${dag.length} 个工具节点，含依赖、修复预算（${MAX_REPAIRS} 次）与停止条件`, durationMs: this.stepDelayMs
    }
    this.emit(task, { type: 'step_update', step: planBuild })
    if (this.stepDelayMs) await delay(this.stepDelayMs)
    const byId = Object.fromEntries(dag.map((s) => [s.step_id, s]))

    // ---- ANALYZE ----
    this.#alive(task)
    this.emit(task, { type: 'state_delta', state: 'ANALYZE' })
    const analysis = runDeterministicAnalysis({ profile, text, rawDelimiter, fileName: task.fileName })
    const claimVerification = enforceVerifiedClaims(analysis)
    task.acceptedClaimIds = claimVerification.accepted.map((claim) => claim.claimId)
    await this.step(task, byId.stats_summarize, (s) => {
      s.evidenceIds = analysis.evidence.map((e) => e.evidence_id)
      s.outputSummary = `${analysis.summary.series.length} 个测量系列 × ${analysis.summary.x.length} 个观测点；统计只执行一次，证据 ${analysis.evidence.length} 条`
    })
    analysis.evidence.forEach((e) => this.emit(task, { type: 'evidence', evidence: e }))
    this.log(task, 'tool', `证据账本写入 ${analysis.evidence.length} 条，统计结果供三方案共享，不重复计算`)
    await this.step(task, byId.claim_bind, (s) => {
      s.evidenceIds = [...new Set(claimVerification.accepted.map((claim) => claim.evidenceId))]
      s.outputSummary = `ClaimVerifier 通过 ${claimVerification.accepted.length} 条结构化结论；所有结论均引用存在的 evidence_id，相关 ≠ 因果`
    })

    // ---- DESIGN ----
    this.#alive(task)
    this.emit(task, { type: 'state_delta', state: 'DESIGN' })
    const titleBase = question.length > 24 ? question.slice(0, 22) + '…' : question
    const fallbackTitle = task.fileName.replace(/\.csv$/i, '')
    let plans = []
    await this.step(task, byId.plan_candidates, (s) => {
      plans = buildPlans(analysis, {
        fileName: task.fileName,
        titleBase: titleBase || fallbackTitle,
        engine: task.execution.engine,
        executed: false,
        userRequest: question,
        preferenceEvents: this.preferenceStore.snapshot().events,
        clarification: task.clarification
      })
      s.outputSummary = `生成 ${plans.length} 套候选，覆盖清晰/惯例/密度三策略，evidenceIds 完全共享`
    })
    await this.step(task, byId.plan_mmr, (s) => {
      const dimsOk = plans.every((p) => p.diffDimensions.length >= 2)
      const audit = plans.selectionAudit
      s.outputSummary = audit
        ? `候选池 K=${audit.K}（可执行 ${audit.executableCount}、淘汰 ${audit.infeasibleCount}），MMR(λ=${audit.lambda}) 保留 3 套，差异维度${dimsOk ? '均 ≥ 2' : '不足'}`
        : dimsOk
          ? '保留 3 套，差异维度均 ≥ 2'
          : '差异维度不足'
    })
    this.emit(task, { type: 'plans_ready', plans, reason: 'initial', selectionAudit: plans.selectionAudit })

    await this.#executeAndVerify(task, plans, analysis, {
      codegenInput: {
        fileName: task.fileName,
        x: analysis.summary.xLabel,
        measures: analysis.summary.series.map((s) => s.label),
        title: titleBase || fallbackTitle,
        yLabel: '测量值'
      },
      byId
    })
  }

  /** EXECUTE（含 REPAIR）→ VERIFY → PRESENT */
  async #executeAndVerify(task, plans, analysis, opts = {}) {
    const reason = opts.reason ?? 'initial'
    const feedback = opts.feedback
    const byId =
      opts.byId ??
      Object.fromEntries(
        task.steps
          .filter((s) => ['code_execute', 'render_output', 'verify_validate'].includes(s.step_id))
          .map((s) => [s.step_id, s])
      )
    const codegenInput =
      opts.codegenInput ?? {
        fileName: task.fileName,
        x: analysis.summary.xLabel,
        measures: analysis.summary.series.map((s) => s.label),
        title: task.title,
        yLabel: '测量值'
      }

    // ---- EXECUTE ----
    task.iteration = (task.iteration ?? 0) + 1
    const iteration = task.iteration
    this.emit(task, { type: 'state_delta', state: 'EXECUTE' })
    this.emit(task, {
      type: 'execution_update',
      execution: { version: iteration, engine: task.execution.engine, status: 'running', startedAt: now(), logs: [] }
    })
    const execStep = byId.code_execute
    execStep.status = 'running'
    execStep.attempts = 0
    this.emit(task, { type: 'step_update', step: { ...execStep } })

    const results = {}
    const caps = await this.capabilities()
    const csv = await this.#csvText(task)
    for (const plan of plans) {
      this.#alive(task)
      const out = await this.#executeOneWithRepair(task, plan, caps, codegenInput)
      results[plan.plan_id] = out.result
      execStep.attempts = (execStep.attempts ?? 0) + out.attempts
      // 单方案验证（规格 + 证据）：验证器从原始 CSV 独立重算，不读生成器内部状态
      const v = verifyPlan(plan, out.result, { evidence: task.evidence, text: csv.text, rawDelimiter: csv.rawDelimiter })
      const verified = out.result.status === 'success' && v.passed
      plan.verification = { passed: v.passed, checks: v.checks, quality: v.quality, artifactHash: v.artifactHash, codeHash: sha256(plan.code?.[out.engine] ?? ''), dataFingerprint: task.dataset?.fingerprint ?? null, revision: task.currentRevision ?? 0, engine: out.engine, attempts: out.attempts }
      plan.executionStatus = out.result.status === 'success' ? (verified ? 'verified' : 'rendered_unverified') : 'failed_execution'
      plan.dataProcessingSummary = plan.dataProcessingSummary.replace(
        /代码将在[\s\S]*?自动修复（(?:预算 [23] 次|最多 3 次)）。/,
        out.result.status === 'success'
          ? verified
            ? '代码已在受控沙箱真实执行，SVG/PNG 产物通过规格/证据独立验证。'
            : '代码已在受控沙箱真实执行并产出 SVG/PNG，但独立验证存在未通过项（见 verification）。'
          : '代码在受控沙箱执行失败，自动修复未成功，不提供渲染预览（诚实降级）。'
      )
      this.#attachArtifacts(task, plan, out, v)
      const fontWarnings = `${out.result.stdout ?? ''}\n${out.result.stderr ?? ''}`.split(/\r?\n/)
        .filter(line => /CJK_FONT_|Glyph .*missing from font/i.test(line))
      if (fontWarnings.length) this.log(task, 'warn', `${plan.plan_id} 字体告警：${[...new Set(fontWarnings)].slice(0, 4).join('；')}`)
      if (out.result.status === 'success') {
        this.log(task, 'tool', `${plan.plan_id} 执行成功（${out.engine}，第 ${out.attempts} 次尝试），验证${verified ? '通过' : '存在未通过项'}：${v.checks.map((c) => `${c.name}${c.passed ? '[PASS]' : '[FAIL]'}`).join(' ')}`)
      } else {
        this.log(task, 'error', `${plan.plan_id} 执行失败（${out.classified?.category ?? 'UNKNOWN'}）：${out.result.stderr?.slice(-200) || out.result.missingArtifacts?.join(',')}`)
      }
    }

    const successPlans = plans.filter((p) => p.executionStatus !== 'failed_execution')
    const verifiedPlans = plans.filter((p) => p.executionStatus === 'verified')
    if (successPlans.length === 0) {
      execStep.status = 'failed'
      const last = Object.values(results).at(-1)
      const classified = classifyError(last)
      execStep.outputSummary = `三套方案执行均失败；末个错误签名：${classified.signature}`
      this.emit(task, { type: 'step_update', step: { ...execStep } })
      this.emit(task, {
        type: 'execution_update',
        execution: { version: iteration, status: 'error', finishedAt: now(), errorCategory: classified.category, normalizedError: classified.signature, logs: [] }
      })
      this.fail(task, 'SANDBOX_EXECUTION_FAILED', `沙箱执行全部失败（${classified.category}/${classified.signature}），已尝试自动修复但未成功`, execStep)
      return
    }
    execStep.status = 'done'
    execStep.outputSummary = `${successPlans.length}/3 套执行成功；自动修复累计 ${task.retries} 次；引擎 ${[...new Set(successPlans.map((p) => p.verification.engine))].join(',')}`
    this.emit(task, { type: 'step_update', step: { ...execStep } })

    // ---- VERIFY（含三方案差异检查） ----
    this.#alive(task)
    this.emit(task, { type: 'state_delta', state: 'VERIFY' })
    const renderStep = byId.render_output
    renderStep.status = 'done'
    const pngs = successPlans.map((p) => task.artifacts[p.plan_id]?.png).filter(Boolean)
    renderStep.outputSummary = `回收 SVG ${successPlans.length} 份、PNG ${pngs.length} 份（尺寸 ${pngs.map((p) => `${p.width}×${p.height}`).join('；')}）`
    this.emit(task, { type: 'step_update', step: { ...renderStep } })

    const overall = verifyAllPlans(plans, results, { evidence: task.evidence, text: csv.text, rawDelimiter: csv.rawDelimiter })
    task.verification = {
      passed: overall.passed,
      difference: overall.difference,
      perPlan: Object.fromEntries(plans.map((p) => [p.plan_id, p.verification])),
      verifiedAt: now()
    }
    const verifyStep = byId.verify_validate
    verifyStep.status = overall.passed ? 'done' : 'failed'
    verifyStep.outputSummary = [
      ...plans.map((p) => `${p.plan_id}：${p.verification.passed ? '通过' : '未通过'}`),
      `方案差异：${overall.difference.passed ? '通过' : '未通过'}`
    ].join('；')
    this.emit(task, { type: 'step_update', step: { ...verifyStep } })

    // 重新下发带验证结果的方案集合（同一 PlotRevision 的验证完成版；feedback 轮次同样记录新版本）
    this.emit(task, {
      type: 'plans_ready',
      plans: plans.map((p) => ({ ...p })),
      reason,
      feedback: feedback ?? undefined,
      ...(plans.selectionAudit ? { selectionAudit: plans.selectionAudit } : {})
    })

    // 执行记录收口：默认预览第一套通过验证的方案
    const preferred = verifiedPlans[0] ?? successPlans[0]
    const prefArt = task.artifacts[preferred.plan_id]
    this.emit(task, {
      type: 'execution_update',
      execution: {
        version: iteration,
        engine: preferred.verification.engine,
        status: 'success',
        startedAt: task.execution.startedAt,
        finishedAt: now(),
        codeHash: preferred.verification.artifactHash ? sha256(preferred.code[preferred.verification.engine]) : undefined,
        artifactSvg: prefArt?.inline?.svg,
        logs: []
      }
    })

    // ---- PRESENT ----
    this.#alive(task)
    this.emit(task, { type: 'state_delta', state: 'PRESENT' })
    const warn = successPlans.length < 3 ? `；${3 - successPlans.length} 套执行失败已在步骤中标注` : ''
    this.emit(task, {
      type: 'done',
      message: `三套方案已在沙箱真实执行并完成独立验证：${verifiedPlans.length}/3 通过全部检查${warn}。产物为真实 SVG/PNG（非 Mock），统计仅执行一次、证据已绑定，自动修复累计 ${task.retries} 次。数据：${task.dataset.rows} 行 × ${task.dataset.cols} 列，证据 ${task.evidence.length} 条。`
    })
  }

  #attachArtifacts(task, plan, out, verification) {
    const svgItem = out.result.artifacts.find((a) => a.name.endsWith('.svg'))
    const pngItem = out.result.artifacts.find((a) => a.name.endsWith('.png'))
    const pdfItem = out.result.artifacts.find((a) => a.name.endsWith('.pdf'))
    const info = {
      attempts: out.attempts,
      latestAttempt: `attempt-${out.attempts}`,
      engine: out.engine,
      verified: verification.passed,
      checks: verification.checks,
      quality: verification.quality,
      hash: verification.artifactHash,
      svgFile: svgItem?.name,
      png: pngItem?.png ? { width: pngItem.png.width, height: pngItem.png.height } : undefined,
      svgBytes: svgItem?.bytes,
      inline: {
        svg: svgItem?.svg,
        pngBase64: pngItem?.png?.dataBase64,
        pdfBase64: pdfItem && fs.existsSync(path.join(out.result.workdir, pdfItem.name))
          ? fs.readFileSync(path.join(out.result.workdir, pdfItem.name)).toString('base64')
          : undefined
      },
      missingArtifacts: out.result.missingArtifacts
    }
    this.store.attachArtifact(task, plan.plan_id, info)
    this.#cleanupWorkdir(out.result)
  }

  #cleanupWorkdir(result) {
    if (this.storage || !result?.workdir) return
    const resolved = path.resolve(result.workdir)
    const tempRoot = path.resolve(os.tmpdir())
    const isOwnedTemp = resolved.startsWith(`${tempRoot}${path.sep}`) && path.basename(resolved).startsWith('local-agent-')
    if (!isOwnedTemp) return
    try { fs.rmSync(resolved, { recursive: true, force: true }) } catch { /* best-effort cleanup */ }
  }

  async #csvText(task) {
    if (!task._csvCache) {
      const { decodeBytes } = await import('./csv.js')
      const decoded = decodeBytes(task.bytes)
      const text = decoded.text.replace(/^﻿/, '')
      const rawDelimiter = task.dataset.delimiter === '\\t' ? '\t' : task.dataset.delimiter
      task._csvCache = { text, rawDelimiter }
    }
    return task._csvCache
  }

  /** 单方案执行 + 自动修复循环（修复预算 MAX_REPAIRS） */
  async #executeOneWithRepair(task, plan, caps, codegenInput) {
    const strategy = plan.strategy
    let engine = task.execution.engine
    let code = plan.code[engine]
    let attempt = 0
    let result
    let classified
    const repairs = []

    // ENGINE 预检：R 不可用、或 MATLAB 未显式授权（许可证须用户自有）时切换 Python（记一次自动修复）
    const matlabAuthorized = process.env.LOCAL_AGENT_ENABLE_MATLAB === '1'
    const engineUsable = (e) => (e === 'matlab' ? caps.matlab?.available && matlabAuthorized : caps[e]?.available)
    let inRepair = false
    if (engine !== 'python' && !engineUsable(engine)) {
      const reason = engine === 'matlab' && caps.matlab?.available && !matlabAuthorized ? '检测到 MATLAB 但未设置 LOCAL_AGENT_ENABLE_MATLAB=1（许可证须用户自有）' : `引擎 ${engine} 不可用（${caps[engine]?.note ?? '未检测到'}）`
      classified = { category: ERROR_SIGNATURE.ENGINE, signature: 'engine.not_available', hint: '切换 Python', repairable: true }
      this.log(task, 'warn', `${reason}，自动切换 Python 执行`)
      repairs.push(classified)
      task.retries += 1
      this.emit(task, { type: 'state_delta', state: 'REPAIR' })
      this.emit(task, { type: 'retry', retries: task.retries })
      this.emit(task, {
        type: 'execution_update',
        execution: { status: 'running', errorCategory: ERROR_SIGNATURE.ENGINE, normalizedError: 'engine.not_available', logs: [] }
      })
      engine = 'python'
      code = plan.code.python
      inRepair = true
    }

    // DEPENDENCY 前置适配：能力探测显示 Python 缺 pandas 时，首次执行直接采用标准库 csv + matplotlib 降级模板。
    // 这是按真实可用运行时的主动选择，不进入 REPAIR、不增加 retries，避免可预见的依赖失败与修复循环。
    if (engine === 'python' && !caps.python?.dependencies?.pandas) {
      const proactiveFallback = generateFallbackCode(strategy, codegenInput)
      if (proactiveFallback && proactiveFallback !== code) {
        code = proactiveFallback
        this.log(task, 'tool', '能力探测：Python 缺少 pandas，首次执行直接采用标准库 csv + matplotlib 降级模板（不触发修复）')
      }
    }

    while (attempt <= MAX_REPAIRS) {
      this.#alive(task)
      if (inRepair) this.emit(task, { type: 'state_delta', state: 'EXECUTE' })
      inRepair = false
      const workdir = this.#workdir(task, plan.plan_id, attempt + 1)
      const codeHash = sha256(code)
      this.log(task, 'tool', `沙箱执行 ${plan.plan_id}：${engine}，第 ${attempt + 1} 次尝试，代码指纹 ${codeHash.slice(0, 10)}…`)
      result = await this._runSandbox({
        workdir,
        engine,
        code,
        csvBuffer: task.bytes,
        csvName: task.fileName,
        expected: expectedArtifacts(strategy, engine),
        signal: task.abortController.signal
      })
      if (result.cancelled || task.abortController.signal.aborted) throw new TaskCancelledError()
      if (result.status === 'success') {
        const svg = result.artifacts?.find((artifact) => artifact.name.endsWith('.svg'))?.svg
        const png = result.artifacts?.find((artifact) => artifact.name.endsWith('.png'))?.png
        const renderChecks = [checkSvgTextLayout(svg), checkSvgRenderQuality(svg, png)]
        const failedRenderChecks = renderChecks.filter((check) => !check.passed)
        if (failedRenderChecks.length) {
          const hint = failedRenderChecks.map((check) => `${check.name}: ${check.detail}`).join('；')
          classified = {
            category: ERROR_SIGNATURE.RENDER,
            signature: 'render.visual_quality_failed',
            hint,
            repairable: engine === 'python' && attempt < MAX_REPAIRS
          }
          this.#cleanupWorkdir(result)
          if (classified.repairable) {
            const fixed = repairVisualLayout(code, attempt + 1)
            if (fixed && fixed !== code) {
              repairs.push(classified)
              task.retries += 1
              this.emit(task, { type: 'state_delta', state: 'REPAIR' })
              this.emit(task, { type: 'retry', retries: task.retries })
              this.log(task, 'warn', `${plan.plan_id} 最终渲染质检未通过，自动调整画布边距/标题预留并重新绘制：${hint}`)
              code = fixed
              inRepair = true
              attempt += 1
              continue
            }
          }
          plan.code[engine] = code
          this.log(task, 'error', `${plan.plan_id} 最终渲染质检未通过，停止交付：${hint}`)
          return { result, engine, code, codeHash, attempts: attempt + 1, repairs, classified, failed: true, renderQualityFailed: true }
        }
        plan.code[engine] = code
        return { result, engine, code, codeHash, attempts: attempt + 1, repairs }
      }
      classified = classifyError(result)
      this.#cleanupWorkdir(result)
      this.log(task, 'warn', `${plan.plan_id} 第 ${attempt + 1} 次执行失败：${classified.category}/${classified.signature}（${classified.hint}）`)
      this.emit(task, {
        type: 'execution_update',
        execution: { status: 'running', errorCategory: classified.category, normalizedError: classified.signature, logs: [] }
      })
      if (!classified.repairable || attempt === MAX_REPAIRS) break
      const fix = repair(classified, { strategy, input: codegenInput, engine, attempt: attempt + 1 })
      if (!fix) {
        classified = { ...classified, repairable: false }
        break
      }
      // 架构 6.3 重复签名停止：修复未改变引擎也未改变代码即盲目重试，立即停止
      if (fix.engine === engine && fix.code === code) {
        this.log(task, 'error', `${classified.signature} 修复未改变代码/引擎，停止盲目重试（架构 6.3 重复签名停止策略）`)
        classified = { ...classified, repairable: false, signature: `${classified.signature}.noop_fix` }
        break
      }
      repairs.push(classified)
      task.retries += 1
      this.emit(task, { type: 'state_delta', state: 'REPAIR' })
      this.emit(task, { type: 'retry', retries: task.retries })
      this.log(task, 'tool', fix.note)
      engine = fix.engine
      code = fix.code
      inRepair = true
      attempt += 1
    }
    return { result, engine, code, attempts: attempt + 1, repairs, classified, failed: true }
  }

  #workdir(task, planId, attempt) {
    this.#alive(task)
    if (this.storage) return this.storage.runDir(task.taskId, planId, attempt)
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), `local-agent-${task.taskId}-${planId}-`))
    return dir
  }
}

export { ENGINE_KINDS }
