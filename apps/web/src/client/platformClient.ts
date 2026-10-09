import { getAnonymousToken, readRuntimeConfig } from './realAgentClient'

export interface ProjectSummary {
  projectId: string
  name: string
  updatedAt: number
  lockedSteps: Record<string, unknown>
  cloud: { status: string; lastSyncedAt?: number | null }
}

export class PlatformClient {
  constructor(private baseUrl: string, private token: string) {}

  static async create(): Promise<PlatformClient | null> {
    const cfg = await readRuntimeConfig()
    if (!cfg.enabled || !cfg.baseUrl) return null
    const token = cfg.token || await getAnonymousToken(cfg.baseUrl)
    return new PlatformClient(cfg.baseUrl.replace(/\/$/, ''), token)
  }

  useToken(token: string) { this.token = token }
  subscribeProject(projectId: string, onEvent: (event: any) => void) {
    const url = new URL(this.baseUrl); url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    const socket = new WebSocket(`${url.origin}/api/projects/${encodeURIComponent(projectId)}/collaboration`)
    socket.onmessage = (event) => {
      let message
      try { message = JSON.parse(String(event.data)) } catch { return }
      if (message.type === 'authenticated') socket.send(JSON.stringify({ type: 'presence', status: 'active' }))
      else onEvent(message)
    }
    socket.onopen = () => socket.send(JSON.stringify({ type: 'auth', token: this.token }))
    socket.onerror = () => onEvent({ type: 'connection_error' })
    socket.onclose = () => onEvent({ type: 'disconnected' })
    return () => socket.close()
  }
  private async request(path: string, init: RequestInit = {}) {
    const response = await fetch(`${this.baseUrl}${path}`, {
      ...init,
      signal: init.signal ?? AbortSignal.timeout(20000),
      headers: { authorization: `Bearer ${this.token}`, 'x-agent-protocol': '1', ...(init.body ? { 'content-type': 'application/json' } : {}), ...(init.headers ?? {}) }
    })
    const value = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(value?.error?.message ?? `HTTP ${response.status}`)
    return value
  }
  anonymous() { return this.request('/api/auth/anonymous', { method: 'POST' }) }
  register(username: string, password: string, displayName: string) { return this.request('/api/auth/register', { method: 'POST', body: JSON.stringify({ username, password, displayName }) }) }
  login(username: string, password: string) { return this.request('/api/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }) }
  listProjects(): Promise<{ projects: ProjectSummary[] }> { return this.request('/api/projects') }
  createProject(name: string): Promise<{ project: ProjectSummary }> { return this.request('/api/projects', { method: 'POST', body: JSON.stringify({ name }) }) }
  attachTask(projectId: string, taskId: string) { return this.request(`/api/projects/${encodeURIComponent(projectId)}/attachments`, { method: 'POST', body: JSON.stringify({ taskId }) }) }
  openProject(projectId: string) { return this.request(`/api/projects/${encodeURIComponent(projectId)}`) }
  setLocks(projectId: string, locks: Record<string, unknown>) { return this.request(`/api/projects/${encodeURIComponent(projectId)}/locks`, { method: 'PUT', body: JSON.stringify({ locks }) }) }
  sync(projectId: string) { return this.request(`/api/projects/${encodeURIComponent(projectId)}/sync`, { method: 'POST', body: JSON.stringify({ direction: 'bidirectional', conflictPolicy: 'fail' }) }) }
  share(projectId: string) { return this.request(`/api/projects/${encodeURIComponent(projectId)}/shares`, { method: 'POST', body: JSON.stringify({ includeCode: true }) }) }
  plugins() { return this.request('/api/plugins') }
  remoteNodes() { return this.request('/api/remote-nodes') }
  variants(taskId: string, planId: string) { return this.request(`/api/tasks/${encodeURIComponent(taskId)}/plans/${encodeURIComponent(planId)}/variants`, { method: 'POST', body: '{}' }) }
  addComment(projectId: string, text: string, target: unknown, significance?: unknown) { return this.request(`/api/projects/${encodeURIComponent(projectId)}/comments`, { method: 'POST', body: JSON.stringify({ text, target, significance }) }) }
  merge(base: string, current: string, incoming: string) { return this.request('/api/merge', { method: 'POST', body: JSON.stringify({ base, current, incoming }) }) }
  async exportAdvanced(taskId: string, planId: string, settings: { dpi: number; transparent: boolean; colorMode: string; formats: string[] }) {
    const query = new URLSearchParams({ planId, dpi: String(settings.dpi), transparent: String(settings.transparent), colorMode: settings.colorMode, formats: settings.formats.join(',') })
    const response = await fetch(`${this.baseUrl}/api/tasks/${encodeURIComponent(taskId)}/export?${query}`, { headers: { authorization: `Bearer ${this.token}`, 'x-agent-protocol': '1' } })
    if (!response.ok) throw new Error(`高级导出失败：HTTP ${response.status}`)
    const href = URL.createObjectURL(await response.blob())
    const link = document.createElement('a'); link.href = href; link.download = `${planId}.zip`; link.click()
    setTimeout(() => URL.revokeObjectURL(href), 10_000)
  }
}
