import test from 'node:test'
import assert from 'node:assert/strict'
import { checkChartSemanticQuality, checkDeliveryReadiness, summarizeQualityChecks } from '../src/verify.js'

function plan(kind, overrides = {}) {
  return {
    spec: {
      figure: { dpi: 300, widthIn: 7.2, heightIn: 4.6 },
      panels: [{ layers: [{ kind }], ...(kind === 'forest' ? { forest: { mean: 'effect' } } : {}) }]
    },
    series: [
      { label: 'x', y: [1, 2, 3, 4], values: [1, 2, 3, 4] },
      { label: 'y', y: [2, 3, 5, 7], values: [2, 3, 5, 7] },
      { label: 'z', y: [3, 6, 4, 8], values: [3, 6, 4, 8] }
    ],
    code: { python: "ax3d.set_xlim(0, 1)\nax3d.set_ylim(0, 1)\nax3d.set_zlim(0, 1)\nax3d.view_init(25, -55)" },
    ...overrides
  }
}

test('P1：三维图必须具有三轴变化与显式数据域，避免坐标轴外伪图', () => {
  assert.equal(checkChartSemanticQuality(plan('scatter3d')).passed, true)
  const degenerate = plan('scatter3d', { series: [{ y: [1, 1, 1, 1] }, { y: [1, 2, 3, 4] }, { y: [2, 3, 4, 5] }] })
  const result = checkChartSemanticQuality(degenerate)
  assert.equal(result.passed, false)
  assert.match(result.detail, /常数坐标轴/)
})

test('P1：小样本小提琴和极端双轴比例给出研究表达建议，但不伪造硬错误', () => {
  const violin = plan('violin', { series: [{ values: [1, 2, 3] }] })
  assert.equal(checkChartSemanticQuality(violin).passed, true)
  assert.match(checkChartSemanticQuality(violin).detail, /n<5/)
  const dual = plan('dual_axis', { series: [{ y: [1, 2, 3] }, { y: [1000, 2000, 3000] }] })
  assert.match(checkChartSemanticQuality(dual).detail, /100 倍/)
})

test('P1：最终交付尺寸将预览 DPI 与版面尺寸风险作为可审阅信息', () => {
  const result = checkDeliveryReadiness(plan('line', { spec: { figure: { dpi: 160, widthIn: 10, heightIn: 8 }, panels: [{ layers: [{ kind: 'line' }] }] } }), {
    artifacts: [{ name: 'plot.png', png: { width: 400, height: 300 } }]
  })
  assert.equal(result.passed, true)
  assert.ok(result.warnings.length >= 2)
})

test('P2：质量评分不可掩盖硬错误，警告进入可解释等级', () => {
  const ready = summarizeQualityChecks([{ passed: true, name: 'a', warnings: [] }])
  assert.equal(ready.grade, 'ready')
  const review = summarizeQualityChecks([{ passed: true, name: 'a', warnings: ['margin'] }])
  assert.equal(review.grade, 'ready')
  assert.equal(review.warningCount, 1)
  const blocked = summarizeQualityChecks([{ passed: false, name: 'a', warnings: [] }])
  assert.equal(blocked.grade, 'blocked')
  assert.equal(blocked.score < 100, true)
})
