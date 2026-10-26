// 真实本地 Agent 客户端：对接 services/local-agent（HTTP + WebSocket）。
// 调用面与 MockAgentClient 保持一致（start/subscribe/answerQuestion/selectPlan/rejectPlan/
// feedback/exportArtifact/cancel），store 可在两种实现间无缝切换。
//
// 协议端点（与 apps/web/src/client/agentClient.ts 末尾约定一致）：
//   POST /api/tasks                 创建任务（multipart：CSV + prompt + engine）——兼容路径
//   POST /api/projects/:pid/tasks   创建任务并归入指定项目（阶段 2 主路径）
//   GET  /api/tasks/:id             任务快照（AgentTask）
//   WS   /api/tasks/:id/events      订阅 TaskEvent（连接即从 seq=0 重放）
//   POST /api/tasks/:id/answer      NEED_INPUT 应答
//   POST /api/tasks/:id/select      选择方案（其他方案保留为可恢复分支）
//   POST /api/tasks/:id/feedback    多轮反馈（产生新 PlotRevision，旧版本保留）
//   GET  /api/tasks/:id/preview     真实渲染产物
//   GET  /api/tasks/:id/export      导出复现 ZIP（导出即 COMPLETE 冻结）
//   DELETE /api/tasks/:id           删除任务（幂等；原始文件立即不可达）——兼容路径
//   DELETE /api/projects/:pid/tasks/:id  删除指定项目下的任务（阶段 2 主路径）
//
// 配置优先级：Native Host Bridge 内存注入 > Vite 环境变量。
// Agent token 禁止通过 URL 查询参数传递，避免进入历史记录、日志或崩溃报告。
import type {
  AgentTask,
  ColorProfile,
  DataRevisionPreview,
  EngineKind,
  ExecutionRecord,
  PlotPlan,
  PreviewArtifact,
  PatchPreview,
  PlanVersion,
  PreferenceSnapshot,
  SpecPatch,
  SourcePreview,
  TaskEvent
} from '../types'
import { getHostBridge } from '../host/bridge'
import { loadSession as getStoredSession } from '../site/session'

export interface LocalAgentConfig {
  baseUrl: string
  token: string
  engine?: EngineKind
  // 阶段 2：所属项目 ID。传入后 start/deleteTask 走 /api/projects/:pid/tasks 项目路径；
  // 不传时回退到旧的 /api/tasks 兼容路径（用于 Mock 演示或测试）。
  projectId?: string
}

export interface StartParams {
  fileName: string
  bytes: Uint8Array
  prompt: string
  // v0.4.0：绘图前多轮需求澄清。clarify=true 时后端按「任务目标→图型偏好→排版呈现」三轮轮询；
  // clarifyAnswers 可预填已答轮次（如 { answeredRounds:[1,2], goal:'…', chartType:'…' }）跳过对应提问。
  clarify?: boolean
  clarifyAnswers?: Record<string, unknown>
}

// 同一页面生命周期内复用匿名身份。每次请求重新申请会得到不同 userId，
// 导致“创建项目”成功后紧接着读取项目/任务却返回无权限。
const anonymousSessions = new Map<string, Promise<string>>()
function anonymousStorageKey(origin: string): string { return `deep-imaging.anonymous.${origin}` }
export function forgetAnonymousToken(baseUrl: string): void {
  const origin = baseUrl.replace(/\/$/, '')
  anonymousSessions.delete(origin)
  try { sessionStorage.removeItem(anonymousStorageKey(origin)) } catch { /* 私密模式可能禁用存储 */ }
}
export async function getAnonymousToken(baseUrl: string): Promise<string> {
  const origin = baseUrl.replace(/\/$/, '')
  let pending = anonymousSessions.get(origin)
  if (!pending) {
    let saved = ''
    try { saved = sessionStorage.getItem(anonymousStorageKey(origin)) ?? '' } catch { /* optional */ }
    pending = saved ? Promise.resolve(saved) : fetch(`${origin}/api/auth/anonymous`, { method: 'POST', cache: 'no-store', signal: AbortSignal.timeout(8000) }).then(async (response) => {
      if (!response.ok) throw new Error(`匿名会话获取失败（HTTP ${response.status}）`)
      const body = await response.json()
      const token = body.identity?.token ?? body.token
      if (typeof token !== 'string' || !token) throw new Error('后端未返回匿名会话令牌')
      try { sessionStorage.setItem(anonymousStorageKey(origin), token) } catch { /* optional */ }
      return token
    })
    anonymousSessions.set(origin, pending)
  }
  try { return await pending } catch (error) { anonymousSessions.delete(origin); throw error }
}

export function readConfigFromLocation(): Partial<LocalAgentConfig> & { enabled: boolean } {
  return {
    enabled: true,
    // 纯网页永远请求部署站点同源的服务器 API；不能把构建时本机地址带到访客浏览器。
    baseUrl: window.location.origin,
    token: '',
    engine: 'python'
  }
}

export async function readRuntimeConfig(): Promise<Partial<LocalAgentConfig> & { enabled: boolean }> {
  // 账户身份与后端位置分开：账号令牌可恢复，目标只能来自宿主 Agent 或网页同源。
  const session = getStoredSession()
  const host = getHostBridge()
  if (host) {
    const config = await host.getAgentConfig()
    return { enabled: !!config.baseUrl, ...config, token: session?.token ?? config.token }
  }
  if (session?.token) {
    return { enabled: true, baseUrl: window.location.origin, token: session.token }
  }
  if (import.meta.env.VITE_TEST_WEB === '1') {
    const response = await fetch('/api/test/config', { cache: 'no-store', signal: AbortSignal.timeout(8000) })
    if (!response.ok) throw new Error('测试服务器连接失败')
    return { enabled: true, baseUrl: window.location.origin, token: (await response.json()).token }
  }
  return readConfigFromLocation()
}

function toWsUrl(httpUrl: string): string {
  const u = new URL(httpUrl)
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:'
  return u.origin
}

export class RealAgentClient {
  resume(taskId: string, lastSeq = -1) { this.taskId = taskId; this.lastSeq = lastSeq }
  private readonly cfg: LocalAgentConfig
  private readonly projectId?: string
  private emit: ((e: TaskEvent) => void) | null = null
  private ws: WebSocket | null = null
  private taskId = ''
  private reconnects = 0
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private closedByUser = false
  private terminal = false
  private lastSeq = -1

  constructor(cfg: LocalAgentConfig) {
    this.cfg = { baseUrl: cfg.baseUrl.replace(/\/$/, ''), token: cfg.token, engine: cfg.engine ?? 'python' }
    this.projectId = cfg.projectId
  }

  get id(): string {
    return this.taskId
  }

  // 当前任务的资源路径：有 projectId 时走项目作用域（阶段 2），否则回退兼容路径。
  private get taskBase(): string {
    return this.projectId
      ? `/api/projects/${encodeURIComponent(this.projectId)}/tasks/${encodeURIComponent(this.taskId)}`
      : `/api/tasks/${encodeURIComponent(this.taskId)}`
  }

  // 创建任务的端点：有 projectId 时归入指定项目，否则走旧的默认项目兼容路径。
  private get createTaskPath(): string {
    return this.projectId ? `/api/projects/${encodeURIComponent(this.projectId)}/tasks` : '/api/tasks'
  }

  // P0-6: 所有 HTTP 请求均通过 Authorization header 携带 token
  private headers(extra: Record<string, string> = {}): Record<string, string> {
    return { authorization: `Bearer ${this.cfg.token}`, 'x-agent-protocol': '1', ...extra }
  }

  async retry(prompt?: string): Promise<{ taskId: string; projectId: string }> {
    return (await this.postJson(`${this.taskBase}/retry`, { prompt })).json
  }

  async cancel(): Promise<void> {
    if (this.taskId) await this.postJson(`${this.taskBase}/cancel`, {})
    this.closedByUser = true
    this.terminal = true
    try {
      this.ws?.close()
    } catch {
      /* ignore */
    }
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
  }

  /** 删除任务：通知后端移除任务记录与原始 data.csv（幂等；重复删除返回 200 existed:false） */
  async deleteTask(): Promise<void> {
    if (!this.taskId) return
    await this.requestJson(this.taskBase, 'DELETE')
    this.closedByUser = true
    this.terminal = true
    try { this.ws?.close() } catch { /* ignore */ }
  }

  /** 仅断开前端事件订阅，不通知后端取消任务（用于切换项目/任务时 detach，避免误取消运行中的任务）。 */
  detach(): void {
    this.closedByUser = true
    try { this.ws?.close() } catch { /* ignore */ }
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
  }

  /** 第一步：创建任务（multipart 上传），返回服务端 taskId；此时尚未订阅事件 */
  async start(params: StartParams): Promise<{ taskId: string }> {
    const form = new FormData()
    form.append('prompt', params.prompt)
    form.append('engine', this.cfg.engine ?? 'python')
    if (params.clarify) form.append('clarify', 'true')
    if (params.clarifyAnswers) form.append('clarifyAnswers', JSON.stringify(params.clarifyAnswers))
    form.append('file', new File([params.bytes as BlobPart], params.fileName, { type: 'text/csv' }), params.fileName)

    const res = await fetch(`${this.cfg.baseUrl}${this.createTaskPath}`, {
      method: 'POST',
      headers: this.headers({}), // multipart 时浏览器自动设置 content-type（含 boundary）
      body: form
    })
    if (!res.ok) {
      const err = await res.json().catch(() => ({ error: { code: 'BAD_REQUEST', message: res.statusText } }))
      const code = err.error?.code ?? 'BAD_REQUEST'
      const message = err.error?.message ?? '创建任务失败'
      // 订阅尚未建立：通过错误回调通知 UI（subscribe 后则统一走事件流）
      queueMicrotask(() => this.emit?.({ type: 'error', code, message }))
      throw new Error(message)
    }
    const body = await res.json()
    this.taskId = body.taskId
    return { taskId: this.taskId }
  }

  /** 第二步：订阅事件流。服务端连接建立即从 seq=0 重放全部历史，天然支持晚连接与断线恢复 */
  subscribe(onEvent: (e: TaskEvent) => void): void {
    this.emit = onEvent
    this.closedByUser = false
    this.connectEvents()
  }

  /** 查看任务快照（GET /api/tasks/:id） */
  async getSnapshot(): Promise<AgentTask> {
    const r = await fetch(`${this.cfg.baseUrl}${this.taskBase}`, { headers: this.headers(), signal: AbortSignal.timeout(8000) })
    if (!r.ok) {
      const err = await r.json().catch(() => ({ error: { code: 'NOT_FOUND', message: `HTTP ${r.status}` } }))
      throw new Error(err.error?.message ?? `HTTP ${r.status}`)
    }
    const body = await r.json()
    const task = body.task ?? body
    if (!task?.taskId || !task.execution || !Array.isArray(task.plans)) {
      throw new Error('任务快照格式无效，请重新打开任务')
    }
    return task
  }

  private connectEvents(): void {
    // P0-6: WebSocket 不支持自定义 header；移除 URL 中的 token 避免日志泄露
    const url = `${toWsUrl(this.cfg.baseUrl)}/api/tasks/${encodeURIComponent(this.taskId)}/events`
    const ws = new WebSocket(url)
    this.ws = ws
    // 连接建立后立即发送认证消息
    ws.onopen = () => {
      this.reconnects = 0
      ws.send(JSON.stringify({ type: 'auth', token: this.cfg.token }))
    }
    ws.onmessage = (ev) => {
      const data = JSON.parse(ev.data as string) as TaskEvent
      if (typeof data.seq === 'number') {
        if (data.seq <= this.lastSeq) return
        this.lastSeq = data.seq
      }
      if (data.type === 'done' || data.type === 'error') {
        // export 冻结（COMPLETE+done）与失败均关闭重连；feedback 迭代不发 done
        if (data.type === 'error' || data.state === 'COMPLETE' || data.state === 'CANCELLED' || data.message?.includes('版本已冻结')) this.terminal = true
      }
      this.emit?.(data)
    }
    ws.onclose = async () => {
      // 非用户主动关闭且任务未结束：有限次重连（重连后服务端重放缺失事件）
      if (!this.closedByUser && !this.terminal && this.reconnects < 8) {
        this.reconnects += 1
        const delay = Math.min(15_000, 500 * 2 ** (this.reconnects - 1))
        this.emit?.({ type: 'log', log: { t: Date.now(), level: 'warn', text: `事件流断开，将在 ${Math.round(delay / 1000)} 秒后重连（第 ${this.reconnects}/8 次）` } })
        this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; this.connectEvents() }, delay)
        return
      }
      // 重连耗尽：用快照区分“任务被删除”与“服务不可用”，给 UI 稳定信号
      if (!this.closedByUser && !this.terminal) {
        try {
          await this.getSnapshot()
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e)
          if (/不存在|删除|HTTP 404/.test(msg)) {
            this.emit?.({ type: 'error', code: 'TASK_NOT_FOUND', message: '任务已被删除或清理' })
            this.terminal = true
          } else {
            this.emit?.({ type: 'error', code: 'EVENT_STREAM_UNAVAILABLE', message: '事件流暂时不可用，请检查服务连接后重试' })
          }
        }
      }
    }
    ws.onerror = () => {
      // 错误交由 onclose 统一处理重连
    }
  }

  private postJson(pathName: string, body: unknown): Promise<{ res: Response; json: any }> {
    return fetch(`${this.cfg.baseUrl}${pathName}`, {
      method: 'POST',
      headers: this.headers({ 'content-type': 'application/json' }),
      body: JSON.stringify(body)
    }).then(async (r) => {
      const json = await r.json().catch(() => ({}))
      if (!r.ok) throw Object.assign(new Error(json?.error?.message ?? `HTTP ${r.status}`), { code: json?.error?.code, status: r.status })
      return { res: r, json }
    })
  }

  private async requestJson(pathName: string, method: 'GET' | 'DELETE'): Promise<any> {
    const response = await fetch(`${this.cfg.baseUrl}${pathName}`, { method, headers: this.headers() })
    const json = await response.json().catch(() => ({}))
    if (!response.ok) throw Object.assign(new Error(json?.error?.message ?? `HTTP ${response.status}`), { code: json?.error?.code, status: response.status })
    return json
  }

  private normalizePatch(planId: string, parentVersion: number, patch: SpecPatch) {
    if (patch.targetKind === 'figure') {
      return { ...patch, planId, parentVersion, targetKind: 'figure' as const, path: patch.path.replace(/^figure\./, '') }
    }
    const match = /^panels\.([^.]+)\.(.+)$/.exec(patch.path)
    if (!match) throw new Error(`无法定位补丁所属面板：${patch.path}`)
    return { ...patch, planId, parentVersion, targetKind: 'panel' as const, targetId: match[1], path: match[2] }
  }

  async previewPatch(planId: string, parentVersion: number, patch: SpecPatch): Promise<PatchPreview> {
    const { json } = await this.postJson(`${this.taskBase}/patches/preview`, this.normalizePatch(planId, parentVersion, patch))
    return json.preview as PatchPreview
  }

  async applyPatch(token: string): Promise<PlanVersion> {
    const { json } = await this.postJson(`${this.taskBase}/patches/apply`, { token })
    return json.revision as PlanVersion
  }

  async revertPatch(): Promise<PlanVersion> {
    const { json } = await this.postJson(`${this.taskBase}/patches/revert`, {})
    return json.revision as PlanVersion
  }

  async restoreVersion(version: number): Promise<PlanVersion> {
    const { json } = await this.postJson(`${this.taskBase}/patches/restore`, { version })
    return json.revision as PlanVersion
  }

  async previewSource(input: { planId: string; engine: EngineKind; parentVersion: number; baseHash?: string; source: string }): Promise<SourcePreview> {
    const { json } = await this.postJson(`${this.taskBase}/source/preview`, input)
    return json.preview as SourcePreview
  }

  async applySource(token: string): Promise<PlanVersion> {
    const { json } = await this.postJson(`${this.taskBase}/source/apply`, { token })
    return json.revision as PlanVersion
  }

  async previewData(input: { kind: 'type_override'; field: string; type: string } | { kind: 'replace'; fileName: string; contentBase64: string }): Promise<DataRevisionPreview> {
    const { json } = await this.postJson(`${this.taskBase}/data/preview`, input)
    return json.preview as DataRevisionPreview
  }

  async applyData(token: string, confirmed: boolean): Promise<void> {
    await this.postJson(`${this.taskBase}/data/apply`, { token, confirmed })
  }

  async applyStylePreset(planId: string, presetId: string, parentVersion: number): Promise<PlanVersion> {
    const { json } = await this.postJson(`${this.taskBase}/styles/apply`, { planId, presetId, parentVersion })
    return json.revision as PlanVersion
  }

  async saveCode(planId: string, engine: EngineKind, code: string): Promise<AgentTask> {
    await this.postJson(`${this.taskBase}/code`, { planId, engine, code })
    return this.getSnapshot()
  }

  getPreferences(): Promise<PreferenceSnapshot> {
    return this.requestJson('/api/preferences', 'GET') as Promise<PreferenceSnapshot>
  }

  async setPreferencePaused(paused: boolean): Promise<PreferenceSnapshot> {
    const { json } = await this.postJson('/api/preferences/pause', { paused })
    return json as PreferenceSnapshot
  }

  async revertPreference(eventId: string): Promise<void> {
    await this.requestJson(`/api/preferences/${encodeURIComponent(eventId)}`, 'DELETE')
  }

  async clearPreferences(): Promise<PreferenceSnapshot> {
    return this.requestJson('/api/preferences', 'DELETE') as Promise<PreferenceSnapshot>
  }

  async recordStylePreference(style: Record<string, string>, summary: string): Promise<PreferenceSnapshot> {
    const { json } = await this.postJson(`${this.taskBase}/preferences`, {
      kind: 'manual_edit', scope: 'global', source: 'preferences_panel', style, attributes: style, summary
    })
    return (json as { preference?: unknown }).preference ? await this.getPreferences() : json as PreferenceSnapshot
  }

  // v0.4.0 优化：配色学习画像查询（撤销/重置闭环）。
  // GET /api/preferences/colors → 由未撤销配色事件重建的画像（学习摘要/逐色板统计/事件 id）。
  getColorProfile(): Promise<ColorProfile> {
    return this.requestJson('/api/preferences/colors', 'GET') as Promise<ColorProfile>
  }

  // v0.4.0 优化：重置配色学习画像。仅移除携带 paletteId 的偏好事件（含已撤销的），
  // 保留与配色无关的偏好（图型/排版等），避免误伤其他学习。
  async resetColorPreferences(): Promise<PreferenceSnapshot> {
    return this.requestJson('/api/preferences/colors', 'DELETE') as Promise<PreferenceSnapshot>
  }

  async answerQuestion(text: string): Promise<void> {
    await this.postJson(`${this.taskBase}/answer`, { answer: text })
  }

  /** SELECT：记录显式偏好；服务端保留三套方案为可恢复分支并发 ITERATE 状态 */
  async selectPlan(plan: PlotPlan): Promise<void> {
    await this.postJson(`${this.taskBase}/select`, { planId: plan.plan_id })
    // 拉取该方案的真实渲染产物并以 execution_update 形式注入状态（execution.artifactSvg）
    try {
      if (!['verified', 'rendered_unverified'].includes(plan.executionStatus ?? '')) return
      const preview = await this.getPreview(plan.plan_id)
      const execution: Partial<ExecutionRecord> = {
        status: 'success',
        engine: (preview.engine as EngineKind) ?? this.cfg.engine,
        artifactSvg: preview.svg
      }
      this.emit?.({ type: 'execution_update', execution })
    } catch {
      /* 预览失败不阻断偏好选择 */
    }
  }

  async rejectPlan(plan: PlotPlan): Promise<void> {
    await this.postJson(`${this.taskBase}/preferences`, { kind: 'reject', planId: plan.plan_id })
  }

  /** FEEDBACK：服务端生成新 PlotRevision（新版本记录），经 ITERATE→DESIGN→EXECUTE→VERIFY→PRESENT */
  async feedback(text: string, selectedPlanId?: string): Promise<void> {
    await this.postJson(`${this.taskBase}/feedback`, {
      feedback: text,
      kind: 'manual_edit',
      ...(selectedPlanId ? { planId: selectedPlanId } : {})
    })
  }

  async confirmChartRecommendation(chartType: string, selectedPlanId?: string): Promise<void> {
    await this.postJson(`${this.taskBase}/feedback`, {
      feedback: `确认图型建议：${chartType}`,
      chartType,
      kind: 'manual_edit',
      ...(selectedPlanId ? { planId: selectedPlanId } : {})
    })
  }

  async generatePaperDraft(input: { planId: string; purpose: string; section: string }): Promise<unknown> {
    const { json } = await this.postJson(`${this.taskBase}/paper-draft`, input)
    return json
  }

  async getPreview(planId?: string, engine?: EngineKind): Promise<PreviewArtifact> {
    const params = new URLSearchParams()
    if (planId) params.set('planId', planId)
    if (engine) params.set('engine', engine)
    const q = params.toString() ? `?${params.toString()}` : ''
    const r = await fetch(`${this.cfg.baseUrl}${this.taskBase}/preview${q}`, { headers: this.headers() })
    if (!r.ok) throw new Error(`preview HTTP ${r.status}`)
    return r.json()
  }

  async getTrace(): Promise<unknown> {
    const r = await fetch(`${this.cfg.baseUrl}${this.taskBase}/trace`, { headers: this.headers() })
    return r.json()
  }

  /** 导出复现 ZIP（三引擎代码 + 数据 + ChartSpec + 证据 + 真实产物），浏览器直接下载；服务端同时进入 COMPLETE */
  async exportArtifact(kind: string, planId?: string, options: { includeCode?: boolean; includeData?: boolean; includeEvidence?: boolean; includeArtifacts?: boolean; colorMode?: 'color' | 'grayscale'; dpi?: number; formats?: string[] } = {}): Promise<void> {
    const params = new URLSearchParams()
    if (planId) params.set('planId', planId)
    if (options.includeCode !== undefined) params.set('includeCode', String(options.includeCode))
    if (options.includeData !== undefined) params.set('includeData', String(options.includeData))
    if (options.includeEvidence !== undefined) params.set('includeEvidence', String(options.includeEvidence))
    if (options.includeArtifacts !== undefined) params.set('includeArtifacts', String(options.includeArtifacts))
    if (options.colorMode) params.set('colorMode', options.colorMode)
    if (options.dpi !== undefined) params.set('dpi', String(Math.round(options.dpi)))
    if (options.formats?.length) params.set('formats', options.formats.join(','))
    const q = params.toString() ? `?${params.toString()}` : ''
    const r = await fetch(`${this.cfg.baseUrl}${this.taskBase}/export${q}`, { headers: this.headers() })
    if (!r.ok) throw new Error(`export HTTP ${r.status}`)
    const blob = await r.blob()
    const href = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = href
    a.download = `${planId ?? this.taskId}.zip`
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(href), 10_000)
    void kind
  }
}
