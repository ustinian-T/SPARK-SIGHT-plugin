import test from 'node:test'
import assert from 'node:assert/strict'
import { deflateSync } from 'node:zlib'
import { checkSvgSafety, checkSvgTextLayout, checkSvgRenderQuality, verifyPlan } from '../src/verify.js'
import { repairVisualLayout } from '../src/repair.js'

function pngFixture({ width = 320, height = 240, ink = false } = {}) {
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 6
  const raw = Buffer.alloc((width * 4 + 1) * height, 255)
  for (let y = 0; y < height; y += 1) raw[y * (width * 4 + 1)] = 0
  if (ink) for (let y = 40; y < height - 40; y += 1) for (let x = 40; x < width - 40; x += 1) {
    const i = y * (width * 4 + 1) + 1 + x * 4
    raw[i] = 30; raw[i + 1] = 80; raw[i + 2] = 120; raw[i + 3] = 255
  }
  const chunk = (name, body) => {
    const head = Buffer.alloc(8); head.writeUInt32BE(body.length, 0); head.write(name, 4)
    return Buffer.concat([head, body, Buffer.alloc(4)])
  }
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]).toString('base64')
}

test('SVG export QA rejects scripts and unsafe external resources', () => {
  assert.equal(checkSvgSafety('<svg><script>alert(1)</script></svg>').passed, false)
  assert.equal(checkSvgSafety('<svg><image href="https://evil.test/a.png" /></svg>').passed, false)
  assert.equal(checkSvgSafety('<svg><rect width="10" height="10" /></svg>').passed, true)
})

test('最终渲染质量：阻断空图、无效画布和低分辨率产物', () => {
  const png = { width: 800, height: 600 }
  const good = `<svg viewBox="0 0 800 600"><path d="M10 10 L790 590"/><text x="400" y="24">title</text></svg>`
  assert.equal(checkSvgRenderQuality(good, png).passed, true)
  assert.equal(checkSvgRenderQuality('<svg viewBox="0 0 800 600"><text>empty</text></svg>', png).passed, false)
  assert.equal(checkSvgRenderQuality('<svg><path d="M0 0L1 1"/><path d="M1 1L2 2"/></svg>', png).passed, false)
  assert.equal(checkSvgRenderQuality(good, { width: 120, height: 100 }).passed, false)
  assert.equal(checkSvgRenderQuality(good, null).passed, false)
})

test('最终渲染质量：解码实际 PNG 像素，拒绝纯白空画布并允许有墨迹图像', () => {
  const svg = '<svg viewBox="0 0 320 240"><path d="M10 10 L300 200"/></svg>'
  assert.equal(checkSvgRenderQuality(svg, { width: 320, height: 240, dataBase64: pngFixture() }).passed, false)
  assert.equal(checkSvgRenderQuality(svg, { width: 320, height: 240, dataBase64: pngFixture({ ink: true }) }).passed, true)
  assert.equal(checkSvgRenderQuality(svg, { width: 321, height: 240, dataBase64: pngFixture({ ink: true }) }).passed, false)
})

test('视觉质检修复：增加标题安全区和导出留白，且有限次修复逐步收紧', () => {
  const source = "import matplotlib.pyplot as plt\nfig, ax = plt.subplots()\nfig.tight_layout()\nfig.savefig('plot.svg', bbox_inches='tight')"
  const first = repairVisualLayout(source, 1)
  const second = repairVisualLayout(source, 2)
  assert.match(first, /tight_layout\(rect=\[0\.04, 0\.06, 0\.96, 0\.86\]\)/)
  assert.match(first, /pad_inches=0\.18/)
  assert.match(second, /tight_layout\(rect=\[0\.04, 0\.06, 0\.96, 0\.82\]\)/)
  assert.equal(repairVisualLayout('plot(svg)', 1), null)
})

test('SVG 文本布局：标题越界或与其他大字重叠时阻断', () => {
  const safe = '<svg viewBox="0 0 200 100"><text x="100" y="20" text-anchor="middle" font-size="16">图 1-1</text><text x="20" y="80" font-size="10">轴标签</text></svg>'
  assert.equal(checkSvgTextLayout(safe).passed, true)
  const unsafe = '<svg viewBox="0 0 200 100"><text x="100" y="20" text-anchor="middle" font-size="16">图 1-1</text><text x="100" y="20" text-anchor="middle" font-size="16">重叠标题</text></svg>'
  assert.equal(checkSvgTextLayout(unsafe).passed, false)
})

test('SVG 文本布局：识别 Matplotlib 常见 transform/style 字体与中文宽度', () => {
  const safe = '<svg viewBox="0 0 240 120"><text transform="translate(120 18)" style="font-size:15px;text-anchor:middle">科研结果</text><text transform="translate(24 100)" style="font:10px SimHei">时间</text></svg>'
  assert.equal(checkSvgTextLayout(safe).passed, true)
  const unsafe = '<svg viewBox="0 0 120 80"><text transform="translate(60 8)" style="font-size:16px;text-anchor:middle">标题越界</text></svg>'
  assert.equal(checkSvgTextLayout(unsafe).passed, false)
})

test('独立验收拒绝均值相同但逐点被替换的数据序列', () => {
  const svg = `<svg viewBox="0 0 200 100"><text x="100" y="20" text-anchor="middle" font-size="16">标题</text>${' '.repeat(520)}</svg>`
  const plan = {
    plan_id: 'p', caption: '图1-1 数据比较', evidenceIds: ['ev_desc_0'], diffDimensions: ['chartType', 'encoding'],
    series: [{ label: 'value', y: [2, 2] }],
    spec: { figure: { title: '数据比较', rows: 1, cols: 1 }, panels: [{ panel_id: 'p1', layers: [{ kind: 'line' }], scales: [] }] }
  }
  const result = { status: 'success', artifacts: [
    { name: 'plot.svg', svg }, { name: 'plot.png', png: { width: 800, height: 600 } }
  ] }
  const verification = verifyPlan(plan, result, {
    evidence: [{ evidence_id: 'ev_desc_0', value: 'mean=2' }],
    text: 'time,value\n1,1\n2,3', rawDelimiter: ','
  })
  const evidenceCheck = verification.checks.find((check) => check.name === '证据一致性')
  assert.equal(evidenceCheck.passed, false)
  assert.match(evidenceCheck.detail, /原始观测/)
})
