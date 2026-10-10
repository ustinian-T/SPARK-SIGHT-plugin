// Resolve once per request, validate every answer, and pin the selected IP to
// the TLS connection. Certificate verification still uses the original host.
import https from 'node:https'
import { lookup } from 'node:dns/promises'
import { isPublicAddress, publicEndpoint } from './modelSettings.js'

export async function resolvePublicProvider(url, resolve = lookup) {
  const endpoint = publicEndpoint(url)
  const hostname = endpoint.hostname.replace(/^\[|\]$/g, '')
  const addresses = await resolve(hostname, { all: true })
  if (!addresses.length || addresses.some(item => !isPublicAddress(item.address))) throw new Error('Private API endpoints are disabled')
  return { endpoint, address: addresses[0] }
}

export async function providerFetch(url, init = {}) {
  init.signal?.throwIfAborted()
  const { endpoint, address } = await resolvePublicProvider(url)
  init.signal?.throwIfAborted()
  return new Promise((resolve, reject) => {
    const req = https.request(endpoint, {
      method: init.method ?? 'GET', headers: init.headers, signal: init.signal,
      agent: false,
      lookup: (_host, options, callback) => options.all ? callback(null, [address]) : callback(null, address.address, address.family)
    }, res => {
      const chunks = []
      let size = 0
      res.on('data', chunk => {
        size += chunk.length
        if (size > 2 * 1024 * 1024) res.destroy(new Error('Provider response exceeds limit'))
        else chunks.push(chunk)
      })
      res.on('error', reject)
      res.on('end', () => {
        if (res.statusCode >= 300 && res.statusCode < 400) return reject(new Error('Provider redirects are disabled'))
        const headers = new Headers()
        for (let i = 0; i < res.rawHeaders.length; i += 2) headers.append(res.rawHeaders[i], res.rawHeaders[i + 1])
        resolve(new Response([204, 304].includes(res.statusCode) ? null : Buffer.concat(chunks), { status: res.statusCode, headers }))
      })
    })
    req.on('error', reject)
    req.setTimeout(15000, () => req.destroy(new Error('Provider request timed out')))
    req.end(init.body)
  })
}

export async function fetchModelCatalog(config) {
  let base = config.baseUrl.replace(/\/(?:chat\/completions|responses|messages)\/?$/, '').replace(/\/$/, '')
  if (config.protocol === 'anthropic_messages' && !base.endsWith('/v1')) base += '/v1'
  const response = await providerFetch(base + '/models', {
    headers: config.provider === 'anthropic' ? { 'x-api-key': config.apiKey, 'anthropic-version': '2023-06-01' } : { authorization: 'Bearer ' + config.apiKey },
    signal: AbortSignal.timeout(15000)
  })
  if (!response.ok) throw new Error('Model catalog request failed')
  const result = await response.json()
  if (!Array.isArray(result.data)) throw new Error('Invalid model catalog')
  return [...new Set(result.data.map(item => item.id).filter(id => typeof id === 'string' && id.trim() && id.length <= 200))].slice(0, 100)
}
