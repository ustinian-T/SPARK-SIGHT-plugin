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

test('棒棒糖图与气泡图：保留真实科研表达并生成尺寸/排序编码', () => {
  const lollipop = generateCodeForSpec(spec('lollipop'), input(['响应指标'])).python
  assert.match(lollipop, /hlines/)
  assert.match(lollipop, /scatter/)
  assert.match(lollipop, /sort_values/)
  const bubble = generateCodeForSpec(spec('bubble'), input(['温度', '响应指标', '单样本成本'])).python
  assert.match(bubble, /_size = 90 \+ 520/)
  assert.match(bubble, /cmap="plasma"/)
  assert.match(bubble, /气泡图需要至少 3 个完整观测/)
})

test('分组小提琴图：不同组使用不同配色并叠加原始观测', () => {
  const s = spec('violin')
  s.panels[0].groups = { groupCol: '实验组别', measure: '响应指标' }
  const code = generateCodeForSpec(s, input(['响应指标'])).python
  assert.match(code, /colors\[_vi % len\(colors\)\]/)
  assert.match(code, /np\.random\.default_rng\(2026 \+ _vi\)/)
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
  assert.match(code, /_dual_df\[x_col\]\.duplicated\(\)\.any\(\)/)
  assert.match(code, /groupby\(x_col, as_index=False\)/)
})

test('三维曲面 Python 模板：删除占位轴并新建 3D 投影轴', () => {
  const code = generateCodeForSpec(spec('surface3d'), input(['a', 'b', 'c'])).python
  assert.match(code, /fig\.delaxes/)
  assert.match(code, /add_subplot\(1, 1, 1, projection="3d"\)/)
  assert.match(code, /plot_trisurf/)
  assert.match(code, /set_\{_axis\}lim/)
  assert.match(code, /set_box_aspect/)
  assert.match(code, /view_init/)
  assert.match(code, /3D 曲面需要至少 8 个完整且非共线的 XY 观测/)
})

test('三维曲面二次处理：规则网格插值且无额外 SciPy 依赖', () => {
  const base = spec('surface3d')
  base.figure.secondaryProcessing = 'interpolate'
  const code = generateCodeForSpec(base, input(['a', 'b', 'c'])).python
  assert.match(code, /plot_surface\(_GX, _GY, _GZ/)
  assert.match(code, /np\.interp/)
  assert.match(code, /网格不完整，使用原始三角曲面/)
  assert.doesNotMatch(code, /from scipy\.interpolate/)
})

test('三维散点 Python 模板：3D 投影轴 + scatter', () => {
  const code = generateCodeForSpec(spec('scatter3d'), input(['a', 'b', 'c'])).python
  assert.match(code, /projection="3d"/)
  assert.match(code, /\.scatter\(_x3\[_m3\], _y3\[_m3\], _z3\[_m3\]/)
  assert.match(code, /set_\{_axis\}lim/)
  assert.match(code, /edgecolors='white'/)
})

test('三维折线与三维填充折线：按第二轴分层生成峰形轨迹', () => {
  for (const kind of ['line3d', 'filled_line3d']) {
    const code = generateCodeForSpec(spec(kind), input(['质量电荷', '样本序号', '信号强度'])).python
    assert.match(code, /projection="3d"/)
    assert.match(code, /np\.unique\(_y3\[_m3\]\)/)
    assert.match(code, /\.plot\(_xs, np\.full\(len\(_xs\), _yv\), _zs/)
  }
  const filled = generateCodeForSpec(spec('filled_line3d'), input(['质量电荷', '样本序号', '信号强度'])).python
  assert.match(filled, /alpha=0\.16, linewidth=3\.0/)
})

test('热力图 Python 模板：相关性矩阵（pandas3 兼容，无 numeric_only）、蓝白红可覆盖、小矩阵标注数值', () => {
  const code = generateCodeForSpec(spec('heatmap'), input(['a', 'b', 'c'])).python
  assert.match(code, /df\[measures\]\.corr\(min_periods=3\)/)
  assert.doesNotMatch(code, /numeric_only/)
  assert.match(code, /vmin=-1, vmax=1/)
  assert.match(code, /cmap=.*coolwarm/)
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
