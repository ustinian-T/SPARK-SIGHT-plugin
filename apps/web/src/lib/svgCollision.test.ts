import { describe, expect, it } from 'vitest'
import { detectSvgTextCollisions, sanitizeSvg, suggestSvgTextFix } from './svgCollision'

describe('真实 SVG 文本包围框碰撞检测', () => {
  it('detects overlapping text boxes', () => {
    const collisions = detectSvgTextCollisions([
      { index: 0, text: '标题', x: 10, y: 10, width: 40, height: 12 },
      { index: 1, text: '副标题', x: 35, y: 15, width: 40, height: 12 }
    ], { width: 100, height: 80 })
    expect(collisions).toHaveLength(1)
    expect(collisions[0].kind).toBe('overlap')
  })

  it('reports text clipped by the SVG viewport', () => {
    const collisions = detectSvgTextCollisions([
      { index: 0, text: '越界标题', x: -4, y: 4, width: 30, height: 12 }
    ], { width: 100, height: 80 })
    expect(collisions[0].kind).toBe('out_of_bounds')
    expect(collisions[0].suggestion).toContain('画布边距')
  })

  it('uses semantic roles to avoid false positives between regular ticks', () => {
    const boxes = [
      { index: 0, text: '1', role: 'tick-label' as const, x: 10, y: 10, width: 10, height: 10 },
      { index: 1, text: '2', role: 'tick-label' as const, x: 18, y: 10, width: 10, height: 10 },
      { index: 2, text: '标题', role: 'title' as const, x: 10, y: 10, width: 10, height: 10 }
    ]
    expect(detectSvgTextCollisions(boxes, { width: 100, height: 80 })).toHaveLength(3)
    expect(suggestSvgTextFix({ a: boxes[2], b: boxes[0], kind: 'overlap', area: 2 })).toContain('titleReserve')
  })

  it('removes executable and external SVG content', () => {
    const safe = sanitizeSvg('<svg><script>alert(1)</script><rect onclick="x"/><image href="https://evil.test/a.png"/></svg>')
    expect(safe).not.toMatch(/script|onclick|https:\/\/evil/i)
  })
})
