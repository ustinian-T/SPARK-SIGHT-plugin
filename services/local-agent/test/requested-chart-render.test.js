import test from 'node:test'
import assert from 'node:assert/strict'
import { startTestServer, multipart, waitForSnapshot, postJson } from './helpers.js'

test('adaptive clarification preserves requested waterfall and surface through real sandbox rendering', { timeout: 180000 }, async () => {
  const h = await startTestServer(1)
  try {
    const cases = [
      { kind: 'waterfall', csv: 'stage,increment,total\nStart,100,100\nCost,-18,82\nImprovement,26,108\nEnd,0,108\n', prompt: '展示从基线到终值的正负增量与累计贡献，使用贡献瀑布图。' },
      { kind: 'surface3d', csv: '温度,湿度,响应指标\n' + Array.from({ length: 25 }, (_, i) => `${20 + i % 5},${40 + Math.floor(i / 5)},${60 + i % 5 + Math.floor(i / 5) * 2}`).join('\n') + '\n', prompt: 'x轴为温度、y轴为湿度、z轴为响应指标，使用三维曲面图。' }
    ]
    for (const item of cases) {
      const upload = multipart({ prompt: item.prompt, engine: 'python', clarify: 'true' }, [{ fileName: item.kind + '.csv', content: item.csv }])
      const response = await fetch(h.base + '/api/tasks', { method: 'POST', headers: { authorization: `Bearer ${h.token}`, 'content-type': upload.contentType }, body: upload.body })
      assert.equal(response.status, 201)
      const { taskId } = await response.json()
      const pending = await waitForSnapshot(h, taskId, t => t.state === 'NEED_INPUT' || t.state === 'FAILED')
      assert.equal(pending.pendingQuestion?.round, 3, JSON.stringify(pending.error))
      await postJson(h, `/api/tasks/${taskId}/answer`, { answer: '标题=Scientific result；图注=Figure 1 Result；配色=推荐' })
      const result = await waitForSnapshot(h, taskId, t => ['PRESENT', 'FAILED'].includes(t.state))
      assert.equal(result.state, 'PRESENT', JSON.stringify(result.error))
      assert.equal(result.clarification.chartType, item.kind)
      assert.equal(result.plans.length, 3)
      for (const plan of result.plans) {
        assert.equal(plan.executionStatus, 'verified', JSON.stringify({ kind: item.kind, checks: plan.verification?.checks, quality: plan.verification?.quality }))
        assert.ok(plan.spec.panels.every(panel => panel.layers.every(layer => layer.kind === item.kind)))
        const preview = await fetch(`${h.base}/api/tasks/${taskId}/preview?planId=${plan.plan_id}`, { headers: { authorization: `Bearer ${h.token}` } })
        assert.equal(preview.status, 200)
        assert.match((await preview.json()).svg, /<svg/)
      }
    }
  } finally { await h.close() }
})
