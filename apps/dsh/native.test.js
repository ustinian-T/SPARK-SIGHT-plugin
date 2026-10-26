import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { isProxyAllowed, defaultStop } from './lib/agent-client.js'
import { PluginAuth, readOrCreateAuthSecret } from './lib/auth.js'
import { formatTaskSummary } from './lib/tools.js'

test('browser relay allow-list exposes task/preview but no wildcard or traversal', () => {
  assert.equal(isProxyAllowed('GET', '/api/tasks/task_abc'), true)
  assert.equal(isProxyAllowed('GET', '/api/tasks/task_abc/preview?planId=plan_1'), true)
  assert.equal(isProxyAllowed('POST', '/api/tasks/task_abc/select'), true)
  assert.equal(isProxyAllowed('POST', '/api/tasks/task_abc/feedback'), true)
  assert.equal(isProxyAllowed('GET', '/api/local/settings'), true)
  assert.equal(isProxyAllowed('GET', '/api/../secret'), false)
  assert.equal(isProxyAllowed('DELETE', '/api/tasks/task_abc'), false)
  assert.equal(isProxyAllowed('GET', '/api/tasks/task_abc/export'), false)
})

test('task summary carries state, clarification and verification without dumping raw JSON', () => {
  const text = formatTaskSummary({
    taskId: 'task_demo',
    state: 'PRESENT',
    title: 'grouped.csv',
    dataset: { rows: 120, columns: [{ name: 'group' }, { name: 'value' }] },
    plans: [{
      plan_id: 'plan_1',
      chartType: '箱线图',
      rationale: '比较组间分布',
      score: { total: 0.92 },
      executionStatus: 'verified',
      verification: { passed: true },
    }],
    planArtifacts: { plan_1: { svgBytes: 10 } },
  })
  assert.match(text, /task_demo/)
  assert.match(text, /PRESENT/)
  assert.match(text, /箱线图/)
  assert.match(text, /已验证/)
  assert.match(text, /plan_1/)
  assert.doesNotMatch(text, /\{"taskId"/)

  const question = formatTaskSummary({
    taskId: 'task_q',
    state: 'NEED_INPUT',
    pendingQuestion: { question: '选择图型', options: ['箱线图', '折线图'], hint: '可直接回答' },
    plans: [],
  })
  assert.match(question, /需要用户确认/)
  assert.match(question, /箱线图/)
  assert.match(question, /sparksight_answer/)
})

test('auth secret is stable across calls and the stored token is required for tools', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-dsh-auth-'))
  try {
    const first = readOrCreateAuthSecret(root)
    const second = readOrCreateAuthSecret(root)
    assert.equal(first, second)
    assert.ok(first.length >= 32)

    const auth = new PluginAuth({ client: {}, dataDir: root })
    assert.throws(() => auth.ensure(), (error) => error.code === 'AUTH_REQUIRED')
    const status = await auth.status({ validate: false })
    assert.equal(status.authenticated, false)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

test('task polling stops on questions, plans, or terminal states', () => {
  assert.equal(defaultStop({ state: 'PLAN', plans: [{ plan_id: 'p' }] }), true)
  assert.equal(defaultStop({ state: 'NEED_INPUT', pendingQuestion: { question: '?' } }), true)
  assert.equal(defaultStop({ state: 'FAILED', plans: [] }), true)
  assert.equal(defaultStop({ state: 'EXECUTE', plans: [] }), false)
})
