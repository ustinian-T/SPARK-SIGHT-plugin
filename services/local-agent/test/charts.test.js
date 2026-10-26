process.env.LOCAL_AGENT_SANDBOX_TIMEOUT_MS ??= '120000'
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { generateCodeForSpec } from '../src/codegen.js'
import { buildCandidatePool } from '../src/decision/candidates.js'
import { buildStatisticalCorrectness } from '../src/decision/features.js'
import { runInSandbox } from '../src/sandbox.js'
import { probeEngines } from '../src/engines.js'
const HAS_PANDAS = Boolean(probeEngines().python.dependencies?.pandas)

const here = path.dirname(fileURLToPath(import.meta.url))
const sample = fs.readFileSync(path.join(here, 'fixtures', 'nitrogen_response_demo.csv'))
const input = {
  fileName: 'nitrogen_response_demo.csv',
  x: 'week',
  measures: ['control', 'treatment_a', 'treatment_b'],
  title: 'P0 图表覆盖测试',
  yLabel: 'response',
  outputBase: 'chart_spec'
}

function panel(id, kind) {
  return {
    panel_id: id,
    title: id,
    row: 0,
    col: 0,
    layers: [{ layer_id: `${id}_layer`, kind, dataRef: 'series_1', label: kind, color: '#315f4c' }],
    scales: [],
    annotations: []
  }
}

function fixtureSpec(chartType) {
  if (chartType === 'scatter') return { figure: { figure_id: 'scatter', title: '散点图', rows: 1, cols: 1 }, panels: [panel('p0', 'scatter')] }
  if (chartType === 'heatmap') return { figure: { figure_id: 'heatmap', title: '相关性热力图', rows: 1, cols: 1 }, panels: [panel('p0', 'heatmap')] }
  const kinds = ['line', 'bar', 'scatter', 'heatmap']
  return {
    figure: { figure_id: 'panel_2x2', title: '四面板', rows: 2, cols: 2 },
    panels: kinds.map((kind, index) => ({ ...panel(`p${index}`, kind), row: Math.floor(index / 2), col: index % 2 }))
  }
}

for (const chartType of ['scatter', 'heatmap', 'panel_2x2']) {
  test(`为 ${chartType} 生成 Python/R/MATLAB 可保存源码`, () => {
    const code = generateCodeForSpec(fixtureSpec(chartType), input)
    assert.match(code.python, /savefig/)
    assert.match(code.r, /ggsave|svg\(/)
    assert.match(code.matlab, /exportgraphics|print\(/)
  })
}

test('散点、热力图与 2×2 Python 模板在真实沙箱产出 SVG/PNG', async (t) => {
  if (!HAS_PANDAS) return t.skip('本机 Python 缺 pandas，跳过 spec pandas 模板真实执行；降级模板在 execution 测试覆盖')
  for (const chartType of ['scatter', 'heatmap', 'panel_2x2']) {
    const code = generateCodeForSpec(fixtureSpec(chartType), input).python
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), `chart-spec-${chartType}-`))
    const result = await runInSandbox({
      workdir,
      engine: 'python',
      code,
      csvBuffer: sample,
      csvName: input.fileName,
      expected: ['chart_spec.png', 'chart_spec.svg']
    })
    assert.equal(result.status, 'success', `${chartType}: ${result.stderr}`)
    assert.ok(result.artifacts.some((item) => item.name === 'chart_spec.svg'))
    assert.ok(result.artifacts.some((item) => item.name === 'chart_spec.png'))
  }
})

test('三维散点与空间曲面按真实 XYZ 数据范围生成可验证产物', async (t) => {
  if (!HAS_PANDAS) return t.skip('本机 Python 缺 pandas，跳过三维 spec 模板真实执行')
  const rows = ['x,y,z']
  for (let x = 0; x < 3; x++) for (let y = 0; y < 3; y++) rows.push(`${x},${y},${x * x + y}`)
  const xyz = Buffer.from(rows.join('\n'))
  const xyzInput = { fileName: 'xyz.csv', x: 'x', measures: ['x', 'y', 'z'], title: '空间响应', yLabel: 'z', outputBase: 'chart_spec', dpi: 300 }
  for (const kind of ['scatter3d', 'surface3d']) {
    const spec = { figure: { figure_id: kind, title: kind, rows: 1, cols: 1, fontFamily: 'DejaVu Sans' }, panels: [panel('p0', kind)] }
    const code = generateCodeForSpec(spec, xyzInput).python
    const workdir = fs.mkdtempSync(path.join(os.tmpdir(), `chart-3d-${kind}-`))
    const result = await runInSandbox({ workdir, engine: 'python', code, csvBuffer: xyz, csvName: 'xyz.csv', expected: ['chart_spec.png', 'chart_spec.svg'] })
    assert.equal(result.status, 'success', `${kind}: ${JSON.stringify(result)}`)
    assert.ok(result.artifacts.some((item) => item.name === 'chart_spec.svg'))
    assert.match(code, /getattr\(ax3d_0, f'set_\{_axis\}lim'\)/)
  }
})

test('热力图少于两个数值测量字段时明确不可行', () => {
  const analysis = {
    summary: { x: [1, 2, 3], series: [{ id: 's0', label: 'value', y: [1, 2, 3] }] }
  }
  const pool = buildCandidatePool(analysis)
  const heatmap = pool.find((item) => item.chartType === 'correlation_heatmap')
  assert.ok(heatmap)
  assert.equal(heatmap.executable, false)
  assert.equal(heatmap.infeasibleReason, 'HEATMAP_REQUIRES_TWO_NUMERIC_MEASURES')
})

test('统计表达不臆测误差棒语义，并对分布/三维/双轴呈现保留边界提示', () => {
  const unknown = buildStatisticalCorrectness('line_error', { hasErrorBars: true, errorBarKinds: ['unknown'] })
  assert.match(unknown.errorBarSemantics, /未知语义/)
  assert.ok(unknown.notes.some((note) => note.includes('不推断')))
  const se = buildStatisticalCorrectness('line_error', { hasErrorBars: true, errorBarKinds: ['se'] })
  assert.match(se.errorBarSemantics, /SE/)
  const threeD = buildStatisticalCorrectness('scatter3d', { hasErrorBars: false })
  assert.ok(threeD.notes.some((note) => note.includes('二维投影')))
})

test('Python 生成代码启用约束布局并让布局引擎自动预留总标题区', () => {
  const code = generateCodeForSpec(fixtureSpec('panel_2x2'), input).python
  assert.match(code, /layout="constrained"/)
  assert.match(code, /fig\.suptitle\([\s\S]*fontweight=[^)]*\)/)
  assert.doesNotMatch(code, /suptitle\([\s\S]*y=1\.03\)/)
  assert.match(code, /facecolor="white"(?:,|\))/)
  // v0.4.3：不再使用 bbox_inches="tight"（与 constrained 混用会把标题压贴边、与刻度重叠）；白底导出保留
  assert.doesNotMatch(code, /bbox_inches="tight"/)
  assert.doesNotMatch(code, /fig\.tight_layout\(\)/)
})

test('MATLAB 生成代码为 tiledlayout 使用 loose 标题区并显式渲染面板标题', () => {
  const code = generateCodeForSpec(fixtureSpec('panel_2x2'), input).matlab
  assert.match(code, /TileSpacing','loose'/)
  assert.match(code, /Padding','loose'/)
  assert.match(code, /panelTitles = \{/)
  assert.match(code, /_st\.HorizontalAlignment = 'center'/)
})
