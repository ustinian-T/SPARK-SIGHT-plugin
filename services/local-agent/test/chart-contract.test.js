import test from 'node:test'
import assert from 'node:assert/strict'
import { CANONICAL_CHART_TYPES, isInteractivePlaceholderChart, normalizeChartType } from '../src/chartTypes.js'

test('前后端图型契约包含高级图型并统一别名', () => {
  assert.ok(CANONICAL_CHART_TYPES.includes('surface3d'))
  assert.equal(normalizeChartType('三维散点图'), 'scatter3d')
  assert.equal(normalizeChartType('box_jitter'), 'box')
  assert.equal(isInteractivePlaceholderChart('森林图'), true)
})
