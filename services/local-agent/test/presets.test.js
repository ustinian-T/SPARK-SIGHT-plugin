import test from 'node:test'
import assert from 'node:assert/strict'
import {
  LEGEND_POSITIONS,
  STYLE_PRESETS,
  STYLE_PRESET_ALIASES,
  resolvePresetId,
  buildPresetPatches
} from '../src/stylePresets.js'
import { createTask, postJson, startTestServer, waitForSnapshot } from './helpers.js'

const SAMPLE = `week,a,b\n1,10,12\n2,13,15\n3,17,18\n4,20,23\n`

test('ships six scientific presets and all required legend shortcuts', () => {
  assert.equal(STYLE_PRESETS.length, 6)
  assert.deepEqual(LEGEND_POSITIONS, ['top', 'bottom', 'left', 'right', 'center', 'inside'])
  assert.equal(new Set(STYLE_PRESETS.map((preset) => preset.id)).size, 6)
})

test('V2 中性命名：预设 id 不再使用 nature/science/cell 等暗示官方适配的名称', () => {
  const forbidden = ['nature', 'science', 'cell']
  for (const preset of STYLE_PRESETS) {
    for (const bad of forbidden) {
      assert.ok(preset.id !== bad && !preset.id.startsWith(bad + '-'), `预设 id ${preset.id} 不应残留旧期刊名`)
    }
  }
  // 六个新 id 均为中性可验证描述
  const ids = STYLE_PRESETS.map((p) => p.id).sort()
  assert.deepEqual(ids, [
    'compact-sans-grid',
    'high-contrast-colorblind',
    'ieee-double-column-serif',
    'monochrome-print',
    'presentation-bold',
    'two-column-sans'
  ])
})

test('V2 旧 alias 映射可用：nature/science/cell 等仍能解析到新预设', () => {
  assert.equal(STYLE_PRESET_ALIASES.nature, 'two-column-sans')
  assert.equal(STYLE_PRESET_ALIASES.science, 'compact-sans-grid')
  assert.equal(STYLE_PRESET_ALIASES.cell, 'high-contrast-colorblind')
  assert.equal(STYLE_PRESET_ALIASES.grayscale, 'monochrome-print')
  assert.equal(STYLE_PRESET_ALIASES.presentation, 'presentation-bold')
  // 解析：新 id 与旧 alias 都应命中
  assert.equal(resolvePresetId('two-column-sans'), 'two-column-sans')
  assert.equal(resolvePresetId('nature'), 'two-column-sans')
  assert.equal(resolvePresetId('cell'), 'high-contrast-colorblind')
  assert.equal(resolvePresetId('not-a-preset'), null)
})

test('V2 specification 字段可验证（栏数/字体/图例位置/线宽）', () => {
  for (const preset of STYLE_PRESETS) {
    const spec = preset.specification
    assert.ok(spec, `${preset.id} 缺少 specification`)
    assert.ok(Number.isInteger(spec.columns) && spec.columns >= 1 && spec.columns <= 2, `${preset.id} columns 非法`)
    assert.ok(['serif', 'sans'].includes(spec.fontFamily), `${preset.id} fontFamily 非法`)
    assert.ok(LEGEND_POSITIONS.includes(spec.legendPosition), `${preset.id} legendPosition 非法`)
    assert.ok(typeof spec.lineWidth === 'number' && spec.lineWidth > 0, `${preset.id} lineWidth 非法`)
    // specification 与顶层字段一致
    assert.equal(spec.fontFamily, preset.fontFamily)
    assert.equal(spec.legendPosition, preset.legend)
    assert.equal(spec.lineWidth, preset.lineWidth)
  }
})

test('preset changes compile to reversible SpecPatches（旧 alias nature 仍可用）', () => {
  const plan = {
    spec: {
      figure: { figure_id: 'figure_1', theme: 'default', fontFamily: 'sans' },
      panels: [{ panel_id: 'panel_1', legend: { legend_id: 'legend_1', position: 'right' }, layers: [{ layer_id: 'layer_1', color: '#111111', lineWidth: 1 }] }]
    }
  }
  // 旧 id 'nature' 经 alias 解析为 two-column-sans，补丁正常生成
  const patches = buildPresetPatches(plan, 'nature')
  assert.ok(patches.length >= 4)
  assert.ok(patches.every((patch) => 'before' in patch && 'after' in patch && patch.before !== patch.after))
  assert.ok(patches.some((patch) => patch.path.endsWith('legend.position')))
  // theme 补丁落到新中性主题
  const themePatch = patches.find((patch) => patch.path === 'theme')
  assert.equal(themePatch.after, 'two-column-sans')
})

test('style preset applies as one verified revision and can be reverted', async () => {
  const h = await startTestServer()
  try {
    const created = await createTask(h, { csv: SAMPLE, prompt: '比较 a 和 b 随 week 的变化趋势' })
    const initial = await waitForSnapshot(h, created.json.taskId, (task) => task.state === 'PRESENT')
    const plan = initial.plans[0]
    // 通过旧 alias id 'nature' 应用，验证向后兼容；落地主题为新中性名
    const applied = await postJson(h, `/api/tasks/${initial.taskId}/styles/apply`, {
      planId: plan.plan_id, presetId: 'nature', parentVersion: initial.currentRevision
    })
    assert.equal(applied.res.status, 200, JSON.stringify(applied.json))
    assert.equal(applied.json.revision.reason, 'style_preset')
    assert.equal(applied.json.revision.patches.length > 0, true)
    const styled = applied.json.revision.plans.find((item) => item.plan_id === plan.plan_id)
    assert.equal(styled.spec.figure.theme, 'two-column-sans')
    const reverted = await postJson(h, `/api/tasks/${initial.taskId}/patches/revert`, {})
    assert.equal(reverted.res.status, 200)
    assert.equal(reverted.json.revision.version, initial.currentRevision)
  } finally {
    await h.close()
  }
})
