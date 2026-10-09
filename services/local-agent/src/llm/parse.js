export function stripJsonFence(text) {
  return String(text ?? '').trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim()
}

export function parseIntentPayload(payload, provider = 'openai', protocol = 'chat_completions') {
  let text
  if (provider === 'anthropic') {
    text = payload?.content?.filter((block) => block?.type === 'text').map((block) => block.text).join('\n')
  } else if (protocol === 'responses') {
    text = payload?.output_text ?? payload?.output
      ?.filter((item) => item?.type === 'message')
      .flatMap((item) => item.content ?? [])
      .filter((part) => part?.type === 'output_text' || part?.type === 'text')
      .map((part) => part.text ?? '')
      .join('\n')
  } else {
    const content = payload?.choices?.[0]?.message?.content
    text = Array.isArray(content)
      ? content.filter((part) => part?.type === 'text' || typeof part?.text === 'string').map((part) => part.text ?? '').join('\n')
      : content
  }
  if (!text) throw Object.assign(new Error('empty completion'), { code: 'EMPTY_COMPLETION' })
  try {
    return JSON.parse(stripJsonFence(text))
  } catch {
    throw Object.assign(new Error('malformed completion'), { code: 'MALFORMED_RESPONSE' })
  }
}
