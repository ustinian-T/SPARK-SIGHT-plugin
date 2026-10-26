// 科研制图规则库测试（《数模国赛MATLAB制图规则 v0.4》通用精华：白底/字号下限/禁彩虹色/图注格式/样式复用）。
import { test } from 'node:test'
import assert from 'node:assert'
import { PLOT_RULES, isValidHex, checkNoParentheses, checkCaption, validateSpecAgainstRules, StyleUsageTracker, defaultCaption, checkRequestedChartType } from '../src/plotRules.js'

test('Nature 9 色为 v0.4 §5.1 原样', () => {
  assert.deepEqual(PLOT_RULES.naturePalette, ['#6E8FB2', '#7DA494', '#EAB67A', '#E5A79A', '#C16E71', '#ABC8E5', '#D8A0C1', '#9F8DB8', '#D0D08A'])
})

test('isValidHex：合法/非法', () => {
  assert.ok(isValidHex('#6E8FB2'))
  assert.ok(isValidHex('#fff'))
  assert.ok(!isValidHex('6E8FB2'))
  assert.ok(!isValidHex('#GGGGGG'))
  assert.ok(!isValidHex(123))
})

test('checkNoParentheses：含括号（含中文括号）即违规', () => {
  assert.equal(checkNoParentheses('日均发电量').ok, true)
  assert.equal(checkNoParentheses('日均发电量(kWh)').ok, false)
  assert.equal(checkNoParentheses('产量（kg）').ok, false)
})

test('checkCaption：图X-X 对象方法功能，无括号', () => {
  assert.equal(checkCaption('图1-1 各处理组日均产量对比').ok, true)
  assert.equal(checkCaption('图1 各处理组日均产量').ok, true)
  assert.equal(checkCaption('各处理组日均产量').ok, false)
  assert.equal(checkCaption('图1-1 产量(kg)').ok, false)
  assert.equal(checkCaption('').ok, false)
})

test('validateSpecAgainstRules：白底/字号下限/禁彩虹色为 error 级，括号为 warn 级', () => {
  const spec = {
    figure: { background: '#F5F5F5', minFontSize: 8, colormap: 'jet', title: '测试（分组）' },
    panels: [{ layers: [{ kind: 'heatmap' }], scales: [{ label: '产量(kg)' }] }]
  }
  const v = validateSpecAgainstRules(spec)
  const errorRules = v.filter((x) => x.level === 'error').map((x) => x.rule)
  assert.ok(errorRules.includes('white_background'))
  assert.ok(errorRules.includes('min_font_size'))
  assert.ok(errorRules.includes('no_rainbow_colormap'))
  assert.ok(!errorRules.includes('no_parentheses_title'))
  assert.ok(v.some((x) => x.rule === 'no_parentheses_title' && x.level === 'warn'))
})

test('validateSpecAgainstRules：合规 spec 无 error', () => {
  const spec = {
    figure: { background: '#FFFFFF', minFontSize: 10, title: '各处理组对比', titleAlign: 'center' },
    panels: [{ layers: [{ kind: 'line' }], scales: [] }]
  }
  const v = validateSpecAgainstRules(spec)
  assert.equal(v.filter((x) => x.level === 'error').length, 0)
})

test('validateSpecAgainstRules：多面板 tight 布局直接阻断标题重叠风险', () => {
  const violations = validateSpecAgainstRules({
    figure: { title: '多面板趋势', rows: 2, cols: 2, layoutEngine: 'tight' },
    panels: []
  })
  assert.ok(violations.some((item) => item.rule === 'title_overlap_risk' && item.level === 'error'))
})

test('validateSpecAgainstRules：缺少总标题直接阻断', () => {
  const violations = validateSpecAgainstRules({ figure: { rows: 1, cols: 1 }, panels: [] })
  assert.ok(violations.some((item) => item.rule === 'title_required' && item.level === 'error'))
})

test('validateSpecAgainstRules：高密度横轴与混合单位被门禁拦截', () => {
  const violations = validateSpecAgainstRules({
    figure: { title: '趋势' },
    panels: [{ categoryCount: 36, scales: [{ axis: 'y', label: '温度', unit: '℃' }, { axis: 'y', label: '成本', unit: '元' }] }]
  })
  assert.ok(violations.some(v => v.rule === 'x_label_density' && v.level === 'error'))
  assert.ok(violations.some(v => v.rule === 'mixed_units_single_axis' && v.level === 'error'))
})

test('checkRequestedChartType：显式图型不得静默替换', () => {
  assert.equal(checkRequestedChartType('line', 'line_error').ok, true)
  assert.equal(checkRequestedChartType('line', 'grouped_bar_error').ok, false)
  assert.equal(checkRequestedChartType('auto', 'grouped_bar_error').ok, true)
})

test('StyleUsageTracker：同一样式最多 2 次（§6.2）', () => {
  const t = new StyleUsageTracker()
  assert.ok(t.canUse('grouped_bar'))
  t.record('grouped_bar')
  t.record('grouped_bar_error') // 归一化为 grouped_bar → 第 2 次
  assert.equal(t.canUse('grouped_bar'), false)
  assert.equal(t.record('grouped_bar').ok, false) // 超限仍计数但拒绝使用
  assert.equal(t.canUse('grouped_bar'), false)
  assert.ok(t.canUse('line_error'))
  assert.deepEqual(t.snapshot(), { grouped_bar: 3 })
})

test('defaultCaption：图X-X 对象+功能', () => {
  assert.equal(defaultCaption({ index: 2, title: '各处理组日均产量' }), '图2-1 各处理组日均产量')
  assert.equal(defaultCaption({}), '图1-1 ')
})
