// 站点会话管理：登录态令牌与用户信息持久化于 localStorage（key 随版本号，改版即失效）。
// 令牌只存本地并通过 Authorization 头发送，禁止拼入 URL（与 realAgentClient 的 P0-6 约定一致）。
import { getHostBridge } from '../host/bridge'

export interface SiteUser {
  userId: string
  username: string
  displayName: string
  phone?: string
  role: 'user' | 'admin' | string
  status?: string
  kind?: string
  expiresAt?: number
  disabled?: boolean
}

export interface SiteSession {
  token: string
  baseUrl: string
  user: SiteUser
  loginAt: number
}

const STORAGE_KEY = 'spark-sight.session.v1'
export const SESSION_CHANGED_EVENT = 'spark-sight:session-changed'

// 登录/登出后广播，通知 Root 等常驻组件重新读取会话（同一文档内 localStorage 无 storage 事件）。
function notifySessionChanged(): void {
  try { window.dispatchEvent(new Event(SESSION_CHANGED_EVENT)) } catch { /* ignore */ }
}

export function loadSession(): SiteSession | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return null
    const parsed = JSON.parse(raw) as SiteSession
    if (!parsed?.token || !parsed?.user?.userId) return null
    return parsed
  } catch { return null }
}

export function saveSession(session: SiteSession): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(session)) } catch { /* 隐私模式等存储不可用场景 */ }
  notifySessionChanged()
}

export function clearSession(): void {
  try { localStorage.removeItem(STORAGE_KEY) } catch { /* ignore */ }
  notifySessionChanged()
}

export function isAdmin(session: SiteSession | null): boolean {
  return session?.user?.role === 'admin'
}

/** 统一的站点 API 调用：携带协议头与令牌，错误统一抛出服务端中文消息。 */
export async function siteApi<T = any>(base: string, path: string, init: RequestInit & { token?: string } = {}): Promise<T> {
  const { token, ...rest } = init
  const target = getHostBridge() ? base : window.location.origin
  const response = await fetch(`${target.replace(/\/$/, '')}${path}`, {
    ...rest,
    headers: {
      'x-agent-protocol': '1',
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(rest.body ? { 'content-type': 'application/json' } : {}),
      ...(rest.headers ?? {})
    }
  })
  const value = await response.json().catch(() => ({}))
  if (!response.ok) {
    const error = new Error(value?.error?.message ?? `请求失败（HTTP ${response.status}）`) as Error & { code?: string; status?: number }
    error.code = value?.error?.code
    error.status = response.status
    throw error
  }
  return value as T
}

export async function verifySession(session: SiteSession): Promise<SiteUser | null> {
  try {
    const value = await siteApi<{ user: SiteUser }>(session.baseUrl, '/api/auth/me', { token: session.token })
    return value.user ?? null
  } catch (error) {
    if ((error as { status?: number }).status === 401) return null
    // 网络抖动等情况不下钻登录页，保持本地会话由后续请求兜底
    return session.user
  }
}

/** 本机会话由加密的 Agent 存储恢复，避免重启后的随机端口/页面 origin 变化丢失登录。 */
export async function restoreHostSession(): Promise<SiteSession | null> {
  const host = getHostBridge()
  if (!host) return loadSession()
  const config = await host.getAgentConfig()
  const result = await siteApi<{ session: { token: string; user: SiteUser } | null }>(config.baseUrl, '/api/auth/local-session', { token: config.token })
  if (!result.session) return null
  return { ...result.session, baseUrl: config.baseUrl, loginAt: Date.now() }
}

/** 显式退出：先通知服务器记录退出并撤销当前会话，网络失败时仍清除本地登录态。 */
export async function logoutSession(): Promise<void> {
  const session = loadSession()
  try {
    if (session) await siteApi(getHostBridge() ? session.baseUrl : window.location.origin, '/api/auth/logout', { method: 'POST', token: session.token })
  } finally {
    clearSession()
  }
}
