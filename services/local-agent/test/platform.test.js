import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { FileCloudAdapter } from '../src/platform.js'
import { startTestServer } from './helpers.js'

async function json(base, pathName, { method = 'GET', token, body } = {}) {
  const response = await fetch(`${base}${pathName}`, {
    method,
    headers: { ...(token ? { authorization: `Bearer ${token}` } : {}), ...(body ? { 'content-type': 'application/json' } : {}) },
    body: body ? JSON.stringify(body) : undefined
  })
  return { response, value: await response.json() }
}

test('anonymous/account modes issue scoped user identities', async () => {
  const h = await startTestServer()
  try {
    const anonymous = await json(h.base, '/api/auth/anonymous', { method: 'POST' })
    assert.equal(anonymous.response.status, 201)
    const anonMe = await json(h.base, '/api/auth/me', { token: anonymous.value.token })
    assert.equal(anonMe.value.user.kind, 'anonymous')
    const registered = await json(h.base, '/api/auth/register', { method: 'POST', body: { username: 'scientist', password: 'long-password-123', displayName: '研究员', agreementAccepted: true, agreementVersion: 'test-v1' } })
    assert.equal(registered.response.status, 201)
    const login = await json(h.base, '/api/auth/login', { method: 'POST', body: { username: 'scientist', password: 'long-password-123' } })
    assert.equal(login.response.status, 200)
    assert.equal(login.value.user.userId, registered.value.user.userId)
  } finally { await h.close() }
})

test('project save/open, processing locks, cloud sync and expiring read-only share', async () => {
  const cloudRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-imaging-cloud-'))
  const h = await startTestServer(1, { cloudAdapter: new FileCloudAdapter(cloudRoot) })
  try {
    const auth = await json(h.base, '/api/auth/anonymous', { method: 'POST' })
    const token = auth.value.token
    const created = await json(h.base, '/api/projects', { method: 'POST', token, body: { name: '联合实验项目' } })
    assert.equal(created.response.status, 201)
    const projectId = created.value.project.projectId
    const locks = await json(h.base, `/api/projects/${projectId}/locks`, { method: 'PUT', token, body: { locks: { filter: true, normalize: { mode: 'baseline' } } } })
    assert.deepEqual(Object.keys(locks.value.lockedSteps).sort(), ['filter', 'normalize'])
    const synced = await json(h.base, `/api/projects/${projectId}/sync`, { method: 'POST', token, body: { direction: 'push' } })
    assert.equal(synced.value.project.cloud.status, 'synced')
    const reopened = await json(h.base, `/api/projects/${projectId}`, { token })
    assert.equal(reopened.value.project.name, '联合实验项目')
    assert.equal(reopened.value.project.lockedSteps.normalize.mode, 'baseline')
    const share = await json(h.base, `/api/projects/${projectId}/shares`, { method: 'POST', token, body: { expiresInMs: 60_000, includeCode: false } })
    const publicView = await json(h.base, `/api/shares/${share.value.share.token}`)
    assert.equal(publicView.response.status, 200)
    assert.equal(publicView.value.readOnly, true)
    assert.equal(publicView.value.project.projectId, projectId)
    const revoked = await json(h.base, `/api/projects/${projectId}/shares/${share.value.share.shareId}`, { method: 'DELETE', token })
    assert.ok(revoked.value.share.revokedAt)
    const gone = await json(h.base, `/api/shares/${share.value.share.token}`)
    assert.equal(gone.response.status, 404)
  } finally { await h.close(); fs.rmSync(cloudRoot, { recursive: true, force: true }) }
})
