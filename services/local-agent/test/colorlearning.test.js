// 配色学习模型测试：在线学习强度、时间衰减、画像重建与有界先验注入推荐器。
import { test } from 'node:test'
import assert from 'node:assert'
import { createColorProfile, learnFromEvent, buildColorProfile, profilePaletteScore, profileSummary, chartTypeBase } from '../src/colorLearning.js'
import { recommendPalette, PALETTE_LIBRARY } from '../src/palettes.js'

const DAY = 86_400_000

test('chartTypeBase：归一化图型基名', () => {
  assert.equal(chartTypeBase('correlation_heatmap'), 'heatmap')
  assert.equal(chartTypeBase('dual_line_normalized'), 'dual_line')
  assert.equal(chartTypeBase('grouped_bar_error'), 'grouped_bar')
})

test('learnFromEvent：select_plan 正向强度最高，reject 为负', () => {
  const t = Date.now()
  const profile = createColorProfile(t)
  learnFromEvent(profile, { kind: 'select_plan', paletteId: 'okabe_ito', chartType: 'line_error', weight: 1, confidence: 1, t })
  const strength = profile.paletteAffinity.okabe_ito
  assert.ok(strength > 0.7 && strength <= 1)
  learnFromEvent(profile, { kind: 'reject', paletteId: 'okabe_ito', chartType: 'line_error', weight: 1, confidence: 1, t })
  assert.ok(profile.paletteAffinity.okabe_ito < strength)
})

test('时间衰减：90 天半衰期后旧事件权重显著下降', () => {
  const t = Date.now()
  const fresh = createColorProfile(t)
  learnFromEvent(fresh, { kind: 'select_plan', paletteId: 'okabe_ito', chartType: 'line_error', weight: 1, confidence: 1, t })
  const old = createColorProfile(t)
  learnFromEvent(old, { kind: 'select_plan', paletteId: 'okabe_ito', chartType: 'line_error', weight: 1, confidence: 1, t: t - 180 * DAY })
  assert.ok(fresh.paletteAffinity.okabe_ito > old.paletteAffinity.okabe_ito)
})

test('buildColorProfile：从事件列表重建画像', () => {
  const t = Date.now()
  const events = [
    { kind: 'select_plan', paletteId: 'okabe_ito', chartType: 'line_error', weight: 1, confidence: 0.8, t: t - DAY },
    { kind: 'set_default', paletteId: 'okabe_ito', chartType: 'line_error', weight: 1, confidence: 0.8, t: t - 2 * DAY },
    { kind: 'reject', paletteId: 'viridis_like', chartType: 'line_error', weight: 1, confidence: 0.8, t: t - 3 * DAY }
  ]
  const profile = buildColorProfile(events, t)
  assert.ok(profile.paletteAffinity.okabe_ito > profile.paletteAffinity.viridis_like)
})

test('profilePaletteScore：有界先验（范围约 [-1.5,1.5]），强偏好为正', () => {
  const t = Date.now()
  const profile = createColorProfile(t)
  learnFromEvent(profile, { kind: 'select_plan', paletteId: 'okabe_ito', chartType: 'line_error', weight: 1, confidence: 1, t })
  const score = profilePaletteScore(profile, 'okabe_ito', 'line_error')
  assert.ok(score > 0.2 && score < 1.5)
  assert.ok(profilePaletteScore(profile, 'paultol_bright', 'line_error') < score)
  assert.equal(profilePaletteScore(null, 'okabe_ito'), 0)
})

test('profileSummary：输出 topPalettes/topRoles', () => {
  const t = Date.now()
  const profile = createColorProfile(t)
  learnFromEvent(profile, { kind: 'select_plan', paletteId: 'okabe_ito', chartType: 'line_error', weight: 1, confidence: 1, t })
  const s = profileSummary(profile)
  assert.ok(s.topPalettes.some((p) => p.paletteId === 'okabe_ito'))
  assert.ok(s.topRoles.length > 0)
})

test('recommendPalette：userProfile 产生 learned 先验分且 reason 提及历史偏好', () => {
  const t = Date.now()
  const profile = createColorProfile(t)
  learnFromEvent(profile, { kind: 'select_plan', paletteId: 'okabe_ito', chartType: 'line_error', weight: 1, confidence: 1, t })
  const out = recommendPalette({
    prompt: '论文趋势图',
    chartType: 'line_error',
    strategy: 'convention',
    seriesCount: 3,
    userProfile: profile
  })
  assert.ok(Number.isFinite(out.scoreBreakdown?.learned))
  assert.ok(out.scoreBreakdown.learned > 0)
  assert.match(out.reason, /历史配色偏好/)
})

test('recommendPalette：推荐评分显式包含 CVD/灰度可辨性维度', () => {
  const out = recommendPalette({ prompt: '论文分类比较', chartType: 'line', strategy: 'clarity', seriesCount: 4 })
  assert.ok(Number.isFinite(out.scoreBreakdown?.accessibility))
  assert.match(out.reason, /CVD\/灰度可辨性/)
})

test('推荐器：色板库含新增科研色系与渐变', () => {
  for (const id of ['nature_lowsat', 'okabe_ito', 'paultol_bright', 'paultol_muted', 'viridis_like', 'magma_like', 'brewer_set2']) {
    assert.ok(PALETTE_LIBRARY[id], `色板 ${id} 应存在`)
  }
  assert.deepEqual(PALETTE_LIBRARY.nature_lowsat.colors.slice(0, 3), ['#6E8FB2', '#7DA494', '#EAB67A'])
})

test('撤销语义：reverted 事件不进入画像（撤销即遗忘，重建时旧信号不残留）', () => {
  const t = Date.now()
  const events = [
    { kind: 'select_plan', paletteId: 'okabe_ito', chartType: 'line_error', weight: 1, confidence: 1, t },
    { kind: 'reject', paletteId: 'okabe_ito', chartType: 'line_error', weight: 1, confidence: 1, t, reverted: true, revertedAt: t + 1 }
  ]
  const profile = buildColorProfile(events, t)
  assert.ok(profile.paletteAffinity.okabe_ito > 0.7, '未撤销的 select 信号保留')
  assert.ok(!('viridis_like' in profile.paletteAffinity))
  // 同一事件若被撤销（reverted=true），画像完全不含该信号
  const onlyReverted = buildColorProfile([{ kind: 'select_plan', paletteId: 'okabe_ito', chartType: 'line_error', weight: 1, confidence: 1, t, reverted: true }], t)
  assert.equal(onlyReverted.paletteAffinity.okabe_ito ?? 0, 0, 'reverted 事件不得影响画像')
})

test('learnFromEvent：event.reverted 直接跳过（在线学习路径同样生效）', () => {
  const t = Date.now()
  const profile = createColorProfile(t)
  learnFromEvent(profile, { kind: 'select_plan', paletteId: 'okabe_ito', chartType: 'line_error', weight: 1, confidence: 1, t, reverted: true })
  assert.equal(profile.paletteAffinity.okabe_ito ?? 0, 0)
})
