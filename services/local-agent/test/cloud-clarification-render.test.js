import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { startTestServer, multipart, waitForSnapshot } from './helpers.js'

test('fresh central account logs into native Agent and renders three grouped-bar charts after guided choices', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cloud-clarify-render-'))
  let cloud, local
  const cloudCalls = []
  try {
    cloud = await startTestServer(1, { persist: true, dataDir: path.join(root, 'cloud'), cloudAccountUrl: '' })
    cloud.agent.identityStore.register({ username: 'renderresearcher', password: 'render-test-password', displayName: 'Researcher', bootstrap: true })
    const cloudFetch = (url, init) => {
      const endpoint = new URL(url).pathname
      cloudCalls.push(endpoint)
      return fetch(cloud.base + endpoint, init)
    }
    local = await startTestServer(1, { persist: true, dataDir: path.join(root, 'native'), cloudAccountUrl: 'https://accounts.example.invalid', cloudAccountFetch: cloudFetch })
    const login = await fetch(local.base + '/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username: 'renderresearcher', password: 'render-test-password' }) })
    assert.equal(login.status, 200)
    const session = await login.json()
    const client = { ...local, token: session.token }
    const csv = Buffer.from('group,sample,value\nControl,1,2\nControl,2,3\nControl,3,4\nTreatment,1,4\nTreatment,2,5\nTreatment,3,6\n')
    const upload = multipart({ prompt: '按 group 分组，value 为测量值，sample 是重复观测编号，显示组间对比', engine: 'python', clarify: 'true' }, [{ fileName: 'experiment.csv', content: csv }])
    const created = await fetch(local.base + '/api/tasks', { method: 'POST', headers: { authorization: `Bearer ${session.token}`, 'content-type': upload.contentType, 'x-agent-protocol': '1' }, body: upload.body })
    assert.equal(created.status, 201)
    const { taskId } = await created.json()
    for (let round = 1; round <= 3; round++) {
      const pending = await waitForSnapshot(client, taskId, task => task.state === 'NEED_INPUT' && task.pendingQuestion?.round === round, { timeout: 30000 })
      if (round === 2) assert.ok(pending.pendingQuestion.options.some(option => option.includes('分组柱状') && option.includes('误差棒')))
      if (round === 3) assert.ok(pending.pendingQuestion.recommendedPalettes.length > 0)
      const answer = round === 1 ? '组间直接对比' : round === 2 ? '分组柱状图（均值+误差棒）' : '标题=Yield；图注=Figure 1 Yield by treatment；标注语言=英文；图例位置=图外底部；配色=推荐'
      const answered = await fetch(`${local.base}/api/tasks/${taskId}/answer`, { method: 'POST', headers: { authorization: `Bearer ${session.token}`, 'content-type': 'application/json' }, body: JSON.stringify({ answer }) })
      assert.equal(answered.status, 200)
    }
    const result = await waitForSnapshot(client, taskId, task => ['PRESENT', 'FAILED'].includes(task.state), { timeout: 180000 })
    assert.equal(result.state, 'PRESENT', JSON.stringify(result.error))
    assert.equal(result.plans.length, 3)
    assert.equal(result.clarification.chartType, 'grouped_bar')
    assert.equal(result.clarification.labelLanguage, 'en')
    assert.equal(result.clarification.legendPosition, 'bottom')
    assert.ok(result.clarification.paletteId)
    const stored = local.agent.store.get(taskId)
    for (const plan of result.plans) {
      assert.equal(plan.executionStatus, 'verified')
      assert.ok(plan.spec.panels.every(panel => panel.layers.every(layer => layer.kind === 'bar')))
      assert.equal(plan.spec.panels[0].legend.position, 'bottom')
      assert.equal(plan.spec.figure.title, 'Yield')
      assert.equal(plan.palette.id, result.clarification.paletteId)
      const artifact = stored.artifacts[plan.plan_id]
      const svg = artifact.inline.svg
      assert.match(svg, /<svg/)
      assert.match(svg, /Yield/)
      assert.ok(artifact.png.width > 320 && artifact.png.height > 240)
    }
    assert.ok(cloudCalls.every(endpoint => ['/api/auth/login', '/api/auth/me', '/api/user-profile'].includes(endpoint)), 'CSV/chat/tasks must stay in the native Agent')
    assert.equal(cloud.agent.store.tasks.size, 0, 'the central account service receives no plot task')
  } finally {
    if (local) await local.close()
    if (cloud) await cloud.close()
    fs.rmSync(root, { recursive: true, force: true })
  }
})
