import { lookup } from 'node:dns/promises'

export async function validateModelSettings(input, resolve = lookup) {
  if (!input || typeof input !== 'object') throw new Error('Invalid model settings')
  const url = new URL(input.baseUrl)
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash || (url.port && url.port !== '443')) throw new Error('HTTPS public endpoint required')
  const addresses = await resolve(url.hostname, { all: true })
  if (!addresses.length || addresses.some(({ address, family }) => {
    if (family === 6) return !/^[23][0-9a-f]{3}:/i.test(address)
    const [a, b] = address.split('.').map(Number)
    return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || (a === 198 && (b === 18 || b === 19))
  })) throw new Error('Private API endpoints are disabled')
  if (!['responses', 'chat_completions', 'anthropic_messages'].includes(input.protocol)) throw new Error('Invalid protocol')
  if (typeof input.model !== 'string' || !input.model.trim() || input.model.length > 200 || typeof input.apiKey !== 'string' || input.apiKey.length > 4096) throw new Error('Invalid model or key')
  return { provider: input.protocol === 'anthropic_messages' ? 'anthropic' : 'openai', protocol: input.protocol, baseUrl: url.href.replace(/\/$/, ''), model: input.model.trim(), apiKey: input.apiKey }
}
