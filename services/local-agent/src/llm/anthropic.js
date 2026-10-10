export function anthropicEndpoint(baseUrl) {
  const base = String(baseUrl).replace(/\/$/, '')
  return base.endsWith('/messages') ? base : base.endsWith('/v1') ? `${base}/messages` : `${base}/v1/messages`
}

export async function requestAnthropicIntent(config, messages, fetchImpl, signal) {
  const system = messages.find((message) => message.role === 'system')?.content ?? ''
  const conversation = messages.filter((message) => message.role !== 'system')
  const arkPlan = /^https:\/\/ark\.cn-beijing\.volces\.com\/api\/(?:plan|coding)(?:\/|$)/.test(config.baseUrl)
  const response = await fetchImpl(anthropicEndpoint(config.baseUrl), {
    method: 'POST', signal, redirect: 'error',
    headers: {
      'content-type': 'application/json; charset=utf-8',
      ...(arkPlan ? { authorization: `Bearer ${config.apiKey}` } : { 'x-api-key': config.apiKey }),
      'anthropic-version': config.anthropicVersion
    },
    body: JSON.stringify({ model: config.model, max_tokens: 2048, temperature: 0, system, messages: conversation })
  })
  if (!response.ok) {
    throw Object.assign(new Error('provider request failed'), {
      code: `HTTP_${response.status}`,
      status: response.status,
      requestId: response?.headers?.get?.('x-request-id') ?? undefined
    })
  }
  try {
    return await response.json()
  } catch {
    throw Object.assign(new Error('provider returned invalid JSON'), { code: 'MALFORMED_RESPONSE' })
  }
}
