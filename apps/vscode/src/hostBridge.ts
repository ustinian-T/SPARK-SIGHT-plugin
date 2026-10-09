import { applyPatchWithReview, applySelectedHunks, codedError, type HostHunkRequest, type HostPatchRequest, type HostPatchResult, type HostSelection, type VscodeFacade } from './patchReview'
import { RuntimeRunner, type RuntimeOpenArtifactRequest, type RuntimePlanRequest } from './runtimeRunner'

export const HOST_PROTOCOL_VERSION = 2 as const
export const HOST_MESSAGE_TYPES = ['agent.config', 'diff.open', 'selection.read', 'patch.apply', 'patch.applyHunks', 'plans.compare', 'text.insert', 'diagnostic.reveal', 'edit.undo', 'handoff.write', 'runtime.capabilities', 'runtime.runMatlab', 'runtime.discover', 'runtime.plan', 'runtime.run', 'runtime.events', 'runtime.cancel', 'runtime.openArtifact'] as const
export type HostMessageType = (typeof HOST_MESSAGE_TYPES)[number]

export interface HostMessage {
  version: number
  id: string
  type: HostMessageType
  payload: unknown
}

export interface HostResponse {
  version: typeof HOST_PROTOCOL_VERSION
  id: string
  ok: boolean
  result?: unknown
  error?: { code: string; message: string }
}

export interface HostDependencies {
  vscode: VscodeFacade
  getAgentConfig?: () => Promise<{ baseUrl: string; token: string; engine?: string }>
  /** v2 通用多语言运行时；未注入时 v2 消息与 deprecated runMatlab 均不可用 */
  runner?: RuntimeRunner
}

export function assertHostMessage(value: unknown): asserts value is HostMessage {
  if (!value || typeof value !== 'object') throw codedError('HOST_MESSAGE_INVALID', 'Host message must be an object')
  const message = value as Partial<HostMessage>
  if (message.version !== HOST_PROTOCOL_VERSION) {
    if (typeof message.version === 'number') throw codedError('HOST_PROTOCOL_MISMATCH', 'Unsupported host protocol')
    throw codedError('HOST_MESSAGE_INVALID', 'Protocol version is required')
  }
  if (!message.id || typeof message.id !== 'string' || !HOST_MESSAGE_TYPES.includes(message.type as HostMessageType) || message.payload === null || message.payload === undefined) {
    throw codedError('HOST_MESSAGE_INVALID', 'Host message id, type, or payload is invalid')
  }
}

export function createHost(vscode: VscodeFacade) {
  return {
    async readSelection(): Promise<HostSelection | null> {
      if (!vscode.isTrusted) throw codedError('WORKSPACE_UNTRUSTED', 'Workspace trust is required')
      const selection = await vscode.readSelection()
      if (selection && !vscode.isUriAllowed(selection.uri)) throw codedError('RESOURCE_NOT_ALLOWED', 'Selection is outside the trusted workspace')
      return selection
    },
    applyPatch(request: HostPatchRequest): Promise<HostPatchResult> {
      return applyPatchWithReview(vscode, request)
    },
    applyHunks(request: HostHunkRequest) {
      return applySelectedHunks(vscode, request)
    },
    async comparePlans(plans: { name: string; source: string }[]) {
      if (!vscode.isTrusted) throw codedError('WORKSPACE_UNTRUSTED', 'Workspace trust is required')
      if (!Array.isArray(plans) || plans.length !== 3) throw codedError('PLAN_COMPARISON_INVALID', 'Exactly three plans are required')
      return Promise.all(plans.map((plan) => vscode.createTemporaryDocument(plan.name, plan.source)))
    },
    async insertAt(input: { uri: string; text: string; line: number; character: number }) {
      if (!vscode.isTrusted) throw codedError('WORKSPACE_UNTRUSTED', 'Workspace trust is required')
      if (!vscode.isUriAllowed(input.uri)) throw codedError('RESOURCE_NOT_ALLOWED', 'Target is outside the trusted workspace')
      await vscode.insertText(input.uri, input.text, input.line, input.character)
    },
    async revealDiagnostic(input: { uri: string; line: number; character: number }) {
      if (!vscode.isUriAllowed(input.uri)) throw codedError('RESOURCE_NOT_ALLOWED', 'Diagnostic is outside the trusted workspace')
      await vscode.revealLocation(input.uri, input.line, input.character)
    },
    async undo() {
      if (!vscode.isTrusted) throw codedError('WORKSPACE_UNTRUSTED', 'Workspace trust is required')
      await vscode.undo()
    },
    async writeHandoff(payload: unknown) {
      if (!vscode.isTrusted) throw codedError('WORKSPACE_UNTRUSTED', 'Workspace trust is required')
      return vscode.writeHandoff(payload)
    }
  }
}

function requireRunner(dependencies: HostDependencies): RuntimeRunner {
  if (!dependencies.runner) throw codedError('RUNTIME_UNAVAILABLE', '通用运行时未在宿主中注册')
  return dependencies.runner
}

export async function handleHostMessage(value: unknown, dependencies: HostDependencies): Promise<HostResponse> {
  let id = ''
  try {
    assertHostMessage(value)
    id = value.id
    const host = createHost(dependencies.vscode)
    let result: unknown
    switch (value.type) {
      case 'agent.config':
        if (!dependencies.getAgentConfig) throw codedError('AGENT_UNAVAILABLE', 'Local Agent is unavailable')
        result = await dependencies.getAgentConfig()
        break
      case 'runtime.capabilities': {
        const runtimes = dependencies.runner ? await dependencies.runner.discover() : []
        result = { host: 'vscode', openDiff: true, readSelection: true, applyPatch: true, partialPatch: true, comparePlans: true, insertAt: true, diagnosticsNavigation: true, undo: true, handoff: true, runMatlab: !!dependencies.runner, runtimeProtocol: 2, runtimes }
        break
      }
      case 'selection.read':
        result = await host.readSelection()
        break
      case 'patch.apply':
        result = await host.applyPatch(value.payload as HostPatchRequest)
        break
      case 'patch.applyHunks':
        result = await host.applyHunks(value.payload as HostHunkRequest)
        break
      case 'plans.compare':
        result = await host.comparePlans(value.payload as { name: string; source: string }[])
        break
      case 'text.insert':
        result = await host.insertAt(value.payload as { uri: string; text: string; line: number; character: number })
        break
      case 'diagnostic.reveal':
        result = await host.revealDiagnostic(value.payload as { uri: string; line: number; character: number })
        break
      case 'edit.undo':
        result = await host.undo()
        break
      case 'handoff.write':
        result = await host.writeHandoff(value.payload)
        break
      case 'runtime.runMatlab': {
        // @deprecated v2 起由通用 runtime.discover/plan/run 取代；此处内部委托给通用管线（language=matlab）
        if (!dependencies.runner) throw codedError('MATLAB_UNAVAILABLE', 'MATLAB host runner is unavailable')
        result = await dependencies.runner.runMatlabLegacy(value.payload as { scriptPath: string; projectRoot?: string; timeoutSeconds?: number })
        break
      }
      case 'runtime.discover':
        result = await requireRunner(dependencies).discover()
        break
      case 'runtime.plan':
        result = await requireRunner(dependencies).plan(value.payload as RuntimePlanRequest)
        break
      case 'runtime.run':
        result = await requireRunner(dependencies).run(value.payload as { planId: string })
        break
      case 'runtime.events': {
        const input = value.payload as { runId: string }
        result = await requireRunner(dependencies).events(input?.runId ?? '')
        break
      }
      case 'runtime.cancel': {
        const input = value.payload as { runId: string }
        result = await requireRunner(dependencies).cancel(input?.runId ?? '')
        break
      }
      case 'runtime.openArtifact':
        result = await requireRunner(dependencies).openArtifact(value.payload as RuntimeOpenArtifactRequest)
        break
      case 'diff.open': {
        if (!dependencies.vscode.isTrusted) throw codedError('WORKSPACE_UNTRUSTED', 'Workspace trust is required')
        const input = value.payload as { uri: string; proposedText: string; title?: string }
        if (!dependencies.vscode.isUriAllowed(input.uri)) throw codedError('RESOURCE_NOT_ALLOWED', 'Diff resource is outside the trusted workspace')
        await dependencies.vscode.openDiff(input.uri, input.proposedText, input.title)
        result = null
        break
      }
    }
    return { version: HOST_PROTOCOL_VERSION, id, ok: true, result }
  } catch (error) {
    const item = error as Error & { code?: string }
    return { version: HOST_PROTOCOL_VERSION, id: id || ((value as { id?: string })?.id ?? ''), ok: false, error: { code: item.code ?? 'HOST_REQUEST_FAILED', message: item.message } }
  }
}
