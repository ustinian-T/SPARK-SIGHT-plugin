// Agent 客户端：封装任务协议（HTTP + WebSocket/SSE 形状）。
// 当前 MockAgentClient 在浏览器内按 12 态状态机推进，驱动可观察闭环；
// 后端 services/local-agent 就绪后，替换为 RealAgentClient（见文件末尾端点约定），UI 与状态层不变。
import type {
  AgentState,
  AgentTask,
  ChatMessage,
  DatasetProfile,
  DataRevisionPreview,
  EngineKind,
  EvidenceRecord,
  ExecutionRecord,
  LogLine,
  PlanStep,
  PlanVersion,
  PatchPreview,
  PlotPlan,
  PreferenceEvent,
  PreferenceKind,
  PreferenceScope,
  PreviewArtifact,
  SourcePreview,
  SpecPatch,
  TaskEvent
} from '../types'
import { buildProfile, readBytesWithEncoding } from '../lib/csv'
import { summarizeCsv, type SummarizeResult } from '../lib/summarize'
import { buildPlans } from '../mock/plans'
import { delay, uid } from '../lib/format'

export interface StartParams {
  fileName: string
  bytes: Uint8Array
  prompt: string
  // v0.4.0：绘图前多轮需求澄清（Mock 模拟与后端一致的三轮 shape：goal→chartType→presentation）。
  clarify?: boolean
  clarifyAnswers?: Record<string, unknown>
}

// Mock 三轮澄清的固定 shape（与后端 src/clarify.js 的 CLARIFY_ROUNDS 同构，便于 UI 联调）
const CLARIFY_ROUNDS: { key: string; question: string; options: string[]; hint: string }[] = [
  { key: 'goal', question: '希望图表重点突出哪类信息？', options: ['各组之间的直接对比', '随观测顺序的趋势与不确定性', '相关性（热力图）', '分布形态'], hint: '用于确定绘图任务' },
  { key: 'chartType', question: '倾向于哪种图表类型？', options: ['自动推荐', '热力图', '双Y轴图', '三维曲面图', '三维散点图', '常规图'], hint: '无特别偏好可选“自动推荐”' },
  { key: 'presentation', question: '图表标题、图注与排版有要求吗？', options: [], hint: '可填写键值对，如：标题=…；图注=…；标题字色=#6E8FB2；无要求将按科研制图默认执行（白底/SimHei/≥10pt/300dpi）' }
]

const now = () => Date.now()

function hashShort(s: string): string {
  let h = 5381
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) >>> 0
  return h.toString(16).padStart(8, '0')
}

// Mock 预览令牌：在内存中暂存待应用的补丁/源码/数据修订，apply 时校验并消费
type MockPendingToken =
  | { kind: 'patch'; planId: string; parentVersion: number; spec: import('../types').ChartSpec; patch: SpecPatch }
  | { kind: 'src'; planId: string; engine: EngineKind; parentVersion: number; baseHash: string; source: string }
  | { kind: 'data'; dataKind: 'type_override' | 'replace' }

export class MockAgentClient {
  private emit!: (e: TaskEvent) => void
  private aborted = false
  private answerResolve: ((text: string) => void) | null = null
  private taskId = ''
  private retries = 0
  private logs: LogLine[] = []
  private version = 1
  // ---- 深度编辑所需的本地确定性状态（仅内存，不触网）----
  private plans: PlotPlan[] = []
  private dataProfile: DatasetProfile | undefined
  private tokens = new Map<string, MockPendingToken>()
  private codeByPlanEngine = new Map<string, Map<EngineKind, string>>()
  // v0.4.0：Mock 三轮澄清的作答记录（供 getSnapshot 的 clarification 字段回显）
  private clarifyAnswers: Record<string, string> = {}

  cancel(): void {
    this.aborted = true
  }

  private log(level: LogLine['level'], text: string, location?: string): void {
    const line: LogLine = { t: now(), level, text, location }
    this.logs.push(line)
    this.emit({ type: 'log', log: line })
  }

  private pref(kind: PreferenceKind, weight: number, summary: string, scope: PreferenceScope = 'project'): void {
    const ev: PreferenceEvent = {
      event_id: uid('pref'),
      kind,
      weight,
      scope,
      summary,
      confidence: 0.8,
      t: now()
    }
    this.emit({ type: 'preference', preference: ev })
  }

  // 逐步推进一个 PlanStep
  private async step(
    s: PlanStep,
    run?: (s: PlanStep) => Promise<void> | void,
    ms = 260
  ): Promise<void> {
    if (this.aborted) return
    const started = now()
    s.status = 'running'
    this.emit({ type: 'step_update', step: { ...s } })
    await delay(ms + Math.random() * 220)
    if (this.aborted) return
    await run?.(s)
    s.durationMs = now() - started
    if ((s.status as PlanStep['status']) !== 'failed') s.status = 'done'
    this.emit({ type: 'step_update', step: { ...s } })
  }

  async start(params: StartParams, onEvent: (e: TaskEvent) => void): Promise<void> {
    this.emit = onEvent
    this.taskId = uid('task')
    const setState = (state: AgentState) => this.emit({ type: 'state_delta', state })
    const steps: PlanStep[] = []
    const push = (s: PlanStep) => {
      steps.push(s)
      return s
    }

    // ---- INGEST ----
    setState('INGEST')
    const load = push({ step_id: 'csv_load', tool: 'csv.load', title: '读取数据文件', status: 'pending', dependsOn: [], inputSummary: params.fileName })
    await this.step(load, (s) => {
      s.outputSummary = `${(params.bytes.length / 1024).toFixed(1)} KB 已读入受控工作目录`
    }, 200)

    const enc = push({ step_id: 'csv_encoding', tool: 'csv.detect_encoding', title: '编码与分隔符探测', status: 'pending', dependsOn: ['csv_load'] })
    let profile
    try {
      profile = await buildProfile(params.fileName, params.bytes)
      enc.outputSummary = `编码 ${profile.encoding}；分隔符 "${profile.delimiter}"；表头 ${profile.hasHeader ? '有' : '无'}`
      enc.status = 'done'
      enc.durationMs = 300
      this.emit({ type: 'step_update', step: { ...enc } })
    } catch (e) {
      enc.status = 'failed'
      enc.outputSummary = String(e)
      this.emit({ type: 'step_update', step: { ...enc } })
      setState('FAILED')
      this.emit({ type: 'error', message: '数据解析失败，请检查文件编码与格式' })
      return
    }

    const prof = push({ step_id: 'data_profile', tool: 'data.profile', title: '数据体检与内容指纹', status: 'pending', dependsOn: ['csv_encoding'] })
    await this.step(prof, (s) => {
      s.outputSummary = `${profile.rows} 行 × ${profile.cols} 列；指纹 ${profile.fingerprint.slice(0, 12)}…`
    }, 320)
    this.emit({ type: 'step_update', step: { step_id: 'data_profile', tool: 'data.profile', title: '数据体检', status: 'done', dependsOn: [], outputSummary: 'done' } })

    // ---- UNDERSTAND ----
    setState('UNDERSTAND')
    const intent = push({ step_id: 'intent_parse', tool: 'intent.parse', title: '意图解析为 TaskSpec', status: 'pending', dependsOn: ['data_profile'] })
    let question = params.prompt.trim()
    // v0.4.0：绘图前多轮需求澄清——clarify=true 时固定三轮（任务目标→图型偏好→排版呈现），
    // 与后端 CLARIFY_ROUNDS 同构；clarifyAnswers.answeredRounds 预填可跳过已答轮次。
    const prefill = (params.clarifyAnswers ?? {}) as Record<string, unknown>
    const answeredRounds = Array.isArray(prefill.answeredRounds) ? (prefill.answeredRounds as number[]) : []
    if (params.clarify) {
      setState('NEED_INPUT')
      intent.status = 'running'
      this.emit({ type: 'step_update', step: { ...intent } })
      for (let i = 0; i < CLARIFY_ROUNDS.length; i += 1) {
        const r = CLARIFY_ROUNDS[i]
        if (answeredRounds.includes(i + 1)) {
          this.clarifyAnswers[r.key] = String(prefill[r.key] ?? '')
          continue
        }
        const answer = await new Promise<string>((resolve) => {
          this.answerResolve = resolve
          this.emit({
            type: 'need_input',
            question: r.question,
            options: r.options,
            hint: r.hint,
            round: i + 1,
            total: CLARIFY_ROUNDS.length,
            key: r.key
          })
        })
        this.clarifyAnswers[r.key] = answer
      }
      question = this.clarifyAnswers.goal || question
      intent.outputSummary = `TaskSpec：${question.slice(0, 40)}；已按三轮澄清确定需求（目标→图型→排版）`
      intent.status = 'done'
      intent.durationMs = now()
      this.emit({ type: 'step_update', step: { ...intent } })
    } else if (question.length < 6) {
      setState('NEED_INPUT')
      intent.status = 'running'
      this.emit({ type: 'step_update', step: { ...intent } })
      const answer = await new Promise<string>((resolve) => {
        this.answerResolve = resolve
        this.emit({
          type: 'need_input',
          question: '希望图表突出哪类信息？（最少追问，仅在关键歧义时提出）',
          options: ['各组之间的直接对比', '随观测顺序的趋势与不确定性', '在有限版面承载更多信息']
        })
      })
      question = answer
      intent.outputSummary = `TaskSpec：${answer}；引擎默认 Python`
      intent.status = 'done'
      intent.durationMs = now()
      this.emit({ type: 'step_update', step: { ...intent } })
    } else {
      await this.step(intent, (s) => {
        s.outputSummary = `TaskSpec：${question.slice(0, 40)}；引擎默认 Python`
      }, 260)
    }

    // ---- PLAN：先给出完整可观察计划（pending）----
    setState('PLAN')
    const dag: PlanStep[] = [
      { step_id: 'stats_summarize', tool: 'stats.summarize', title: '确定性统计分析（仅执行一次）', status: 'pending', dependsOn: ['intent_parse'], inputSummary: '分组/趋势/描述统计' },
      { step_id: 'claim_bind', tool: 'claim.bind_evidence', title: '结论与证据绑定', status: 'pending', dependsOn: ['stats_summarize'] },
      { step_id: 'plan_candidates', tool: 'plan.generate_candidates', title: `生成 K=6~9 个候选 ChartSpec`, status: 'pending', dependsOn: ['claim_bind'] },
      { step_id: 'plan_mmr', tool: 'plan.score_mmr', title: '效用评分与 MMR 去重', status: 'pending', dependsOn: ['plan_candidates'] },
      { step_id: 'code_execute', tool: 'code.execute', title: '三引擎代码生成与沙箱执行', status: 'pending', dependsOn: ['plan_mmr'], inputSummary: 'Python 完整基线' },
      { step_id: 'render_output', tool: 'render.output', title: '渲染 SVG/PNG 预览', status: 'pending', dependsOn: ['code_execute'] },
      { step_id: 'verify_validate', tool: 'verify.validate', title: '独立验证（规格/证据/差异）', status: 'pending', dependsOn: ['render_output'] }
    ]
    dag.forEach((s) => push(s))
    const planBuild: PlanStep = { step_id: 'plan_build', tool: 'plan.build', title: '构建 PlanGraph 执行计划', status: 'done', dependsOn: ['intent_parse'], outputSummary: `${dag.length} 个工具节点，含依赖与停止条件`, durationMs: 240 }
    push(planBuild)
    this.emit({ type: 'step_update', step: planBuild })
    dag.forEach((s) => this.emit({ type: 'step_update', step: { ...s } }))
    await delay(300)

    // ---- ANALYZE（真实确定性聚合）----
    setState('ANALYZE')
    const { text } = readBytesWithEncoding(params.bytes)
    const result: SummarizeResult = summarizeCsv(text, profile.delimiter === '\\t' ? '\t' : profile.delimiter, profile)
    await this.step(steps.find((s) => s.step_id === 'stats_summarize')!, (s) => {
      s.outputSummary = `${result.series.length} 个测量系列 × ${result.x.length} 个观测点；统计只执行一次`
      s.evidenceIds = []
    }, 420)

    const evidence: EvidenceRecord[] = [
      { evidence_id: 'ev_n', tool: 'stats.describe', metric: '样本量 / 字段数', fields: ['*'], scope: `文件 ${params.fileName}`, value: `${profile.rows} 行 × ${profile.cols} 列` },
      ...result.series.slice(0, 3).map((s, i) => {
        const observed = s.y.map((value, index) => ({ value, index })).filter((item): item is { value: number; index: number } => item.value !== null)
        const first = observed[0]
        const last = observed[observed.length - 1]
        const hasEnds = !!first && !!last
        const absChange = hasEnds ? Math.round((last.value - first.value) * 10) / 10 : null
        // 基线为 0 时百分比未定义，报告绝对变化，不伪造 0%。
        const pctChange = hasEnds && first.value !== 0 ? Math.round(((last.value - first.value) / first.value) * 1000) / 10 : null
        const trendValue = !hasEnds
          ? '缺少首/末观测，无法计算变化'
          : first.value === 0
            ? `${first.value.toFixed(1)} → ${last.value.toFixed(1)}（绝对变化 ${absChange! >= 0 ? '+' : ''}${absChange}；基线为 0，百分比变化未定义）`
            : `${first.value.toFixed(1)} → ${last.value.toFixed(1)}（${pctChange! >= 0 ? '+' : ''}${pctChange}%）`
        return {
          evidence_id: `ev_trend_${i}`,
          tool: 'stats.trend',
          metric: '首末值与变化率',
          fields: [s.label],
          scope: `${result.xLabel}=${result.x[first?.index ?? 0]}→${result.x[last?.index ?? result.x.length - 1]}`,
          value: trendValue
        }
      }),
      ...(result.series.length > 0 ? [{
        evidence_id: 'ev_peak',
        tool: 'stats.extremum',
        metric: '同一末观测点最高系列',
        fields: result.series.map((s) => s.label),
        ...(() => {
          const lastIndexOf = (y: (number | null)[]) => {
            for (let i = y.length - 1; i >= 0; i--) if (y[i] !== null) return i
            return -1
          }
          const commonIndex = result.series.reduce((acc, s) => Math.min(acc, lastIndexOf(s.y)), Number.POSITIVE_INFINITY)
          const atCommon = result.series.map((s) => ({ s, v: commonIndex >= 0 ? s.y[commonIndex] : Number.NEGATIVE_INFINITY }))
          const peak = [...atCommon].sort((a, b) => (b.v ?? -Infinity) - (a.v ?? -Infinity))[0]
          return {
            scope: `末观测点 ${result.x[commonIndex >= 0 ? commonIndex : result.x.length - 1]}`,
            value: peak.s.label,
            note: commonIndex < result.x.length - 1
              ? `部分系列在该点之后缺失，末点比较截至 ${result.xLabel}=${result.x[commonIndex]}`
              : undefined
          }
        })()
      }] : [])
    ]
    evidence.forEach((e) => this.emit({ type: 'evidence', evidence: e }))
    this.log('tool', `证据账本写入 ${evidence.length} 条，统计结果供三方案共享，不重复计算`)
    await this.step(steps.find((s) => s.step_id === 'claim_bind')!, (s) => {
      s.outputSummary = '所有自然语言结论必须引用 evidence_id'
    }, 220)

    // ---- DESIGN ----
    setState('DESIGN')
    const titleBase = question.length > 24 ? question.slice(0, 22) + '…' : question
    const summary = `${profile.rows} 行 × ${profile.cols} 列；缺失率按列核验；统计仅执行一次并被三方案共享`
    let plans: PlotPlan[] = []
    await this.step(steps.find((s) => s.step_id === 'plan_candidates')!, (s) => {
      plans = buildPlans(result, params.fileName, titleBase || params.fileName.replace('.csv', ''), summary)
      s.outputSummary = `生成 7 个候选，覆盖清晰/惯例/密度三策略`
    }, 480)
    await this.step(steps.find((s) => s.step_id === 'plan_mmr')!, (s) => {
      s.outputSummary = `MMR λ 去重后保留 3 套，差异维度均 ≥ 2`
    }, 360)
    // 保留当前方案与数据体检，供后续 previewPatch/applyPatch 等深度编辑在内存中确定性操作
    this.plans = plans
    this.dataProfile = profile
    this.emit({ type: 'plans_ready', plans })

    // ---- EXECUTE（含一次依赖错误 → 自纠错）----
    setState('EXECUTE')
    const execStep = steps.find((s) => s.step_id === 'code_execute')!
    execStep.status = 'running'
    execStep.attempts = 1
    this.emit({ type: 'step_update', step: { ...execStep } })
    this.emit({ type: 'execution_update', execution: { status: 'running', version: this.version, engine: 'python', logs: [...this.logs] } })
    this.log('info', '[python] 沙箱就绪：CPU/内存/时长受限，默认禁网，工作目录已隔离')
    this.log('tool', '渲染 plan_clarity.png …')
    await delay(500)
    this.log('info', 'plan_clarity.png 渲染成功（分组柱状）')
    this.log('tool', '渲染 plan_convention.pdf …')
    await delay(500)
    // 注入一次可恢复的依赖错误，演示归一化与自纠错（不走安全拒绝路径）
    this.log('error', "ModuleNotFoundError: No module named 'seaborn'", 'plan_convention.py:3')
    execStep.status = 'failed'
    execStep.attempts = 1
    execStep.errorSignature = 'DEPENDENCY'
    execStep.outputSummary = '依赖错误：可选库缺失'
    this.emit({ type: 'step_update', step: { ...execStep } })
    setState('REPAIR')
    this.retries = 1
    this.emit({ type: 'retry', retries: this.retries })
    this.log('warn', 'normalize_error → 依赖错误（DEPENDENCY）；策略：移除可选依赖，回退 Matplotlib 内置误差棒')
    await delay(700)
    this.log('info', 'plan_convention 重试 1/3 成功（已回退内置实现，结果可复现）')
    this.log('tool', '渲染 plan_density.png …')
    await delay(480)
    this.log('info', 'plan_density.png 渲染成功（1×2 复合子图）')
    execStep.status = 'done'
    execStep.attempts = 1
    execStep.durationMs = 2200
    execStep.outputSummary = '3 套方案执行完成，1 次依赖错误已自愈'
    this.emit({ type: 'step_update', step: { ...execStep } })

    await this.step(steps.find((s) => s.step_id === 'render_output')!, (s) => {
      s.outputSummary = 'SVG 矢量 + 300dpi PNG；旧预览保留至新渲染成功'
    }, 300)

    // ---- VERIFY ----
    setState('VERIFY')
    await this.step(steps.find((s) => s.step_id === 'verify_validate')!, (s) => {
      s.outputSummary = '差异维度≥2、证据绑定完整、未发现因果越界措辞'
    }, 420)
    this.log('info', 'ClaimVerifier：相关≠因果校验通过；高风险结论已要求带条件表述')

    const execution: ExecutionRecord = {
      version: this.version,
      engine: 'python',
      status: 'success',
      logs: [...this.logs],
      errorCategory: 'DEPENDENCY（已自愈）',
      codeHash: hashShort(plans.map((p) => p.code.python).join('\n')),
      startedAt: 0,
      finishedAt: now()
    }
    this.emit({ type: 'execution_update', execution })

    // ---- PRESENT ----
    setState('PRESENT')
    this.emit({ type: 'done', message: '三套差异化方案已就绪，请并排比较并选择，或继续提出修改' })
  }

  answerQuestion(text: string): void {
    this.answerResolve?.(text)
    this.answerResolve = null
  }

  selectPlan(plan: PlotPlan): TaskEvent[] {
    this.pref('select_plan', 0.7, `选择「${plan.name}」（${plan.strategy}），引擎 ${plan.engine}`)
    this.log('info', `已选择 ${plan.plan_id}，其他方案保留为可恢复分支`)
    this.emit({ type: 'state_delta', state: 'ITERATE' })
    return []
  }

  async feedback(text: string, plans: PlotPlan[], selectedId?: string): Promise<void> {
    this.emit({ type: 'state_delta', state: 'ITERATE' })
    this.version += 1
    this.emit({ type: 'execution_update', execution: { status: 'running', version: this.version, logs: [...this.logs] } })
    this.log('tool', `限定作用域重渲染：${text}`)
    await delay(700)
    this.log('info', `v${this.version} 渲染完成；非目标面板规格哈希未变（局部隔离）`)
    this.pref('manual_edit', 0.6, `主动修改：${text}`)
    void selectedId
    void plans
    this.emit({
      type: 'execution_update',
      execution: { status: 'success', version: this.version, logs: [...this.logs], codeHash: hashShort('v' + this.version) }
    })
  }

  rejectPlan(plan: PlotPlan): void {
    this.pref('reject', -0.8, `拒绝方案「${plan.name}」`, 'global')
  }

  exportArtifact(kind: string, _planId?: string, _options?: { includeCode?: boolean; includeData?: boolean; includeEvidence?: boolean; includeArtifacts?: boolean; colorMode?: 'color' | 'grayscale'; dpi?: number; formats?: string[] }): void {
    this.pref('export', 0.45, `导出 ${kind}`, 'project')
    this.log('info', `导出 ${kind}：附依赖锁、运行说明与内容指纹，离线可复现`)
    this.emit({ type: 'state_delta', state: 'COMPLETE' })
    this.emit({ type: 'done', message: `已导出 ${kind}` })
  }

  // ===================== 深度编辑（本地确定性实现，不触网）=====================
  // 与 RealAgentClient 公共方法签名对齐；所有方法返回同形状对象，杜绝运行时 undefined。

  resume(taskId: string): void {
    this.taskId = taskId
  }

  /** 删除任务：本地 Mock 无服务端资源需清理，仅标记中止 */
  async deleteTask(): Promise<void> {
    this.aborted = true
  }

  /** 构造一个当前版本的 PlanVersion 快照（plans 不可变，旧版本永不被覆盖） */
  private buildPlanVersion(reason: string, extra: Partial<PlanVersion> = {}): PlanVersion {
    return {
      version: this.version,
      at: now(),
      reason,
      plans: this.plans,
      ...extra
    }
  }

  private emptyProfile(): DatasetProfile {
    return {
      fileName: 'mock.csv', encoding: 'UTF-8', delimiter: ',', hasHeader: true,
      rows: 0, cols: 0, sizeBytes: 0, parserConfig: 'mock', fingerprint: 'mock-fingerprint',
      columns: [], quality: { duplicateRows: { count: 0, rowNumbers: [] }, outliers: [], constantColumns: [], mixedTypeColumns: [], smallGroups: [], highMissingColumns: [] },
      warnings: [], headRows: []
    }
  }

  /** 预览 SpecPatch：在内存中把补丁应用到 spec 副本，返回一次性 token */
  async previewPatch(planId: string, parentVersion: number, patch: SpecPatch): Promise<PatchPreview> {
    const plan = this.plans.find((p) => p.plan_id === planId)
    if (!plan) throw new Error(`Mock：方案不存在 ${planId}`)
    // 深拷贝 spec 作为补丁应用后的预览结果（确定性，不做真实 spec 路径解析）
    const spec = JSON.parse(JSON.stringify(plan.spec)) as import('../types').ChartSpec
    const token = 'mock-patch-' + uid('tok')
    this.tokens.set(token, { kind: 'patch', planId, parentVersion, spec, patch })
    this.log('tool', `预览补丁 v${parentVersion} → v${parentVersion + 1}（${patch.label}）`)
    return {
      token,
      expiresAt: now() + 5 * 60 * 1000,
      parentVersion,
      planId,
      targetKind: patch.targetKind === 'figure' ? 'figure' : 'panel',
      targetId: patch.targetId,
      path: patch.path,
      before: patch.before,
      after: patch.after,
      spec
    }
  }

  /** 应用补丁：校验 token，递增版本，下发 execution_update（success） */
  async applyPatch(token: string): Promise<PlanVersion> {
    const rec = this.tokens.get(token)
    if (!rec || rec.kind !== 'patch') throw new Error('Mock：补丁预览 token 无效或已过期')
    const plan = this.plans.find((p) => p.plan_id === rec.planId)
    if (plan) plan.spec = rec.spec
    this.version += 1
    this.tokens.delete(token)
    this.log('info', `v${this.version} 已应用补丁：${rec.patch.label}`)
    this.emit({ type: 'execution_update', execution: { status: 'success', version: this.version, logs: [...this.logs] } })
    return this.buildPlanVersion('patch', { parent: rec.parentVersion, selectedPlanId: rec.planId })
  }

  /** 撤销到父修订 */
  async revertPatch(): Promise<PlanVersion> {
    this.version = Math.max(1, this.version - 1)
    this.log('info', `已撤销到 v${this.version}`)
    this.emit({ type: 'execution_update', execution: { status: 'success', version: this.version, logs: [...this.logs] } })
    return this.buildPlanVersion('revert')
  }

  /** 恢复到指定历史版本 */
  async restoreVersion(version: number): Promise<PlanVersion> {
    if (!Number.isInteger(version) || version < 1) throw new Error('Mock：version 必须为正整数')
    this.version = version
    this.log('info', `已恢复到历史版本 v${version}`)
    this.emit({ type: 'execution_update', execution: { status: 'success', version, logs: [...this.logs] } })
    return this.buildPlanVersion('restore')
  }

  /** 预览源码：校验非空，返回哈希与行数 */
  async previewSource(input: { planId: string; engine: EngineKind; parentVersion: number; baseHash?: string; source: string }): Promise<SourcePreview> {
    if (!input.source || !input.source.trim()) throw new Error('Mock：源码不能为空')
    const token = 'mock-src-' + uid('tok')
    const sourceHash = hashShort(input.source)
    const changedLines = input.source.split('\n').length
    this.tokens.set(token, { kind: 'src', planId: input.planId, engine: input.engine, parentVersion: input.parentVersion, baseHash: input.baseHash ?? '', source: input.source })
    return {
      token,
      expiresAt: now() + 5 * 60 * 1000,
      parentVersion: input.parentVersion,
      planId: input.planId,
      engine: input.engine,
      baseHash: input.baseHash ?? '',
      sourceHash,
      mode: 'spec',
      sourceMap: [],
      changedLines
    }
  }

  /** 应用源码：递增版本并保存代码，下发 execution_update */
  async applySource(token: string): Promise<PlanVersion> {
    const rec = this.tokens.get(token)
    if (!rec || rec.kind !== 'src') throw new Error('Mock：源码预览 token 无效或已过期')
    this.version += 1
    const map = this.codeByPlanEngine.get(rec.planId) ?? new Map<EngineKind, string>()
    map.set(rec.engine, rec.source)
    this.codeByPlanEngine.set(rec.planId, map)
    const plan = this.plans.find((p) => p.plan_id === rec.planId)
    if (plan) {
      plan.code = { ...plan.code, [rec.engine]: rec.source }
      plan.executionStatus = 'code_edited_unverified'
    }
    this.tokens.delete(token)
    this.log('info', `v${this.version} 已应用 ${rec.engine} 源码修订`)
    this.emit({ type: 'execution_update', execution: { status: 'success', version: this.version, logs: [...this.logs] } })
    return this.buildPlanVersion('source', {
      parent: rec.parentVersion,
      mode: 'spec',
      source: { planId: rec.planId, engine: rec.engine, baseHash: rec.baseHash, sourceHash: hashShort(rec.source), sourceMap: [] }
    })
  }

  /** 预览数据修订：type_override 与 replace 均返回确定性 profile 预览 */
  async previewData(input: { kind: 'type_override'; field: string; type: string } | { kind: 'replace'; fileName: string; contentBase64: string }): Promise<DataRevisionPreview> {
    const token = 'mock-data-' + uid('tok')
    this.tokens.set(token, { kind: 'data', dataKind: input.kind })
    const profile = this.dataProfile ?? this.emptyProfile()
    // replace 会整体替换数据，需用户确认；type_override 仅改单字段类型，低风险
    const requiresConfirmation = input.kind === 'replace'
    const risks = input.kind === 'replace'
      ? [{ code: 'DATA_REPLACE', message: `替换为 ${input.fileName} 后将重算统计、证据与全部方案` }]
      : [{ code: 'TYPE_OVERRIDE', field: input.field, message: `将字段 ${input.field} 视为 ${input.type}，影响相关统计口径` }]
    return {
      token,
      expiresAt: now() + 5 * 60 * 1000,
      kind: input.kind,
      previousFingerprint: profile.fingerprint,
      nextFingerprint: hashShort(JSON.stringify(input)),
      profile,
      risks,
      requiresConfirmation
    }
  }

  /** 应用数据修订：消费 token 并递增版本（不实际重算，仅确定性标记） */
  async applyData(token: string, confirmed: boolean): Promise<void> {
    const rec = this.tokens.get(token)
    if (!rec || rec.kind !== 'data') throw new Error('Mock：数据修订预览 token 无效')
    if (rec.dataKind === 'replace' && !confirmed) throw new Error('Mock：替换数据需要用户确认')
    this.version += 1
    this.tokens.delete(token)
    this.log('info', `v${this.version} 已应用数据修订（${rec.dataKind}）`)
  }

  /** 应用科研样式预设：递增版本，下发 preference 事件 */
  async applyStylePreset(planId: string, presetId: string, parentVersion: number): Promise<PlanVersion> {
    this.version += 1
    this.pref('manual_edit', 0.6, `应用样式预设 ${presetId} 到方案 ${planId}`)
    this.log('info', `v${this.version} 已应用样式预设 ${presetId}`)
    this.emit({ type: 'execution_update', execution: { status: 'success', version: this.version, logs: [...this.logs] } })
    return this.buildPlanVersion('style_preset', { parent: parentVersion, selectedPlanId: planId })
  }

  /** 保存代码草稿到内存，返回最新任务快照 */
  async saveCode(planId: string, engine: EngineKind, code: string): Promise<AgentTask> {
    const map = this.codeByPlanEngine.get(planId) ?? new Map<EngineKind, string>()
    map.set(engine, code)
    this.codeByPlanEngine.set(planId, map)
    const plan = this.plans.find((p) => p.plan_id === planId)
    if (plan) {
      plan.code = { ...plan.code, [engine]: code }
      plan.executionStatus = 'code_edited_unverified'
    }
    this.log('info', `已保存 ${engine.toUpperCase()} 代码草稿（待重新运行验证）`)
    return this.getSnapshot()
  }

  /** 返回内存中的任务快照 */
  async getSnapshot(): Promise<AgentTask> {
    const clarification = Object.keys(this.clarifyAnswers).length > 0
      ? {
          goal: this.clarifyAnswers.goal ?? '',
          chartType: this.clarifyAnswers.chartType ?? '自动',
          source: 'clarified' as const,
          complete: true,
          answers: { ...this.clarifyAnswers }
        }
      : undefined
    return {
      taskId: this.taskId,
      state: 'PRESENT',
      title: 'Mock 任务',
      createdAt: now(),
      dataset: this.dataProfile,
      steps: [],
      evidence: [],
      plans: this.plans,
      execution: { version: this.version, engine: 'python', status: 'success', logs: [...this.logs], finishedAt: now() },
      preferences: [],
      retries: this.retries,
      planVersions: [this.buildPlanVersion('initial')],
      currentRevision: this.version,
      clarification
    }
  }

  /** 返回一个确定性 Mock SVG 预览 */
  async getPreview(planId?: string, _engine?: EngineKind): Promise<PreviewArtifact> {
    const plan = this.plans.find((p) => p.plan_id === planId) ?? this.plans[0]
    return {
      planId: plan?.plan_id ?? 'mock-plan',
      engine: 'python',
      svg: '<svg xmlns="http://www.w3.org/2000/svg" width="480" height="360"><rect width="100%" height="100%" fill="#ffffff"/><rect x="40" y="40" width="400" height="280" fill="none" stroke="#cccccc"/><text x="240" y="190" text-anchor="middle" fill="#333333" font-family="serif" font-size="16">Mock 预览</text></svg>'
    }
  }
}

/*
对接真实后端时的协议约定（services/local-agent，协议 v1 / 服务 v0.3.0，RealAgentClient 已实现）：
  POST /api/tasks                 创建任务（multipart：CSV + prompt + engine），返回 {taskId, state}
  GET  /api/tasks/:id             任务快照（AgentTask，含 planVersions PlotRevision 谱系）
  WS   /api/tasks/:id/events      订阅 TaskEvent（连接即从 seq=0 重放；state_delta/step_update/
                                  evidence/plans_ready/execution_update/retry/preference/need_input/error/done）
  POST /api/tasks/:id/answer      NEED_INPUT 应答
  POST /api/tasks/:id/select      选择方案（置顶，其余两套保留为可恢复分支，进入 ITERATE）
  POST /api/tasks/:id/feedback    多轮反馈（生成新 PlotRevision，旧版本不可变；202 异步）
  POST /api/tasks/:id/replan      /feedback 的等价别名
  POST /api/tasks/:id/complete    确认冻结 → COMPLETE 终态（幂等；导出时服务端自动调用）
  POST /api/tasks/:id/preferences 拒绝方案/六维偏好（select_plan 为 /select 别名）
  GET  /api/tasks/:id/preview     真实渲染产物（SVG 全文 + PNG 元数据）
  GET  /api/tasks/:id/export      导出 ZIP（SVG/PNG/PDF/三引擎源码/数据/ChartSpec/证据；导出即冻结）
  GET  /api/tasks/:id/trace       执行 trace（含 revisions 版本谱系）
  DELETE /api/tasks/:id           删除任务（内存+磁盘立即不可达；幂等，重复删除 200 existed:false）
  （未实现）POST /api/tasks/:id/patches  提交/接受 SpecPatch，返回最小代码 Diff —— 当前由 Mock 运行时承载
端点经 URL 参数 ?agent=local&url=&token= 或 VITE_LOCAL_AGENT_URL/TOKEN/ENGINE 配置；
本地服务仅绑 127.0.0.1 + 随机端口 + 启动令牌。
*/

export type { ChatMessage }
