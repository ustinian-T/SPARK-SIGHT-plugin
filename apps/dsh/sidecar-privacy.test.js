import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { SidecarManager } from './lib/sidecar.js'

test('DSH sidecar ignores inherited host and token configuration', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spark-dsh-private-'))
  const previous = { LOCAL_AGENT_HOST: process.env.LOCAL_AGENT_HOST, LOCAL_AGENT_TOKEN: process.env.LOCAL_AGENT_TOKEN, LOCAL_AGENT_PORT: process.env.LOCAL_AGENT_PORT }
  Object.assign(process.env, { LOCAL_AGENT_HOST: '0.0.0.0', LOCAL_AGENT_TOKEN: 'inherited-fixture-token', LOCAL_AGENT_PORT: '0' })
  const manager = new SidecarManager({ config: { dataDir: root, agentDir: fileURLToPath(new URL('../../services/local-agent', import.meta.url)) } })
  try {
    const endpoint = await manager.start()
    assert.notEqual(endpoint.token, 'inherited-fixture-token')
    assert.ok(endpoint.baseUrl.startsWith('http://127.0.0.1:'))
  } finally {
    await manager.stop()
    for (const [name, value] of Object.entries(previous)) value === undefined ? delete process.env[name] : process.env[name] = value
    fs.rmSync(root, { recursive: true, force: true })
  }
})
