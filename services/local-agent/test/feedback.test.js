import test from 'node:test'
import assert from 'node:assert/strict'
import { applyFeedbackToPlans } from '../src/feedback.js'

function plan(id, title) {
  return {
    plan_id: id,
    series: [{ id: 'a', color: '#00AA00' }],
    spec: {
      figure: { title, theme: 'clarity' },
      panels: [{
        scales: [{ axis: 'x', label: 'week', grid: false }, { axis: 'y', label: 'response', grid: true }],
        legend: { visible: true, position: 'bottom' },
        layers: [{ kind: 'line', color: '#00AA00', lineWidth: 1.4, showErrorBars: false }]
      }]
    }
  }
}

test('feedback applies explicit chart properties to selected plan only', () => {
  const source = [plan('one', '旧标题（折线图）'), plan('two', '保留标题（柱状图）')]
  const out = applyFeedbackToPlans(source, '标题改为：处理组趋势；图例移到图内右上角；线宽设为 2.2；显示误差棒', { planId: 'one', xLabel: 'week' })
  assert.equal(out.plans[0].spec.figure.title, '处理组趋势')
  assert.equal(out.plans[0].spec.panels[0].legend.position, 'inside')
  assert.equal(out.plans[0].spec.panels[0].layers[0].lineWidth, 2.2)
  assert.equal(out.plans[0].spec.panels[0].layers[0].showErrorBars, true)
  assert.deepEqual(out.plans[1], source[1])
  assert.ok(out.changes.length >= 4)
})

test('academic and monochrome feedback produces visible deterministic changes', () => {
  const source = [plan('one', '旧标题（折线图）')]
  const out = applyFeedbackToPlans(source, '标题改为更学术的表述，并改成黑白印刷友好、弱化装饰', { xLabel: 'week' })
  assert.match(out.plans[0].spec.figure.title, /不同处理组随 week 的响应变化/)
  assert.equal(out.plans[0].spec.figure.theme, 'convention')
  assert.equal(out.plans[0].spec.panels[0].scales[1].grid, false)
  assert.equal(out.plans[0].series[0].color, '#111111')
})

test('ambiguous unit request is reported instead of inventing a unit', () => {
  const out = applyFeedbackToPlans([plan('one', '旧标题')], '纵轴补充单位与含义', { planId: 'one' })
  assert.equal(out.plans[0].spec.panels[0].scales[1].label, 'response')
  assert.match(out.unresolved[0], /单位未提供/)
})
