import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startTestServer } from './helpers.js'

async function request(base, endpoint, { token, method = 'GET', body } = {}) {
  const response = await fetch(base + endpoint, {
    method,
    headers: { 'x-agent-protocol': '1', ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  })
  return { status: response.status, body: await response.json() }
}
async function login(base, username) {
  const result = await request(base, '/api/auth/login', { method: 'POST', body: { username, password: 'profile-test-password' } })
  assert.equal(result.status, 200)
  return result.body
}

test('account profiles synchronize across three authenticated clients, remain isolated and survive cloud restart', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-profile-api-'))
  let cloud
  const clients = []
  try {
    cloud = await startTestServer(1, { persist: true, dataDir: path.join(root, 'cloud'), cloudAccountUrl: '' })
    const alice = cloud.agent.identityStore.register({ username: 'profilealice', password: 'profile-test-password', displayName: 'Alice', bootstrap: true })
    const bob = cloud.agent.identityStore.register({ username: 'profilebob', password: 'profile-test-password', displayName: 'Bob', bootstrap: true })
    // Each local sidecar has a separate identity vault/data volume. The transport
    // fixture stands in for HTTPS while retaining the actual central HTTP API.
    const cloudFetch = (url, options) => fetch(cloud.base + new URL(url).pathname, options)
    for (const name of ['desktop', 'vscode', 'dsh']) {
      clients.push(await startTestServer(1, { persist: true, dataDir: path.join(root, name), cloudAccountUrl: 'https://accounts.example.invalid', cloudAccountFetch: cloudFetch }))
    }
    const sessions = await Promise.all(clients.map(client => login(client.base, 'profilealice')))
    assert.ok(sessions.every(session => session.user.userId === alice.user.userId))
    assert.equal(new Set(sessions.map(session => session.token)).size, 3, '客户端本机会话互不复用')
    const saved = await request(clients[0].base, '/api/user-profile', { token: sessions[0].token, method: 'PUT', body: {
      expectedRevision: 0,
      profile: { researchField: '  农学  ', experienceLevel: 'advanced', labelLanguage: 'en', outputPurpose: 'paper', paletteId: 'calm_blue', legendPosition: 'right', clarificationMode: 'minimal', prompt: 'private prompt', dataset: 'private CSV', apiKey: 'private secret', role: 'admin', ownerId: bob.user.userId },
    } })
    assert.equal(saved.status, 200)
    const expected = { researchField: '农学', experienceLevel: 'advanced', labelLanguage: 'en', outputPurpose: 'paper', paletteId: 'calm_blue', legendPosition: 'right', clarificationMode: 'minimal' }
    assert.deepEqual(saved.body.profile, expected)
    assert.equal(saved.body.revision, 1)
    assert.ok(Number.isFinite(saved.body.updatedAt))
    for (let index = 1; index < clients.length; index++) {
      const loaded = await request(clients[index].base, '/api/user-profile', { token: sessions[index].token })
      assert.equal(loaded.status, 200)
      assert.deepEqual(loaded.body, saved.body)
    }
    const bobSession = await login(clients[1].base, 'profilebob')
    const bobProfile = await request(clients[1].base, `/api/user-profile?userId=${alice.user.userId}`, { token: bobSession.token })
    assert.equal(bobProfile.status, 200)
    assert.deepEqual(bobProfile.body.profile, {})
    const bobSave = await request(clients[1].base, '/api/user-profile', { token: bobSession.token, method: 'PUT', body: { expectedRevision: 0, userId: alice.user.userId, profile: { labelLanguage: 'zh', ownerId: alice.user.userId } } })
    assert.equal(bobSave.status, 200)
    assert.deepEqual(bobSave.body.profile, { labelLanguage: 'zh' })
    assert.deepEqual((await request(clients[0].base, '/api/user-profile', { token: sessions[0].token })).body.profile, expected)
    const stale = await request(clients[2].base, '/api/user-profile', { token: sessions[2].token, method: 'PUT', body: { expectedRevision: 0, profile: { labelLanguage: 'bilingual' } } })
    assert.equal(stale.status, 409)
    assert.equal(stale.body.error.code, 'SYNC_CONFLICT')
    const partial = await request(clients[2].base, '/api/user-profile', { token: sessions[2].token, method: 'PUT', body: { expectedRevision: 1, profile: { researchField: null, paletteId: '../../evil', experienceLevel: 'invented', labelLanguage: 'bilingual' } } })
    assert.equal(partial.status, 200)
    const { researchField: _removed, ...retained } = expected
    assert.deepEqual(partial.body.profile, { ...retained, labelLanguage: 'bilingual' })
    await cloud.close()
    cloud = await startTestServer(1, { persist: true, dataDir: path.join(root, 'cloud'), cloudAccountUrl: '' })
    const reloaded = await request(clients[0].base, '/api/user-profile', { token: sessions[0].token })
    assert.equal(reloaded.status, 200)
    assert.deepEqual(reloaded.body, partial.body)
    assert.deepEqual((await request(clients[1].base, '/api/user-profile', { token: bobSession.token })).body.profile, { labelLanguage: 'zh' })
    const disk = fs.readFileSync(path.join(root, 'cloud', 'user-plot-profiles.json'), 'utf8')
    assert.ok(!disk.includes('private prompt') && !disk.includes('private CSV') && !disk.includes('private secret'))
  } finally {
    await Promise.all(clients.map(client => client.close()))
    await cloud?.close()
    assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep))
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('profile API rejects unauthenticated, invalid, anonymous and bootstrap-only identities', async () => {
  const server = await startTestServer(1, { cloudAccountUrl: '' })
  try {
    for (const method of ['GET', 'PUT']) {
      const body = method === 'PUT' ? { profile: { labelLanguage: 'en' } } : undefined
      assert.equal((await request(server.base, '/api/user-profile', { method, body })).status, 401)
      assert.equal((await request(server.base, '/api/user-profile', { method, body, token: 'invalid-bearer' })).status, 401)
      assert.equal((await request(server.base, '/api/user-profile', { method, body, token: server.token })).status, 403)
      const anonymous = server.agent.identityStore.anonymous()
      assert.equal((await request(server.base, '/api/user-profile', { method, body, token: anonymous.token })).status, 403)
    }
  } finally { await server.close() }
})
