import { lookup } from 'node:dns/promises'
import { isIP } from 'node:net'

export function isPublicAddress(address) {
  if (isIP(address) === 6) return /^[23][0-9a-f]{3}:/i.test(address) && !/^2001:(?:0:|db8:)/i.test(address) && !/^2002:/i.test(address)
  if (isIP(address) !== 4) return false
  const [a, b, c] = address.split('.').map(Number)
  return !(a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && (b === 168 || b === 0 || (b === 88 && c === 99))) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100))) || (a === 203 && b === 0 && c === 113))
}

export function publicEndpoint(value) {
  const url = new URL(value)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.port && url.port !== '443')) throw new Error('HTTPS public endpoint required')
  return url
}

export async function validateModelSettings(input, resolve = lookup) {
  if (!input || typeof input !== 'object') throw new Error('Invalid model settings')
  const url = publicEndpoint(input.baseUrl)
  const addresses = await resolve(url.hostname, { all: true })
  if (!addresses.length || addresses.some(({ address }) => !isPublicAddress(address))) throw new Error('Private API endpoints are disabled')
  if (!['responses', 'chat_completions', 'anthropic_messages'].includes(input.protocol)) throw new Error('Invalid protocol')
  if (typeof input.model !== 'string' || !input.model.trim() || input.model.length > 200 || typeof input.apiKey !== 'string' || input.apiKey.length > 4096) throw new Error('Invalid model or key')
  const providerId = input.providerId ?? 'custom-api'
  const displayName = input.displayName ?? 'Custom API'
  if (typeof providerId !== 'string' || !/^[a-z][a-z0-9_-]{0,63}$/.test(providerId) || typeof displayName !== 'string' || !displayName.trim() || displayName.length > 80) throw new Error('Invalid provider identity')
  const models = input.models ?? [input.model.trim()]
  if (!Array.isArray(models) || models.length > 100 || models.some(m => typeof m !== 'string' || !m.trim() || m.length > 200)) throw new Error('Invalid model directory')
  return { providerId, displayName: displayName.trim(), models: [...new Set(models.map(m => m.trim()))], provider: input.protocol === 'anthropic_messages' ? 'anthropic' : 'openai', protocol: input.protocol, baseUrl: url.href.replace(/\/$/, ''), model: input.model.trim(), apiKey: input.apiKey }
}
