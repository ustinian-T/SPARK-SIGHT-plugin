import { getHostBridge } from '../host/bridge'
import { readRuntimeConfig } from './realAgentClient'

export interface ModelSettings {
  providerId?: string
  displayName?: string
  models?: string[]
  configured?: boolean
  provider: 'openai' | 'anthropic'
  protocol: 'chat_completions' | 'responses' | 'anthropic_messages'
  baseUrl: string
  model: string
  apiKey: string
}
/** 协议 → 默认端点映射（火山引擎 ARK） */
export const PROTOCOL_ENDPOINTS: Record<ModelSettings['protocol'], string> = {
  responses: 'https://ark.cn-beijing.volces.com/api/plan/v3',
  chat_completions: 'https://ark.cn-beijing.volces.com/api/plan/v3',
  anthropic_messages: 'https://ark.cn-beijing.volces.com/api/plan',
}

export const defaultModelSettings: ModelSettings = {
  providerId: 'custom-api', displayName: 'Custom API', models: [],
  provider: 'openai', protocol: 'chat_completions',
  baseUrl: 'https://api.openai.com/v1',
  model: '', apiKey: ''
}

/** 切换协议时同步更新端点（仅当当前端点为已知默认端点时才自动替换，避免覆盖用户自定义） */
export function endpointForProtocol(protocol: ModelSettings['protocol'], currentBaseUrl?: string): string {
  const known = Object.values(PROTOCOL_ENDPOINTS)
  if (currentBaseUrl && !known.includes(currentBaseUrl)) return currentBaseUrl
  return PROTOCOL_ENDPOINTS[protocol]
}
const storageKey = 'deep-imaging.model-settings.v1'

/** 是否运行在纯网页模式（无桌面宿主桥）。网页端不持久化 API Key，模型配置由服务端管理。 */
export function isWebMode(): boolean {
  return !getHostBridge()
}

export async function localSettingsRequest(path: string, body?: unknown) {
  const cfg = await readRuntimeConfig()
  const response = await fetch(`${cfg.baseUrl}${path}`, {
    method: body === undefined ? 'GET' : 'PUT',
    headers: { authorization: `Bearer ${cfg.token}`, 'x-agent-protocol': '1', 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  })
  if (!response.ok) throw new Error(`本地设置请求失败 (${response.status})`)
  return response.json()
}
export async function loadModelSettings(): Promise<ModelSettings> {
  // P0-4: Web 端不再从 localStorage 读取 API Key
  // 桌面端和 VS Code 通过宿主桥读取系统凭据库中的设置
  if (getHostBridge()) return { ...defaultModelSettings, ...(await localSettingsRequest('/api/local/settings')).model }
  // Web 端返回不含 apiKey 的默认配置；模型调用由服务端完成
  return { ...defaultModelSettings, apiKey: '' }
}
export async function saveModelSettings(settings: ModelSettings) {
  // P0-4: Web 端不再保存 API Key 到 localStorage
  // 桌面端和 VS Code 通过宿主桥保存到系统凭据库
  if (getHostBridge()) await localSettingsRequest('/api/local/settings', { model: settings })
  // Web 端：不持久化任何模型配置
}
export async function clearModelKey() {
  if (getHostBridge()) await localSettingsRequest('/api/local/settings', { clearKey: true })
}

export async function getModelCatalog(settings: ModelSettings): Promise<string[]> {
  const cfg = await readRuntimeConfig()
  const route = getHostBridge() ? '/api/local/model-catalog' : '/api/me/model-catalog'
  const response = await fetch(`${cfg.baseUrl}${route}`, {
    method: 'POST', headers: { authorization: `Bearer ${cfg.token}`, 'content-type': 'application/json', 'x-agent-protocol': '1' }, body: JSON.stringify({ ...settings, model: settings.model || 'catalog-probe' })
  })
  if (!response.ok) throw new Error('无法获取模型目录，请手动添加模型 ID')
  return (await response.json()).models
}
