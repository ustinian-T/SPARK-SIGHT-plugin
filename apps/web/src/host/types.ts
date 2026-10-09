import type { EngineKind } from '../types'

/**
 * 宿主运行协议版本号
 * v2：在 v1 基础上引入通用多语言运行时（discover / plan / run / events / cancel / openArtifact）
 */
export const HOST_PROTOCOL_VERSION = 2 as const

/**
 * 宿主消息类型清单
 * v1 消息全部保留以兼容旧调用路径；runtime.runMatlab 已在 v2 中被通用 runtime.run 取代，标记为 deprecated。
 */
export const HOST_MESSAGE_TYPES = [
  'agent.config',
  'diff.open',
  'selection.read',
  'patch.apply',
  'patch.applyHunks',
  'plans.compare',
  'text.insert',
  'diagnostic.reveal',
  'edit.undo',
  'handoff.write',
  'runtime.capabilities',
  'runtime.runMatlab',
  // ===== v2 新增：通用多语言运行时协议 =====
  'runtime.discover',
  'runtime.plan',
  'runtime.run',
  'runtime.events',
  'runtime.cancel',
  'runtime.openArtifact'
] as const

export type HostMessageType = (typeof HOST_MESSAGE_TYPES)[number]

export interface HostMessage<T = unknown> {
  version: typeof HOST_PROTOCOL_VERSION
  id: string
  type: HostMessageType
  payload: T
}

export interface HostResponse<T = unknown> {
  version: typeof HOST_PROTOCOL_VERSION
  id: string
  ok: boolean
  result?: T
  error?: { code: string; message: string }
}

export interface HostTransport {
  request(message: HostMessage): Promise<unknown>
}

export interface HostAgentConfig {
  baseUrl: string
  token: string
  engine?: EngineKind
}

export interface HostDiffRequest {
  uri: string
  originalText: string
  proposedText: string
  title?: string
}

export interface HostSelection {
  uri: string
  text: string
  languageId?: string
  startLine?: number
  endLine?: number
}

export interface HostPatchRequest {
  uri: string
  baseHash: string
  proposedText: string
  label?: string
}

export interface HostPatchResult {
  applied: boolean
  reviewOpened: boolean
}

/**
 * 宿主能力（v1 保留）
 * 描述的是 Web 宿主壳（浏览器 / Tauri / VSCode 插件）本身提供的能力，
 * 与 v2 中的 RuntimeCapability（多语言运行时）是两个维度。
 */
export interface HostCapabilities {
  host: 'browser' | 'tauri' | 'vscode'
  openDiff: boolean
  readSelection: boolean
  applyPatch: boolean
  runMatlab?: boolean
  projects?: boolean
  credentialStore?: 'os'
}

// ==========================================================================
// v2 通用多语言运行时协议
// ==========================================================================

/** 受支持的脚本语言 */
export type RuntimeLanguage = 'python' | 'r' | 'matlab' | 'julia' | 'node'

/** 运行时来源：内置随产品分发 / 系统已装 / VSCode 插件提供 / 远程后端 */
export type RuntimeSource = 'bundled' | 'system' | 'vscode-extension' | 'remote'

/**
 * 沙箱等级：
 *  - generated-only：仅允许执行由 Agent 生成的脚本，禁止访问系统解释器任意参数
 *  - strong：强沙箱，隔离文件系统与网络
 *  - host-trusted：完全信任宿主环境
 */
export type SandboxLevel = 'generated-only' | 'strong' | 'host-trusted'

/**
 * 描述一个可用的多语言运行时能力。
 * 注意：executable 仅在宿主内部使用，跨进程/跨端公开响应中必须置空字符串，
 * 不得暴露绝对路径。
 */
export interface RuntimeCapability {
  /** 稳定的 runtime id，供后续 plan/run 引用 */
  id: string
  /** 该运行时对应的语言 */
  language: RuntimeLanguage
  /** 运行时来源 */
  source: RuntimeSource
  /** 解释器可执行路径（仅内部使用，公开响应中置空） */
  executable: string
  /** 解释器版本，不可探测时为 null */
  version: string | null
  /** 已安装包清单：包名 → 版本号；false 表示已安装但版本未知 */
  packages: Record<string, string | false>
  /** 当前是否可被调用执行 */
  canRun: boolean
  /** 当前是否允许安装新包 */
  canInstall: boolean
  /** 沙箱等级 */
  sandboxLevel: SandboxLevel
  /** 不可用/受限的诚实原因（canRun=false 或 canInstall=false 时建议给出） */
  reason?: string
}

/** runtime.plan 请求体：描述希望宿主执行的脚本运行计划 */
export interface RuntimePlanRequest {
  /** 目标 runtime id（来自 discoverRuntimes） */
  runtimeId: string
  /** 待执行脚本路径（宿主工作区内相对/绝对路径） */
  scriptPath: string
  /** 工作目录 */
  workDir: string
  /** 命令行参数 */
  args: string[]
  /** 允许从宿主透传的环境变量白名单 */
  envWhitelist: string[]
  /** 预期产出的相对路径清单（供事后校验） */
  expectedArtifacts: string[]
}

/** runtime.plan 响应体：宿主给出的、经安全审查后的执行计划 */
export interface RuntimePlan {
  /** 计划 id，后续 run 时引用 */
  planId: string
  runtimeId: string
  language: RuntimeLanguage
  /** 拼接好的完整命令 argv */
  command: string[]
  workDir: string
  /** 实际允许透传的环境变量键值对（已按白名单过滤） */
  envAllowed: Record<string, string>
  expectedArtifacts: string[]
  /** 脚本源文件哈希，用于事后校验未被篡改 */
  sourceHash: string
  /** 给用户/Agent 的人工审查备注 */
  reviewNotes: string[]
}

/** runtime.run 请求体：可以直接传 planId，也可以传完整 plan 对象（宿主自行校验一致性） */
export type RuntimeRunRequest =
  | { planId: string }
  | { plan: RuntimePlan }

/** runtime.run 响应体 */
export interface RuntimeRunResponse {
  runId: string
}

/** runtime.events 中逐条事件的类型 */
export type RuntimeEventType = 'stdout' | 'stderr' | 'diagnostic' | 'phase' | 'resource' | 'artifact'

/** runtime.events 中的单条事件 */
export interface RuntimeEvent {
  type: RuntimeEventType
  timestamp: number
  data: unknown
}

/** 运行状态机 */
export type RuntimeRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

/** runtime.events 响应体：当前运行状态 + 增量/全量事件流 + 完整性指纹 */
export interface RuntimeEventsResponse {
  runId: string
  status: RuntimeRunStatus
  events: RuntimeEvent[]
  /** 进程退出码；未结束时为 null */
  exitCode: number | null
  /** 运行时指纹（解释器路径哈希等），用于事后审计 */
  runtimeFingerprint?: string
  /** 实际执行脚本的源哈希，应与 plan.sourceHash 一致 */
  sourceHash?: string
  /** 产出文件哈希，用于校验产物完整性 */
  dataHash?: string
  /** 实际依赖快照（包名 → 版本 / false） */
  dependencySnapshot?: Record<string, string | false>
}

/** runtime.cancel 请求体 */
export interface RuntimeCancelRequest {
  runId: string
}

/** runtime.cancel 响应体 */
export interface RuntimeCancelResponse {
  runId: string
  cancelled: boolean
}

/** runtime.openArtifact 请求体：请求宿主用系统默认方式打开产物 */
export interface RuntimeOpenArtifactRequest {
  runId: string
  artifactPath: string
}

/** runtime.openArtifact 响应体 */
export interface RuntimeOpenArtifactResponse {
  opened: boolean
  path: string
}

/**
 * 宿主桥接接口
 * 在 v1 接口基础上追加 v2 通用运行时方法；runMatlab 保留但已废弃。
 */
export interface HostBridge {
  getAgentConfig(): Promise<HostAgentConfig>
  openDiff(input: HostDiffRequest): Promise<void>
  readSelection(): Promise<HostSelection | null>
  applyPatch(input: HostPatchRequest): Promise<HostPatchResult>
  getRuntimeCapabilities(): Promise<HostCapabilities>
  /** @deprecated v2 起请使用 discoverRuntimes / planRuntime / runRuntime 通用流程 */
  runMatlab(input: { projectRoot: string; scriptPath: string; executable?: string; timeoutSeconds?: number }): Promise<{ ok: boolean; scriptPath: string; output: string }>
  receive(value: unknown): Promise<HostMessage>

  // ===== v2 通用多语言运行时 =====
  /** 枚举当前宿主可见的全部多语言运行时（公开响应中 executable 已被剥离） */
  discoverRuntimes(): Promise<RuntimeCapability[]>
  /** 提交一份脚本执行计划，由宿主做路径/沙箱/白名单审查后返回 planId */
  planRuntime(input: RuntimePlanRequest): Promise<RuntimePlan>
  /** 依据 planId 或完整 plan 启动一次运行，返回 runId */
  runRuntime(input: RuntimeRunRequest): Promise<RuntimeRunResponse>
  /** 拉取指定 run 的事件流与最终状态（含完整性指纹） */
  getRuntimeEvents(runId: string): Promise<RuntimeEventsResponse>
  /** 请求取消一次仍在运行的任务 */
  cancelRuntime(runId: string): Promise<RuntimeCancelResponse>
  /** 请求宿主用系统默认程序打开某次运行产出的 artifact */
  openArtifact(input: RuntimeOpenArtifactRequest): Promise<RuntimeOpenArtifactResponse>
}

declare global {
  interface Window {
    __DEEP_IMAGING_HOST__?: HostBridge
    __TAURI__?: { core?: { invoke?: (command: string, args?: Record<string, unknown>) => Promise<unknown> } }
  }
}
