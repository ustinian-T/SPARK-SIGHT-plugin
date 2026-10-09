import { llmConfigured, probeProvider, providerConfig } from '../src/llm.js'

const config = providerConfig()
if (!llmConfigured(config)) {
  console.error(JSON.stringify({ ok: false, category: 'NOT_CONFIGURED' }))
  process.exitCode = 2
} else {
  const result = await probeProvider(config)
  console.log(JSON.stringify(result, null, 2))
  if (!result.ok) process.exitCode = 1
}
