import test from 'node:test'
import assert from 'node:assert/strict'
import { multipart, startTestServer, TOKEN } from './helpers.js'

async function createBundle(h) {
  const { body, contentType } = multipart(
    { prompt: '比较不同实验批次指标变化' },
    [
      { field: 'files', fileName: 'batch-a.csv', content: Buffer.from('time,value_a\n1,2\n2,4\n3,6\n') },
      { field: 'files', fileName: 'batch-b.csv', content: Buffer.from('time,value_b\n1,3\n2,5\n3,7\n') },
      { field: 'files', fileName: 'batch-c.json', content: Buffer.from(JSON.stringify([{ time: 1, value_c: 8 }, { time: 2, value_c: 9 }, { time: 3, value_c: 10 }])) }
    ]
  )
  const res = await fetch(`${h.base}/api/bundles`, {
    method: 'POST', headers: { 'content-type': contentType, authorization: `Bearer ${TOKEN}` }, body
  })
  return { res, json: await res.json() }
}

test('bundle analysis recommends relations but creates no task before confirmation', async () => {
  const h = await startTestServer(1, { runSandbox: async ({ engine }) => ({ status: 'cancelled', engine, cancelled: true, artifacts: [], missingArtifacts: [] }) })
  try {
    const created = await createBundle(h)
    assert.equal(created.res.status, 201)
    assert.equal(created.json.files.length, 3)
    assert.ok(created.json.recommendations.length >= 3)
    assert.equal(h.agent.store.tasks.size, 0, 'confirmation is a hard execution gate')
    assert.ok(created.json.recommendations.every((item) => item.alignment && typeof item.confidence === 'number'))
  } finally { await h.close() }
})

test('one decision request may accept multiple recommendations into isolated branches', async () => {
  const h = await startTestServer(1, { runSandbox: async ({ engine }) => ({ status: 'cancelled', engine, cancelled: true, artifacts: [], missingArtifacts: [] }) })
  try {
    const created = await createBundle(h)
    const selected = created.json.recommendations.filter((item) => item.executable).slice(0, 2)
    assert.equal(selected.length, 2)
    const res = await fetch(`${h.base}/api/bundles/${created.json.bundleId}/decisions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${TOKEN}` },
      body: JSON.stringify({ decisions: selected.map((item) => ({ recommendationId: item.recommendationId, action: 'accept' })) })
    })
    const json = await res.json()
    assert.equal(res.status, 202)
    assert.equal(json.branches.length, 2)
    assert.equal(new Set(json.branches.map((item) => item.taskId)).size, 2)
    assert.equal(h.agent.store.tasks.size, 2)
    for (const branch of json.branches) assert.equal(h.agent.store.get(branch.taskId).recommendationId, branch.recommendationId)
  } finally {
    for (const task of h.agent.store.tasks.values()) task.abortController.abort()
    await h.close()
  }
})
