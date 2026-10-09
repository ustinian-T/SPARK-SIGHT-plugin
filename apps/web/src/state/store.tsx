import { createContext, useContext, useEffect, useMemo, useReducer, useRef, useState, type ReactNode } from 'react'
import { localSettingsRequest } from '../client/modelSettings'
import type {
  AgentState,
  AgentTask,
  ApprovalMode,
  ApprovalRequestEvent,
  BacklogItem,
  BatchConfirmGroup,
  BatchConfirmResult,
  BatchGroup,
  BatchSplitResult,
  ChatMessage,
  DatasetProfile,
  EngineKind,
  ExecutionRecord,
  GrantRecord,
  GrantRequestEvent,
  GrantResolvedEvent,
  GrantScope,
  GalleryChart,
  GalleryFilter,
  LogLine,
  PlanStep,
  PlotPlan,
  PatchPreview,
  PreferenceEvent,
  ColorProfile,
  ProjectPreferences,
  ProjectPreferencesResponse,
  ProjectSummary,
  SpecPatch,
  SourcePreview,
  TaskEvent,
  TaskSummary
} from '../types'
import { RealAgentClient, getAnonymousToken, readConfigFromLocation, readRuntimeConfig } from '../client/realAgentClient'
import { loadSession as getStoredSession } from '../site/session'
import { CHECKING_GATE, probeGate, type GateReason, type GateResult } from '../client/gate'
import { getHostBridge } from '../host/bridge'
import { buildProfile } from '../lib/csv'
import { applySpecPatch, type DiffLine, type PatchResult } from '../lib/patch'
import { uid } from '../lib/format'

const localCfg = readConfigFromLocation()

export type MainView = 'chat' | 'compare' | 'code' | 'platform' | 'gallery' | 'inspector' | 'evidence' | 'preferences'
export type RunLocation = 'remote' | 'local'

export interface PendingPatch {
  planId: string
  patch: SpecPatch
  result: PatchResult
  preview?: PatchPreview
  applying?: boolean
  error?: string
}

interface AppState {
  task: AgentTask | null
  messages: ChatMessage[]
  mainView: MainView
  consoleOpen: boolean
  activePlanId?: string
  activeEngine: EngineKind
  runLocation: RunLocation
  localConnected: boolean
  gate: GateResult
  startError?: string
  pendingPatch?: PendingPatch
  running: boolean
  preferencePaused: boolean
  globalPreferences: PreferenceEvent[]
  // v0.4.0 优化：配色学习画像（撤销/重置闭环；由后端 /api/preferences/colors 重建）
  colorProfile: ColorProfile | null
  colorProfileLoading: boolean
  // 阶段 2：项目切换器 + 任务列表
  currentProjectId: string
  projects: ProjectSummary[]
  projectTasks: TaskSummary[]
  projectsError?: string
  // 阶段 4：项目偏好共享 + 图表类型使用统计
  projectPreferences: ProjectPreferences
  chartUsage: Record<string, number>
  // 阶段 5：跨任务取数授权
  grants: GrantRecord[]
  pendingGrant: GrantRequestEvent | null
  // 阶段 6：审批模式 + 待审批队列
  approvalMode: ApprovalMode
  pendingApprovals: ApprovalRequestEvent[]
  // 阶段 7：待办队列 + 打断标志（在 step 边界切换，不中途中断函数执行）
  backlog: BacklogItem[]
  interruptFlag: boolean
  // 阶段 8：项目图库（按项目聚合所有任务产出的图表）
  galleryCharts: GalleryChart[]
  galleryLoading: boolean
  galleryFilter: GalleryFilter
  galleryError?: string
}

type Action =
  | { kind: 'restore_local'; saved: Partial<AppState> }
  | { kind: 'event'; event: TaskEvent; taskId: string; title: string }
  | { kind: 'user_msg'; text: string; attachments?: string[] }
  | { kind: 'assistant_msg'; text: string; state?: AgentState }
  | { kind: 'start'; taskId: string; title: string; dataset?: AgentTask['dataset'] }
  | { kind: 'set_view'; view: MainView }
  | { kind: 'toggle_console'; open?: boolean }
  | { kind: 'set_active_plan'; planId?: string }
  | { kind: 'set_engine'; engine: EngineKind }
  | { kind: 'update_code'; planId: string; engine: EngineKind; code: string }
  | { kind: 'set_location'; location: RunLocation }
  | { kind: 'select'; planId: string }
  | { kind: 'propose_patch'; pending: PendingPatch }
  | { kind: 'accept_patch' }
  | { kind: 'cancel_patch' }
  | { kind: 'set_col_type'; index: number; type: import('../types').ColumnType }
  | { kind: 'clear_prefs' }
  | { kind: 'cancel_run' }
  | { kind: 'hydrate_task'; task: AgentTask }
  | { kind: 'preference_state'; paused: boolean; events: PreferenceEvent[] }
  | { kind: 'color_profile'; profile: ColorProfile | null; loading?: boolean }
  // 优化5：编辑即重渲染——applySource 成功后拉取该方案真实渲染 SVG，图表随之变化
  | { kind: 'artifact_svg'; svg: string | null; planId?: string; engine?: EngineKind | string }
  | { kind: 'patch_preview'; preview: PatchPreview }
  | { kind: 'patch_applying' }
  | { kind: 'patch_error'; message: string }
  | { kind: 'gate_result'; gate: GateResult }
  | { kind: 'start_error'; message?: string }
  | { kind: 'reset' }
  // 阶段 2：项目与任务列表
  | { kind: 'set_project'; projectId: string }
  | { kind: 'projects_loaded'; projects: ProjectSummary[] }
  | { kind: 'project_tasks_loaded'; tasks: TaskSummary[]; projectId?: string }
  | { kind: 'project_created'; project: ProjectSummary }
  | { kind: 'projects_error'; message: string }
  | { kind: 'clear_task' }
  // 阶段 4：项目偏好
  | { kind: 'project_preferences_loaded'; data: ProjectPreferencesResponse }
  | { kind: 'project_preferences_updated'; preferences: ProjectPreferences }
  // 阶段 5：授权
  | { kind: 'grants_loaded'; grants: GrantRecord[] }
  | { kind: 'grant_received'; request: GrantRequestEvent }
  | { kind: 'grant_resolved'; requestId: string }
  // 阶段 6：审批
  | { kind: 'approval_mode_loaded'; mode: ApprovalMode }
  | { kind: 'approval_mode_set'; mode: ApprovalMode }
  | { kind: 'approval_received'; request: ApprovalRequestEvent }
  | { kind: 'approval_resolved'; requestId: string }
  // 阶段 7：待办队列
  | { kind: 'backlog_add'; item: BacklogItem }
  | { kind: 'backlog_status'; id: string; status: BacklogItem['status'] }
  | { kind: 'backlog_reorder'; id: string; direction: 'up' | 'down' }
  | { kind: 'backlog_clear' }
  | { kind: 'interrupt_set'; flag: boolean }
  // 阶段 8：项目图库
  | { kind: 'gallery_loading' }
  | { kind: 'gallery_loaded'; charts: GalleryChart[] }
  | { kind: 'gallery_set_filter'; filter: GalleryFilter }
  | { kind: 'gallery_error'; message: string }

const initialExecution: ExecutionRecord = {
  version: 0,
  engine: 'python',
  status: 'idle',
  logs: []
}

function upsertStep(steps: PlanStep[], step: PlanStep): PlanStep[] {
  const i = steps.findIndex((s) => s.step_id === step.step_id)
  if (i < 0) return [...steps, step]
  const copy = steps.slice()
  copy[i] = { ...copy[i], ...step }
  return copy
}

export function applyEvent(task: AgentTask, e: TaskEvent): AgentTask {
  let t = { ...task }
  if (e.state) t.state = e.state
  if (e.step) t.steps = upsertStep(t.steps, e.step)
  if (e.evidence) t.evidence = [...t.evidence, e.evidence]
  if (e.log) t.execution = { ...t.execution, logs: [...t.execution.logs, e.log] }
  if (e.plans) t.plans = e.plans
  if (e.selectionAudit) t.selectionAudit = e.selectionAudit
  if (e.execution) {
    t.execution = {
      ...t.execution,
      ...e.execution,
      logs: t.execution.logs // 日志以 log 事件为准，避免整体覆盖
    }
  }
  if (e.question) {
    t.pendingQuestion = {
      question: e.question,
      options: e.options ?? [],
      ...(e.choiceGroups !== undefined ? { choiceGroups: e.choiceGroups } : {}),
      ...(e.defaults !== undefined ? { defaults: e.defaults } : {}),
      ...(e.round !== undefined ? { round: e.round } : {}),
      ...(e.total !== undefined ? { total: e.total } : {}),
      ...(e.key !== undefined ? { key: e.key } : {}),
      ...(e.hint !== undefined ? { hint: e.hint } : {}),
      // v0.4.0 优化：第三轮（key=presentation）推荐色板（依据用户历史配色学习）
      ...(e.recommendedPalettes !== undefined ? { recommendedPalettes: e.recommendedPalettes } : {})
    }
  }
  if (e.type === 'retry' && e.retries !== undefined) t.retries = e.retries
  if (e.preference) {
    t.preferences = [e.preference, ...t.preferences]
    if (e.preference.kind === 'select_plan' && e.preference.planId) t.selectedPlanId = e.preference.planId
  }
  if (e.revision) {
    t.currentRevision = e.revision.version
    t.planVersions = [...(t.planVersions ?? []).filter((revision) => revision.version !== e.revision!.version), e.revision]
    t.plans = e.revision.plans
  }
  return t
}

export function reducer(state: AppState, action: Action): AppState {
  if (action.kind === 'restore_local') return { ...state, ...action.saved, galleryLoading: false, running: false, pendingPatch: undefined, interruptFlag: false, runLocation: state.runLocation, localConnected: state.localConnected }
  switch (action.kind) {
    case 'start':
      return {
        ...state,
        running: true,
        startError: undefined,
        task: {
          taskId: action.taskId,
          state: 'INGEST',
          title: action.title,
          createdAt: Date.now(),
          dataset: action.dataset,
          steps: [],
          evidence: [],
          plans: [],
          execution: { ...initialExecution },
          preferences: [],
          retries: 0
        },
        messages: [],
        pendingPatch: undefined,
        activePlanId: undefined
      }
    case 'event': {
      if (!state.task) return state
      const task = applyEvent(state.task, action.event)
      const BUSY: AgentState[] = ['INGEST', 'UNDERSTAND', 'PLAN', 'ANALYZE', 'DESIGN', 'EXECUTE', 'VERIFY', 'REPAIR']
      const running = BUSY.includes(task.state) || task.execution.status === 'running'
      const globalPreferences = action.event.preference
        ? [action.event.preference, ...state.globalPreferences.filter((item) => item.event_id !== action.event.preference?.event_id)]
        : state.globalPreferences
      return { ...state, task, running, globalPreferences, projectTasks: state.projectTasks.map(item => item.taskId === task.taskId ? { ...item, state: task.state } : item) }
    }
    case 'user_msg':
      return {
        ...state,
        messages: [...state.messages, { id: uid('m'), role: 'user', text: action.text, t: Date.now(), attachments: action.attachments }]
      }
    case 'assistant_msg':
      return {
        ...state,
        messages: [...state.messages, { id: uid('m'), role: 'assistant', text: action.text, t: Date.now(), state: action.state }]
      }
    case 'set_view':
      return { ...state, mainView: action.view }
    case 'toggle_console':
      return { ...state, consoleOpen: action.open ?? !state.consoleOpen }
    case 'set_active_plan':
      return { ...state, activePlanId: action.planId }
    case 'set_engine':
      return { ...state, activeEngine: action.engine }
    case 'update_code': {
      if (!state.task) return state
      const plans = state.task.plans.map((plan) => plan.plan_id === action.planId
        ? { ...plan, code: { ...plan.code, [action.engine]: action.code }, executionStatus: 'code_edited_unverified', verification: undefined }
        : plan)
      return { ...state, task: { ...state.task, plans } }
    }
    case 'set_location':
      return { ...state, runLocation: action.location }
    case 'select':
      return {
        ...state,
        task: state.task ? { ...state.task, selectedPlanId: action.planId, state: 'ITERATE' } : state.task,
        activePlanId: action.planId,
        mainView: 'compare'
      }
    case 'propose_patch':
      return { ...state, pendingPatch: action.pending }
    case 'patch_preview':
      return state.pendingPatch ? { ...state, pendingPatch: { ...state.pendingPatch, preview: action.preview, error: undefined } } : state
    case 'patch_applying':
      return state.pendingPatch ? { ...state, pendingPatch: { ...state.pendingPatch, applying: true, error: undefined } } : state
    case 'patch_error':
      return state.pendingPatch ? { ...state, pendingPatch: { ...state.pendingPatch, applying: false, error: action.message } } : state
    case 'cancel_patch':
      return { ...state, pendingPatch: undefined }
    case 'set_col_type': {
      if (!state.task?.dataset) return state
      const columns = state.task.dataset.columns.map((c) =>
        c.index === action.index ? { ...c, userType: action.type } : c
      )
      return { ...state, task: { ...state.task, dataset: { ...state.task.dataset, columns } } }
    }
    case 'accept_patch': {
      const pp = state.pendingPatch
      if (!pp || !state.task) return { ...state, pendingPatch: undefined }
      const plans = state.task.plans.map((p) =>
        p.plan_id === pp.planId ? { ...p, spec: pp.result.spec } : p
      )
      const exec: ExecutionRecord = {
        ...state.task.execution,
        version: state.task.execution.version + 1,
        status: 'success'
      }
      return {
        ...state,
        pendingPatch: undefined,
        task: { ...state.task, plans, execution: exec }
      }
    }
    case 'clear_prefs':
      return { ...state, globalPreferences: [], task: state.task ? { ...state.task, preferences: [] } : state.task }
    case 'preference_state':
      return { ...state, preferencePaused: action.paused, globalPreferences: action.events }
    case 'color_profile':
      return { ...state, colorProfile: action.profile, colorProfileLoading: action.loading ?? false }
    case 'artifact_svg':
      // 编辑即重渲染：把该方案最新真实渲染 SVG 写入 execution.artifactSvg（null=拉取失败保留旧图）
      return state.task
        ? { ...state, task: { ...state.task, execution: { ...state.task.execution, artifactSvg: action.svg ?? undefined, artifactPlanId: action.planId, artifactEngine: action.engine } } }
        : state
    case 'hydrate_task':
      return { ...state, task: action.task, activePlanId: action.task.selectedPlanId ?? state.activePlanId, running: action.task.execution.status === 'running' }
    case 'cancel_run':
      // 停止当前运行任务：状态→cancelled；执行中/待打断的待办一并取消；排队中的待办保留。
      return state.task
        ? {
            ...state,
            running: false,
            interruptFlag: false,
            task: { ...state.task, state: 'CANCELLED', execution: { ...state.task.execution, status: 'cancelled' } },
            backlog: state.backlog.map((item) =>
              item.status === 'executing' || item.status === 'blocking'
                ? { ...item, status: 'cancelled' as const }
                : item
            )
          }
        : { ...state, interruptFlag: false, backlog: state.backlog.map((item) =>
            item.status === 'executing' || item.status === 'blocking'
              ? { ...item, status: 'cancelled' as const }
              : item
          ) }
    case 'gate_result':
      return { ...state, gate: action.gate, localConnected: action.gate.status === 'available' }
    case 'start_error':
      return { ...state, startError: action.message, running: false }
    case 'reset':
      // 删除当前任务后回到初始界面，但保留项目上下文（当前项目、项目列表），避免丢失项目导航。
      return { ...initialState, gate: state.gate, currentProjectId: state.currentProjectId, projects: state.projects, projectTasks: state.projectTasks }
    // ---------- 阶段 2：项目与任务列表 ----------
    case 'set_project':
      // 切换项目时清空旧任务列表，待 selectProject 拉取新任务；不清 task 由调用方决定。
      return { ...state, currentProjectId: action.projectId, projectTasks: [] }
    case 'projects_loaded':
      return { ...state, projects: action.projects, projectsError: undefined }
    case 'project_tasks_loaded':
      if (action.projectId && action.projectId !== state.currentProjectId) return state
      return { ...state, projectTasks: action.tasks }
    case 'project_created':
      return { ...state, projects: [...state.projects, action.project] }
    case 'projects_error':
      return { ...state, projectsError: action.message }
    case 'clear_task':
      // 仅清空当前任务视图（不删除后端任务），用于“新建任务”回到上传入口或切换项目。
      return {
        ...state,
        task: null,
        messages: [],
        running: false,
        pendingPatch: undefined,
        activePlanId: undefined,
        startError: undefined
      }
    // ---------- 阶段 4：项目偏好 ----------
    case 'project_preferences_loaded':
      return { ...state, projectPreferences: action.data.preferences ?? {}, chartUsage: action.data.chartUsage ?? {} }
    case 'project_preferences_updated':
      return { ...state, projectPreferences: { ...state.projectPreferences, ...action.preferences } }
    // ---------- 阶段 5：授权 ----------
    case 'grants_loaded':
      return { ...state, grants: action.grants }
    case 'grant_received':
      return { ...state, pendingGrant: action.request }
    case 'grant_resolved':
      // 清空待确认授权；已 resolved 的请求无论 approved 与否都不再阻塞对话框。
      return { ...state, pendingGrant: state.pendingGrant?.requestId === action.requestId ? null : state.pendingGrant }
    // ---------- 阶段 6：审批 ----------
    case 'approval_mode_loaded':
    case 'approval_mode_set':
      return { ...state, approvalMode: action.mode }
    case 'approval_received':
      // 同 requestId 去重，避免 WS 重放造成队列重复。
      if (state.pendingApprovals.some((r) => r.requestId === action.request.requestId)) return state
      return { ...state, pendingApprovals: [...state.pendingApprovals, action.request] }
    case 'approval_resolved':
      return { ...state, pendingApprovals: state.pendingApprovals.filter((r) => r.requestId !== action.requestId) }
    // ---------- 阶段 7：待办队列 ----------
    case 'backlog_add':
      return { ...state, backlog: [...state.backlog, action.item] }
    case 'backlog_status':
      return {
        ...state,
        backlog: state.backlog.map((item) =>
          item.id === action.id ? { ...item, status: action.status } : item
        )
      }
    case 'backlog_reorder': {
      const idx = state.backlog.findIndex((item) => item.id === action.id)
      if (idx < 0) return state
      const swapWith = action.direction === 'up' ? idx - 1 : idx + 1
      if (swapWith < 0 || swapWith >= state.backlog.length) return state
      const copy = state.backlog.slice()
      // 仅允许调整排队中/待打断项的顺序；执行中/已完成/已取消不参与排序。
      const moving = copy[idx]
      const target = copy[swapWith]
      if (moving.status !== 'queued' && moving.status !== 'blocking') return state
      if (target.status !== 'queued' && target.status !== 'blocking') return state
      copy[idx] = target
      copy[swapWith] = moving
      // 重排后同步 priority 字段（数组下标即优先级），保证下次插入排序正确。
      return { ...state, backlog: copy.map((item, i) => ({ ...item, priority: i })) }
    }
    case 'backlog_clear':
      // 清空队列：移除排队中与已取消项；执行中/待打断/已完成项保留以便追溯。
      return { ...state, backlog: state.backlog.filter((item) => item.status !== 'queued' && item.status !== 'cancelled') }
    case 'interrupt_set':
      return { ...state, interruptFlag: action.flag }
    // ---------- 阶段 8：项目图库 ----------
    case 'gallery_loading':
      return { ...state, galleryLoading: true, galleryError: undefined }
    case 'gallery_loaded':
      return { ...state, galleryLoading: false, galleryCharts: action.charts }
    case 'gallery_set_filter':
      return { ...state, galleryFilter: action.filter }
    case 'gallery_error':
      return { ...state, galleryLoading: false, galleryError: action.message }
    default:
      return state
  }
}

const initialState: AppState = {
  task: null,
  messages: [],
  mainView: 'chat',
  consoleOpen: false,
  activeEngine: 'python',
  runLocation: getHostBridge() ? 'local' : 'remote',
  localConnected: !!getHostBridge(),
  gate: CHECKING_GATE,
  startError: undefined,
  running: false,
  preferencePaused: false,
  globalPreferences: [],
  colorProfile: null,
  colorProfileLoading: false,
  currentProjectId: '',
  projects: [],
  projectTasks: [],
  projectPreferences: {},
  chartUsage: {},
  grants: [],
  pendingGrant: null,
  approvalMode: 'user',
  pendingApprovals: [],
  backlog: [],
  interruptFlag: false,
  galleryCharts: [],
  galleryLoading: false,
  galleryFilter: { sort: 'newest' }
}

// 门禁失败原因 → 通俗说明
export function describeGateReason(reason: GateReason | null): string {
  switch (reason) {
    case 'not_configured': return '尚未配置绘图后端地址'
    case 'unreachable': return '无法连接到绘图后端（服务未启动或被拦截）'
    case 'auth_failed': return '后端认证失败（令牌无效或已过期）'
    case 'protocol_mismatch': return '前后端协议版本不兼容'
    case 'no_runtime': return '后端已连接，但没有任何可用的 Python / R 运行环境'
    default: return '绘图后端当前不可用'
  }
}

interface StoreApi {
  state: AppState
  client: React.MutableRefObject<RealAgentClient | null>
  start: (input: { fileName: string; bytes: Uint8Array; prompt: string; clarify?: boolean; clarifyAnswers?: Record<string, unknown> }) => Promise<void>
  answer: (text: string) => void
  choosePlan: (plan: PlotPlan) => void
  rejectPlan: (plan: PlotPlan) => void
  feedback: (text: string) => Promise<void>
  proposePatch: (planId: string, patch: SpecPatch) => Promise<void>
  acceptPatch: () => Promise<void>
  cancelPatch: () => void
  saveSource: (planId: string, engine: EngineKind, source: string) => Promise<SourcePreview | undefined>
  exportArtifact: (kind: string, options?: { includeCode?: boolean; includeData?: boolean; includeEvidence?: boolean; includeArtifacts?: boolean; colorMode?: 'color' | 'grayscale'; dpi?: number; formats?: string[] }) => void
  saveCode: (planId: string, engine: EngineKind, code: string) => Promise<void>
  setView: (v: MainView) => void
  setActivePlan: (id?: string) => void
  toggleConsole: (open?: boolean) => void
  setEngine: (e: EngineKind) => void
  setLocation: (l: RunLocation) => void
  setColType: (index: number, type: import('../types').ColumnType) => void
  replaceData: (file: File) => Promise<void>
  applyStylePreset: (planId: string, presetId: string) => Promise<void>
  undoRevision: () => Promise<void>
  clearPrefs: () => void
  setPreferencePaused: (paused: boolean) => void
  revertPreference: (eventId: string) => void
  // v0.4.0 优化：配色学习画像查询与重置（撤销/重置闭环）
  loadColorProfile: () => Promise<void>
  resetColorPreferences: () => void
  newTask: () => void
  retryTask: (prompt?: string) => Promise<void>
  cancelRun: () => void
  refreshGate: () => Promise<void>
  dismissStartError: () => void
  reset: () => Promise<void>
  // 阶段 2：项目与任务列表
  loadProjects: () => Promise<void>
  createProject: (name: string, description?: string) => Promise<ProjectSummary>
  renameProject: (projectId: string, name: string, description?: string) => Promise<void>
  // 项目上云：纳入云存储配额管理并立即镜像项目数据（未上云数据仅保留 7 天）
  cloudSyncProject: (projectId: string) => Promise<void>
  selectProject: (projectId: string) => Promise<void>
  loadProjectTasks: (projectId: string) => Promise<void>
  deleteProjectTask: (projectId: string, taskId: string) => Promise<void>
  openTask: (taskId: string, projectId?: string) => Promise<void>
  startNewTask: () => void
  // 阶段 3：批量拆分
  requestBatchSplit: (files: File[]) => Promise<BatchSplitResult>
  confirmBatchSplit: (groups: BatchConfirmGroup[]) => Promise<BatchConfirmResult>
  // 阶段 4：项目偏好
  loadProjectPreferences: () => Promise<void>
  updateProjectPreferences: (patch: ProjectPreferences) => Promise<void>
  setCurrentTaskAsProjectDefault: () => Promise<void>
  // 阶段 5：授权
  loadGrants: () => Promise<void>
  resolveGrant: (requestId: string, approved: boolean, scope: GrantScope) => Promise<void>
  // 阶段 6：审批
  loadApprovalMode: () => Promise<void>
  setApprovalMode: (mode: ApprovalMode) => Promise<void>
  respondApproval: (requestId: string, approved: boolean, oncePerSession?: boolean) => Promise<void>
  // 阶段 7：待办队列
  addToBacklog: (content: string, attachments?: string[]) => void
  executeBacklogItem: (id: string) => void
  removeBacklogItem: (id: string) => void
  reorderBacklog: (id: string, direction: 'up' | 'down') => void
  clearBacklog: () => void
  // 阶段 8：项目图库
  loadGalleryCharts: (projectId: string) => Promise<void>
  setGalleryFilter: (filter: GalleryFilter) => void
  // 取某方案在沙箱真实渲染的 SVG（供三方案对比卡片优先显示真实产物，失败返回 null 回退占位）
  fetchPlanPreview: (taskId: string, planId: string) => Promise<string | null>
}

const Ctx = createContext<StoreApi | null>(null)

export function StoreProvider({ children }: { children: ReactNode }) {
  const [state, dispatch] = useReducer(reducer, initialState)
  const [restored, setRestored] = useState(false)
  const clientRef = useRef<RealAgentClient | null>(null)
  const taskMeta = useRef({ id: uid('task'), title: '' })
  const feedbackInFlight = useRef(false)
  const assistantNoticeRef = useRef({ text: '', at: 0 })
  // 阶段 6：本会话内“同类动作不再询问”的内存集合（重启即失效，不持久化）。
  const sessionAutoApprove = useRef<Set<string>>(new Set())
  // 通过 ref 暴露最新 api，供挂载副作用（只跑一次）调用 loadProjects。
  const apiRef = useRef<StoreApi | null>(null)
  useEffect(() => {
    let cancelled = false
    const restore = async () => {
      try {
        const saved = getHostBridge() ? await localSettingsRequest('/api/local/ui') : JSON.parse(localStorage.getItem('deep-imaging.ui.v1') ?? '{}')
        if (!cancelled && saved.messages && Array.isArray(saved.messages)) {
          dispatch({ kind: 'restore_local', saved })
          if (saved.task?.taskId) {
            taskMeta.current = { id: saved.task.taskId, title: saved.task.title }
            const cfg = await readRuntimeConfig()
            const gate = cfg.enabled && cfg.baseUrl ? null : await probeGate()
            const baseUrl = cfg.baseUrl || gate?.baseUrl || ''
            if (baseUrl && (!gate || gate.status === 'available')) {
              const token = cfg.token || (getHostBridge() ? '' : await getAnonymousToken(baseUrl))
              const client = new RealAgentClient({ baseUrl, token, engine: saved.activeEngine, projectId: saved.currentProjectId })
              client.resume(saved.task.taskId)
              try {
                const task = await client.getSnapshot()
                client.resume(saved.task.taskId, (task.eventSeq ?? 0) - 1)
                if (!cancelled) {
                  clientRef.current = client
                  dispatch({ kind: 'hydrate_task', task })
                  client.subscribe((event) => dispatch({ kind: 'event', event, taskId: task.taskId, title: task.title }))
                }
              } catch (error) {
                if (!cancelled && /不存在|已清理|HTTP 404|HTTP 403/.test(error instanceof Error ? error.message : String(error))) {
                  dispatch({ kind: 'clear_task' })
                  dispatch({ kind: 'start_error', message: '上次任务已不可访问；请重新上传数据。' })
                }
              }
            }
          }
        }
      } catch { /* Saved history remains available when the Agent is temporarily offline. */ }
      finally { if (!cancelled) setRestored(true) }
    }
    void restore()
    return () => { cancelled = true }
  }, [])
  useEffect(() => {
    if (!restored) return
    const timer = setTimeout(() => {
      // 门禁结果含运行时状态，不写入浏览器存储；保存前剔除，避免持久化任何后端状态。
      const { gate: _gate, startError: _startError, interruptFlag: _interrupt, ...saved } = { ...state, running: false, pendingPatch: undefined, interruptFlag: false }
      if (getHostBridge()) void localSettingsRequest('/api/local/ui', saved).catch(() => {})
      else { try { localStorage.setItem('deep-imaging.ui.v1', JSON.stringify(saved)) } catch { /* Browser storage may be full. */ } }
    }, 400)
    return () => clearTimeout(timer)
  }, [state, restored])

  // P0：真实健康门禁。启动探测一次，之后每 30 秒复检，切换执行位置时立即探测。
  useEffect(() => {
    if (!restored) return
    let cancelled = false
    const run = async () => {
      const result = await probeGate()
      if (!cancelled) dispatch({ kind: 'gate_result', gate: result })
    }
    void run()
    const onWake = () => { if (!document.hidden) void run() }
    window.addEventListener('online', onWake)
    document.addEventListener('visibilitychange', onWake)
    const interval = setInterval(() => void run(), 15_000)
    return () => { cancelled = true; clearInterval(interval); window.removeEventListener('online', onWake); document.removeEventListener('visibilitychange', onWake) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restored, state.runLocation])

  // 初次恢复遇到网络故障时，健康检查恢复后重新连接原任务，保留本地记录。
  useEffect(() => {
    if (!restored || state.gate.status !== 'available') return
    void apiRef.current?.loadProjects().catch(() => {})
    if (state.task && !clientRef.current) void apiRef.current?.openTask(state.task.taskId, state.currentProjectId || undefined).catch(() => {})
  }, [restored, state.gate.status])

  // 阶段 2：应用初始化后自动加载项目列表；后端不可用时 loadProjects 内部静默跳过（GateBlock 已提示）。
  useEffect(() => {
    if (!restored) return
    void apiRef.current?.loadProjects().catch(() => {})
  }, [restored])

  // 阶段 4/5/6：项目切换后加载项目偏好、授权记录、审批模式；并建立项目级 WS 监听
  // grant_requested / grant_resolved / approval_requested 事件。
  useEffect(() => {
    if (!restored || !state.currentProjectId) return
    void apiRef.current?.loadProjectPreferences().catch(() => {})
    void apiRef.current?.loadGrants().catch(() => {})
    void apiRef.current?.loadApprovalMode().catch(() => {})

    let cancelled = false
    let ws: WebSocket | null = null
    let reconnectTimer: ReturnType<typeof setTimeout> | undefined

    const connect = async () => {
      // 通过门禁拿 baseUrl/token
      const gate = await probeGate()
      if (cancelled || gate.status !== 'available') return
      const host = getHostBridge()
      let runtimeCfg = localCfg
      try { runtimeCfg = await readRuntimeConfig() } catch { /* keep localCfg */ }
      const baseUrl = gate.baseUrl || runtimeCfg.baseUrl || window.location.origin
      let token = runtimeCfg.token ?? ''
      if (!token && !host) {
        try {
          token = await getAnonymousToken(baseUrl)
        } catch { /* ignore */ }
      }
      const wsBase = baseUrl.replace(/^http/, 'ws')
      const url = `${wsBase}/api/projects/${encodeURIComponent(state.currentProjectId)}/collaboration`
      try {
        ws = new WebSocket(url)
      } catch { return }
      ws.onopen = () => {
        ws?.send(JSON.stringify({ type: 'auth', token }))
      }
      ws.onmessage = (ev) => {
        if (cancelled) return
        try {
          const data = JSON.parse(ev.data as string)
          const type = data.type as string
          if (type === 'grant_requested') {
            dispatch({ kind: 'grant_received', request: data as GrantRequestEvent })
          } else if (type === 'grant_resolved') {
            dispatch({ kind: 'grant_resolved', requestId: (data as GrantResolvedEvent).requestId })
          } else if (type === 'approval_requested') {
            const req = data as ApprovalRequestEvent
            // yolo 模式或本会话已记住同类：自动批准，不弹出审批条。
            const mode = apiRef.current?.state.approvalMode ?? 'user'
            if (mode === 'yolo' || sessionAutoApprove.current.has(req.category)) {
              void apiRef.current?.respondApproval(req.requestId, true).catch(() => {})
              return
            }
            dispatch({ kind: 'approval_received', request: req })
          }
        } catch { /* 非 JSON 消息忽略 */ }
      }
      ws.onclose = () => {
        if (!cancelled) reconnectTimer = setTimeout(connect, 2000)
      }
    }
    void connect()
    return () => {
      cancelled = true
      if (reconnectTimer) clearTimeout(reconnectTimer)
      try { ws?.close() } catch { /* ignore */ }
    }
  }, [restored, state.currentProjectId])

  const api = useMemo<StoreApi>(() => {
    const pushAssistant = (text: string, st?: AgentState) => {
      const now = Date.now()
      if (assistantNoticeRef.current.text === text && now - assistantNoticeRef.current.at < 2500) return
      assistantNoticeRef.current = { text, at: now }
      dispatch({ kind: 'assistant_msg', text, state: st })
    }

    // 统一的 TaskEvent → dispatch 处理：start 新建任务与 openTask 打开历史任务共用。
    const makeEventHandler = (taskId: string, title: string) => (event: TaskEvent) => {
      dispatch({ kind: 'event', event, taskId, title })
      if (event.type === 'done') {
        const current = clientRef.current
        if (current instanceof RealAgentClient && current.id === taskId) {
          void current.getSnapshot().then((task) => {
            if (clientRef.current === current && apiRef.current?.state.task?.taskId === taskId) dispatch({ kind: 'hydrate_task', task })
          }).catch(() => {})
        }
      }
      if (event.type === 'need_input') {
        const rounds = event.total ? `（第 ${event.round ?? 1}/${event.total} 轮）` : ''
        pushAssistant(`${event.question ?? '请补充信息'}${rounds}`)
      }
      if (event.type === 'plans_ready') pushAssistant('已生成三套差异化方案，正在沙箱执行与独立验证。', 'DESIGN')
      if (event.type === 'retry') pushAssistant('检测到可恢复错误，已归一化并按修复策略重试（最多 3 次）。', 'REPAIR')
      if (event.type === 'done' && event.message) pushAssistant(event.message)
      if (event.type === 'error') pushAssistant(event.message ?? '任务失败')

      // 阶段 7：打断机制——只在 step 边界（step_update 事件）切换，不中途中断函数执行。
      // 用户点击「立即执行」后置 interruptFlag=true；下一个 step_update 到达时取出 blocking 待办执行。
      const latest = apiRef.current?.state
      if (!latest) return
      if (event.type === 'step_update' && latest.interruptFlag) {
        // 取优先级最高（priority 最小）的 blocking 待办
        const blocking = latest.backlog
          .filter((item) => item.status === 'blocking')
          .sort((a, b) => a.priority - b.priority)[0]
        if (blocking) {
          // 标记为执行中
          dispatch({ kind: 'backlog_status', id: blocking.id, status: 'executing' })
          pushAssistant(`【待办打断】正在插队执行：${blocking.content}`, 'ITERATE')
          // 作为 feedback 发送给当前任务
          void apiRef.current?.feedback(blocking.content).catch(() => {
            pushAssistant(`待办「${blocking.content}」执行失败，已标记取消。`)
            dispatch({ kind: 'backlog_status', id: blocking.id, status: 'cancelled' })
            dispatch({ kind: 'interrupt_set', flag: false })
          })
        }
      }
      // 任务到达稳定态（PRESENT/ITERATE/COMPLETE/NEED_INPUT）时，若有待办正在执行则标记完成并清除打断标志。
      const stableStates: AgentState[] = ['PRESENT', 'ITERATE', 'COMPLETE', 'NEED_INPUT']
      if (event.state && stableStates.includes(event.state) && latest.interruptFlag) {
        const executing = latest.backlog.find((item) => item.status === 'executing')
        if (executing) {
          dispatch({ kind: 'backlog_status', id: executing.id, status: 'done' })
          dispatch({ kind: 'interrupt_set', flag: false })
          pushAssistant(`【待办完成】「${executing.content}」已执行完毕，原任务可继续。`)
        }
      }
    }

    // 解析项目/任务列表 API 所需的 baseUrl 与 token；后端不可用时返回 null（此时 GateBlock 已提示，不重复报错）。
    const resolveApiAuth = async (): Promise<{ baseUrl: string; token: string } | null> => {
      const gate = state.gate.status === 'available' ? state.gate : await probeGate()
      if (gate.status !== 'available') return null
      const host = getHostBridge()
      let runtimeCfg = localCfg
      // 所有资源使用同一运行时身份，包括网页测试服务和宿主 Agent。
      try { runtimeCfg = await readRuntimeConfig() } catch { runtimeCfg = localCfg }
      const baseUrl = gate.baseUrl || runtimeCfg.baseUrl || window.location.origin
      let token = runtimeCfg.token ?? ''
      if (!token && !host) {
        try {
          token = await getAnonymousToken(baseUrl)
        } catch { /* 匿名会话失败由门禁阻断页呈现 */ }
      }
      return { baseUrl, token }
    }

    // 带认证头的 JSON 请求封装：非 2xx 统一抛出含后端 message 的 Error，供 UI 可见反馈。
    const apiFetch = async (path: string, init?: RequestInit): Promise<any> => {
      const auth = await resolveApiAuth()
      if (!auth) throw new Error(getHostBridge() ? '本机 Agent 当前不可用' : '服务器绘图服务当前不可用，请联系管理员')
      const headers: Record<string, string> = {
        authorization: `Bearer ${auth.token}`,
        'x-agent-protocol': '1',
        ...((init?.headers as Record<string, string> | undefined) ?? {})
      }
      // 20s 硬超时：避免后端/网络挂起时 Promise 永不结束（如图库“加载中”永驻）。
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(), 20000)
      init?.signal?.addEventListener('abort', () => controller.abort(), { once: true })
      let res: Response
      try {
        res = await fetch(`${auth.baseUrl}${path}`, { ...init, headers, signal: controller.signal })
      } catch (e) {
        if ((e as Error).name === 'AbortError') throw new Error('请求超时（20 秒无响应），请稍后重试')
        throw e
      } finally {
        clearTimeout(timeoutId)
      }
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(json?.error?.message ?? `请求失败（HTTP ${res.status}）`)
      return json
    }

    return {
      state,
      client: clientRef,
      async start({ fileName, bytes, prompt, clarify, clarifyAnswers }) {
        if (!restored) return
        dispatch({ kind: 'start_error' })
        const host = getHostBridge()
        let runtimeCfg = localCfg
        {
          try {
            runtimeCfg = await readRuntimeConfig()
          } catch (error) {
            dispatch({ kind: 'start_error', message: `读取绘图服务配置失败：${error instanceof Error ? error.message : String(error)}` })
            return
          }
        }
        // 以最新真实门禁结果决定客户端，禁止生产业务路径静默实例化 Mock。
        const gate = await probeGate()
        dispatch({ kind: 'gate_result', gate })
        const realConfigured = runtimeCfg.enabled && !!runtimeCfg.baseUrl
        let client: RealAgentClient
        if (gate.status === 'available' && realConfigured) {
          let token = runtimeCfg.token ?? ''
          // 公网同源且无显式令牌：获取匿名会话；同一标签页内刷新时可恢复身份。
          if (!token && !host) {
            try {
              token = await getAnonymousToken(gate.baseUrl)
            } catch { /* 认证失败由后端门禁阻断页呈现 */ }
          }
          client = new RealAgentClient({ baseUrl: gate.baseUrl || runtimeCfg.baseUrl!, token, engine: state.activeEngine, projectId: state.currentProjectId || undefined })
        } else {
          dispatch({ kind: 'start_error', message: describeGateReason(gate.reason) })
          return
        }
        clientRef.current = client
        // 先做一次真实数据体检供侧栏展示；客户端运行时会在 INGEST 阶段再算一次（结果一致）。
        let dataset: DatasetProfile | undefined
        try {
          dataset = await buildProfile(fileName, bytes)
        } catch {
          dataset = undefined
        }
        let taskId = uid('task')
        if (client instanceof RealAgentClient) {
          // 真实后端：先创建任务拿到服务端 taskId，再订阅事件（连接即重放，不丢事件）
          try {
            const created = await client.start({ fileName, bytes, prompt, clarify, clarifyAnswers })
            taskId = created.taskId
          } catch (e) {
            dispatch({ kind: 'start_error', message: `创建任务失败：${e instanceof Error ? e.message : String(e)}` })
            return
          }
        }
        // 任务 id 定稿后再绑定事件处理（真实后端取服务端 id，Mock 用本地占位 id）。
        const handler = makeEventHandler(taskId, fileName)
        taskMeta.current = { id: taskId, title: fileName }
        dispatch({ kind: 'start', taskId, title: fileName, dataset })
        dispatch({ kind: 'user_msg', text: prompt || `（使用示例需求）分析 ${fileName}`, attachments: [fileName] })
        pushAssistant('已接收数据与需求，开始数据接入与意图解析，全过程可观察。', 'INGEST')
        // 新任务已创建到当前项目：后台刷新任务列表，使侧栏立即出现新条目。
        if (state.currentProjectId) void apiRef.current?.loadProjectTasks(state.currentProjectId).catch(() => {})
        if (client instanceof RealAgentClient) {
          client.subscribe(handler)
          void client.getPreferences().then(
            (prefs) => dispatch({ kind: 'preference_state', paused: prefs.paused, events: prefs.events }),
            (error) => {
              const message = `读取偏好设置失败：${error instanceof Error ? error.message : String(error)}`
              dispatch({ kind: 'projects_error', message })
              pushAssistant(`${message}；请检查项目连接后重试。`)
            }
          )
          void client.getColorProfile().then(
            (profile) => dispatch({ kind: 'color_profile', profile }),
            () => { /* 画像拉取失败不阻塞任务流程 */ }
          )
        }
      },
      answer(text) {
        const client = clientRef.current
        if (!client) { pushAssistant('后端连接未恢复，回答未提交。'); return }
        dispatch({ kind: 'user_msg', text })
        void Promise.resolve(client.answerQuestion(text)).catch((error) =>
          pushAssistant(`提交回答失败，请重试：${error instanceof Error ? error.message : String(error)}`))
      },
      choosePlan(plan) {
        const client = clientRef.current
        const done = () => {
          dispatch({ kind: 'select', planId: plan.plan_id })
          pushAssistant(`已选择「${plan.name}」，可在右侧检查器受控编辑，或继续提出修改。`)
        }
        if (!client) { pushAssistant('后端连接未恢复，暂不能选择方案。'); return }
        void client.selectPlan(plan).then(done, (error) => pushAssistant(`选择方案失败：${error instanceof Error ? error.message : String(error)}`))
      },
      rejectPlan(plan) {
        const client = clientRef.current
        const done = () => pushAssistant(`已将「${plan.name}」记为负向偏好，后续将降低类似方案排序。`)
        if (!client) { pushAssistant('后端连接未恢复，暂不能记录偏好。'); return }
        void client.rejectPlan(plan).then(done, (error) => pushAssistant(`记录负向偏好失败：${error instanceof Error ? error.message : String(error)}`))
      },
      async feedback(text) {
        if (!state.task) return
        if (feedbackInFlight.current) {
          pushAssistant('上一轮修改仍在执行，请等待验证完成后再提交新的反馈。')
          return
        }
        dispatch({ kind: 'user_msg', text })
        const client = clientRef.current
        if (!client) { pushAssistant('后端连接未恢复，反馈未提交。'); return }
        feedbackInFlight.current = true
        pushAssistant('正在提交修改并等待新的真实产物…')
        try {
          await client.feedback(text, state.task.selectedPlanId)
          pushAssistant('已提交反馈，正在重新规划、执行与验证。')
        } catch (error) {
          pushAssistant(`提交反馈失败，请重试：${error instanceof Error ? error.message : String(error)}`)
        } finally {
          feedbackInFlight.current = false
        }
      },
      async proposePatch(planId, patch) {
        const plan = state.task?.plans.find((p) => p.plan_id === planId)
        if (!plan) return
        const result = applySpecPatch(plan.spec, patch, state.activeEngine, plan.code[state.activeEngine])
        dispatch({ kind: 'propose_patch', pending: { planId, patch, result } })
        const client = clientRef.current
        if (client instanceof RealAgentClient) {
          try {
            const versions = state.task?.planVersions ?? []
            const parentVersion = state.task?.currentRevision ?? versions[versions.length - 1]?.version ?? 0
            const preview = await client.previewPatch(planId, parentVersion, patch)
            dispatch({ kind: 'patch_preview', preview })
          } catch (error) {
            dispatch({ kind: 'patch_error', message: error instanceof Error ? error.message : String(error) })
          }
        }
      },
      async acceptPatch() {
        const pp = state.pendingPatch
        if (!pp) return
        const client = clientRef.current
        if (!client || !pp.preview) {
          dispatch({ kind: 'patch_error', message: client ? '服务端补丁预览尚未就绪，请稍后重试' : '后端连接未恢复，补丁未应用' })
          return
        }
        dispatch({ kind: 'patch_applying' })
        try {
          await client.applyPatch(pp.preview.token)
          dispatch({ kind: 'hydrate_task', task: await client.getSnapshot() })
          dispatch({ kind: 'cancel_patch' })
          pushAssistant(`已应用「${pp.patch.label}」并通过真实执行与独立验证。`)
        } catch (error) {
          dispatch({ kind: 'patch_error', message: error instanceof Error ? error.message : String(error) })
        }
      },
      cancelPatch() {
        dispatch({ kind: 'cancel_patch' })
      },
      async saveSource(planId, engine, source) {
        const client = clientRef.current
        const task = state.task
        const plan = task?.plans.find((item) => item.plan_id === planId)
        if (!(client instanceof RealAgentClient) || !task || !plan) {
          pushAssistant('源码重跑需要连接真实 Agent，未执行修改。')
          return undefined
        }
        if (engine === 'matlab' && !getHostBridge()) {
          pushAssistant('网页端只生成 MATLAB 代码；请在桌面端或 VS Code 中使用本机授权 MATLAB 运行。')
          return undefined
        }
        const bytes = new TextEncoder().encode(plan.code[engine])
        const digest = await crypto.subtle.digest('SHA-256', bytes)
        const baseHash = Array.from(new Uint8Array(digest), (value) => value.toString(16).padStart(2, '0')).join('')
        const latest = await client.getSnapshot()
        if (latest.plans.find((item) => item.plan_id === planId)?.code[engine] !== plan.code[engine] || latest.dataset?.fingerprint !== task.dataset?.fingerprint) {
          throw new Error('源码或数据基线已变化，请保留草稿并重新打开当前任务。')
        }
        const versions = latest.planVersions ?? []
        const parentVersion = latest.currentRevision ?? versions[versions.length - 1]?.version ?? 0
        const preview = await client.previewSource({ planId, engine, parentVersion, baseHash, source })
        await client.applySource(preview.token)
        dispatch({ kind: 'hydrate_task', task: await client.getSnapshot() })
        // 优化5：编辑即重渲染——重跑完成后立即拉取该方案真实渲染 SVG，图表随之变化；
        // 拉取失败不清空旧图（保留上次通过图，避免“代码改了但图消失”）。
        try {
          const artifact = await client.getPreview(planId)
          dispatch({ kind: 'artifact_svg', svg: artifact.svg, planId, engine: artifact.engine })
        } catch { /* 预览拉取失败：保留旧图 */ }
        pushAssistant(preview.mode === 'spec'
          ? '源码修改已映射回 ChartSpec，并重新生成三引擎代码、执行和刷新图表。'
          : '源码修改无法安全逆向为 ChartSpec，已明确进入代码主导模式并重新执行、刷新图表。')
        return preview
      },
      exportArtifact(kind, options) {
        const client = clientRef.current
        if (!client) { pushAssistant('后端连接未恢复，未导出文件。'); return }
        void client.exportArtifact(kind, state.task?.selectedPlanId, options).then(
          () => dispatch({ kind: 'assistant_msg', text: '已导出复现 ZIP（三引擎源码、数据、ChartSpec、证据、真实渲染产物）。' }),
          (e) => dispatch({ kind: 'assistant_msg', text: `导出失败：${String(e?.message ?? e)}` })
        )
      },
      async saveCode(planId, engine, code) {
        const client = clientRef.current
        if (!client) throw new Error('后端连接未恢复，代码未保存')
        const task = await client.saveCode(planId, engine, code)
        dispatch({ kind: 'hydrate_task', task })
        dispatch({ kind: 'assistant_msg', text: `已保存 ${engine.toUpperCase()} 代码草稿。代码已标记为“待重新运行验证”，旧预览不会冒充新代码结果。` })
      },
      setView: (v) => dispatch({ kind: 'set_view', view: v }),
      setActivePlan: (id) => dispatch({ kind: 'set_active_plan', planId: id }),
      toggleConsole: (open) => dispatch({ kind: 'toggle_console', open }),
      setEngine: (e) => dispatch({ kind: 'set_engine', engine: e }),
      setLocation: (_l) => dispatch({ kind: 'set_location', location: getHostBridge() ? 'local' : 'remote' }),
      setColType: (index, type) => {
        const client = clientRef.current
        const column = state.task?.dataset?.columns[index]
        if (!client || !column) { pushAssistant('后端连接未恢复，列类型未修改。'); return }
        void client.previewData({ kind: 'type_override', field: column.name, type }).then(async (preview) => {
          const confirmed = !preview.requiresConfirmation || window.confirm(`${preview.risks.map((risk) => risk.message).join('\n')}\n\n确认后将重新计算统计、证据、三方案与图表。`)
          if (!confirmed) return
          await client.applyData(preview.token, true)
          dispatch({ kind: 'hydrate_task', task: await client.getSnapshot() })
          pushAssistant(`字段 ${column.name} 的类型已写入数据版本并完成重算。`)
        }, (error) => pushAssistant(`列类型修订失败：${error instanceof Error ? error.message : String(error)}`))
      },
      async replaceData(file) {
        const client = clientRef.current
        if (!(client instanceof RealAgentClient)) throw new Error('数据替换需要连接真实 Agent')
        const bytes = new Uint8Array(await file.arrayBuffer())
        let binary = ''
        for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000))
        const preview = await client.previewData({ kind: 'replace', fileName: file.name, contentBase64: btoa(binary) })
        const confirmed = !preview.requiresConfirmation || window.confirm(`${preview.risks.map((risk) => risk.message).join('\n')}\n\n确认替换并保留旧版本？`)
        if (!confirmed) return
        await client.applyData(preview.token, true)
        dispatch({ kind: 'hydrate_task', task: await client.getSnapshot() })
        pushAssistant('数据已替换；旧图保留并标记为基于旧数据，新统计、证据和方案已完成。')
      },
      async applyStylePreset(planId, presetId) {
        const client = clientRef.current
        const task = state.task
        if (!(client instanceof RealAgentClient) || !task) throw new Error('样式预设需要连接真实 Agent')
        const versions = task.planVersions ?? []
        await client.applyStylePreset(planId, presetId, task.currentRevision ?? versions[versions.length - 1]?.version ?? 0)
        dispatch({ kind: 'hydrate_task', task: await client.getSnapshot() })
        pushAssistant('科研样式预设已作为可撤销修订应用，并通过重新执行验证。')
      },
      async undoRevision() {
        const client = clientRef.current
        if (!(client instanceof RealAgentClient)) throw new Error('撤销需要连接真实 Agent')
        await client.revertPatch()
        dispatch({ kind: 'hydrate_task', task: await client.getSnapshot() })
        pushAssistant('已撤销到父修订，历史版本仍完整保留。')
      },
      clearPrefs: () => {
        const client = clientRef.current
        if (!client) { pushAssistant('后端连接未恢复，偏好未清空。'); return }
        void client.clearPreferences().then(
          (prefs) => dispatch({ kind: 'preference_state', paused: prefs.paused, events: prefs.events }),
          (error) => pushAssistant(`清空偏好失败：${error instanceof Error ? error.message : String(error)}`)
        )
      },
      setPreferencePaused: (paused) => {
        const client = clientRef.current
        if (!client) { pushAssistant('后端连接未恢复，偏好设置未更新。'); return }
        void client.setPreferencePaused(paused).then(
          (prefs) => dispatch({ kind: 'preference_state', paused: prefs.paused, events: prefs.events }),
          (error) => pushAssistant(`更新偏好设置失败：${error instanceof Error ? error.message : String(error)}`)
        )
      },
      revertPreference: (eventId) => {
        const client = clientRef.current
        if (!(client instanceof RealAgentClient)) return
        void client.revertPreference(eventId).then(async () => {
          const prefs = await client.getPreferences()
          dispatch({ kind: 'preference_state', paused: prefs.paused, events: prefs.events })
          // 撤销即遗忘：同步刷新配色学习画像（reverted 事件不再参与重建）
          await apiRef.current?.loadColorProfile().catch(() => {})
        }, (error) => pushAssistant(`撤销偏好失败：${error instanceof Error ? error.message : String(error)}`))
      },
      // v0.4.0 优化：拉取配色学习画像（学习摘要/逐色板统计），供偏好面板展示“为什么推荐这个色板”。
      async loadColorProfile() {
        const client = clientRef.current
        if (!(client instanceof RealAgentClient)) return
        dispatch({ kind: 'color_profile', profile: null, loading: true })
        try {
          const profile = await client.getColorProfile()
          dispatch({ kind: 'color_profile', profile, loading: false })
        } catch (error) {
          dispatch({ kind: 'color_profile', profile: null, loading: false })
          pushAssistant(`读取配色学习画像失败：${error instanceof Error ? error.message : String(error)}`)
        }
      },
      // v0.4.0 优化：重置配色学习画像（仅清配色事件，保留图型/排版等其他偏好）。
      resetColorPreferences: () => {
        const client = clientRef.current
        if (!(client instanceof RealAgentClient)) { pushAssistant('后端连接未恢复，配色学习未重置。'); return }
        if (!window.confirm('确认重置配色学习画像？将遗忘所有历史配色偏好（含已撤销的），图型/排版等其他偏好保留。')) return
        void client.resetColorPreferences().then(async (prefs) => {
          dispatch({ kind: 'preference_state', paused: prefs.paused, events: prefs.events })
          const profile = await client.getColorProfile()
          dispatch({ kind: 'color_profile', profile })
          pushAssistant('配色学习画像已重置：后续推荐将不再受历史配色偏好影响，可重新学习。')
        }, (error) => pushAssistant(`重置配色学习失败：${error instanceof Error ? error.message : String(error)}`))
      },
      newTask() {
        clientRef.current?.detach()
        clientRef.current = null
        dispatch({ kind: 'clear_task' })
      },
      async retryTask(prompt) {
        const current = clientRef.current
        if (!(current instanceof RealAgentClient)) throw new Error('请先恢复 Agent 连接再重试')
        const result = await current.retry(prompt)
        await apiRef.current?.openTask(result.taskId, result.projectId)
        await apiRef.current?.loadProjectTasks(result.projectId)
      },
      cancelRun: () => {
        const client = clientRef.current
        if (!client) { pushAssistant('后端连接未恢复，取消请求未提交。'); return }
        const finish = () => {
          dispatch({ kind: 'cancel_run' })
          dispatch({ kind: 'assistant_msg', text: '已取消运行；已完成的步骤、数据体检与中间结果均保留。' })
        }
        void client.cancel().then(finish, (error) => pushAssistant(`取消任务失败：${error instanceof Error ? error.message : String(error)}`))
      },
      async refreshGate() {
        const result = await probeGate()
        dispatch({ kind: 'gate_result', gate: result })
      },
      dismissStartError: () => dispatch({ kind: 'start_error' }),
      async reset() {
        // 先真实通知后端删除任务（含原始 data.csv），再清空本地视图；删除失败不得静默。
        const projectId = state.currentProjectId
        if (state.task && !clientRef.current) {
          pushAssistant('后端连接未恢复，任务和数据未删除；请重新连接后重试。')
          return
        }
        try {
          await clientRef.current?.deleteTask()
        } catch (error) {
          // 保留任务与客户端，使用户能重试删除，不伪称服务端数据已经清理。
          pushAssistant(`服务端删除失败，任务和数据仍保留，请稍后重试：${error instanceof Error ? error.message : String(error)}`)
          return
        }
        clientRef.current = null
        dispatch({ kind: 'reset' })
        // 删除当前任务后刷新项目任务列表，使侧栏移除该条目。
        if (projectId) void apiRef.current?.loadProjectTasks(projectId).catch(() => {})
      },
      // ---------- 阶段 2：项目与任务列表 ----------
      async loadProjects() {
        let list: ProjectSummary[]
        try {
          list = (await apiFetch('/api/projects')).projects ?? []
        } catch {
          // 后端不可用（GateBlock 已呈现）或拉取失败：不向用户重复弹错，保持空列表。
          return
        }
        // 兜底：理论上后端启动时自动创建 proj_default；若列表为空则创建默认项目。
        if (list.length === 0) {
          try {
            const created = await apiFetch('/api/projects', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ name: '默认项目' })
            })
            list = [created.project]
          } catch { /* 兜底创建失败保持空列表 */ }
        }
        dispatch({ kind: 'projects_loaded', projects: list })
        // 选中当前已选项目（若仍存在），否则选中第一个；随后加载其任务列表。
        const selected = apiRef.current?.state.currentProjectId || state.currentProjectId
        const target = list.find((p) => p.projectId === selected) ?? list[0]
        if (target) {
          if (target.projectId !== selected) dispatch({ kind: 'set_project', projectId: target.projectId })
          await apiRef.current?.loadProjectTasks(target.projectId)
        }
      },
      async createProject(name, description) {
        const json = await apiFetch('/api/projects', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ name, ...(description ? { description } : {}) })
        })
        const project = json.project as ProjectSummary
        dispatch({ kind: 'project_created', project })
        await apiRef.current?.selectProject(project.projectId)
        return project
      },
      async renameProject(projectId, name, description) {
        await apiFetch(`/api/projects/${encodeURIComponent(projectId)}`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ ...(name ? { name } : {}), ...(description !== undefined ? { description } : {}) })
        })
        // 同步更新本地项目列表，避免重命名后下拉仍显示旧名。
        const updated = state.projects.map((p) =>
          p.projectId === projectId
            ? { ...p, name: name ?? p.name, ...(description !== undefined ? { description } : {}) }
            : p
        )
        dispatch({ kind: 'projects_loaded', projects: updated })
      },
      // 项目上云：调用 /api/projects/:id/cloud（含 300 MB 配额校验与数据镜像），成功后刷新项目列表。
      async cloudSyncProject(projectId) {
        await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/cloud`, { method: 'POST' })
        await apiRef.current?.loadProjects()
      },
      async selectProject(projectId) {
        if (projectId === state.currentProjectId && state.task) return
        // 切换项目：切换选中、清空当前任务视图并 detach 旧连接（不删除后端任务），防止跨项目数据泄漏。
        try { (clientRef.current instanceof RealAgentClient ? clientRef.current.detach() : undefined) } catch { /* Mock 无 detach，忽略 */ }
        clientRef.current = null
        dispatch({ kind: 'set_project', projectId })
        dispatch({ kind: 'clear_task' })
        dispatch({ kind: 'set_view', view: 'chat' })
        await apiRef.current?.loadProjectTasks(projectId)
      },
      async loadProjectTasks(projectId) {
        try {
          const json = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/tasks`)
          dispatch({ kind: 'project_tasks_loaded', projectId, tasks: json.tasks ?? [] })
        } catch (error) {
          dispatch({ kind: 'projects_error', message: `加载任务列表失败：${error instanceof Error ? error.message : String(error)}` })
        }
      },
      async deleteProjectTask(projectId, taskId) {
        await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(taskId)}`, { method: 'DELETE' })
        // 若删除的正是当前打开的任务，清空视图并回到上传入口。
        if (state.task?.taskId === taskId) {
          try { (clientRef.current instanceof RealAgentClient ? clientRef.current.detach() : undefined) } catch { /* ignore */ }
          clientRef.current = null
          dispatch({ kind: 'clear_task' })
        }
        await apiRef.current?.loadProjectTasks(projectId)
      },
      async openTask(taskId, targetProjectId) {
        const projectId = targetProjectId ?? state.currentProjectId
        if (!projectId) return
        // detach 旧任务连接（不取消后端任务），再按项目重新建立客户端并恢复该任务快照。
        try { (clientRef.current instanceof RealAgentClient ? clientRef.current.detach() : undefined) } catch { /* ignore */ }
        const host = getHostBridge()
        let runtimeCfg = localCfg
        try { runtimeCfg = await readRuntimeConfig() } catch { runtimeCfg = localCfg }
        const gate = await probeGate()
        if (gate.status !== 'available') {
          dispatch({ kind: 'projects_error', message: describeGateReason(gate.reason) })
          return
        }
        let token = runtimeCfg.token ?? ''
        if (!token && !host) {
          try {
            token = await getAnonymousToken(gate.baseUrl || runtimeCfg.baseUrl!)
          } catch { /* ignore */ }
        }
        const client = new RealAgentClient({
          baseUrl: gate.baseUrl || runtimeCfg.baseUrl!,
          token,
          engine: state.activeEngine,
          projectId
        })
        client.resume(taskId)
        clientRef.current = client
        const task = await client.getSnapshot()
        dispatch({ kind: 'set_project', projectId })
        taskMeta.current = { id: taskId, title: task.title }
        dispatch({ kind: 'hydrate_task', task })
        dispatch({ kind: 'set_view', view: 'chat' })
        client.subscribe(makeEventHandler(taskId, task.title))
        void client.getPreferences().then(
          (prefs) => dispatch({ kind: 'preference_state', paused: prefs.paused, events: prefs.events }),
          (error) => {
            const message = `读取偏好设置失败：${error instanceof Error ? error.message : String(error)}`
            dispatch({ kind: 'projects_error', message })
            pushAssistant(`${message}；请检查项目连接后重试。`)
          }
        )
        void client.getColorProfile().then(
          (profile) => dispatch({ kind: 'color_profile', profile }),
          () => { /* 画像拉取失败不阻塞任务恢复 */ }
        )
      },
      startNewTask() {
        // 回到上传入口（不删除后端已有任务）：detach 当前连接并清空任务视图。
        try { (clientRef.current instanceof RealAgentClient ? clientRef.current.detach() : undefined) } catch { /* ignore */ }
        clientRef.current = null
        dispatch({ kind: 'clear_task' })
        dispatch({ kind: 'set_view', view: 'chat' })
      },
      // ---------- 阶段 3：批量拆分 ----------
      async requestBatchSplit(files: File[]) {
        const pid = state.currentProjectId
        if (!pid) throw new Error('请先选择项目再批量上传')
        const auth = await resolveApiAuth()
        if (!auth) throw new Error('后端当前不可用，请先启动绘图服务')
        const form = new FormData()
        for (const f of files) form.append('files', f, f.name)
        const res = await fetch(`${auth.baseUrl}/api/projects/${encodeURIComponent(pid)}/tasks/batch`, {
          method: 'POST',
          headers: { authorization: `Bearer ${auth.token}`, 'x-agent-protocol': '1' },
          body: form
        })
        const json = await res.json().catch(() => ({}))
        if (!res.ok) throw new Error(json?.error?.message ?? `批量拆分请求失败（HTTP ${res.status}）`)
        return json as BatchSplitResult
      },
      async confirmBatchSplit(groups: BatchConfirmGroup[]) {
        const pid = state.currentProjectId
        if (!pid) throw new Error('请先选择项目')
        const json = await apiFetch(`/api/projects/${encodeURIComponent(pid)}/tasks/batch/confirm`, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ groups })
        })
        void apiRef.current?.loadProjectTasks(pid).catch(() => {})
        return json as BatchConfirmResult
      },
      // ---------- 阶段 4：项目偏好 ----------
      async loadProjectPreferences() {
        const pid = state.currentProjectId
        if (!pid) return
        try {
          const json = await apiFetch(`/api/projects/${encodeURIComponent(pid)}/preferences`)
          dispatch({ kind: 'project_preferences_loaded', data: json as ProjectPreferencesResponse })
        } catch (error) {
          const message = `项目偏好加载失败：${error instanceof Error ? error.message : String(error)}`
          dispatch({ kind: 'projects_error', message })
          pushAssistant(`${message}；当前任务仍可继续，但不会继承项目默认设置。`)
        }
      },
      async updateProjectPreferences(patch: ProjectPreferences) {
        const pid = state.currentProjectId
        if (!pid) throw new Error('请先选择项目')
        const json = await apiFetch(`/api/projects/${encodeURIComponent(pid)}/preferences`, {
          method: 'PUT',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(patch)
        })
        dispatch({ kind: 'project_preferences_updated', preferences: (json?.preferences as ProjectPreferences) ?? patch })
      },
      async setCurrentTaskAsProjectDefault() {
        const plan = state.task?.plans.find((p) => p.plan_id === state.activePlanId) ?? state.task?.plans[0]
        if (!plan) throw new Error('当前任务尚无方案，无法提取样式作为默认')
        const patch: ProjectPreferences = {
          font: plan.spec.figure.fontFamily,
          dpi: plan.spec.figure.dpi,
          ...(plan.palette?.id ? { colorPalette: plan.palette.id } : {})
        }
        await apiRef.current?.updateProjectPreferences(patch)
        pushAssistant('已将当前任务的配色 / 字体 / DPI 写为项目默认，后续新任务将继承。')
      },
      // ---------- 阶段 5：授权 ----------
      async loadGrants() {
        const pid = state.currentProjectId
        if (!pid) return
        try {
          const json = await apiFetch(`/api/projects/${encodeURIComponent(pid)}/grants`)
          dispatch({ kind: 'grants_loaded', grants: (json?.grants as GrantRecord[]) ?? [] })
        } catch { /* 静默 */ }
      },
      async resolveGrant(requestId: string, approved: boolean, scope: GrantScope) {
        const pid = state.currentProjectId
        const pending = state.pendingGrant
        if (!pending || pending.requestId !== requestId) return
        if (approved && pid) {
          try {
            await apiFetch(`/api/projects/${encodeURIComponent(pid)}/grants`, {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ fromTaskId: pending.fromTaskId, toTaskId: pending.toTaskId, fields: pending.fields, scope })
            })
          } catch (e) {
            pushAssistant(`创建授权记录失败：${e instanceof Error ? e.message : String(e)}`)
          }
        }
        try {
          await apiFetch(`/api/projects/${encodeURIComponent(pid)}/grants/resolve`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ requestId, approved, scope })
          })
        } catch { /* resolve 端点失败不阻塞 UI 关闭 */ }
        dispatch({ kind: 'grant_resolved', requestId })
        void apiRef.current?.loadGrants().catch(() => {})
      },
      // ---------- 阶段 6：审批 ----------
      async loadApprovalMode() {
        try {
          const json = await apiFetch('/api/approval/mode')
          if (json?.mode) dispatch({ kind: 'approval_mode_loaded', mode: json.mode as ApprovalMode })
        } catch { /* 后端未就绪时保持 user 默认 */ }
      },
      async setApprovalMode(mode: ApprovalMode) {
        dispatch({ kind: 'approval_mode_set', mode })
        try {
          await apiFetch('/api/approval/mode', {
            method: 'PUT',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ mode })
          })
        } catch (e) {
          pushAssistant(`切换审批模式失败：${e instanceof Error ? e.message : String(e)}`)
          throw e
        }
      },
      async respondApproval(requestId: string, approved: boolean, oncePerSession?: boolean) {
        const req = state.pendingApprovals.find((r) => r.requestId === requestId)
        if (oncePerSession && req) sessionAutoApprove.current.add(req.category)
        try {
          await apiFetch(`/api/tasks/${encodeURIComponent(req?.taskId ?? '')}/approval/${encodeURIComponent(requestId)}`, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ approved })
          })
        } catch (e) {
          pushAssistant(`提交审批结果失败：${e instanceof Error ? e.message : String(e)}`)
        }
        dispatch({ kind: 'approval_resolved', requestId })
      },
      // ---------- 阶段 7：待办队列 ----------
      addToBacklog(content: string, attachments?: string[]) {
        const trimmed = content.trim()
        if (!trimmed) return
        const item: BacklogItem = {
          id: uid('backlog'),
          projectId: state.currentProjectId,
          taskId: state.task?.taskId ?? '',
          content: trimmed,
          attachments: attachments ?? [],
          status: 'queued',
          createdAt: Date.now(),
          priority: state.backlog.length
        }
        dispatch({ kind: 'backlog_add', item })
        pushAssistant(`已加入待办队列：${trimmed}`)
      },
      executeBacklogItem(id: string) {
        const item = state.backlog.find((b) => b.id === id)
        if (!item) return
        // 排队中 → blocking：设置打断标志，等待下一个 step 边界执行。
        dispatch({ kind: 'backlog_status', id, status: 'blocking' })
        dispatch({ kind: 'interrupt_set', flag: true })
        // 如果当前没有运行中的任务（空闲状态），立即作为 feedback 发送，不必等 step_update。
        if (!state.running && state.task) {
          dispatch({ kind: 'backlog_status', id, status: 'executing' })
          pushAssistant(`【待办执行】${item.content}`, 'ITERATE')
          void apiRef.current?.feedback(item.content).then(() => {
            dispatch({ kind: 'backlog_status', id, status: 'done' })
            dispatch({ kind: 'interrupt_set', flag: false })
          }, () => {
            dispatch({ kind: 'backlog_status', id, status: 'cancelled' })
            dispatch({ kind: 'interrupt_set', flag: false })
            pushAssistant(`待办「${item.content}」执行失败。`)
          })
        } else {
          pushAssistant(`已设置插队：将在当前步骤结束后执行「${item.content}」。`)
        }
      },
      removeBacklogItem(id: string) {
        dispatch({ kind: 'backlog_status', id, status: 'cancelled' })
      },
      reorderBacklog(id: string, direction: 'up' | 'down') {
        dispatch({ kind: 'backlog_reorder', id, direction })
      },
      clearBacklog() {
        if (!window.confirm('确认清空排队中的待办？（执行中和已完成的待办将保留）')) return
        dispatch({ kind: 'backlog_clear' })
      },
      // ---------- 阶段 8：项目图库 ----------
      // 遍历项目内所有任务，逐个拉取详情（含 plans），聚合为图表卡片；
      // 已渲染出产物的方案后台补真实 SVG，其余用 ChartPreview 占位。整体异步，不阻塞 UI。
      async loadGalleryCharts(projectId: string) {
        dispatch({ kind: 'gallery_loading' })
        const charts: GalleryChart[] = []
        // 仅对已有渲染产物元数据（planArtifacts）的方案发起预览请求，避免 N+1。
        const pendingSvg: { chartId: string; projectId: string; taskId: string; planId: string }[] = []
        try {
          const auth = await resolveApiAuth()
          if (auth) {
            // 真实后端：先取任务列表，再逐个拉任务详情收集 plans。
            const listJson = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/tasks`)
            const tasks: TaskSummary[] = listJson.tasks ?? []
            for (const t of tasks) {
              let detail: AgentTask | null = null
              try {
                const detailJson = await apiFetch(`/api/projects/${encodeURIComponent(projectId)}/tasks/${encodeURIComponent(t.taskId)}`)
                detail = (detailJson.task ?? detailJson) as AgentTask
              } catch { continue /* 单个任务失败不阻塞整个图库 */ }
              for (const plan of detail?.plans ?? []) {
                const kind = plan.chartType || plan.spec.panels[0]?.layers[0]?.kind || 'line'
                const chartId = `${t.taskId}:${plan.plan_id}`
                charts.push({
                  id: chartId,
                  taskId: t.taskId,
                  taskTitle: detail?.title ?? t.title,
                  planId: plan.plan_id,
                  chartType: kind,
                  plan,
                  createdAt: detail?.createdAt ?? t.createdAt
                })
                if (detail?.planArtifacts?.[plan.plan_id]) {
                  pendingSvg.push({ chartId, projectId, taskId: t.taskId, planId: plan.plan_id })
                }
              }
            }
          } else {
            // 后端不可用（含开发态 Mock 演示）：用当前任务 plans 生成卡片，不伪造真实 SVG。
            const task = state.task
            if (task) {
              for (const plan of task.plans) {
                const kind = plan.chartType || plan.spec.panels[0]?.layers[0]?.kind || 'line'
                charts.push({
                  id: `${task.taskId}:${plan.plan_id}`,
                  taskId: task.taskId,
                  taskTitle: task.title,
                  planId: plan.plan_id,
                  chartType: kind,
                  plan,
                  createdAt: task.createdAt
                })
              }
            }
          }
          dispatch({ kind: 'gallery_loaded', charts })
        } catch (e) {
          dispatch({ kind: 'gallery_error', message: e instanceof Error ? e.message : String(e) })
          return
        }
        // 后台并发补全真实 SVG；单个失败回退 ChartPreview 占位，不影响网格展示。
        if (pendingSvg.length === 0) return
        try {
          const settled = await Promise.allSettled(
            pendingSvg.map((item) =>
              apiFetch(`/api/projects/${encodeURIComponent(item.projectId)}/tasks/${encodeURIComponent(item.taskId)}/preview?planId=${encodeURIComponent(item.planId)}`)
                .then((json) => ({ chartId: item.chartId, svg: (json as { svg?: string }).svg }))
            )
          )
          const svgMap = new Map<string, string>()
          for (const s of settled) {
            if (s.status === 'fulfilled' && s.value.svg) svgMap.set(s.value.chartId, s.value.svg)
          }
          if (svgMap.size === 0) return
          dispatch({ kind: 'gallery_loaded', charts: charts.map((c) => (svgMap.has(c.id) ? { ...c, svg: svgMap.get(c.id) } : c)) })
        } catch { /* 补图失败保持 ChartPreview 占位 */ }
      },
      setGalleryFilter: (filter) => dispatch({ kind: 'gallery_set_filter', filter }),
      async fetchPlanPreview(taskId, planId) {
        try {
          const json = await apiFetch(`/api/tasks/${encodeURIComponent(taskId)}/preview?planId=${encodeURIComponent(planId)}`)
          return (json as { svg?: string }).svg ?? null
        } catch {
          return null
        }
      }
    }
  }, [state, restored])

  apiRef.current = api

  return <Ctx.Provider value={api}>{restored ? children : <div style={{ padding: 24 }}>正在读取已保存的记录…</div>}</Ctx.Provider>
}

export function useStore(): StoreApi {
  const ctx = useContext(Ctx)
  if (!ctx) throw new Error('useStore must be used within StoreProvider')
  return ctx
}

export type { DiffLine, LogLine }
