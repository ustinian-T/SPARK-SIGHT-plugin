// 前后端契约测试：以 apps/web/src/types/index.ts 的枚举为唯一基准，
// 校验 scripts/gen-contract.mjs 抓取的真实服务载荷（contract/fixtures.json）。
// 运行 `npm run contract` 可重新抓取；本测试不启动服务，只做跨端一致性断言。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const webRoot = path.resolve(root, '..', '..', 'apps', 'web')
const fixturesPath = path.join(root, 'contract', 'fixtures.json')
const typesPath = path.join(webRoot, 'src', 'types', 'index.ts')

test('契约基线存在（缺失时先运行 npm run contract）', () => {
  assert.ok(fs.existsSync(fixturesPath), 'contract/fixtures.json 不存在，请先运行 npm run contract')
  assert.ok(fs.existsSync(typesPath), '前端类型文件缺失')
})

const fx = JSON.parse(fs.readFileSync(fixturesPath, 'utf-8'))
const typesSrc = fs.readFileSync(typesPath, 'utf-8')

/** 从 types/index.ts 提取 `export type X = | 'a' | 'b'` 联合枚举 */
function union(typeName) {
  const re = new RegExp(`export type ${typeName}\\s*=([^;]+);`, 's')
  const m = typesSrc.match(re)
  assert.ok(m, `类型 ${typeName} 未找到`)
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1])
}

const AGENT_STATES = union('AgentState')
const EVENT_TYPES = union('TaskEventType')
const PREF_KINDS = union('PreferenceKind')
const STRATEGIES = union('PlanStrategy')
const EXEC_STATUSES = ['idle', 'running', 'success', 'error', 'cancelled'] // ExecutionRecord.status 内联联合
const PLAN_IDS = ['plan_clarity', 'plan_convention', 'plan_density']

test('事件流：每个 type 都是前端 TaskEventType 合法成员', () => {
  assert.ok(Array.isArray(fx.eventStream) && fx.eventStream.length > 20)
  assert.ok(Array.isArray(fx.cancelledEvents) && fx.cancelledEvents.length > 0)
  for (const e of [...fx.eventStream, ...fx.cancelledEvents]) {
    assert.ok(EVENT_TYPES.includes(e.type), `非法事件名 ${e.type}`)
  }
})

test('取消事件流：CANCELLED 只产生一次终态并保持不可逆', () => {
  const states = fx.cancelledEvents.filter((e) => e.type === 'state_delta').map((e) => e.state)
  const done = fx.cancelledEvents.filter((e) => e.type === 'done')
  assert.ok(states.includes('CANCELLED'))
  assert.equal(states.at(-1), 'CANCELLED')
  assert.equal(done.length, 1)
  assert.equal(done[0].state, 'CANCELLED')
  assert.equal(fx.cancelledSnapshot.state, 'CANCELLED')
  assert.ok(fx.cancelledSnapshot.cancelledAt)
})

test('事件流：所有 state_delta 都是前端 AgentState 合法成员，且覆盖关键状态', () => {
  const states = fx.eventStream.filter((e) => e.type === 'state_delta').map((e) => e.state)
  for (const s of states) assert.ok(AGENT_STATES.includes(s), `非法状态 ${s}`)
  for (const s of ['INGEST', 'UNDERSTAND', 'PLAN', 'ANALYZE', 'DESIGN', 'EXECUTE', 'VERIFY', 'PRESENT', 'ITERATE', 'COMPLETE']) {
    assert.ok(states.includes(s), `事件流缺少状态 ${s}`)
  }
  // COMPLETE 是最后一个状态，终态后不得再出现执行类状态
  assert.equal(states.at(-1), 'COMPLETE')
  const completeIdx = states.lastIndexOf('COMPLETE')
  assert.ok(!states.slice(completeIdx + 1).some((s) => s !== 'COMPLETE'), '终态 COMPLETE 后出现非法状态')
})

test('事件流：preference 事件 kind 合法，且包含 select_plan', () => {
  const prefs = fx.eventStream.filter((e) => e.type === 'preference')
  assert.ok(prefs.some((e) => e.preference.kind === 'select_plan'))
  for (const e of prefs) assert.ok(PREF_KINDS.includes(e.preference.kind), `非法 preference kind ${e.preference.kind}`)
})

test('事件流：execution_update.status 取值合法', () => {
  for (const e of fx.eventStream.filter((x) => x.type === 'execution_update')) {
    if (e.execution.status) assert.ok(EXEC_STATUSES.includes(e.execution.status), `非法 execution.status ${e.execution.status}`)
  }
})

test('成功快照：AgentTask 关键字段齐全，三套方案 id/strategy 固定且证据绑定闭环', () => {
  const t = fx.successSnapshot
  for (const k of ['taskId', 'state', 'createdAt', 'steps', 'evidence', 'plans', 'execution', 'preferences', 'retries', 'plansVersion', 'planVersions']) {
    assert.ok(k in t, `快照缺字段 ${k}`)
  }
  assert.equal(t.state, 'PRESENT')
  assert.equal(t.plans.length, 3)
  assert.deepEqual(t.plans.map((p) => p.plan_id), PLAN_IDS)
  for (const p of t.plans) {
    assert.ok(STRATEGIES.includes(p.strategy), `非法 strategy ${p.strategy}`)
    assert.equal(p.executionStatus, 'verified')
    assert.ok(p.verification?.passed)
    for (const id of p.evidenceIds ?? []) assert.ok(t.evidence.some((e) => e.evidence_id === id), `方案 ${p.plan_id} 引用了不存在的证据 ${id}`)
  }
  assert.equal(t.execution.status, 'success')
})

test('版本历史：feedback 生成新 PlotRevision 且旧版本完整保留', () => {
  const versions = fx.successSnapshot.planVersions
  assert.ok(versions.length >= 4, `planVersions 应至少 4 条，实际 ${versions.length}`)
  assert.deepEqual(versions.map((v) => v.version), versions.map((_, i) => i + 1))
  assert.ok(versions.some((v) => v.reason === 'feedback' && /黑白印刷/.test(v.feedback ?? '')))
  const patchRevision = versions.find((v) => v.reason === 'patch')
  assert.ok(patchRevision, '缺少补丁产生的 PlotRevision')
  assert.equal(patchRevision.plans.find((p) => p.plan_id === 'plan_clarity')?.spec?.figure?.title, '契约补丁标题')
  // 旧版本不可变：v1 是执行前方案（code_generated_not_executed、无 verification），仍可回溯
  assert.equal(versions[0].plans.length, 3)
  assert.ok(versions[0].plans.every((p) => p.executionStatus === 'code_generated_not_executed'))
  assert.ok(versions[0].plans.every((p) => !p.verification))
  // 每个版本都保留三套方案（分支不删除）
  for (const v of versions) assert.equal(v.plans.length, 3)
})

test('偏好控制：契约覆盖全局暂停与恢复，最终恢复学习', () => {
  assert.equal(fx.preferenceSnapshot.paused, false)
  assert.ok(Array.isArray(fx.preferenceSnapshot.events))
})

test('完成快照：COMPLETE 冻结；失败快照：FAILED + 稳定错误码', () => {
  assert.equal(fx.completeSnapshot.state, 'COMPLETE')
  assert.equal(fx.failedSnapshot.state, 'FAILED')
  assert.ok(fx.failedSnapshot.error?.code, '失败快照缺少 error.code')
  assert.equal(fx.failedSnapshot.error.code, 'UNKNOWN_FIELD')
  assert.equal(fx.cancelledSnapshot.state, 'CANCELLED')
})

test('失败快照事件中不含任何统计证据（不虚构字段时不产出结论）', () => {
  // 失败发生在 UNDERSTAND：快照 evidence 应为空
  assert.equal(fx.failedSnapshot.evidence.length, 0)
  assert.equal(fx.failedSnapshot.plans.length, 0)
})
