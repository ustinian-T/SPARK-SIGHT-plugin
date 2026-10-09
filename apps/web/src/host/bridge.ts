import {
  HOST_MESSAGE_TYPES,
  HOST_PROTOCOL_VERSION,
  type HostAgentConfig,
  type HostBridge,
  type HostCapabilities,
  type HostDiffRequest,
  type HostMessage,
  type HostPatchRequest,
  type HostPatchResult,
  type HostResponse,
  type HostSelection,
  type HostTransport,
  type RuntimeCancelResponse,
  type RuntimeCapability,
  type RuntimeEventsResponse,
  type RuntimeOpenArtifactRequest,
  type RuntimeOpenArtifactResponse,
  type RuntimePlan,
  type RuntimePlanRequest,
  type RuntimeRunRequest,
  type RuntimeRunResponse
} from './types'
import { registerTauriFileEvents } from './tauriEvents'

function codedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

/**
 * 校验一条入站 host message 是否合法。
 * v2：若客户端以 v1（version=1）请求接入，直接返回 HOST_PROTOCOL_MISMATCH，
 * 强制旧调用方升级。
 */
export function assertHostMessage(value: unknown): asserts value is HostMessage {
  if (!value || typeof value !== 'object') throw codedError('HOST_MESSAGE_INVALID', 'host message must be an object')
  const item = value as Partial<HostMessage>
  if (item.version !== HOST_PROTOCOL_VERSION) {
    if (typeof item.version === 'number') throw codedError('HOST_PROTOCOL_MISMATCH', `unsupported host protocol: ${item.version}`)
    throw codedError('HOST_MESSAGE_INVALID', 'host protocol version is required')
  }
  if (typeof item.id !== 'string' || item.id.length === 0 || typeof item.type !== 'string' || !HOST_MESSAGE_TYPES.includes(item.type as never)) {
    throw codedError('HOST_MESSAGE_INVALID', 'host message id/type is invalid')
  }
  if (!Object.prototype.hasOwnProperty.call(item, 'payload') || item.payload === null) {
    throw codedError('HOST_MESSAGE_INVALID', 'host message payload is invalid')
  }
}

function assertHostResponse(value: unknown, requestId: string): asserts value is HostResponse {
  if (!value || typeof value !== 'object') throw codedError('HOST_RESPONSE_INVALID', 'host response must be an object')
  const item = value as Partial<HostResponse>
  if (item.version !== HOST_PROTOCOL_VERSION) throw codedError('HOST_PROTOCOL_MISMATCH', 'host response protocol mismatch')
  if (item.id !== requestId) throw codedError('HOST_RESPONSE_MISMATCH', 'host response id mismatch')
  if (typeof item.ok !== 'boolean') throw codedError('HOST_RESPONSE_INVALID', 'host response ok flag is invalid')
  if (!item.ok) throw codedError(item.error?.code ?? 'HOST_REQUEST_FAILED', item.error?.message ?? 'host request failed')
}

function assertAgentConfig(value: unknown): asserts value is HostAgentConfig {
  const item = value as Partial<HostAgentConfig> | null
  if (!item || typeof item.baseUrl !== 'string' || !/^https?:\/\/127\.0\.0\.1(?::\d+)?$/.test(item.baseUrl) || typeof item.token !== 'string' || !item.token) {
    throw codedError('HOST_RESPONSE_INVALID', 'invalid local Agent configuration')
  }
}

/**
 * 校验单个 RuntimeCapability 字段完整性。
 * 这里做最小必要校验，确保宿主响应没有漏字段；不在这里做白名单枚举校验，
 * 以保持对未来新增语言/来源的向前兼容。
 */
function assertRuntimeCapability(item: unknown): asserts item is RuntimeCapability {
  const c = item as Partial<RuntimeCapability> | null
  if (!c) throw codedError('HOST_RESPONSE_INVALID', 'runtime capability must be an object')
  if (typeof c.id !== 'string' || !c.id) throw codedError('HOST_RESPONSE_INVALID', 'runtime capability.id is invalid')
  if (typeof c.language !== 'string' || !c.language) throw codedError('HOST_RESPONSE_INVALID', 'runtime capability.language is invalid')
  if (typeof c.source !== 'string' || !c.source) throw codedError('HOST_RESPONSE_INVALID', 'runtime capability.source is invalid')
  // executable 可能为空字符串（公开响应），但类型必须是 string
  if (typeof c.executable !== 'string') throw codedError('HOST_RESPONSE_INVALID', 'runtime capability.executable must be a string')
  if (c.version !== null && typeof c.version !== 'string') throw codedError('HOST_RESPONSE_INVALID', 'runtime capability.version must be string|null')
  if (!c.packages || typeof c.packages !== 'object') throw codedError('HOST_RESPONSE_INVALID', 'runtime capability.packages must be an object')
  if (typeof c.canRun !== 'boolean') throw codedError('HOST_RESPONSE_INVALID', 'runtime capability.canRun must be boolean')
  if (typeof c.canInstall !== 'boolean') throw codedError('HOST_RESPONSE_INVALID', 'runtime capability.canInstall must be boolean')
  if (typeof c.sandboxLevel !== 'string' || !c.sandboxLevel) throw codedError('HOST_RESPONSE_INVALID', 'runtime capability.sandboxLevel is invalid')
  if (c.reason !== undefined && typeof c.reason !== 'string') throw codedError('HOST_RESPONSE_INVALID', 'runtime capability.reason must be string when present')
}

/**
 * 剥离 RuntimeCapability 中的 executable 绝对路径，避免跨端泄露本机路径。
 * 即使宿主已经置空，这里再做一次强制置空，作为防御性兜底。
 */
function sanitizeRuntimeCapability(cap: RuntimeCapability): RuntimeCapability {
  return { ...cap, executable: '' }
}

export function createHostBridge(transport: HostTransport, createId: () => string = () => crypto.randomUUID()): HostBridge {
  async function call<T>(type: HostMessage['type'], payload: object): Promise<T> {
    const request: HostMessage = { version: HOST_PROTOCOL_VERSION, id: createId(), type, payload }
    assertHostMessage(request)
    const response = await transport.request(request)
    assertHostResponse(response, request.id)
    return response.result as T
  }

  return {
    async receive(value) {
      assertHostMessage(value)
      return value
    },
    async getAgentConfig() {
      const config = await call<HostAgentConfig>('agent.config', {})
      assertAgentConfig(config)
      return config
    },
    async openDiff(input: HostDiffRequest) {
      await call<null>('diff.open', input)
    },
    readSelection: () => call<HostSelection | null>('selection.read', {}),
    applyPatch: (input: HostPatchRequest) => call<HostPatchResult>('patch.apply', input),
    getRuntimeCapabilities: () => call<HostCapabilities>('runtime.capabilities', {}),
    // @deprecated v2 起请使用 discoverRuntimes / planRuntime / runRuntime
    runMatlab: (input) => call('runtime.runMatlab', input),

    // ===== v2 通用多语言运行时 =====
    async discoverRuntimes(): Promise<RuntimeCapability[]> {
      const list = await call<unknown>('runtime.discover', {})
      if (!Array.isArray(list)) throw codedError('HOST_RESPONSE_INVALID', 'runtime.discover must return an array')
      return list.map((item) => {
        assertRuntimeCapability(item)
        // 防御性剥离：公开响应中绝不暴露 executable 绝对路径
        return sanitizeRuntimeCapability(item)
      })
    },
    planRuntime: (input: RuntimePlanRequest) => call<RuntimePlan>('runtime.plan', input),
    runRuntime: (input: RuntimeRunRequest) => call<RuntimeRunResponse>('runtime.run', input as object),
    getRuntimeEvents: (runId: string) => call<RuntimeEventsResponse>('runtime.events', { runId }),
    cancelRuntime: (runId: string) => call<RuntimeCancelResponse>('runtime.cancel', { runId }),
    openArtifact: (input: RuntimeOpenArtifactRequest) => call<RuntimeOpenArtifactResponse>('runtime.openArtifact', input)
  }
}

export function installHostBridge(bridge: HostBridge): void {
  if (typeof window === 'undefined') throw codedError('HOST_UNAVAILABLE', 'window is unavailable')
  window.__DEEP_IMAGING_HOST__ = bridge
}

export function getHostBridge(): HostBridge | undefined {
  return typeof window === 'undefined' ? undefined : window.__DEEP_IMAGING_HOST__
}

function installDetectedTauriBridge(): void {
  if (typeof window === 'undefined' || window.__DEEP_IMAGING_HOST__) return
  const invoke = window.__TAURI__?.core?.invoke
  if (!invoke) return
  window.__DEEP_IMAGING_HOST__ = createHostBridge({
    request: (message) => invoke('host_request', { message })
  })
}

installDetectedTauriBridge()

/**
 * 桌面端 Tauri 文件事件处理器（P1-3）。
 *   onFiles(paths)：双击关联文件 / 拖放结束后收到合法路径列表，送入上传/建任务链路。
 *   onDiff(payload)：外部请求打开 Diff 视图（payload 通常含 uri/proposedText）。
 */
export interface TauriFileEventHandlers {
  onFiles: (paths: string[]) => void
  onDiff: (payload: unknown) => void
}

/**
 * 初始化桌面端文件事件监听（open-files / drag-drop / open-diff）。
 * 内部复用 registerTauriFileEvents；非 Tauri 环境返回 no-op 反注册，纯 Web 构建不崩溃。
 *
 * @returns 反注册函数：应用卸载时调用可移除全部监听
 */
export function setupTauriEvents(handlers: TauriFileEventHandlers): Promise<() => void> {
  return registerTauriFileEvents(handlers.onFiles, handlers.onDiff)
}
