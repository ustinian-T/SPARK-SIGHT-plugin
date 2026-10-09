// 配色学习画像的撤销/重置闭环测试：
// 单元级（PreferenceStore.colorEvents/colorProfile/clearColors/revert 语义）+ HTTP 路由（GET/DELETE /api/preferences/colors）。
import { test, before, after } from 'node:test'
import assert from 'node:assert'
import { PreferenceStore } from '../src/preferences.js'
import { startTestServer } from './helpers.js'

function colorEvent(overrides = {}) {
  return {
    event_id: `pref_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 8)}`,
    kind: 'reject',
    weight: 0.8,
    scope: 'task',
    summary: '用户否决方案，记录配色负向信号',
    confidence: 0.6,
    t: Date.now(),
    paletteId: 'user_nature',
    planId: 'plan_clarity',
    ...overrides
  }
}

test('colorProfile：配色事件统计、逐色板明细与学习摘要', () => {
  const store = new PreferenceStore(null)
  store.append(colorEvent({ kind: 'select_plan', paletteId: 'user_nature', weight: 1, confidence: 1 }))
  store.append(colorEvent({ kind: 'reject', paletteId: 'okabe_ito', weight: 0.8, confidence: 0.6 }))
  const profile = store.colorProfile()
  assert.equal(profile.eventCount, 2)
  assert.equal(profile.eventIds.length, 2)
  const nature = profile.paletteStats.find((p) => p.paletteId === 'user_nature')
  assert.equal(nature.positive, 1)
  assert.equal(nature.negative, 0)
  const okabe = profile.paletteStats.find((p) => p.paletteId === 'okabe_ito')
  assert.equal(okabe.negative, 1)
  assert.ok(profile.summary.topPalettes.some((p) => p.paletteId === 'user_nature'), '画像摘要应含正向色板')
})

test('revert：撤销后配色事件不再计入画像（撤销即遗忘）', () => {
  const store = new PreferenceStore(null)
  const { event } = store.append(colorEvent({ kind: 'select_plan', paletteId: 'user_nature', weight: 1, confidence: 1 }))
  assert.equal(store.colorProfile().eventCount, 1)
  store.revert(event.event_id)
  const profile = store.colorProfile()
  assert.equal(profile.eventCount, 0, 'reverted 事件不进入画像')
  assert.equal(profile.summary.topPalettes.length, 0)
})

test('clearColors：仅清配色事件，非配色偏好保留', () => {
  const store = new PreferenceStore(null)
  store.append(colorEvent({ paletteId: 'user_nature' }))
  store.append({ event_id: 'pref_export_1', kind: 'export', weight: 0.45, scope: 'project', summary: '导出复现包', confidence: 0.8, t: Date.now() })
  const out = store.clearColors()
  assert.equal(out.removed, 1)
  const events = store.snapshot().events
  assert.equal(events.length, 1)
  assert.equal(events[0].kind, 'export')
  assert.equal(store.colorProfile().eventCount, 0)
})

let h
before(async () => { h = await startTestServer(1) })
after(async () => { await h.close() })

test('HTTP：GET /api/preferences/colors 返回画像形状（空态 ok）', async () => {
  const res = await fetch(`${h.base}/api/preferences/colors`, { headers: { authorization: `Bearer ${h.token}` } })
  assert.equal(res.status, 200)
  const json = await res.json()
  assert.equal(json.ok, true)
  assert.equal(json.eventCount, 0)
  assert.ok(Array.isArray(json.paletteStats))
  assert.ok(Array.isArray(json.eventIds))
  assert.ok(json.summary && typeof json.summary === 'object')
})

test('HTTP：DELETE /api/preferences/colors 幂等返回 removed', async () => {
  const res = await fetch(`${h.base}/api/preferences/colors`, { method: 'DELETE', headers: { authorization: `Bearer ${h.token}` } })
  assert.equal(res.status, 200)
  const json = await res.json()
  assert.equal(json.ok, true)
  assert.equal(json.removed, 0)
  assert.ok(Array.isArray(json.events))
})
