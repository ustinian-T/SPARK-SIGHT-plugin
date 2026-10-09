import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startTestServer } from './helpers.js'
import { CloudAccountClient } from '../src/cloudAccounts.js'

const cloudUser = { userId: 'user_cloud_member', username: 'cloudmember', displayName: '云端成员', role: 'user', status: 'active', expiresAt: Date.now() + 86400000 }
function accountFixture() {
  const calls = []
  const fetchImpl = async (url, init = {}) => {
    const endpoint = new URL(url).pathname
    calls.push({ endpoint, method: init.method ?? 'GET', body: init.body ? JSON.parse(init.body) : undefined })
    if (endpoint === '/api/auth/login') {
      const credentials = JSON.parse(init.body)
      return Response.json(credentials.password === 'test-cloud-password' ? { user: cloudUser, token: 'test-cloud-bearer' } : { error: { code: 'AUTH_FAILED', message: '账户名或密码错误' } }, { status: credentials.password === 'test-cloud-password' ? 200 : 401 })
    }
    assert.equal(init.headers.authorization, 'Bearer test-cloud-bearer')
    if (endpoint === '/api/auth/me') return Response.json({ user: cloudUser })
    if (endpoint === '/api/auth/logout') return Response.json({ ok: true })
    if (endpoint === '/api/user-profile') return Response.json({ profile: { labelLanguage: 'en', legendPosition: 'bottom' }, revision: 2, updatedAt: 1 })
    throw Error('Local data must not be sent to cloud: ' + endpoint)
  }
  return { calls, fetchImpl }
}

test('云会话重启恢复、离线缓存、服务器撤销与本地退出', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-cloud-session-'))
  let mode = 'online'
  const fixture = accountFixture()
  const fetchImpl = async (...args) => {
    if (mode === 'offline') throw Error('offline')
    if (mode === 'revoked') return Response.json({ error: { message: '已撤销' } }, { status: 401 })
    return fixture.fetchImpl(...args)
  }
  try {
    const client = new CloudAccountClient({ baseUrl: 'https://accounts.example.invalid', root, fetchImpl })
    const login = await client.login({ username: 'cloudmember', password: 'test-cloud-password' })
    await client.profileForIdentity(client.verify(login.token))
    const restarted = new CloudAccountClient({ baseUrl: 'https://accounts.example.invalid', root, fetchImpl })
    assert.equal(restarted.resume().token, login.token)
    mode = 'offline'
    assert.equal((await restarted.me(login.token)).offline, true)
    assert.equal((await restarted.profileForIdentity(restarted.verify(login.token))).offline, true)
    mode = 'revoked'
    await assert.rejects(restarted.me(login.token), error => error.status === 401)
    assert.equal(restarted.resume(), null)
    assert.equal(restarted.verify(login.token), null)
    mode = 'online'
    const next = await restarted.login({ username: 'cloudmember', password: 'test-cloud-password' })
    mode = 'offline'
    await restarted.logout(next.token)
    assert.equal(restarted.resume(), null)
  } finally { fs.rmSync(root, { recursive: true, force: true }) }
})
async function request(base, endpoint, { token, body, method = 'GET' } = {}) {
  const res = await fetch(base + endpoint, { method, headers: { ...(token ? { authorization: 'Bearer ' + token } : {}), ...(body ? { 'content-type': 'application/json' } : {}) }, body: body ? JSON.stringify(body) : undefined })
  return { status: res.status, body: await res.json() }
}

test('客户端登录查询云账号，签发本地会话，项目留在本机，特征走云端', async () => {
  const fixture = accountFixture()
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-cloud-login-'))
  const h = await startTestServer(1, { persist: true, dataDir: root, cloudAccountUrl: 'https://accounts.example.invalid', cloudAccountFetch: fixture.fetchImpl })
  try {
    const login = await request(h.base, '/api/auth/login', { method: 'POST', body: { username: 'cloudmember', password: 'test-cloud-password' } })
    assert.equal(login.status, 200, '云端已注册账号应能登录本地客户端')
    assert.equal(login.body.user.userId, cloudUser.userId)
    assert.notEqual(login.body.token, 'test-cloud-bearer', '浏览器只接收本机会话')
    const profile = await request(h.base, '/api/user-profile', { token: login.body.token })
    assert.equal(profile.status, 200)
    assert.equal(profile.body.profile.labelLanguage, 'en')
    await request(h.base, '/api/user-profile', { token: login.body.token, method: 'PUT', body: { profile: { labelLanguage: 'en', legendPosition: null, apiKey: 'private-key', dataset: 'private-data', prompt: 'private-chat' }, expectedRevision: 2, chat: 'private-chat' } })
    const sentProfile = fixture.calls.find(call => call.endpoint === '/api/user-profile' && call.method === 'PUT').body
    assert.deepEqual(sentProfile, { profile: { labelLanguage: 'en', legendPosition: null }, expectedRevision: 2 })
    const project = await request(h.base, '/api/projects', { method: 'POST', token: login.body.token, body: { name: '本地私有项目' } })
    assert.equal(project.status, 201)
    assert.ok(project.body.project.projectId)
    assert.ok(!fixture.calls.some(call => call.endpoint.includes('projects')))
    const session = await request(h.base, '/api/auth/local-session', { token: h.token })
    assert.equal(session.body.session.token, login.body.token)
    assert.equal((await request(h.base, '/api/auth/local-session')).status, 401)
    const encrypted = fs.readFileSync(path.join(root, 'cloud-account-sessions.json'), 'utf8')
    assert.ok(!encrypted.includes('test-cloud-bearer') && !encrypted.includes(login.body.token) && !encrypted.includes('test-cloud-password'))
    await request(h.base, '/api/auth/logout', { token: login.body.token, method: 'POST' })
    assert.equal((await request(h.base, '/api/projects', { token: login.body.token })).status, 401)
  } finally { await h.close(); fs.rmSync(root, { recursive: true, force: true }) }
})

test('云端认证失败不得回退本机同名账号', async () => {
  const fixture = accountFixture()
  const h = await startTestServer(1, { cloudAccountUrl: 'https://accounts.example.invalid', cloudAccountFetch: fixture.fetchImpl })
  try {
    h.agent.identityStore.register({ username: 'cloudmember', password: 'local-password-123', displayName: '本机同名', bootstrap: true })
    const result = await request(h.base, '/api/auth/login', { method: 'POST', body: { username: 'cloudmember', password: 'local-password-123' } })
    assert.equal(result.status, 401, '本机同名密码不能替代云端认证')
    assert.ok(fixture.calls.some(call => call.endpoint === '/api/auth/login'))
  } finally { await h.close() }
})
