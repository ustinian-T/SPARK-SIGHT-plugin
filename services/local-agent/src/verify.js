// 独立验证层（算法说明书第 12 节 / 架构 5.6）：不读取生成器内部状态，
// 仅依据沙箱产物、原始 CSV 与证据账本做四项独立检查（规格/证据/差异/科研制图规则）。
import { createHash } from 'node:crypto'
import { inflateSync } from 'node:zlib'
import { parseCsv, toNumber } from './csv.js'
import { validateSpecAgainstRules, checkCaption } from './plotRules.js'

function isValidSvg(svg) {
  return typeof svg === 'string' && svg.includes('<svg') && svg.includes('</svg>') && svg.length > 500
}

export function checkSvgSafety(svg) {
  const text = String(svg ?? '')
  const issues = []
  if (/<\s*script\b|<\s*foreignObject\b|<\s*(?:iframe|object|embed)\b/i.test(text)) issues.push('SVG 包含不允许的可执行或外部嵌入节点')
  if (/\s+on[a-z]+\s*=|(?:href|xlink:href)\s*=\s*["']\s*(?:https?:|data:text\/html|javascript:)/i.test(text)) issues.push('SVG 包含事件属性或外部危险资源引用')
  return { passed: issues.length === 0, name: 'SVG 安全与导出', detail: issues.join('；') || 'SVG 未包含脚本、事件属性或危险外部资源' }
}

/**
 * 轻量 SVG 文本布局质检：服务端无法依赖浏览器字体排版，因此用 SVG
 * 的 x/y/font-size/text-anchor 估算文本盒，并只对标题/大字与视口越界做阻断。
 * 普通刻度之间的近似碰撞保留为 warning，避免字体差异导致合法产物误杀。
 */
export function checkSvgTextLayout(svg) {
  const source = String(svg ?? '')
  const root = /<svg\b([^>]*)>/i.exec(source)?.[1] ?? ''
  const viewBox = /\bviewBox\s*=\s*["']\s*[-\d.]+\s+[-\d.]+\s+(\d+(?:\.\d+)?)\s+(\d+(?:\.\d+)?)\s*["']/i.exec(root)
  const width = Number(viewBox?.[1] ?? /\bwidth\s*=\s*["']\s*(\d+(?:\.\d+)?)/i.exec(root)?.[1])
  const height = Number(viewBox?.[2] ?? /\bheight\s*=\s*["']\s*(\d+(?:\.\d+)?)/i.exec(root)?.[1])
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    return { passed: true, name: 'SVG 文字布局', detail: 'SVG 未声明可测量的 viewBox/尺寸，交由前端原生 getBBox() 复核', warnings: ['missing_viewbox'] }
  }
  const boxes = []
  const textRe = /<text\b([^>]*)>([\s\S]*?)<\/text>/gi
  const attr = (attrs, name) => new RegExp(`\\b${name}\\s*=\\s*["']([^"']+)`, 'i').exec(attrs)?.[1] ?? ''
  const numeric = (value, fallback = 0) => {
    const n = Number(String(value).match(/-?\d+(?:\.\d+)?/)?.[0])
    return Number.isFinite(n) ? n : fallback
  }
  let match
  while ((match = textRe.exec(source))) {
    const attrs = match[1]
    const content = match[2].replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/\s+/g, ' ').trim()
    if (!content) continue
    const style = attr(attrs, 'style')
    const transform = attr(attrs, 'transform')
    const translation = /translate\(\s*(-?[\d.]+)(?:[ ,]+(-?[\d.]+))?/i.exec(transform)
    const scale = /scale\(\s*(-?[\d.]+)/i.exec(transform)?.[1]
    const scaleFactor = Math.abs(numeric(scale, 1)) || 1
    const x = numeric(attr(attrs, 'x'), numeric(translation?.[1], 0))
    const baseline = numeric(attr(attrs, 'y'), numeric(translation?.[2], 0))
    const fontSize = numeric(attr(attrs, 'font-size'), numeric(/(?:^|;)\s*font-size\s*:\s*([\d.]+)/i.exec(style)?.[1], numeric(/(?:^|;)\s*font\s*:\s*([\d.]+)/i.exec(style)?.[1], 10))) * scaleFactor
    const anchor = attr(attrs, 'text-anchor') || /(?:^|;)\s*text-anchor\s*:\s*(middle|end|start)/i.exec(style)?.[1] || 'start'
    const textWidth = Math.max(fontSize, [...content].length * fontSize * (/[\u3400-\u9fff]/.test(content) ? 0.95 : 0.55))
    const left = anchor === 'middle' ? x - textWidth / 2 : anchor === 'end' ? x - textWidth : x
    boxes.push({ left, top: baseline - fontSize * 1.15, right: left + textWidth, bottom: baseline + fontSize * 0.15, content, fontSize })
  }
  const warnings = []
  const blocking = []
  for (const box of boxes) {
    const titleLike = box.fontSize >= 14 || /^图\s*\d|title|标题/i.test(box.content)
    if (titleLike && (box.left < 0 || box.top < 0 || box.right > width || box.bottom > height)) blocking.push(`标题/大字越过 SVG 视口：${box.content.slice(0, 30)}`)
  }
  for (let i = 0; i < boxes.length; i += 1) {
    for (let j = i + 1; j < boxes.length; j += 1) {
      const a = boxes[i]; const b = boxes[j]
      const area = Math.max(0, Math.min(a.right, b.right) - Math.max(a.left, b.left)) * Math.max(0, Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top))
      if (area <= 1) continue
      const titlePair = a.fontSize >= 14 || b.fontSize >= 14 || /^图\s*\d|title|标题/i.test(a.content) || /^图\s*\d|title|标题/i.test(b.content)
      if (titlePair) blocking.push(`标题与其他文字包围框重叠：${a.content.slice(0, 18)} / ${b.content.slice(0, 18)}`)
      else warnings.push(`普通文字可能重叠：${a.content.slice(0, 18)} / ${b.content.slice(0, 18)}`)
    }
  }
  return {
    passed: blocking.length === 0,
    name: 'SVG 文字布局',
    detail: blocking.concat(warnings).join('；') || `已检查 ${boxes.length} 个文本元素，标题区域无越界或重叠`,
    warnings
  }
}

function inspectPngRaster(dataBase64) {
  const bytes = Buffer.from(String(dataBase64 ?? ''), 'base64')
  if (bytes.length < 33 || bytes.toString('hex', 0, 8) !== '89504e470d0a1a0a') return null
  let width = 0; let height = 0; let bitDepth = 0; let colorType = -1
  const idat = []
  for (let offset = 8; offset + 12 <= bytes.length;) {
    const size = bytes.readUInt32BE(offset)
    if (offset + size + 12 > bytes.length) return null
    const type = bytes.toString('ascii', offset + 4, offset + 8)
    const chunk = bytes.subarray(offset + 8, offset + 8 + size)
    if (type === 'IHDR' && size === 13) {
      width = chunk.readUInt32BE(0); height = chunk.readUInt32BE(4)
      bitDepth = chunk[8]; colorType = chunk[9]
    } else if (type === 'IDAT') idat.push(chunk)
    else if (type === 'IEND') break
    offset += size + 12
  }
  const channels = ({ 0: 1, 2: 3, 4: 2, 6: 4 })[colorType]
  if (!width || !height || bitDepth !== 8 || !channels || width * height > 40_000_000) return null
  const bpp = channels
  const rowBytes = width * channels
  let packed
  try { packed = inflateSync(Buffer.concat(idat)) } catch { return null }
  if (packed.length !== (rowBytes + 1) * height) return null
  const rows = new Array(height)
  const paeth = (a, b, c) => {
    const p = a + b - c; const pa = Math.abs(p - a); const pb = Math.abs(p - b); const pc = Math.abs(p - c)
    return pa <= pb && pa <= pc ? a : pb <= pc ? b : c
  }
  for (let y = 0; y < height; y += 1) {
    const row = Buffer.allocUnsafe(rowBytes)
    const start = y * (rowBytes + 1); const filter = packed[start]; const prior = rows[y - 1]
    for (let x = 0; x < rowBytes; x += 1) {
      const raw = packed[start + 1 + x]; const left = x >= bpp ? row[x - bpp] : 0
      const up = prior?.[x] ?? 0; const upperLeft = x >= bpp ? prior?.[x - bpp] ?? 0 : 0
      const predictor = filter === 1 ? left : filter === 2 ? up : filter === 3 ? Math.floor((left + up) / 2) : filter === 4 ? paeth(left, up, upperLeft) : 0
      if (filter > 4) return null
      row[x] = (raw + predictor) & 255
    }
    rows[y] = row
  }
  let marked = 0; let minX = width; let minY = height; let maxX = -1; let maxY = -1
  for (let y = 0; y < height; y += 1) {
    const row = rows[y]
    for (let x = 0; x < width; x += 1) {
      const i = x * channels
      const r = colorType === 0 || colorType === 4 ? row[i] : row[i]
      const g = colorType === 0 || colorType === 4 ? r : row[i + 1]
      const b = colorType === 0 || colorType === 4 ? r : row[i + 2]
      const alpha = colorType === 4 ? row[i + 1] : colorType === 6 ? row[i + 3] : 255
      if (alpha > 12 && (Math.min(r, g, b) < 244 || Math.max(r, g, b) - Math.min(r, g, b) > 18)) {
        marked += 1; minX = Math.min(minX, x); minY = Math.min(minY, y); maxX = Math.max(maxX, x); maxY = Math.max(maxY, y)
      }
    }
  }
  return { width, height, markedPixels: marked, inkRatio: marked / (width * height), inkBounds: maxX < 0 ? null : { minX, minY, maxX, maxY } }
}

/**
 * SVG final-render proxy checks. The browser performs glyph-accurate checks in
 * the preview; this server-side pass catches deterministic clipping/degenerate
 * viewports and suspiciously empty exports before an artifact is marked ready.
 */
export function checkSvgRenderQuality(svg, png) {
  const source = String(svg ?? '')
  const root = /<svg\b([^>]*)>/i.exec(source)?.[1] ?? ''
  const vb = /\bviewBox\s*=\s*["']\s*(-?[\d.]+)\s+(-?[\d.]+)\s+([\d.]+)\s+([\d.]+)\s*["']/i.exec(root)
  const width = Number(vb?.[3] ?? /\bwidth\s*=\s*["']\s*([\d.]+)/i.exec(root)?.[1])
  const height = Number(vb?.[4] ?? /\bheight\s*=\s*["']\s*([\d.]+)/i.exec(root)?.[1])
  const issues = []
  const warnings = []
  if (!Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) {
    issues.push('SVG 缺少有效画布尺寸，无法验证最终绘图区')
  } else {
    const visibleText = [...source.matchAll(/<text\b[^>]*>([\s\S]*?)<\/text>/gi)]
      .map((m) => m[1].replace(/<[^>]+>/g, '').replace(/&(?:amp|lt|gt|quot|apos);/g, ' ').trim())
      .filter(Boolean)
    if (visibleText.length === 0) warnings.push('SVG 没有可搜索文本（可能已转曲或缺少标题/轴标注）')
    const drawable = [...source.matchAll(/<(?:path|line|polyline|polygon|circle|ellipse|rect)\b([^>]*)\/?\s*>/gi)]
    if (drawable.length < 1) issues.push('SVG 缺少可见绘图元素，疑似空白图或渲染不完整')
    // Explicit, untransformed circle/ellipse/rect primitives can be checked
    // exactly. Paths and transformed elements are intentionally not guessed.
    for (const [, attrs] of drawable) {
      const attr = (name) => new RegExp(`\\b${name}\\s*=\\s*["'](-?[\\d.]+)`, 'i').exec(attrs)?.[1]
      const x = Number(attr('x')); const y = Number(attr('y'))
      const w = Number(attr('width')); const h = Number(attr('height'))
      if (Number.isFinite(x) && Number.isFinite(y) && Number.isFinite(w) && Number.isFinite(h) &&
          !/\btransform\s*=/.test(attrs) && (x < -0.5 || y < -0.5 || x + w > width + 0.5 || y + h > height + 0.5)) {
        warnings.push('发现未变换的矩形绘图元素超出 SVG 画布边界')
        break
      }
    }
  }
  if (!png?.width || !png?.height) issues.push('缺少最终 PNG 渲染，不能完成位图验收')
  else if (png.width < 320 || png.height < 240) issues.push(`最终位图分辨率过低：${png.width}×${png.height}`)
  if (png?.dataBase64) {
    const raster = inspectPngRaster(png.dataBase64)
    if (!raster) issues.push('PNG 像素数据无法解码，不能完成最终图像验收')
    else if (raster.width !== png.width || raster.height !== png.height) issues.push('PNG 元数据尺寸与实际像素尺寸不一致')
    else if (raster.inkRatio < 0.0001 || !raster.inkBounds) issues.push('PNG 有效绘图像素过少，疑似空白或渲染残缺')
    else if (raster.inkBounds.minX <= 1 || raster.inkBounds.minY <= 1 || raster.inkBounds.maxX >= raster.width - 2 || raster.inkBounds.maxY >= raster.height - 2) {
      warnings.push('非白色绘图内容贴近位图边缘，建议检查裁切与留白')
    }
  } else {
    warnings.push('未提供 PNG 像素流，当前仅完成 SVG 结构与分辨率验收')
  }
  const passed = issues.length === 0
  return {
    passed,
    name: '最终渲染质量',
    detail: [...issues, ...warnings].join('；') || '画布、可见绘图元素及最终位图尺寸通过基础验收',
    warnings,
    issues,
    severity: passed ? (warnings.length ? 'warning' : 'pass') : 'error'
  }
}

// 检查 1：规格符合性——产物存在、SVG 合法、PNG 尺寸合理、面板布局代理校验
function checkSpecConformance(plan, result) {
  const details = []
  let passed = true
  if (result.status !== 'success') {
    return { passed: false, name: '规格符合性', detail: '沙箱执行未成功' }
  }
  const svgItem = result.artifacts.find((a) => a.name.endsWith('.svg'))
  const pngItem = result.artifacts.find((a) => a.name.endsWith('.png'))
  if (!isValidSvg(svgItem?.svg)) {
    passed = false
    details.push('SVG 缺失或不是合法矢量图')
  }
  if (!pngItem?.png || pngItem.png.width < 320 || pngItem.png.height < 240) {
    passed = false
    details.push(`PNG 尺寸异常：${pngItem ? `${pngItem.png.width}x${pngItem.png.height}` : '缺失'}`)
  }
  // 双面板方案应显著宽于高（布局代理检查）
  if (plan.spec.figure.cols > plan.spec.figure.rows && pngItem?.png && pngItem.png.width < pngItem.png.height * 1.6) {
    passed = false
    details.push('双面板方案宽高比与 1×2 布局不符')
  }
  // 面板数与 ChartSpec 布局声明一致
  const expectedPanels = plan.spec.figure.rows * plan.spec.figure.cols
  if (plan.spec.panels.length !== expectedPanels) {
    passed = false
    details.push(`ChartSpec 面板数 ${plan.spec.panels.length} ≠ 预期 ${expectedPanels}`)
  }
  return { passed, name: '规格符合性', detail: details.join('；') || 'SVG/PNG 合法，尺寸与布局符合 ChartSpec' }
}

// 检查 2：证据一致性——从原始 CSV 独立重算均值，与证据账本比对；代码只引用真实字段。
// v0.4.1：长表分组形态（panel.groups）下，series 标签是分组列取值而非列名，
// 独立重算每组组均值并与 series.y 比对；宽表保持原有逐系列校验。
function checkEvidenceConsistency({ plan, evidence, text, rawDelimiter }) {
  const details = []
  let passed = true
  const matrix = parseCsv(text, rawDelimiter)
  const header = matrix[0].map((h) => h.trim())
  const rows = matrix.slice(1)
  const groupPanel = (plan.spec.panels ?? []).find((p) => p.groups)

  if (groupPanel) {
    const gIdx = header.indexOf(groupPanel.groups.groupCol)
    const mIdx = header.indexOf(groupPanel.groups.measure)
    if (gIdx < 0 || mIdx < 0) {
      return { passed: false, name: '证据一致性', detail: `分组列 ${groupPanel.groups.groupCol} 或测量列 ${groupPanel.groups.measure} 不在 CSV 列中` }
    }
    const sums = new Map()
    const counts = new Map()
    for (const r of rows) {
      const g = String(r[gIdx] ?? '').trim()
      const v = toNumber(r[mIdx])
      if (!g || v === null) continue
      sums.set(g, (sums.get(g) ?? 0) + v)
      counts.set(g, (counts.get(g) ?? 0) + 1)
    }
    for (const s of plan.series) {
      const sourceValues = rows.filter((r) => String(r[gIdx] ?? '').trim() === s.label).map((r) => toNumber(r[mIdx])).filter((v) => v !== null)
      const plottedValues = (s.values ?? []).filter((v) => Number.isFinite(v))
      if (sourceValues.length !== plottedValues.length || sourceValues.some((v, i) => Math.abs(v - plottedValues[i]) > 1e-9)) {
        passed = false
        details.push(`组「${s.label}」传入绘图的数据点与 CSV 原始有效观测不一致`)
      }
      const mean = sums.has(s.label) ? sums.get(s.label) / counts.get(s.label) : null
      const position = Math.max(0, s.x?.indexOf(s.label) ?? 0)
      const plotted = Array.isArray(s.y) ? s.y[position] : s.y
      if (mean === null || !Number.isFinite(plotted)) {
        passed = false
        details.push(`组「${s.label}」不在分组列 ${groupPanel.groups.groupCol} 的取值中或组均值缺失`)
        continue
      }
      if (Math.abs(mean - plotted) > 1e-3) {
        passed = false
        details.push(`组「${s.label}」独立重算均值 ${mean.toFixed(3)} 与绘制值 ${plotted} 不一致`)
      }
    }
    if (!evidence.some((e) => e.evidence_id === 'ev_group_stats')) {
      passed = false
      details.push('缺少分组描述统计证据 ev_group_stats')
    }
  } else {
    for (const s of plan.series) {
      const idx = header.indexOf(s.label)
      if (idx < 0) {
        passed = false
        details.push(`代码系列字段「${s.label}」不在 CSV 列中`)
        continue
      }
      const sourceValues = rows.map((r) => toNumber(r[idx]))
      const plottedValues = Array.isArray(s.y) ? s.y : []
      if (sourceValues.length !== plottedValues.length || sourceValues.some((v, i) => v === null ? plottedValues[i] !== null : !Number.isFinite(plottedValues[i]) || Math.abs(v - plottedValues[i]) > 1e-9)) {
        passed = false
        details.push(`「${s.label}」绘图序列与 CSV 原始观测/缺失位置不一致`)
      }
      const vals = sourceValues.filter((v) => v !== null)
      const mean = vals.reduce((a, b) => a + b, 0) / vals.length
      const ev = evidence.find((e) => e.evidence_id === `ev_desc_${plan.series.indexOf(s)}`)
      const m = ev ? /mean=(-?[\d.]+)/.exec(ev.value) : null
      if (!m) {
        passed = false
        details.push(`「${s.label}」缺少描述统计证据 ev_desc_${plan.series.indexOf(s)}`)
      } else if (Math.abs(Number(m[1]) - Math.round(mean * 1e6) / 1e6) > 1e-3) {
        passed = false
        details.push(`「${s.label}」证据均值 ${m[1]} 与独立重算 ${mean.toFixed(3)} 不一致`)
      }
    }
    // v0.4.2：森林图必须能解析出 CI 列（显式 ciLow/ciHigh 或按 _sd/_se 后缀近似），防止引用不存在的列
    const forestPanel = (plan.spec.panels ?? []).find((p) => p.layers?.[0]?.kind === 'forest')
    if (forestPanel?.forest) {
      const fm = forestPanel.forest
      if (header.indexOf(fm.mean) < 0) {
        passed = false
        details.push(`森林图均值列「${fm.mean}」不在 CSV 列中`)
      } else {
        const hasCi = fm.ciLow && fm.ciHigh && header.indexOf(fm.ciLow) >= 0 && header.indexOf(fm.ciHigh) >= 0
        const hasSd = header.indexOf(`${fm.mean}_sd`) >= 0
        const hasSe = header.indexOf(`${fm.mean}_se`) >= 0
        if (!hasCi && !hasSd && !hasSe) {
          passed = false
          details.push(`森林图缺少 CI 列（${fm.ciLow}/${fm.ciHigh}）或 ${fm.mean}_sd/_se 列`)
        }
      }
    }
  }
  // 方案绑定的证据 id 必须全部存在
  for (const id of plan.evidenceIds ?? []) {
    if (!evidence.some((e) => e.evidence_id === id)) {
      passed = false
      details.push(`引用了不存在的证据 ${id}`)
    }
  }
  return { passed, name: '证据一致性', detail: details.join('；') || '系列均值独立重算与证据一致，证据引用完整' }
}

// 检查 3：方案差异——三方案 SVG 哈希两两不同、差异维度 ≥2、标题不同
function checkPlanDifference(plans, results) {
  const details = []
  let passed = true
  const hashes = plans.map((p) => {
    const r = results[p.plan_id]
    const svg = r?.artifacts.find((a) => a.name.endsWith('.svg'))?.svg ?? ''
    return createHash('sha256').update(svg).digest('hex')
  })
  for (let i = 0; i < hashes.length; i++) {
    for (let j = i + 1; j < hashes.length; j++) {
      if (hashes[i] === hashes[j]) {
        passed = false
        details.push(`${plans[i].plan_id} 与 ${plans[j].plan_id} 渲染产物完全相同`)
      }
    }
  }
  for (const p of plans) {
    if ((p.diffDimensions?.length ?? 0) < 2) {
      passed = false
      details.push(`${p.plan_id} 差异维度不足 2 个`)
    }
  }
  const titles = new Set(plans.map((p) => p.spec.figure.title))
  if (titles.size !== plans.length) {
    details.push('备选方案共用研究标题（便于同一问题下横向比较，不影响验收）')
  }
  return { passed, name: '方案差异', detail: details.join('；') || '三套方案渲染产物两两不同，差异维度均 ≥2' }
}

// 检查 4：科研制图规则符合性（《数模国赛MATLAB制图规则 v0.4》通用精华：纯白底、字号下限、
// 禁彩虹色、图注「图X-X 对象方法功能」无括号；标题居中与配色数量为建议级，不阻断交付）
function checkPlotRules(plan) {
  const violations = validateSpecAgainstRules(plan.spec ?? {})
  const errors = violations.filter((v) => v.level === 'error')
  const warns = violations.filter((v) => v.level === 'warn')
  const caption = plan.caption ? checkCaption(plan.caption) : { ok: true }
  const details = [
    ...errors.map((v) => v.message),
    ...warns.map((v) => `${v.message}（建议）`),
    ...(caption.ok ? [] : [caption.reason])
  ]
  return {
    passed: errors.length === 0,
    name: '科研制图规则',
    detail: details.join('；') || '白底、字号下限、图注格式与配色规范符合科研制图规则',
    violations
  }
}

// P1：不同图型不能只通过“文件能生成”验收。这里仅阻断确定错误；样本量、
// 双轴量纲差异等研究判断保留为可审阅建议，避免系统替代研究者作结论。
export function checkChartSemanticQuality(plan) {
  const panels = plan.spec?.panels ?? []
  const kinds = panels.flatMap((panel) => (panel.layers ?? []).map((layer) => layer.kind))
  const errors = []
  const warnings = []
  const finite = (values) => (values ?? []).filter(Number.isFinite)
  const uniqueCount = (values) => new Set(finite(values).map((value) => Number(value).toPrecision(12))).size
  if (kinds.some((kind) => kind === 'surface3d' || kind === 'scatter3d')) {
    const axes = (plan.series ?? []).slice(0, 3).map((series) => finite(series.y))
    if (axes.length < 3 || axes.some((values) => values.length < 4)) errors.push('三维图至少需要 3 个字段且每轴具有 4 个完整有限观测')
    else if (axes.some((values) => uniqueCount(values) < 2)) errors.push('三维图存在常数坐标轴，不能形成有效空间表达')
    else if (!/set_\{_axis\}lim|set_[xyz]lim/.test(plan.code?.python ?? '')) errors.push('三维图代码未显式按数据范围设置三轴范围')
    else if (!/view_init|view\(/.test(plan.code?.python ?? '')) warnings.push('三维图未声明观察视角，复现时视觉表达可能不稳定')
  }
  if (kinds.includes('heatmap') && (plan.series?.length ?? 0) < 2) errors.push('热力图至少需要两个数值变量')
  if (kinds.includes('forest')) {
    const forest = panels.find((panel) => panel.layers?.some((layer) => layer.kind === 'forest'))?.forest
    if (!forest?.mean) errors.push('森林图缺少效应量/均值字段声明')
    if (!/axvline\(0|abline\(v\s*=\s*0|xline\(0/.test(plan.code?.python ?? '') && !/abline\(v\s*=\s*0|xline\(0/.test(plan.code?.r ?? '')) warnings.push('森林图未检测到零效应参考线，请确认效应量尺度')
  }
  if (kinds.includes('violin')) {
    const samples = (plan.series ?? []).map((series) => finite(series.values ?? series.y).length)
    if (samples.some((count) => count > 0 && count < 5)) warnings.push('小提琴图存在 n<5 的组，密度形状不稳定；建议同时显示原始散点或改用箱线/点图')
  }
  if (kinds.includes('dual_axis') && (plan.series?.length ?? 0) >= 2) {
    const ranges = plan.series.slice(0, 2).map((series) => {
      const values = finite(series.y); return values.length ? Math.max(...values) - Math.min(...values) : 0
    })
    const positive = ranges.filter((value) => value > 0)
    if (positive.length === 2 && Math.max(...positive) / Math.min(...positive) > 100) warnings.push('双 Y 轴两侧量程相差超过 100 倍，比较斜率可能造成误导；建议提供归一化或分面版本')
  }
  return {
    passed: errors.length === 0,
    name: '图型语义与数据域',
    detail: [...errors, ...warnings].join('；') || '图型所需字段、数据变化与关键参考元素符合当前表达要求',
    issues: errors,
    warnings,
    severity: errors.length ? 'error' : warnings.length ? 'warning' : 'pass'
  }
}

export function checkDeliveryReadiness(plan, result) {
  const png = result.artifacts?.find((artifact) => artifact.name.endsWith('.png'))?.png
  const figure = plan.spec?.figure ?? {}
  const warnings = []
  const dpi = Number(figure.dpi ?? 300)
  if (dpi < 300) warnings.push(`当前渲染 DPI=${dpi}，适合预览但不建议作为期刊最终位图交付`)
  const targetWidth = Number(figure.widthIn ?? 0) * dpi
  const targetHeight = Number(figure.heightIn ?? 0) * dpi
  if (png?.width && targetWidth && png.width < targetWidth * 0.65) warnings.push('最终 PNG 宽度明显低于声明版面尺寸，导出前建议提高 DPI 或画布宽度')
  if (png?.height && targetHeight && png.height < targetHeight * 0.65) warnings.push('最终 PNG 高度明显低于声明版面尺寸，导出前建议提高 DPI 或画布高度')
  return {
    passed: true,
    name: '最终交付尺寸',
    detail: warnings.join('；') || `按 ${dpi} DPI 检查最终交付尺寸与科研排版可读性`,
    warnings,
    severity: warnings.length ? 'warning' : 'pass'
  }
}

// P2：将零散检查收敛为可记录、可比较的质量等级；分数从不覆盖硬错误。
export function summarizeQualityChecks(checks) {
  const failed = checks.filter((check) => !check.passed)
  const warnings = checks.reduce((count, check) => count + (check.warnings?.length ?? (check.severity === 'warning' ? 1 : 0)), 0)
  const score = Math.max(0, 100 - failed.length * 35 - warnings * 4)
  return {
    schema: 'deep-imaging.quality.v1',
    score,
    grade: failed.length ? 'blocked' : score >= 90 ? 'ready' : score >= 75 ? 'review' : 'revise',
    passedChecks: checks.filter((check) => check.passed).length,
    failedChecks: failed.length,
    warningCount: warnings,
    summary: failed.length ? `存在 ${failed.length} 项阻断问题，不能作为合格科研图交付` : warnings ? `通过硬性验收，存在 ${warnings} 条可审阅的质量建议` : '通过全部自动化质量验收，可进入人工科研表达复核'
  }
}

/**
 * 对单个方案执行前三项检查；对三方案集合执行差异检查。
 * @returns {{checks: object[], passed: boolean, artifactHash?: string}}
 */
export function verifyPlan(plan, result, ctx) {
  const svg = result.artifacts.find((a) => a.name.endsWith('.svg'))?.svg
  const checks = [
    checkSpecConformance(plan, result),
    checkEvidenceConsistency({ plan, ...ctx }),
    checkPlotRules(plan),
    checkSvgSafety(svg),
    checkSvgTextLayout(svg),
    checkSvgRenderQuality(svg, result.artifacts.find((a) => a.name.endsWith('.png'))?.png),
    checkChartSemanticQuality(plan),
    checkDeliveryReadiness(plan, result)
  ]
  const quality = summarizeQualityChecks(checks)
  return {
    passed: checks.every((c) => c.passed),
    checks,
    quality,
    artifactHash: svg ? createHash('sha256').update(svg).digest('hex') : undefined
  }
}

export function verifyAllPlans(plans, results, ctx) {
  const perPlan = {}
  for (const plan of plans) {
    perPlan[plan.plan_id] = verifyPlan(plan, results[plan.plan_id], ctx)
  }
  const difference = checkPlanDifference(
    plans.filter((p) => results[p.plan_id]?.status === 'success'),
    results
  )
  const passed = Object.values(perPlan).every((v) => v.passed) && difference.passed
  return { passed, perPlan, difference }
}
