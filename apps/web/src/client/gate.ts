// 后端能力门禁：启动与定时执行真实健康检查，区分未配置 / 不可达 / 认证失败 / 协议不兼容 / 能力缺失。
// 前端不再自行决定语言：可选语言一律来自 /api/capabilities 的真实探测结果。
import type { EngineKind } from '../types'
import { getHostBridge } from '../host/bridge'
import { forgetAnonymousToken, getAnonymousToken, readRuntimeConfig } from './realAgentClient'

export type GateReason =
  | 'not_configured'
  | 'unreachable'
  | 'auth_failed'
  | 'protocol_mismatch'
  | 'no_runtime'

export interface RuntimeAvailability {
  engine: EngineKind
  available: boolean
  version: string | null
  note?: string
}

export interface GateResult {
  status: 'checking' | 'available' | 'unavailable'
  reason: GateReason | null
  baseUrl: string
  mode: string
  persist: boolean
  protocol: number | null
  runtimes: RuntimeAvailability[]
  checkedAt: number
  detail?: string
}

export const CHECKING_GATE: GateResult = {
  status: 'checking',
  reason: null,
  baseUrl: '',
  mode: '',
  persist: false,
  protocol: null,
  runtimes: [],
  checkedAt: Date.now()
}

interface HealthResponse {
  status?: string
  version?: string
  protocol?: number
  mode?: string
  persist?: boolean
}

interface CapabilitiesResponse {
  protocol?: number
  runtimes?: Record<string, {
    engine?: string
    available?: boolean
    version?: string | null
    note?: string
  }>
}

/** 解析本次探测的目标 baseUrl 与 token。 */
async function resolveTarget(): Promise<{ baseUrl: string; token: string; configured: boolean }> {
  const cfg = await readRuntimeConfig()
  return { baseUrl: cfg.baseUrl ?? '', token: cfg.token ?? '', configured: cfg.enabled && !!cfg.baseUrl }
}

async function fetchJson(url: string, init?: RequestInit, timeoutMs = 20000): Promise<{ ok: boolean; status: number; json: any }> {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  try {
    const res = await fetch(url, { ...init, signal: controller.signal })
    let json: any = {}
    try { json = await res.json() } catch { /* non-JSON error body */ }
    return { ok: res.ok, status: res.status, json }
  } finally {
    clearTimeout(timer)
  }
}

/** 执行一次完整的健康 + 能力探测；任何失败都如实返回，绝不伪造可用。 */
export async function probeGate(): Promise<GateResult> {
  const checkedAt = Date.now()
  let target: { baseUrl: string; token: string; configured: boolean }
  try {
    target = await resolveTarget()
  } catch (error) {
    return { ...CHECKING_GATE, status: 'unavailable', reason: 'unreachable', checkedAt, detail: msg(error) }
  }
  if (!target.configured || !target.baseUrl) {
    return { ...CHECKING_GATE, status: 'unavailable', reason: 'not_configured', baseUrl: target.baseUrl, checkedAt }
  }

  // 第一步：/health 无需认证，判断进程是否存活与部署模式。
  let health: { ok: boolean; status: number; json: HealthResponse }
  try {
    health = await fetchJson(`${target.baseUrl}/health`, { cache: 'no-store' })
  } catch (error) {
    return { ...CHECKING_GATE, status: 'unavailable', reason: 'unreachable', baseUrl: target.baseUrl, checkedAt, detail: msg(error) }
  }
  if (!health.ok) {
    return { ...CHECKING_GATE, status: 'unavailable', reason: 'unreachable', baseUrl: target.baseUrl, checkedAt, detail: `HTTP ${health.status}` }
  }
  if (health.json.protocol !== 1) {
    return gateFromHealth(health.json, target.baseUrl, checkedAt, 'protocol_mismatch', `绘图 Agent 协议应为 v1，实际为 ${health.json.protocol ?? '未知'}`)
  }

  // 第二步：获取认证令牌（显式令牌优先；同源公网用一次性匿名会话）。
  let token = target.token
  if (!token) {
    try {
      token = await getAnonymousToken(target.baseUrl)
    } catch { /* fall through to auth_failed */ }
  }

  // 第三步：/api/capabilities 携带令牌与协议版本。
  let caps: { ok: boolean; status: number; json: CapabilitiesResponse }
  try {
    caps = await fetchJson(`${target.baseUrl}/api/capabilities`, {
      cache: 'no-store',
      headers: { authorization: `Bearer ${token}`, 'x-agent-protocol': '1' }
    })
  } catch (error) {
    return gateFromHealth(health.json, target.baseUrl, checkedAt, 'unreachable', msg(error))
  }
  if ((caps.status === 401 || caps.status === 403) && !target.token) {
    // Agent 重启后匿名票据签名可能变化；仅重取一次，不无限循环。
    forgetAnonymousToken(target.baseUrl)
    try {
      token = await getAnonymousToken(target.baseUrl)
      caps = await fetchJson(`${target.baseUrl}/api/capabilities`, {
        cache: 'no-store', headers: { authorization: `Bearer ${token}`, 'x-agent-protocol': '1' }
      })
    } catch (error) {
      return gateFromHealth(health.json, target.baseUrl, checkedAt, 'auth_failed', msg(error))
    }
  }
  if (caps.status === 401 || caps.status === 403) {
    return gateFromHealth(health.json, target.baseUrl, checkedAt, 'auth_failed', '令牌无效或已过期')
  }
  if (caps.status === 409 || (caps.ok && caps.json.protocol !== 1)) {
    return gateFromHealth(health.json, target.baseUrl, checkedAt, 'protocol_mismatch', `能力接口协议应为 v1，实际为 ${caps.json.protocol ?? '未知'}`)
  }
  if (!caps.ok) {
    return gateFromHealth(health.json, target.baseUrl, checkedAt, 'no_runtime', `HTTP ${caps.status}`)
  }

  // Web（无宿主桥）只保留 Python / R；桌面宿主桥保留 MATLAB 等本机发现结果。
  const allowMatlab = !!getHostBridge()
  const runtimes: RuntimeAvailability[] = []
  for (const key of ['python', 'r', 'matlab'] as EngineKind[]) {
    if (key === 'matlab' && !allowMatlab) continue
    const rt = caps.json.runtimes?.[key]
    if (rt) {
      runtimes.push({
        engine: key,
        available: rt.available === true,
        version: rt.version ?? null,
        note: rt.note
      })
    }
  }

  const anyRuntime = runtimes.some((r) => r.available)
  return {
    status: anyRuntime ? 'available' : 'unavailable',
    reason: anyRuntime ? null : 'no_runtime',
    baseUrl: target.baseUrl,
    mode: health.json.mode ?? '',
    persist: health.json.persist ?? false,
    protocol: health.json.protocol ?? caps.json.protocol ?? null,
    runtimes,
    checkedAt
  }
}

function gateFromHealth(h: HealthResponse, baseUrl: string, checkedAt: number, reason: GateReason, detail: string): GateResult {
  return {
    status: 'unavailable',
    reason,
    baseUrl,
    mode: h.mode ?? '',
    persist: h.persist ?? false,
    protocol: h.protocol ?? null,
    runtimes: [],
    checkedAt,
    detail
  }
}

function msg(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
