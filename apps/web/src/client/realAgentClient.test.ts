import { afterEach, describe, expect, it, vi } from 'vitest'
import { RealAgentClient, readRuntimeConfig } from './realAgentClient'
import type { SpecPatch } from '../types'

function response(json: unknown = { ok: true }) {
  return { ok: true, status: 200, json: async () => json } as Response
}

function client() {
  const value = new RealAgentClient({ baseUrl: 'http://127.0.0.1:8787', token: 'token' })
  ;(value as any).taskId = 'task_1'
  return value
}

afterEach(() => vi.unstubAllGlobals())

describe('RealAgentClient lifecycle API', () => {
  it('uses the deployed website origin even when an old browser session saved a local Agent URL', async () => {
    vi.stubGlobal('window', { location: { origin: 'https://plots.example.org' } })
    vi.stubGlobal('localStorage', { getItem: () => JSON.stringify({ token: 'account-token', baseUrl: 'http://127.0.0.1:5181', user: { userId: 'user_1' } }) })
    const config = await readRuntimeConfig()
    expect(config.baseUrl).toBe('https://plots.example.org')
    expect(config.token).toBe('account-token')
  })
  it('posts cancel before closing the event socket', async () => {
    const order: string[] = []
    const fetchSpy = vi.fn(async () => { order.push('fetch'); return response({ state: 'CANCELLED' }) })
    vi.stubGlobal('fetch', fetchSpy)
    const value = client()
    ;(value as any).ws = { close: () => order.push('close') }
    await value.cancel()
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:8787/api/tasks/task_1/cancel',
      expect.objectContaining({ method: 'POST' })
    )
    expect(order).toEqual(['fetch', 'close'])
  })

  it('maps UI patch paths to preview/apply endpoints', async () => {
    const fetchSpy = vi.fn(async (_url: string, init: RequestInit) => response({ preview: { token: 'preview-token', ...(JSON.parse(String(init.body))) } }))
    vi.stubGlobal('fetch', fetchSpy)
    const value = client()
    const patch: SpecPatch = {
      patch_id: 'p1', targetKind: 'figure', targetId: 'fig_1', path: 'figure.title', label: '标题', before: 'A', after: 'B'
    }
    const preview = await value.previewPatch('plan_clarity', 2, patch)
    expect(preview.token).toBe('preview-token')
    expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body))).toMatchObject({
      planId: 'plan_clarity', parentVersion: 2, targetKind: 'figure', path: 'title'
    })
    await value.applyPatch(preview.token)
    expect(fetchSpy.mock.calls[1][0]).toContain('/patches/apply')
  })

  it('uses global preference pause, revert, and clear endpoints', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => response({ paused: false, events: [] }))
    vi.stubGlobal('fetch', fetchSpy)
    const value = client()
    await value.setPreferencePaused(true)
    await value.revertPreference('pref_1')
    await value.clearPreferences()
    expect(fetchSpy.mock.calls.map((call) => [call[0], call[1]?.method])).toEqual([
      ['http://127.0.0.1:8787/api/preferences/pause', 'POST'],
      ['http://127.0.0.1:8787/api/preferences/pref_1', 'DELETE'],
      ['http://127.0.0.1:8787/api/preferences', 'DELETE']
    ])
  })

  it('keeps project-scoped tasks on the project API path for preview and cancellation', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => response({ svg: '<svg/>', planId: 'p1' }))
    vi.stubGlobal('fetch', fetchSpy)
    const value = new RealAgentClient({ baseUrl: 'http://127.0.0.1:8787', token: 'token', projectId: 'project_1' })
    ;(value as any).taskId = 'task_1'
    await value.getPreview('p1')
    await value.cancel()
    expect(fetchSpy.mock.calls[0][0]).toContain('/api/projects/project_1/tasks/task_1/preview')
    expect(fetchSpy.mock.calls[1][0]).toContain('/api/projects/project_1/tasks/task_1/cancel')
  })

  it('requests an engine-specific preview so code and SVG cannot be mismatched', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => response({ svg: '<svg/>', planId: 'p1', engine: 'r' }))
    vi.stubGlobal('fetch', fetchSpy)
    const value = new RealAgentClient({ baseUrl: 'http://127.0.0.1:8787', token: 'token' })
    ;(value as any).taskId = 'task_1'
    await value.getPreview('p1', 'r')
    expect(String(fetchSpy.mock.calls[0][0])).toContain('/preview?planId=p1&engine=r')
  })

  it('serializes reproducibility export options without leaking them into the path', async () => {
    const fetchSpy = vi.fn(async (_url: string, _init?: RequestInit) => new Response(new Blob(['zip']), { status: 200 }))
    vi.stubGlobal('fetch', fetchSpy)
    vi.stubGlobal('document', { createElement: () => ({ click: () => {}, remove: () => {}, href: '', download: '' }), body: { appendChild: () => {}, removeChild: () => {} } })
    const value = new RealAgentClient({ baseUrl: 'http://127.0.0.1:8787', token: 'token' })
    ;(value as any).taskId = 'task_1'
    await value.exportArtifact('reproduce', 'plan_a', { includeData: false, colorMode: 'grayscale', dpi: 600, formats: ['svg', 'pdf'] })
    const url = String(fetchSpy.mock.calls[0][0])
    expect(url).toContain('includeData=false')
    expect(url).toContain('colorMode=grayscale')
    expect(url).toContain('dpi=600')
    expect(url).toContain('formats=svg%2Cpdf')
  })

  it('previews and applies edited source with an optimistic base hash', async () => {
    const fetchSpy = vi.fn(async (url: string, _init?: RequestInit) => response(url.endsWith('/preview')
      ? { preview: { token: 'source-token', mode: 'code', sourceMap: [] } }
      : { revision: { version: 3, reason: 'source', mode: 'code', plans: [] } }))
    vi.stubGlobal('fetch', fetchSpy)
    const value = client()
    const preview = await value.previewSource({
      planId: 'plan_clarity', engine: 'python', parentVersion: 2, baseHash: 'abc', source: 'print(1)'
    })
    expect(preview.token).toBe('source-token')
    expect(fetchSpy.mock.calls[0][0]).toContain('/source/preview')
    expect(JSON.parse(String(fetchSpy.mock.calls[0][1]?.body))).toMatchObject({ baseHash: 'abc', parentVersion: 2 })
    const revision = await value.applySource(preview.token)
    expect(revision.mode).toBe('code')
    expect(fetchSpy.mock.calls[1][0]).toContain('/source/apply')
  })
})


describe('project task recovery', () => {
  it('unwraps project snapshots before hydrating the workspace', async () => {
    const task = { taskId: 'task_1', plans: [], execution: { status: 'idle' } }
    const fetchSpy = vi.fn(async (_url: string) => response({ projectId: 'project_1', task }))
    vi.stubGlobal('fetch', fetchSpy)
    const value = new RealAgentClient({ baseUrl: 'https://plots.example.org', token: 'token', projectId: 'project_1' })
    value.resume('task_1')
    expect(await value.getSnapshot()).toEqual(task)
    expect(fetchSpy.mock.calls[0][0]).toBe('https://plots.example.org/api/projects/project_1/tasks/task_1')
  })
  it('rejects incomplete snapshots instead of crashing the reducer', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => response({ task: { taskId: 'task_1' } })))
    await expect(client().getSnapshot()).rejects.toThrow('任务快照格式无效')
  })
  it('subscribes through the authenticated event endpoint supported by the server', () => {
    const urls: string[] = []
    vi.stubGlobal('WebSocket', class { constructor(url: string) { urls.push(url) } close() {} })
    const value = new RealAgentClient({ baseUrl: 'https://plots.example.org', token: 'token', projectId: 'project_1' })
    value.resume('task_1')
    value.subscribe(() => {})
    expect(urls).toEqual(['wss://plots.example.org/api/tasks/task_1/events'])
    value.detach()
  })
})

