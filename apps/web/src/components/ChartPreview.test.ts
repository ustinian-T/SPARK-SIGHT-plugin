import { describe, expect, it } from 'vitest'
import { ChartPreview, normalizePreviewSeries, previewTopReserve, wrapPreviewTitle } from './ChartPreview'
import { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { PlotPlan, PreviewSeries } from '../types'

describe('ChartPreview layout contract', () => {
  it('wraps long titles before panel layout is computed', () => {
    expect(wrapPreviewTitle('这是一个用于验证多面板科研绘图标题不会与图面重叠的长标题', 12)).toHaveLength(3)
    expect(previewTopReserve('短标题', false)).toBeLessThan(previewTopReserve('短标题', true))
  })
  it('renders saved grouped means and errors without scalar-array crashes', () => {
    const series = [{ id: 'a', label: '对照组', x: ['对照组', '处理组'], y: 3, yerr: 1, color: '#0173B2', kind: 'bar' },
      { id: 'b', label: '处理组', x: ['对照组', '处理组'], y: 5, yerr: 1, color: '#DE8F05', kind: 'bar' }] as unknown as PreviewSeries[]
    expect(normalizePreviewSeries(series).map(s => s.y)).toEqual([[3, null], [null, 5]])
    const plan = { series, spec: { figure: { title: '处理效果', widthIn: 7.2, heightIn: 4.6, rows: 1, cols: 1, theme: 'clarity' },
      panels: [{ panel_id: 'p', row: 0, col: 0, layers: [{ kind: 'bar', showErrorBars: true }], annotations: [], scales: [], legend: { visible: true } }] } } as unknown as PlotPlan
    expect(renderToStaticMarkup(createElement(ChartPreview, { plan }))).toContain('对照组')
  })
})
