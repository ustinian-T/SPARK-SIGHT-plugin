// 排版与美观参数测试（绘图前询问 → 无要求按科研制图默认执行）。
import { test } from 'node:test'
import assert from 'node:assert'
import { resolveTypography, applyTypographyToSpec, resolvePresentation, sanitizeFigureTitle, SCIENTIFIC_TYPOGRAPHY_DEFAULTS, FONT_FAMILIES } from '../src/typography.js'

test('标题清理：排版元数据不进入图题或图注', () => {
  const dirty = '重点凸显对比度【制图规范】字体=SimHei；DPI=300；配色=auto'
  assert.equal(sanitizeFigureTitle(dirty, 'data'), '重点凸显对比度')
  const p = resolvePresentation({ title: dirty, caption: dirty }, { figureIndex: 1, title: 'data' })
  assert.equal(p.title, '重点凸显对比度')
  assert.equal(p.caption, '图1-1 重点凸显对比度')
})

test('科研默认：SimHei、标题 15pt 加粗居中、白底、300dpi、正文≥10pt', () => {
  const t = resolveTypography()
  assert.equal(t.fontFamily, FONT_FAMILIES.simhei)
  assert.equal(t.title.size, 15)
  assert.equal(t.title.weight, 'bold')
  assert.equal(t.title.align, 'center')
  assert.equal(t.title.spacing, 1.15)
  assert.equal(t.caption.size, 10.5)
  assert.equal(t.axisLabel.size, 12.5)
  assert.equal(t.tick.size, 11)
  assert.equal(t.legend.size, 11)
  assert.equal(t.annotation.size, 10.5)
  assert.equal(t.background, '#FFFFFF')
  assert.equal(t.exportDpi, 300)
  assert.ok(t.title.size >= 10 && t.caption.size >= 10 && t.tick.size >= 10)
})

test('字号越界被钳制到规则区间（标题 14–16，轴标签 12–13，刻度/图例 10–11）', () => {
  const t = resolveTypography({ title: { size: 8 }, axisLabel: { size: 5 }, tick: { size: 3 }, legend: { size: 3 }, exportDpi: 120 })
  assert.equal(t.title.size, 14)
  assert.equal(t.axisLabel.size, 12)
  assert.equal(t.tick.size, 10)
  assert.equal(t.legend.size, 10)
  assert.equal(t.exportDpi, 300)
  const big = resolveTypography({ title: { size: 40 }, exportDpi: 900 })
  assert.equal(big.title.size, 16)
  assert.equal(big.exportDpi, 600)
})

test('用户指定：字号/字色/字距/字体生效', () => {
  const t = resolveTypography({ fontFamily: 'KaiTi', title: { size: 15, color: '#6E8FB2', spacing: 1.2 }, caption: { size: 10.5, color: '#C16E71', spacing: 1.0 } })
  assert.equal(t.fontFamily, FONT_FAMILIES.kai)
  assert.equal(t.title.color, '#6E8FB2')
  assert.equal(t.title.spacing, 1.2)
  assert.equal(t.caption.color, '#C16E71')
  assert.equal(t.caption.spacing, 1.0)
})

test('applyTypographyToSpec：写入 spec.figure 排版字段', () => {
  const spec = { figure: { title: 't' }, panels: [] }
  applyTypographyToSpec(spec, resolveTypography())
  const f = spec.figure
  assert.equal(f.fontFamily, 'SimHei')
  assert.equal(f.titleFontSize, 15)
  assert.equal(f.titleColor, '#000000')
  assert.equal(f.titleSpacing, 1.15)
  assert.equal(f.axisLabelSize, 12.5)
  assert.equal(f.tickSize, 11)
  assert.equal(f.legendSize, 11)
  assert.equal(f.annotationSize, 10.5)
  assert.equal(f.background, '#FFFFFF')
  assert.equal(f.minFontSize, 10.5) // min(15,12.5,11,11,10.5)
  assert.equal(f.layoutEngine, 'constrained')
  assert.equal(f.titleReserve, 0.08)
})

test('resolvePresentation：标题/图注缺省按「图X-X 标题」生成', () => {
  const out = resolvePresentation({ title: '氮响应对比', typography: { source: 'interactive' } }, { figureIndex: 1 })
  assert.equal(out.title, '氮响应对比')
  assert.equal(out.caption, '图1-1 氮响应对比')
  const fallback = resolvePresentation(null, { title: '默认标题' })
  assert.equal(fallback.title, '默认标题')
  assert.equal(fallback.caption, '图1-1 默认标题')
})
