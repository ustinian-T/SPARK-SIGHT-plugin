// 扩展图型（热力图增强 / 双Y轴 / 三维曲面 / 三维散点）代码生成测试。
import { test } from 'node:test'
import assert from 'node:assert'
import { generateCodeForSpec, validateChartSpec } from '../src/codegen.js'

const input = (measures) => ({
  fileName: 'demo.csv', x: 'week', measures, title: '测试标题', yLabel: '测量值', outputBase: 'chart_spec', dpi: 300
})

const spec = (kind, rows = 1, cols = 1) => ({
  figure: { title: '测试标题', rows, cols, background: '#FFFFFF', minFontSize: 10, titleFontSize: 15 },
  panels: Array.from({ length: rows * cols }, (_, i) => ({
    panel_id: `p${i}`, title: `p${i}`, row: Math.floor(i / cols), col: i % cols,
    layers: [{ layer_id: `l${i}`, kind, label: `l${i}`, color: '#6E8FB2' }], scales: [], annotations: []
  }))
})

test('validateChartSpec：三维图少于 3 个数值列报 SURFACE_REQUIRES_THREE_NUMERIC_MEASURES', () => {
  assert.throws(() => validateChartSpec(spec('surface3d'), input(['a', 'b'])), /SURFACE_REQUIRES_THREE_NUMERIC_MEASURES/)
  assert.throws(() => validateChartSpec(spec('scatter3d'), input(['a', 'b'])), /SURFACE_REQUIRES_THREE_NUMERIC_MEASURES/)
})

test('validateChartSpec：双Y轴少于 2 个数值列报 DUAL_AXIS_REQUIRES_TWO_MEASURES', () => {
  assert.throws(() => validateChartSpec(spec('dual_axis'), input(['a'])), /DUAL_AXIS_REQUIRES_TWO_MEASURES/)
})

test('科研字体传递至 Python、R、MATLAB 并保留跨平台回退', () => {
  const fontSpec = spec('scatter3d')
  fontSpec.figure.fontFamily = 'Source Han Serif SC'
  const generated = generateCodeForSpec(fontSpec, input(['a', 'b', 'c']))
  assert.match(generated.python, /"font.family": \["Source Han Serif SC", \*plt.rcParams\["font.serif"\]/)
  assert.match(generated.python, /Source Han Sans SC/)
  assert.match(generated.r, /plot_font <- "Source Han Serif SC"/)
  assert.match(generated.r, /par\(family = plot_font\)/)
  assert.match(generated.r, /if \(!font_available\) plot_font <- "Noto Sans CJK SC"/)
  assert.match(generated.matlab, /defaultAxesFontName', 'Source Han Serif SC'/)
})

test('双Y轴 Python 模板：twinx 双轴与合并图例', () => {
  const code = generateCodeForSpec(spec('dual_axis'), input(['a', 'b'])).python
  assert.match(code, /twinx\(\)/)
  assert.match(code, /get_legend_handles_labels\(\)/)
  assert.match(code, /set_ylabel/)
})

test('三维曲面 Python 模板：删除占位轴并新建 3D 投影轴', () => {
  const code = generateCodeForSpec(spec('surface3d'), input(['a', 'b', 'c'])).python
  assert.match(code, /fig\.delaxes/)
  assert.match(code, /add_subplot\(1, 1, 1, projection="3d"\)/)
  assert.match(code, /plot_trisurf/)
  assert.match(code, /set_\{_axis\}lim/)
  assert.match(code, /set_box_aspect/)
  assert.match(code, /view_init/)
  assert.match(code, /无完整 XYZ 观测/)
})

test('三维散点 Python 模板：3D 投影轴 + scatter', () => {
  const code = generateCodeForSpec(spec('scatter3d'), input(['a', 'b', 'c'])).python
  assert.match(code, /projection="3d"/)
  assert.match(code, /\.scatter\(_x3\[_m3\], _y3\[_m3\], _z3\[_m3\]/)
  assert.match(code, /set_\{_axis\}lim/)
  assert.match(code, /edgecolors='white'/)
})

test('热力图 Python 模板：相关性矩阵（pandas3 兼容，无 numeric_only）、蓝白红可覆盖、小矩阵标注数值', () => {
  const code = generateCodeForSpec(spec('heatmap'), input(['a', 'b', 'c'])).python
  assert.match(code, /df\[measures\]\.corr\(\)/)
  assert.doesNotMatch(code, /numeric_only/)
  assert.match(code, /vmin=-1, vmax=1/)
  assert.match(code, /cmap="coolwarm"/)
  assert.match(code, /\.text\(/)
})

test('双Y轴 R 模板：sec_axis 比例换算', () => {
  const code = generateCodeForSpec(spec('dual_axis'), input(['a', 'b'])).r
  assert.match(code, /sec_axis/)
  assert.match(code, /scale_y_continuous/)
})

test('三维曲面 R 模板：akima 插值 persp 与降级', () => {
  const code = generateCodeForSpec(spec('surface3d'), input(['a', 'b', 'c'])).r
  assert.match(code, /akima::interp/)
  assert.match(code, /persp/)
  assert.match(code, /scatterplot3d/)
})

test('三维散点 R 模板：scatterplot3d', () => {
  const code = generateCodeForSpec(spec('scatter3d'), input(['a', 'b', 'c'])).r
  assert.match(code, /scatterplot3d::scatterplot3d/)
})

test('双Y轴 MATLAB 模板：yyaxis left/right', () => {
  const code = generateCodeForSpec(spec('dual_axis'), input(['a', 'b'])).matlab
  assert.match(code, /yyaxis left/)
  assert.match(code, /yyaxis right/)
})

test('三维曲面 MATLAB 模板：delaunay + trisurf', () => {
  const code = generateCodeForSpec(spec('surface3d'), input(['a', 'b', 'c'])).matlab
  assert.match(code, /delaunay/)
  assert.match(code, /trisurf/)
})

test('三维散点 MATLAB 模板：scatter3', () => {
  const code = generateCodeForSpec(spec('scatter3d'), input(['a', 'b', 'c'])).matlab
  assert.match(code, /scatter3\(/)
})

test('specPython 科研排版：约束布局自动预留总标题区、白底导出、标题 pad、无 tight_layout', () => {
  const code = generateCodeForSpec(spec('line', 1, 2), input(['a', 'b'])).python
  assert.match(code, /layout="constrained"/)
  assert.match(code, /fig\.suptitle\(/)
  assert.doesNotMatch(code, /suptitle\([\s\S]*y=1\.03\)/)
  assert.match(code, /facecolor="white"\)/)
  assert.match(code, /pad=14/)
  assert.doesNotMatch(code, /bbox_inches="tight"/)
  assert.doesNotMatch(code, /fig\.tight_layout\(\)/)
  assert.match(code, /"figure.facecolor": "#FFFFFF"/)
  assert.match(code, /"axes.titlesize": 15/)
})
