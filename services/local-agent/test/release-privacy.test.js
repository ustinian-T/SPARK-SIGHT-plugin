import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { IdentityStore } from '../src/platform.js'
import { validateModelSettings } from '../src/modelSettings.js'
import { startTestServer } from './helpers.js'
import { resolvePublicProvider } from '../src/providerFetch.js'
import { anthropicEndpoint } from '../src/llm/anthropic.js'
import { UploadStore } from '../src/uploads.js'

test('registration selects personal configuration and cannot enable shared credentials', () => {
  const store = new IdentityStore()
  const { user } = store.register({ username: 'researcher', password: 'test-password-long', agreementAccepted: true })
  assert.deepEqual(user.modelAccess, { allowOwn: true, allowShared: false })
  assert.equal(user.modelSource, 'own')
  assert.throws(() => store.updateUser(user.userId, { modelAccess: { allowOwn: true, allowShared: true } }))
  assert.throws(() => store.setModelSource(user.userId, 'shared'))
})

test('custom provider metadata and manual model directory survive validation', async () => {
  const input = { providerId: 'my-gateway', displayName: 'Research API', baseUrl: 'https://api.example.com/v1', protocol: 'chat_completions', model: 'research-model', models: ['research-model', 'other-model'], apiKey: 'test-key' }
  const valid = await validateModelSettings(input, async () => [{ address: '8.8.8.8', family: 4 }])
  assert.equal(valid.providerId, input.providerId)
  assert.deepEqual(valid.models, input.models)
  await assert.rejects(validateModelSettings({ ...input, providerId: '../invalid' }, async () => [{ address: '8.8.8.8', family: 4 }]))
})

test('request-time DNS rejects private and mixed answers before connecting', async () => {
  for (const address of ['127.0.0.1', '169.254.169.254', '::1', '::ffff:127.0.0.1', '2002:7f00:1::']) {
    await assert.rejects(resolvePublicProvider('https://gateway.example/v1', async () => [{ address, family: address.includes(':') ? 6 : 4 }]))
  }
  await assert.rejects(resolvePublicProvider('https://gateway.example/v1', async () => [{ address: '8.8.8.8', family: 4 }, { address: '10.0.0.1', family: 4 }]))
  const pinned = await resolvePublicProvider('https://gateway.example/v1', async () => [{ address: '8.8.8.8', family: 4 }])
  assert.equal(pinned.address.address, '8.8.8.8')
  assert.equal(anthropicEndpoint('https://api.anthropic.com/v1'), 'https://api.anthropic.com/v1/messages')
})

test('invalid delegated identity never falls back to host privileges', async () => {
  const h = await startTestServer()
  try {
    const res = await fetch(h.base + '/api/local/ui', { headers: { authorization: 'Bearer ' + h.token, 'x-user-token': 'invalid-user-session' } })
    assert.equal(res.status, 401)
  } finally { await h.close() }
})

test('accounts cannot read peer preferences or access nested peer task endpoints', async () => {
  const h = await startTestServer()
  try {
    const a = h.agent.identityStore.register({ username: 'isolatea', password: 'test-password-long', agreementAccepted: true })
    const b = h.agent.identityStore.register({ username: 'isolateb', password: 'test-password-long', agreementAccepted: true })
    h.agent.preferenceStore.append({ event_id: 'host-private-event', summary: 'private host history' })
    const headers = { authorization: 'Bearer ' + b.token }
    const result = await (await fetch(h.base + '/api/preferences', { headers })).json()
    assert.ok(!JSON.stringify(result).includes('private host history'))
    const task = h.agent.store.create({ prompt: 'private task', engine: 'python', fileName: 'fixture.csv', bytes: Buffer.from('x,y\n1,2'), tenantId: a.user.userId })
    assert.equal((await fetch(h.base + `/api/tasks/${task.taskId}/patches/preview`, { method: 'POST', headers: { ...headers, 'content-type': 'application/json' }, body: '{}' })).status, 404)
  } finally { await h.close() }
})

test('abandoned upload deletion checks ownership and removes confidential bytes', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'spark-upload-'))
  try {
    const store = new UploadStore(root)
    const entry = store.create('alice', { fileName: 'data.csv', totalBytes: 4 })
    store.append('alice', entry.uploadId, { offset: 0, chunk: Buffer.from('data') })
    const file = store.consume('alice', entry.uploadId)
    assert.throws(() => store.remove('bob', entry.uploadId))
    store.remove('alice', entry.uploadId)
    assert.equal(fs.existsSync(file), false)
    assert.throws(() => store.status('alice', entry.uploadId))
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})

test('login endpoint throttles repeated password guesses', async () => {
  const h = await startTestServer()
  try {
    let response
    for (let i = 0; i < 21; i++) response = await fetch(h.base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'guess-target', password: 'invalid-password' }) })
    assert.equal(response.status, 429)
  } finally { await h.close() }
})

test('local keys are encrypted, omitted from responses and separated between users', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'spark-privacy-'))
  const h = await startTestServer(1, { dataDir, persist: true, modelSettingsValidator: async value => value })
  try {
    const a = h.agent.identityStore.register({ username: 'researcha', password: 'test-password-long', agreementAccepted: true })
    const b = h.agent.identityStore.register({ username: 'researchb', password: 'test-password-long', agreementAccepted: true })
    const headers = token => ({ authorization: 'Bearer ' + token, 'content-type': 'application/json' })
    const config = { providerId: 'my-api', displayName: 'Mine', baseUrl: 'https://api.example.com/v1', protocol: 'chat_completions', model: 'm', models: ['m'], apiKey: 'privacy-fixture-key' }
    assert.equal((await fetch(h.base + '/api/local/settings', { method: 'PUT', headers: headers(a.token), body: JSON.stringify({ model: config }) })).status, 200)
    const view = await (await fetch(h.base + '/api/local/settings', { headers: headers(a.token) })).json()
    assert.equal(view.model.configured, true)
    assert.equal(view.model.apiKey, undefined)
    const other = await (await fetch(h.base + '/api/local/settings', { headers: headers(b.token) })).json()
    assert.equal(other.model.configured, false)
    for (const name of fs.readdirSync(dataDir)) if (name.endsWith('.json')) assert.ok(!fs.readFileSync(path.join(dataDir, name), 'utf8').includes(config.apiKey), name)
  } finally { await h.close(); fs.rmSync(dataDir, { recursive: true, force: true }) }
})
