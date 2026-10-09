import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { validateModelSettings } from '../src/modelSettings.js'
import { startTestServer } from './helpers.js'

const settings = { baseUrl: 'https://api.example.com/v1', model: 'test-model', apiKey: 'example-test-credential', protocol: 'responses' }
test('model configuration rejects private addresses and insecure endpoints', async () => {
  for (const address of ['127.0.0.1', '10.0.0.2', '169.254.169.254', '192.168.1.1', '172.16.0.1', '::1', '::ffff:127.0.0.1']) {
    await assert.rejects(validateModelSettings(settings, async () => [{ address, family: address.includes(':') ? 6 : 4 }]))
  }
  await assert.rejects(validateModelSettings({ ...settings, baseUrl: 'http://api.example.com' }))
  await assert.rejects(validateModelSettings({ ...settings, baseUrl: 'https://user:pass@api.example.com' }))
  const result = await validateModelSettings(settings, async () => [{ address: '8.8.8.8', family: 4 }])
  assert.equal(result.provider, 'openai')
  assert.equal(result.apiKey, settings.apiKey)
})

test('native UI history persists through Agent restart and requires authorization', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-local-settings-'))
  let h = await startTestServer(1, { dataDir })
  const headers = { authorization: `Bearer ${h.token}`, 'x-agent-protocol': '1', 'content-type': 'application/json' }
  try {
    assert.equal((await fetch(`${h.base}/api/local/ui`)).status, 401)
    const saved = { messages: [{ role: 'user', text: 'local-only chat' }], task: null }
    assert.equal((await fetch(`${h.base}/api/local/ui`, { method: 'PUT', headers, body: JSON.stringify(saved) })).status, 200)
    await h.close()
    h = await startTestServer(1, { dataDir })
    assert.deepEqual(await (await fetch(`${h.base}/api/local/ui`, { headers })).json(), saved)
    assert.equal((await fetch(`${h.base}/api/test/config`)).status, 401)
  } finally { await h.close(); fs.rmSync(dataDir, { recursive: true, force: true }) }
})

test('public test mode cannot read native stored settings or UI history', async () => {
  const previous = process.env.TEST_WEB_MODE
  process.env.TEST_WEB_MODE = '1'
  const h = await startTestServer()
  try {
    const response = await fetch(`${h.base}/api/test/config`)
    assert.equal(response.headers.get('cache-control'), 'no-store')
    assert.equal((await response.json()).token, h.token)
    for (const route of ['/api/local/ui', '/api/local/settings']) {
      assert.equal((await fetch(`${h.base}${route}`, { headers: { authorization: `Bearer ${h.token}`, 'x-agent-protocol': '1' } })).status, 403)
    }
    const form = new FormData()
    form.append('prompt', '绘制 x 和 y')
    form.append('engine', 'matlab')
    form.append('file', new Blob(['x,y\n1,2\n2,3\n'], { type: 'text/csv' }), 'data.csv')
    const forbiddenEngine = await fetch(`${h.base}/api/tasks`, {
      method: 'POST', headers: { authorization: `Bearer ${h.token}`, 'x-agent-protocol': '1' }, body: form
    })
    assert.equal(forbiddenEngine.status, 400)
    assert.equal((await forbiddenEngine.json()).error.code, 'INVALID_ENGINE')
  } finally { await h.close(); if (previous === undefined) delete process.env.TEST_WEB_MODE; else process.env.TEST_WEB_MODE = previous }
})

test('public web mode requires accounts and never exposes the test token', async () => {
  const previous = process.env.LOCAL_AGENT_WEB_ONLY
  process.env.LOCAL_AGENT_WEB_ONLY = '1'
  const h = await startTestServer()
  try {
    assert.equal((await fetch(`${h.base}/api/test/config`)).status, 401)
    assert.equal((await fetch(`${h.base}/api/auth/anonymous`, { method: 'POST' })).status, 403)
    assert.equal((await fetch(`${h.base}/api/local/settings`, {
      headers: { authorization: `Bearer ${h.token}`, 'x-agent-protocol': '1' }
    })).status, 403)
    const capabilities = await (await fetch(`${h.base}/api/capabilities`, {
      headers: { authorization: `Bearer ${h.token}`, 'x-agent-protocol': '1' }
    })).json()
    assert.equal(capabilities.runtimes.matlab, undefined)
  } finally {
    await h.close()
    if (previous === undefined) delete process.env.LOCAL_AGENT_WEB_ONLY
    else process.env.LOCAL_AGENT_WEB_ONLY = previous
  }
})
