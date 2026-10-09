function header(response, name) {
  return response?.headers?.get?.(name) ?? response?.headers?.get?.(name.toLowerCase()) ?? undefined
}

export function openAiEndpoint(baseUrl, protocol = 'chat_completions') {
  const base = String(baseUrl).replace(/\/$/, '')
  const suffix = protocol === 'responses' ? '/responses' : '/chat/completions'
  return base.endsWith(suffix) ? base : `${base}${suffix}`
}

export async function requestOpenAiIntent(config, messages, fetchImpl, signal) {
  const protocol = config.protocol === 'responses' ? 'responses' : 'chat_completions'
  // 推理模型（ark-code-latest 等）先产出 reasoning_content（100+ tokens）再产出 content，
  // max_tokens 必须足够（≥2048），否则 finish_reason=length 且 content 为空。
  const body = protocol === 'responses'
    ? { model: config.model, input: messages, temperature: 0, max_output_tokens: 2048 }
    : { model: config.model, temperature: 0, max_tokens: 2048, response_format: { type: 'json_object' }, messages }
  const response = await fetchImpl(openAiEndpoint(config.baseUrl, protocol), {
    method: 'POST', signal, redirect: 'error',
    headers: { 'content-type': 'application/json; charset=utf-8', authorization: `Bearer ${config.apiKey}` },
    body: JSON.stringify(body)
  })
  if (!response.ok) {
    throw Object.assign(new Error('provider request failed'), {
      code: `HTTP_${response.status}`,
      status: response.status,
      requestId: header(response, 'x-request-id')
    })
  }
  try {
    return await response.json()
  } catch {
    throw Object.assign(new Error('provider returned invalid JSON'), { code: 'MALFORMED_RESPONSE' })
  }
}
