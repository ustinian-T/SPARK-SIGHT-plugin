import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { AuthManager } from '../src/auth.js'
import { RateLimiter } from '../src/rateLimit.js'
import { UploadStore } from '../src/uploads.js'
import { sandboxCapabilities, assertExecutionAllowed, runInSandbox } from '../src/sandbox.js'
import { createServer } from '../src/server.js'
import { FAST_PROBE, multipart } from './helpers.js'

test('remote sessions are tenant-bound, expiring, and signed downloads reject tampering/expiry', () => {
  let now = 1_000_000
  const auth = new AuthManager({ secret: 'test-signing-secret-32-bytes-long', now: () => now, sessionTtlMs: 1000 })
  const alice = auth.createSession({ tenantId: 'alice', subject: 'user-a' })
  assert.equal(auth.authenticate(`Bearer ${alice.token}`).tenantId, 'alice')
  const signed = auth.signDownload({ tenantId: 'alice', taskId: 'task-1', planId: 'plan-1', ttlMs: 500 })
  assert.equal(auth.verifyDownload(signed).taskId, 'task-1')
  assert.throws(() => auth.verifyDownload({ ...signed, taskId: 'task-2' }), (error) => error.code === 'SIGNED_URL_INVALID')
  now += 501
  assert.throws(() => auth.verifyDownload(signed), (error) => error.code === 'SIGNED_URL_EXPIRED')
  now += 500
  assert.throws(() => auth.authenticate(`Bearer ${alice.token}`), (error) => error.code === 'SESSION_EXPIRED')
})

test('rate limiter separates tenants and enforces request and concurrent-task quotas', () => {
  let now = 0
  const limits = new RateLimiter({ windowMs: 1000, maxRequests: 2, maxConcurrentTasks: 1, now: () => now })
  assert.doesNotThrow(() => limits.consume('alice'))
  assert.doesNotThrow(() => limits.consume('alice'))
  assert.throws(() => limits.consume('alice'), (error) => error.code === 'RATE_LIMITED')
  assert.doesNotThrow(() => limits.consume('bob'))
  limits.beginTask('alice')
  assert.throws(() => limits.beginTask('alice'), (error) => error.code === 'QUOTA_EXCEEDED')
  limits.endTask('alice')
  assert.doesNotThrow(() => limits.beginTask('alice'))
  now = 1001
  assert.doesNotThrow(() => limits.consume('alice'))
})

test('resumable uploads enforce tenant isolation, contiguous ranges, and byte quota', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-imaging-upload-'))
  const uploads = new UploadStore(root, { maxBytes: 12 })
  const session = uploads.create('alice', { fileName: 'data.csv', totalBytes: 11 })
  assert.equal(uploads.append('alice', session.uploadId, { offset: 0, chunk: Buffer.from('a,b\n1,') }).receivedBytes, 6)
  assert.throws(() => uploads.status('bob', session.uploadId), (error) => error.code === 'UPLOAD_NOT_FOUND')
  assert.throws(() => uploads.append('alice', session.uploadId, { offset: 2, chunk: Buffer.from('bad') }), (error) => error.code === 'UPLOAD_OFFSET_MISMATCH')
  const done = uploads.append('alice', session.uploadId, { offset: 6, chunk: Buffer.from('2\n3,4') })
  assert.equal(done.complete, true)
  assert.equal(fs.readFileSync(uploads.consume('alice', session.uploadId)).toString(), 'a,b\n1,2\n3,4')
  assert.throws(() => uploads.create('alice', { fileName: 'huge.csv', totalBytes: 13 }), (error) => error.code === 'UPLOAD_TOO_LARGE')
})

test('custom source is refused under weak sandbox while generated source reports honest limits', () => {
  const capabilities = sandboxCapabilities()
  assert.equal(capabilities.generatedCode, true)
  assert.ok(Array.isArray(capabilities.enforced))
  assert.ok(Array.isArray(capabilities.notEnforced))
  if (!capabilities.customCode) assert.throws(() => assertExecutionAllowed({ sourceKind: 'custom' }), (error) => error.code === 'STRONG_SANDBOX_REQUIRED')
  assert.doesNotThrow(() => assertExecutionAllowed({ sourceKind: 'generated' }))
})

test('generated-code sandbox enforces artifact output quota', async () => {
  const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-imaging-output-quota-'))
  const result = await runInSandbox({
    workdir, engine: 'python', code: 'open("huge.svg", "w", encoding="utf-8").write("x" * 1024)',
    csvBuffer: Buffer.from('a,b\n1,2\n'), csvName: 'data.csv', expected: ['huge.svg'], maxArtifactBytes: 32
  })
  assert.equal(result.status, 'error')
  assert.deepEqual(result.missingArtifacts, ['huge.svg:quota_exceeded'])
})

test('remote HTTP mode isolates tenants, resumes uploads, and serves expiring signed exports', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-imaging-remote-api-'))
  const agent = createServer({
    host: '127.0.0.1', port: 0, token: 'local-admin', persist: false, dataDir, stepDelayMs: 1, probeEngines: FAST_PROBE,
    remote: {
      enabled: true, secret: 'remote-test-signing-secret-at-least-32',
      users: { 'alice-key': { tenantId: 'alice' }, 'bob-key': { tenantId: 'bob' } },
      rateLimit: { maxRequests: 1000, maxConcurrentTasks: 2 }
    }
  })
  const started = await agent.start()
  const base = `http://127.0.0.1:${started.port}`
  const session = async (key) => {
    const response = await fetch(`${base}/api/auth/session`, { method: 'POST', headers: { 'x-api-key': key } })
    assert.equal(response.status, 201)
    return (await response.json()).token
  }
  const alice = await session('alice-key')
  const bob = await session('bob-key')
  const headers = (value, extra = {}) => ({ authorization: `Bearer ${value}`, ...extra })
  try {
    const upload = await fetch(`${base}/api/uploads`, { method: 'POST', headers: headers(alice, { 'content-type': 'application/json' }), body: JSON.stringify({ fileName: 'resume.csv', totalBytes: 7 }) })
    const uploadSession = await upload.json()
    let chunk = await fetch(`${base}/api/uploads/${uploadSession.uploadId}`, { method: 'PUT', headers: headers(alice, { 'x-upload-offset': '0' }), body: Buffer.from('a,b\n') })
    assert.equal((await chunk.json()).receivedBytes, 4)
    chunk = await fetch(`${base}/api/uploads/${uploadSession.uploadId}`, { method: 'PUT', headers: headers(alice, { 'x-upload-offset': '4' }), body: Buffer.from('1,2') })
    assert.equal((await chunk.json()).complete, true)
    assert.equal((await fetch(`${base}/api/uploads/${uploadSession.uploadId}`, { headers: headers(bob) })).status, 404)
    const resumedTask = await fetch(`${base}/api/uploads/${uploadSession.uploadId}/tasks`, { method: 'POST', headers: headers(alice, { 'content-type': 'application/json' }), body: JSON.stringify({ prompt: '绘制 a 和 b', engine: 'python' }) })
    assert.equal(resumedTask.status, 201)
    assert.match((await resumedTask.json()).taskId, /^task_/)

    const csv = Buffer.from('week,a,b\n1,2,3\n2,4,5\n3,6,7\n4,8,9\n')
    const form = multipart({ prompt: '比较 a 和 b 趋势', engine: 'python' }, [{ fileName: 'remote.csv', content: csv }])
    const createdResponse = await fetch(`${base}/api/tasks`, { method: 'POST', headers: headers(alice, { 'content-type': form.contentType }), body: form.body })
    assert.equal(createdResponse.status, 201)
    const created = await createdResponse.json()
    assert.equal((await fetch(`${base}/api/tasks/${created.taskId}`, { headers: headers(bob) })).status, 404)
    let task
    const deadline = Date.now() + 60_000
    do {
      const response = await fetch(`${base}/api/tasks/${created.taskId}`, { headers: headers(alice) })
      task = await response.json()
      if (task.state === 'PRESENT') break
      await new Promise((resolve) => setTimeout(resolve, 30))
    } while (Date.now() < deadline)
    assert.equal(task.state, 'PRESENT')
    const signedResponse = await fetch(`${base}/api/tasks/${created.taskId}/export/sign`, { method: 'POST', headers: headers(alice, { 'content-type': 'application/json' }), body: JSON.stringify({ planId: task.plans[0].plan_id, ttlMs: 10_000 }) })
    assert.equal(signedResponse.status, 200)
    const signed = await signedResponse.json()
    const download = await fetch(`${base}${signed.url}`)
    assert.equal(download.status, 200)
    assert.equal(download.headers.get('content-type'), 'application/zip')
    assert.ok((await download.arrayBuffer()).byteLength > 1000)
  } finally {
    await agent.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})
