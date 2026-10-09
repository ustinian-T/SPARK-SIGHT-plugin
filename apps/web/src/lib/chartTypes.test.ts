import { describe, expect, it } from 'vitest'
import { canonicalChartType, hasInteractivePlaceholder } from './chartTypes'

describe('前后端图型契约', () => {
  it('normalizes legacy aliases in one place', () => {
    expect(canonicalChartType('box_jitter')).toBe('box')
    expect(canonicalChartType('三维曲面图')).toBe('surface3d')
    expect(canonicalChartType('森林图')).toBe('forest')
  })

  it('marks advanced chart types as interactive placeholders', () => {
    expect(hasInteractivePlaceholder('surface3d')).toBe(true)
    expect(hasInteractivePlaceholder('violin')).toBe(true)
    expect(hasInteractivePlaceholder('line')).toBe(false)
  })
})
