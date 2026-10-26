// 任务仓库：任务聚合、结构化事件日志、订阅广播、快照与文件态持久化。
// applyEvent 与 apps/web/src/state/store.tsx 的 applyEvent 保持同构，
// 保证 GET /api/tasks/:id 返回的快照与前端 AgentTask 类型兼容。
import { randomUUID } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { ingestFile } from './csv.js'

const TTL_MS = 24 * 60 * 60 * 1000 // 网页临时性：默认 24h 清理（WEB-005）

export function newTaskId() {
  return `task_${Date.now().toString(36)}_${randomUUID().replace(/-/g, '').slice(0, 10)}`
}

export function createTaskRecord({ taskId, title, engine, prompt, fileName, bytes, tenantId = 'local', projectId = 'proj_default', dataNature = 'unknown', dataDisclosure = '' }) {
  const allowedDataNature = new Set(['unknown', 'synthetic_demo', 'real_research'])
  const normalizedDataNature = allowedDataNature.has(String(dataNature)) ? String(dataNature) : 'unknown'
  return {
    taskId,
    tenantId,
    projectId, // 所属项目 ID（阶段 1：任务必须归属于且仅归属于一个 Project）
    state: 'INGEST',
    title,
    dataNature: normalizedDataNature,
    dataDisclosure: String(dataDisclosure ?? '').trim(),
    createdAt: Date.now(),
    dataset: undefined,
    steps: [],
    evidence: [],
    acceptedClaimIds: [],
    plans: [],
    plansVersion: 0,
    // 方案版本历史（PlotRevision 谱系）：每次 initial/feedback 的 plans_ready 都留存不可变快照，
    // 仅排序类 preference（reason='preference'）不产生新版本。旧版本永不被覆盖。
    planVersions: [],
    dataVersions: [],
    currentRevision: 0,
    iteration: 0, // 执行轮次：首轮 1，每次 feedback 重执行 +1（对应 ExecutionRecord.version）
    iterating: false, // 是否有 feedback 重规划正在运行（并发守卫）
    deleted: false, // 删除标记：置位后编排器在阶段边界静默停止，且不再落盘/广播
    cancelledAt: undefined,
    abortController: new AbortController(),
    selectedPlanId: undefined,
    execution: { version: 0, engine, status: 'idle', logs: [] },
    preferences: [],
    pendingQuestion: undefined,
    retries: 0,
    // 服务端内部字段
    prompt,
    fileName,
    bytes,
    events: [],
    subscribers: new Set(),
    answerResolver: null,
    error: undefined,
    ttlTimer: undefined,
    restored: false,
    artifacts: {}, // planId -> { dir, attempts, svgFile, pngFile?, verified, checks, hash }
    verification: undefined,
    selectionAudit: undefined, // K 候选池 + MMR 选择审计（DESIGN 阶段写入）
    // 多轮需求澄清（绘图前 ≥3 轮轮询）：clarify=true 启用交互轮询；clarifyAnswers 预填跳过对应轮；clarification 为最终澄清结果
    clarify: false,
    clarifyAnswers: undefined,
    clarification: undefined
  }
}

function upsertStep(steps, step) {
  const i = steps.findIndex((s) => s.step_id === step.step_id)
  if (i < 0) return [...steps, step]
  const copy = steps.slice()
  copy[i] = { ...copy[i], ...step }
  return copy
}

// 与前端 store.tsx applyEvent 同构（服务端附加字段为可选扩展）
function applyEvent(task, e) {
  if (e.state) {
    task.state = e.state
    if (e.state !== 'NEED_INPUT') task.pendingQuestion = undefined
  }
  if (e.cancelledAt) task.cancelledAt = e.cancelledAt
  if (e.step) task.steps = upsertStep(task.steps, e.step)
  if (e.evidence) task.evidence = [...task.evidence, e.evidence]
  if (e.log) task.execution = { ...task.execution, logs: [...task.execution.logs, e.log] }
  if (e.plans) {
    task.plansVersion = (task.plansVersion ?? 0) + 1
    if (e.reason !== 'preference') {
      // 新版本记录：深拷贝方案集合（含当时验证状态），保留反馈文本与触发原因，永不覆盖。
      // version 为稠密的 PlotRevision 修订号（偏好排序不产生修订）；
      // plansVersion 仍是事件计数器（每次 plans_ready 都递增，用于前端变更检测）。
      task.planVersions.push({
        version: task.planVersions.length + 1,
        at: e.at ?? Date.now(),
        reason: e.reason ?? 'initial',
        feedback: e.feedback,
        dataFingerprint: e.dataFingerprint ?? task.dataset?.fingerprint,
        selectedPlanId: task.selectedPlanId,
        plans: structuredClone(e.plans)
      })
      task.currentRevision = task.planVersions.at(-1).version
    }
    task.plans = e.plans
  }
  if (e.selectionAudit) task.selectionAudit = structuredClone(e.selectionAudit)
  if (e.execution) {
    task.execution = { ...task.execution, ...e.execution, logs: task.execution.logs }
  }
  if (e.question) task.pendingQuestion = { question: e.question, options: e.options ?? [] }
  if (e.type === 'retry' && e.retries !== undefined) task.retries = e.retries
  if (e.preference) {
    task.preferences = [e.preference, ...task.preferences.filter((p) => p.event_id !== e.preference.event_id)]
    if (e.preference.kind === 'select_plan' && e.preference.planId) task.selectedPlanId = e.preference.planId
  }
  if (e.type === 'error') task.error = { code: e.code ?? 'TASK_FAILED', message: e.message ?? '任务失败' }
  if (e.type === 'need_input') {
    task.pendingQuestion = { question: e.question ?? '', options: e.options ?? [] }
    // 多轮澄清元信息（round/total/key/hint）随 need_input 下发给前端展示
    if (e.round) task.pendingQuestion.round = e.round
    if (e.total) task.pendingQuestion.total = e.total
    if (e.key) task.pendingQuestion.key = e.key
    if (e.hint) task.pendingQuestion.hint = e.hint
    if (Array.isArray(e.recommendedPalettes)) task.pendingQuestion.recommendedPalettes = structuredClone(e.recommendedPalettes)
    if (Array.isArray(e.choiceGroups)) task.pendingQuestion.choiceGroups = structuredClone(e.choiceGroups)
    if (e.defaults && typeof e.defaults === 'object') task.pendingQuestion.defaults = structuredClone(e.defaults)
  }
  if (e.type === 'revision_applied' && e.revision) {
    if (!task.planVersions.some((item) => item.version === e.revision.version)) task.planVersions.push(structuredClone(e.revision))
    task.currentRevision = e.revision.version
    task.plans = structuredClone(e.revision.plans)
    if (e.revision.artifacts) task.artifacts = structuredClone(e.revision.artifacts)
  }
  if (e.type === 'revision_restored' && e.version) {
    const revision = task.planVersions.find((item) => item.version === e.version)
    if (revision) {
      task.currentRevision = revision.version
      task.plans = structuredClone(revision.plans)
      if (revision.artifacts) task.artifacts = structuredClone(revision.artifacts)
    }
  }
  if (e.type === 'dataset_revised' && e.dataset) {
    task.dataset = structuredClone(e.dataset)
    task.fileName = e.dataset.fileName ?? task.fileName
    task.dataVersions = structuredClone(e.dataVersions ?? task.dataVersions ?? [])
    if (e.markOldData) task.planVersions.forEach((revision) => { revision.basedOnOldData = true })
  }
}

export class TaskStore {
  constructor({ ttlMs = TTL_MS, storage = null, projectStore = null } = {}) {
    this.tasks = new Map()
    this.ttlMs = ttlMs
    this.storage = storage
    this.projectStore = projectStore
  }

  create(init) {
    const taskId = newTaskId()
    // 逻辑归属：未显式指定项目的旧任务自动归入默认项目 proj_default
    const projectId = init.projectId || 'proj_default'
    const task = createTaskRecord({ ...init, taskId, projectId })
    this.scheduleTtl(task)
    this.tasks.set(taskId, task)
    if (this.storage) {
      // 物理落盘：仅显式指定了 projectId 的任务写入项目目录 .data/projects/<pid>/tasks/<tid>/；
      // 默认/旧任务保持扁平 .data/tasks/<tid>/ 布局（兼容既有持久化测试与迁移前状态）。
      // taskLocations 索引在 initTask 内部登记，后续 delete/replace/append 据此定位。
      this.storage.initTask(
        taskId,
        { engine: task.execution.engine, prompt: init.prompt ?? '', fileName: init.fileName, title: task.title, createdAt: task.createdAt, tenantId: task.tenantId, projectId, dataNature: task.dataNature, dataDisclosure: task.dataDisclosure },
        init.bytes,
        init.projectId || undefined
      )
    }
    // 登记到项目任务列表（逻辑归属；projectStore 未启用时为内存态兼容，跳过）
    this.projectStore?.addTask(projectId, taskId)
    return task
  }

  scheduleTtl(task) {
    if (this.ttlMs <= 0) return
    task.ttlTimer = setTimeout(() => this.delete(task.taskId), this.ttlMs)
    task.ttlTimer.unref?.()
  }

  get(taskId) {
    return this.tasks.get(taskId)
  }

  delete(taskId) {
    const task = this.tasks.get(taskId)
    if (!task) return false
    task.deleted = true // 先标记：在途编排器在下一阶段边界静默停止，不再重建目录/落盘
    task.abortController.abort(new Error('task deleted'))
    clearTimeout(task.ttlTimer)
    for (const conn of task.subscribers) {
      try {
        conn.close(1000, 'task deleted')
      } catch {
        /* ignore */
      }
    }
    task.subscribers.clear()
    this.tasks.delete(taskId)
    // 原始上传文件（data.csv）、事件日志与全部 runs 产物同步物理删除，删除后立即不可访问。
    // 不传 projectId：由 storage.taskLocations 索引定位真实目录（扁平或项目目录）。
    this.storage?.deleteTask(taskId)
    // 从所属项目任务列表摘除
    this.projectStore?.removeTask(task.projectId, taskId)
    return true
  }

  /** 追加事件：持久化 → 写入日志 → 聚合到快照 → 广播（按序、不重复） */
  emit(task, event) {
    if (task.deleted) return // 已删除任务为孤儿对象：静默丢弃一切后续事件
    // 主动取消是不可逆终态；仅允许紧随 state_delta 的唯一 done 收尾，屏蔽在途异步步骤晚到事件。
    if (task.state === 'CANCELLED') {
      const isCancelDone = event.type === 'done' && event.state === 'CANCELLED'
      const alreadyDone = task.events.some((item) => item.type === 'done' && item.state === 'CANCELLED')
      if (!isCancelDone || alreadyDone) return
    }
    const seq = task.events.length
    const stamped = { seq, at: Date.now(), ...event }
    task.events.push(stamped)
    if (this.storage) {
      try {
        this.storage.appendEvent(task.taskId, stamped)
      } catch (e) {
        // 持久化失败不阻断内存执行，但必须在日志中可见
        process.stderr.write(`[storage] appendEvent failed for ${task.taskId}: ${e.message}\n`)
      }
    }
    applyEvent(task, event)
    for (const conn of task.subscribers) drain(conn, task)
  }

  subscribe(task, conn) {
    task.subscribers.add(conn)
    conn.deliveredSeq = 0
    conn.onClose = () => task.subscribers.delete(conn)
    drain(conn, task)
  }

  /** 从文件态恢复全部任务（重放事件日志），返回恢复数量 */
  restore() {
    if (!this.storage) return 0
    let n = 0
    for (const rec of this.storage.loadAll()) {
      if (this.tasks.has(rec.taskId)) continue
      const projectId = rec.projectId ?? rec.meta?.projectId ?? 'proj_default'
      const task = createTaskRecord({
        taskId: rec.taskId,
        projectId,
        title: rec.meta.title ?? rec.meta.fileName,
        engine: rec.meta.engine ?? 'python',
        prompt: rec.meta.prompt ?? '',
        fileName: rec.meta.fileName ?? 'data.csv',
        bytes: rec.bytes,
        tenantId: rec.meta.tenantId ?? 'local',
        dataNature: rec.meta.dataNature ?? 'unknown',
        dataDisclosure: rec.meta.dataDisclosure ?? ''
      })
      task.createdAt = rec.meta.createdAt ?? Date.now()
      task.restored = true
      // dataset 不经过事件持久化：用原始字节重新确定性解析（同字节同解析配置 → 同指纹）
      try {
        task.dataset = ingestFile(task.fileName, rec.bytes).profile
      } catch {
        /* 原始数据损坏时 dataset 留空，快照仍可从事件日志恢复任务状态 */
      }
      for (const ev of rec.events) applyEvent(task, ev)
      task.events = rec.events
      // 总体验证结果不作为独立事件持久化，从重放后的方案 verification 重建
      // （跨方案差异检查 difference 无法仅从事件日志复原，诚实留空）
      if (task.plans.length && task.plans.every((p) => p.verification)) {
        task.verification = {
          passed: task.plans.every((p) => p.executionStatus === 'verified'),
          difference: undefined,
          restoredFromLog: true,
          perPlan: Object.fromEntries(task.plans.map((p) => [p.plan_id, p.verification])),
          verifiedAt: task.events.findLast?.((e) => e.type === 'plans_ready')?.at
        }
      }
      // 产物索引（预览/导出时按需读盘，不在启动时载入大图）
      for (const [planId, attempts] of Object.entries(rec.artifacts ?? {})) {
        const latestName = attempts[attempts.length - 1]
        const latestDir = path.join(this.storage.taskDir(rec.taskId), 'runs', planId, latestName)
        const info = { attempts: attempts.length, latestAttempt: latestName }
        try {
          for (const f of fs.readdirSync(latestDir)) {
            const fp = path.join(latestDir, f)
            const stat = fs.statSync(fp)
            if (f.endsWith('.svg')) {
              info.svgFile = f
              info.svgBytes = stat.size
            }
            if (f.endsWith('.png')) {
              const buf = fs.readFileSync(fp)
              if (buf.length >= 24 && buf.toString('ascii', 12, 16) === 'IHDR') {
                info.png = { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
              }
            }
          }
          info.verified = task.plans.find((p) => p.plan_id === planId)?.executionStatus === 'verified'
        } catch {
          /* 产物缺失时仅保留尝试次数索引 */
        }
        task.artifacts[planId] = info
      }
      // 超过 TTL 的任务直接清理；未到期则按剩余时间计时
      const age = Date.now() - task.createdAt
      if (this.ttlMs > 0 && age > this.ttlMs) {
        // 清理失败（文件被占用/权限受限）不得阻断启动：跳过该任务并继续恢复其余任务，
        // 否则一个残留目录会让整个服务起不来。
        try {
          this.storage.deleteTask(rec.taskId)
          this.projectStore?.removeTask(projectId, rec.taskId)
        } catch {
          /* 留待下次启动或手动清理 */
        }
        continue
      }
      if (this.ttlMs > 0) {
        task.ttlTimer = setTimeout(() => this.delete(rec.taskId), Math.max(60_000, this.ttlMs - age))
        task.ttlTimer.unref?.()
      }
      this.tasks.set(rec.taskId, task)
      n++
    }
    return n
  }

  /** 记录某方案的最终执行产物（元数据；SVG/PNG 留在磁盘，预览时读取） */
  attachArtifact(task, planId, info) {
    task.artifacts[planId] = { ...task.artifacts[planId], ...info }
  }

  /** 返回与前端 AgentTask 兼容的任务快照（产物仅给元数据，避免大图内联） */
  snapshot(task) {
    const planArtifacts = {}
    for (const [planId, a] of Object.entries(task.artifacts)) {
      planArtifacts[planId] = {
        attempts: a.attempts ?? 1,
        verified: a.verified ?? false,
        artifactHash: a.hash,
        png: a.png ?? undefined,
        svgBytes: a.svgBytes
      }
    }
    return {
      taskId: task.taskId,
      eventSeq: task.events.length,
      projectId: task.projectId,
      state: task.state,
      title: task.title,
      dataNature: task.dataNature,
      dataDisclosure: task.dataDisclosure,
      createdAt: task.createdAt,
      dataset: task.dataset,
      dataOverview: task.dataOverview,
      steps: task.steps,
      evidence: task.evidence,
      acceptedClaimIds: task.acceptedClaimIds,
      plans: task.plans,
      selectedPlanId: task.selectedPlanId,
      execution: task.execution,
      preferences: task.preferences,
      pendingQuestion: task.pendingQuestion,
      clarification: task.clarification,
      retries: task.retries,
      plansVersion: task.plansVersion,
      planVersions: task.planVersions,
      dataVersions: task.dataVersions,
      currentRevision: task.currentRevision,
      selectionAudit: task.selectionAudit,
      planArtifacts,
      verification: task.verification,
      restored: task.restored || undefined,
      cancelledAt: task.cancelledAt,
      ...(task.error ? { error: task.error } : {})
    }
  }
}

// 按 seq 顺序补发未投递事件（新连接先补发历史，再接收实时事件）
function drain(conn, task) {
  while (conn.deliveredSeq < task.events.length) {
    const ev = task.events[conn.deliveredSeq]
    conn.deliveredSeq++
    const { seq, at, ...payload } = ev
    conn.send(JSON.stringify({ ...payload, seq }))
  }
}

// 供测试/脚本复用：把一批事件重放到一个任务记录上
export function replayEvents(task, events) {
  for (const ev of events) applyEvent(task, ev)
  return task
}

export function readFileIfExists(fp) {
  try {
    return fs.readFileSync(fp)
  } catch {
    return null
  }
}
