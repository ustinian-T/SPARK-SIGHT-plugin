import { describe, expect, it, vi } from 'vitest'
import { createHostBridge, installHostBridge } from './bridge'
import type { HostMessage, HostTransport, RuntimeCapability, RuntimePlan, RuntimeEventsResponse } from './types'

/**
 * 构造一个假的宿主 transport，按消息 type 返回不同 result。
 * 所有响应一律带 version=2（v2 协议）。
 */
function fakeTransport(handler: (message: HostMessage) => unknown = () => ({})): HostTransport {
  return { request: vi.fn(async (message) => ({ version: 2, id: message.id, ok: true, result: handler(message) })) }
}

/** 一个完整合法的 RuntimeCapability 样例（宿主侧返回，含绝对路径） */
const sampleCapabilityFromHost: RuntimeCapability = {
  id: 'python-bundled-3.12',
  language: 'python',
  source: 'bundled',
  executable: 'C:\\deep-imaging\\runtimes\\python\\python.exe',
  version: '3.12.4',
  packages: { numpy: '2.1.0', matplotlib: false },
  canRun: true,
  canInstall: false,
  sandboxLevel: 'generated-only',
  reason: undefined
}

describe('host bridge protocol v1 (legacy compat)', () => {
  it('rejects malformed host messages before transport execution', async () => {
    const transport = fakeTransport()
    const bridge = createHostBridge(transport)
    // v1 客户端（version=1）在 v2 协议下必须被拒绝
    await expect(bridge.receive({ version: 1, id: '1', type: 'agent.config', payload: {} })).rejects.toMatchObject({ code: 'HOST_PROTOCOL_MISMATCH' })
    await expect(bridge.receive({ version: 2, id: '', type: 'patch.apply', payload: null })).rejects.toMatchObject({ code: 'HOST_MESSAGE_INVALID' })
    expect(transport.request).not.toHaveBeenCalled()
  })

  it('rejects future-version host messages', async () => {
    const transport = fakeTransport()
    const bridge = createHostBridge(transport)
    await expect(bridge.receive({ version: 99, id: '1', type: 'agent.config', payload: {} })).rejects.toMatchObject({ code: 'HOST_PROTOCOL_MISMATCH' })
    expect(transport.request).not.toHaveBeenCalled()
  })

  it('correlates requests and exposes typed host operations', async () => {
    const transport = fakeTransport((message) => {
      if (message.type === 'agent.config') return { baseUrl: 'http://127.0.0.1:5181', token: 'one-time', engine: 'python' }
      if (message.type === 'runtime.capabilities') return { host: 'tauri', openDiff: true, readSelection: false, applyPatch: false }
      return null
    })
    const bridge = createHostBridge(transport, () => 'request-1')
    await expect(bridge.getAgentConfig()).resolves.toMatchObject({ token: 'one-time' })
    await expect(bridge.getRuntimeCapabilities()).resolves.toMatchObject({ host: 'tauri' })
    expect(transport.request).toHaveBeenCalledTimes(2)
  })

  it('rejects response ids that do not match the request', async () => {
    const bridge = createHostBridge({ request: async () => ({ version: 2, id: 'wrong', ok: true, result: {} }) }, () => 'expected')
    await expect(bridge.getRuntimeCapabilities()).rejects.toMatchObject({ code: 'HOST_RESPONSE_MISMATCH' })
  })

  it('installs the runtime bridge without putting the Agent token in the URL', async () => {
    vi.stubGlobal('window', { location: { search: '' } })
    const bridge = createHostBridge(fakeTransport((message) => message.type === 'agent.config'
      ? { baseUrl: 'http://127.0.0.1:5181', token: 'secret-token' }
      : null))
    installHostBridge(bridge)
    await expect(window.__DEEP_IMAGING_HOST__?.getAgentConfig()).resolves.toMatchObject({ token: 'secret-token' })
    expect(window.location.search).not.toContain('secret-token')
  })
})

describe('host bridge protocol v2 runtime', () => {
  it('accepts v2 messages through the message type allowlist', async () => {
    const v2Types = [
      'runtime.discover',
      'runtime.plan',
      'runtime.run',
      'runtime.events',
      'runtime.cancel',
      'runtime.openArtifact'
    ] as const
    const transport = fakeTransport((message) => {
      if (message.type === 'runtime.discover') return [sampleCapabilityFromHost]
      return null
    })
    const bridge = createHostBridge(transport)
    for (const t of v2Types) {
      const msg: HostMessage = { version: 2, id: `id-${t}`, type: t, payload: {} }
      await expect(bridge.receive(msg)).resolves.toMatchObject({ type: t, version: 2 })
    }
  })

  it('discoverRuntimes strips the executable absolute path before returning', async () => {
    const transport = fakeTransport((message) => {
      if (message.type === 'runtime.discover') return [
        sampleCapabilityFromHost,
        { ...sampleCapabilityFromHost, id: 'r-system-4.4', language: 'r' as const, executable: '/usr/bin/Rscript' }
      ]
      return null
    })
    const bridge = createHostBridge(transport)
    const list = await bridge.discoverRuntimes()
    expect(list).toHaveLength(2)
    for (const cap of list) {
      // 关键断言：公开响应中 executable 必须被强制置空
      expect(cap.executable).toBe('')
    }
    // 其它字段应原样保留
    expect(list[0]).toMatchObject({
      id: 'python-bundled-3.12',
      language: 'python',
      source: 'bundled',
      version: '3.12.4',
      canRun: true,
      canInstall: false,
      sandboxLevel: 'generated-only',
      packages: { numpy: '2.1.0', matplotlib: false }
    })
  })

  it('rejects RuntimeCapability responses missing required fields', async () => {
    // 故意缺 packages / sandboxLevel，应被 bridge 校验抛出
    const bad = { ...sampleCapabilityFromHost, packages: undefined, sandboxLevel: undefined }
    const transport = fakeTransport((message) => message.type === 'runtime.discover' ? [bad] : null)
    const bridge = createHostBridge(transport)
    await expect(bridge.discoverRuntimes()).rejects.toMatchObject({ code: 'HOST_RESPONSE_INVALID' })
  })

  it('plan/run/events/cancel/openArtifact round-trips typed payloads', async () => {
    const sent: HostMessage[] = []
    const transport: HostTransport = {
      request: vi.fn(async (message) => {
        sent.push(message)
        let result: unknown = null
        if (message.type === 'runtime.plan') {
          const req = message.payload as { runtimeId: string; scriptPath: string }
          result = {
            planId: 'plan-1',
            runtimeId: req.runtimeId,
            language: 'python',
            command: ['python', req.scriptPath],
            workDir: '/work',
            envAllowed: { PYTHONIOENCODING: 'utf-8' },
            expectedArtifacts: ['out.png'],
            sourceHash: 'sha256:abc',
            reviewNotes: ['ok']
          } satisfies RuntimePlan
        } else if (message.type === 'runtime.run') {
          result = { runId: 'run-1' }
        } else if (message.type === 'runtime.events') {
          result = {
            runId: 'run-1',
            status: 'completed',
            events: [
              { type: 'stdout', timestamp: 1, data: 'hello' },
              { type: 'artifact', timestamp: 2, data: { path: 'out.png' } }
            ],
            exitCode: 0,
            runtimeFingerprint: 'fp-1',
            sourceHash: 'sha256:abc',
            dataHash: 'sha256:def',
            dependencySnapshot: { numpy: '2.1.0' }
          } satisfies RuntimeEventsResponse
        } else if (message.type === 'runtime.cancel') {
          result = { runId: 'run-1', cancelled: true }
        } else if (message.type === 'runtime.openArtifact') {
          result = { opened: true, path: 'out.png' }
        }
        // 统一按 v2 协议外层包装
        return { version: 2, id: message.id, ok: true, result }
      })
    }
    const bridge = createHostBridge(transport, () => 'req-id')

    // plan
    const plan = await bridge.planRuntime({
      runtimeId: 'python-bundled-3.12',
      scriptPath: 'plot.py',
      workDir: '/work',
      args: [],
      envWhitelist: ['PYTHONIOENCODING'],
      expectedArtifacts: ['out.png']
    })
    expect(plan.planId).toBe('plan-1')
    expect(plan.command).toEqual(['python', 'plot.py'])

    // run (by planId)
    const run = await bridge.runRuntime({ planId: plan.planId })
    expect(run.runId).toBe('run-1')

    // events
    const events = await bridge.getRuntimeEvents(run.runId)
    expect(events.status).toBe('completed')
    expect(events.exitCode).toBe(0)
    expect(events.events).toHaveLength(2)
    expect(events.dependencySnapshot).toEqual({ numpy: '2.1.0' })

    // cancel
    const cancelled = await bridge.cancelRuntime(run.runId)
    expect(cancelled.cancelled).toBe(true)

    // openArtifact
    const opened = await bridge.openArtifact({ runId: run.runId, artifactPath: 'out.png' })
    expect(opened.opened).toBe(true)

    // 校验请求侧 payload 与 type 完全匹配协议
    expect(sent.map((m) => m.type)).toEqual([
      'runtime.plan',
      'runtime.run',
      'runtime.events',
      'runtime.cancel',
      'runtime.openArtifact'
    ])
    // runtime.events 请求体只带 runId
    expect(sent[2].payload).toEqual({ runId: 'run-1' })
    // runtime.cancel 请求体只带 runId
    expect(sent[3].payload).toEqual({ runId: 'run-1' })
  })
})
