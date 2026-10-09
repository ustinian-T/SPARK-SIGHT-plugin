// 由 ChartSpec + 确定性聚合系列驱动的 SVG 预览（前端占位渲染）。
// 后端就绪后预览以引擎实际输出的 SVG/PNG 为准；本组件保证界面调整在 500ms 内得到一致反馈。
import { useMemo, useRef, useState } from 'react'
import type { LayerKind, PanelSpec, PlotPlan, PreviewSeries } from '../types'
import { canonicalChartType } from '../lib/chartTypes'

interface Box {
  x: number
  y: number
  w: number
  h: number
}

const PAD = { l: 48, r: 14, t: 30, b: 36 }

export function wrapPreviewTitle(title: string, maxChars = 34): string[] {
  const value = String(title ?? '').trim()
  if (!value) return ['']
  const lines: string[] = []
  for (let offset = 0; offset < value.length; offset += maxChars) lines.push(value.slice(offset, offset + maxChars))
  return lines
}

export function previewTopReserve(title: string, legendAtTop: boolean): number {
  return 18 + wrapPreviewTitle(title).length * 16 + (legendAtTop ? 24 : 8)
}

function previewKind(kind: LayerKind): LayerKind {
  return canonicalChartType(String(kind))
}

function divergingColor(value: number): string {
  const low = [110, 143, 178]
  const mid = [255, 255, 255]
  const high = [193, 110, 113]
  const t = Math.min(1, Math.max(-1, value))
  const a = t < 0 ? low : mid
  const b = t < 0 ? mid : high
  const p = t < 0 ? t + 1 : t
  return `rgb(${a.map((v, i) => Math.round(v + (b[i] - v) * p)).join(',')})`
}

function niceDomain(min: number, max: number): [number, number] {
  if (min === max) return [min - 1, max + 1]
  const pad = (max - min) * 0.12
  return [min - pad, max + pad]
}

function ticks(min: number, max: number, n = 4): number[] {
  const [a, b] = niceDomain(min, max)
  const step = (b - a) / n
  return Array.from({ length: n + 1 }, (_, i) => a + step * i)
}

function normalize(series: PreviewSeries[]): PreviewSeries[] {
  return series.map((s) => {
    const base = s.y.find((value) => value !== null) || 1
    return { ...s, y: s.y.map((v) => (v === null ? null : (100 * v) / base)), yerr: undefined }
  })
}

// Older Agent snapshots stored group means/errors as scalars. Normalize that
// wire format before rendering so saved projects cannot blank the workbench.
export function normalizePreviewSeries(series: PreviewSeries[]): PreviewSeries[] {
  return series.map(s => {
    const x = Array.isArray(s.x) && s.x.length ? s.x : [s.label]
    const position = Math.max(0, x.indexOf(s.label))
    const align = (value: unknown): (number | null)[] => Array.isArray(value) ? value
      : x.map((_, i) => i === position && typeof value === 'number' && Number.isFinite(value) ? value : null)
    return { ...s, x, y: align(s.y), ...(s.yerr === undefined ? {} : { yerr: align(s.yerr) }) }
  })
}

function lineSegments(values: (number | null)[], xAt: (index: number) => number, yAt: (value: number) => number): string[] {
  const segments: string[] = []
  let current: string[] = []
  values.forEach((value, index) => {
    if (value === null) {
      if (current.length) segments.push(current.join(' '))
      current = []
    } else current.push(`${xAt(index)},${yAt(value)}`)
  })
  if (current.length) segments.push(current.join(' '))
  return segments
}

function correlation(a: (number | null)[], b: (number | null)[]): number {
  const pairs = a.map((value, index) => [value, b[index]] as const).filter((pair): pair is readonly [number, number] => pair[0] !== null && pair[1] !== null)
  if (pairs.length < 2) return 0
  const meanA = pairs.reduce((sum, pair) => sum + pair[0], 0) / pairs.length
  const meanB = pairs.reduce((sum, pair) => sum + pair[1], 0) / pairs.length
  const numerator = pairs.reduce((sum, pair) => sum + (pair[0] - meanA) * (pair[1] - meanB), 0)
  const da = Math.sqrt(pairs.reduce((sum, pair) => sum + (pair[0] - meanA) ** 2, 0))
  const db = Math.sqrt(pairs.reduce((sum, pair) => sum + (pair[1] - meanB) ** 2, 0))
  return da && db ? numerator / (da * db) : 0
}

/** 五数概括：min / Q1 / median / Q3 / max（箱线图占位用） */
function fiveNumber(values: number[]): [number, number, number, number, number] {
  const sorted = [...values].sort((a, b) => a - b)
  const n = sorted.length
  if (n === 0) return [0, 0, 0, 0, 0]
  const quantile = (p: number) => {
    const idx = (n - 1) * p
    const lo = Math.floor(idx)
    const hi = Math.ceil(idx)
    return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (idx - lo)
  }
  return [sorted[0], quantile(0.25), quantile(0.5), quantile(0.75), sorted[n - 1]]
}

function violinPath(cx: number, values: number[], yAt: (value: number) => number, width: number): string {
  if (values.length === 0) return ''
  const min = Math.min(...values)
  const max = Math.max(...values)
  if (min === max) return `M ${cx - 2},${yAt(min)} L ${cx + 2},${yAt(min)} Z`
  const bandwidth = Math.max((max - min) * 0.18, 1e-6)
  const levels = Array.from({ length: 25 }, (_, i) => min + (max - min) * i / 24)
  const density = levels.map((level) => values.reduce((sum, value) => sum + Math.exp(-0.5 * ((value - level) / bandwidth) ** 2), 0))
  const peak = Math.max(...density, 1)
  const widths = density.map((value) => 2 + width * Math.sqrt(value / peak))
  const left = levels.map((level, i) => `${cx - widths[i]},${yAt(level)}`).join(' L ')
  const right = levels.slice().reverse().map((level, i) => `${cx + widths[levels.length - 1 - i]},${yAt(level)}`).join(' L ')
  return `M ${left} L ${right} Z`
}

function Panel({
  box,
  panel,
  series,
  kind,
  norm,
  showErrors,
  baseline
}: {
  box: Box
  panel?: PanelSpec
  series: PreviewSeries[]
  kind: LayerKind
  norm?: boolean
  showErrors?: boolean
  baseline?: number
}) {
  const [hovered, setHovered] = useState<{ x: number; y: number; label: string; value: string; color: string } | null>(null)
  const [view3d, setView3d] = useState({ rotation: 0, zoom: 1 })
  const drag3d = useRef<{ x: number; rotation: number } | null>(null)
  const data = useMemo(() => {
    const safe = normalizePreviewSeries(series)
    return norm ? normalize(safe) : safe
  }, [norm, series])
  const n = data[0]?.x.length ?? 0
  const ns = data.length
  const innerW = box.w - PAD.l - PAD.r
  const innerH = box.h - PAD.t - PAD.b
  const allY = useMemo(() => data.flatMap((s) => s.y).filter((value): value is number => value !== null), [data])
  let ymin = Math.min(...allY, baseline ?? Infinity)
  let ymax = Math.max(...allY, baseline ?? -Infinity)
  if (showErrors && !norm) {
    data.forEach((s) =>
      s.yerr?.forEach((e, i) => {
        const value = s.y[i]
        if (value === null || e === null) return
        ymin = Math.min(ymin, value - e)
        ymax = Math.max(ymax, value + e)
      })
    )
  }
  const [d0, d1] = niceDomain(ymin, ymax)
  const xAt = (i: number) => box.x + PAD.l + (n <= 1 ? innerW / 2 : (innerW * i) / (n - 1))
  const yAt = (v: number) => box.y + PAD.t + innerH - ((v - d0) / (d1 - d0)) * innerH
  const yticks = ticks(d0, d1)
  const xLabels = data[0]?.x ?? []

  const groupW = innerW / Math.max(n, 1)
  const barW = Math.min(26, (groupW * 0.8) / Math.max(ns, 1))
  const scatterPairs = data.length >= 2
    ? data[0].y.map((value, index) => [value, data[1].y[index]] as const).filter((pair): pair is readonly [number, number] => pair[0] !== null && pair[1] !== null)
    : []
  const scatterX = scatterPairs.map((pair) => pair[0])
  const scatterY = scatterPairs.map((pair) => pair[1])
  const [sx0, sx1] = scatterX.length ? niceDomain(Math.min(...scatterX), Math.max(...scatterX)) : [0, 1]
  const [sy0, sy1] = scatterY.length ? niceDomain(Math.min(...scatterY), Math.max(...scatterY)) : [0, 1]
  const scatterXAt = (value: number) => box.x + PAD.l + ((value - sx0) / (sx1 - sx0)) * innerW
  const scatterYAt = (value: number) => box.y + PAD.t + innerH - ((value - sy0) / (sy1 - sy0)) * innerH
  const clearHover = () => setHovered(null)
  const setHover = (event: React.SyntheticEvent<SVGElement>, label: string, value: string, color: string) => {
    const target = event.currentTarget.getBoundingClientRect()
    const host = event.currentTarget.ownerSVGElement?.getBoundingClientRect()
    setHovered({ x: (target.left - (host?.left ?? 0)) + target.width / 2, y: target.top - (host?.top ?? 0), label, value, color })
  }
  const forestDomain = niceDomain(Math.min(...allY, 0), Math.max(...allY, 1))
  const forestXAt = (value: number) => box.x + PAD.l + ((value - forestDomain[0]) / (forestDomain[1] - forestDomain[0])) * innerW
  const forestRows = data.flatMap((s) => s.y.map((value, index) => ({ series: s, value, index, error: s.yerr?.[index] ?? null, ciLow: s.ciLow ?? null, ciHigh: s.ciHigh ?? null }))).filter((item): item is { series: PreviewSeries; value: number; index: number; error: number | null; ciLow: number | null; ciHigh: number | null } => item.value !== null)
  const violinEntries = data.map((s) => ({ label: s.label, color: s.color, values: s.values?.filter(Number.isFinite) ?? s.y.filter((value): value is number => value !== null) }))
  const violinXAt = (index: number) => box.x + PAD.l + (violinEntries.length <= 1 ? innerW / 2 : (innerW * index) / (violinEntries.length - 1))

  return (
    <g>
      {panel?.title && (
        <text x={box.x + box.w / 2} y={box.y + 16} textAnchor="middle" fontSize={12} fontWeight={650} fill="#1d3327">
          {panel.title}
        </text>
      )}
      {/* 网格 + Y 轴刻度 */}
      {yticks.map((tv, i) => {
        const y = yAt(tv)
        return (
          <g key={i}>
            <line x1={box.x + PAD.l} x2={box.x + box.w - PAD.r} y1={y} y2={y} stroke="#e2ece5" strokeWidth={1} />
            <text x={box.x + PAD.l - 6} y={y + 3.5} textAnchor="end" fontSize={9.5} fill="#7c9185">
              {Math.abs(tv) >= 100 ? tv.toFixed(0) : tv.toFixed(1)}
            </text>
          </g>
        )
      })}
      {/* 基准线 */}
      {baseline !== undefined && (
        <line x1={box.x + PAD.l} x2={box.x + box.w - PAD.r} y1={yAt(baseline)} y2={yAt(baseline)} stroke="#9aa79e" strokeWidth={1} strokeDasharray="5 4" />
      )}
      {/* X 轴 */}
      <line x1={box.x + PAD.l} x2={box.x + box.w - PAD.r} y1={box.y + PAD.t + innerH} y2={box.y + PAD.t + innerH} stroke="#cdd8d1" />
      {xLabels.map((lab, i) => (
        <text key={i} x={xAt(i)} y={box.y + PAD.t + innerH + 16} textAnchor="middle" fontSize={9.5} fill="#7c9185">
          {String(lab)}
        </text>
      ))}
      {/* 数据 */}
      {kind === 'heatmap' ? (
        data.map((row, ri) =>
          data.map((column, ci) => {
            const value = correlation(row.y, column.y)
            const cellW = innerW / Math.max(data.length, 1)
            const cellH = innerH / Math.max(data.length, 1)
            return (
              <g key={`${row.id}-${column.id}`}>
                <rect x={box.x + PAD.l + ci * cellW} y={box.y + PAD.t + ri * cellH} width={cellW} height={cellH} fill={divergingColor(value)} />
                <text x={box.x + PAD.l + (ci + 0.5) * cellW} y={box.y + PAD.t + (ri + 0.55) * cellH} textAnchor="middle" fontSize={9} fill="#20352a">
                  {value.toFixed(2)}
                </text>
              </g>
            )
          })
        )
      ) : kind === 'surface3d' || kind === 'scatter3d' ? (
        <g
          onMouseLeave={clearHover}
          tabIndex={0}
          role="application"
          aria-label="三维图交互预览：拖动旋转，滚轮缩放，双击复位"
          onDoubleClick={() => setView3d({ rotation: 0, zoom: 1 })}
          onKeyDown={(event) => { if (event.key === 'Home' || event.key === '0') setView3d({ rotation: 0, zoom: 1 }) }}
          onPointerDown={(event) => { drag3d.current = { x: event.clientX, rotation: view3d.rotation }; event.currentTarget.setPointerCapture?.(event.pointerId) }}
          onPointerMove={(event) => { if (drag3d.current) setView3d((current) => ({ ...current, rotation: drag3d.current!.rotation + (event.clientX - drag3d.current!.x) * .35 })) }}
          onPointerUp={() => { drag3d.current = null }}
          onPointerCancel={() => { drag3d.current = null }}
          onWheel={(event) => { event.preventDefault(); setView3d((current) => ({ ...current, zoom: Math.min(1.35, Math.max(.75, current.zoom - event.deltaY * .001)) })) }}
          style={{ cursor: drag3d.current ? 'grabbing' : 'grab' }}
          transform={`translate(${box.x + box.w / 2} ${box.y + box.h / 2}) scale(${view3d.zoom}) rotate(${view3d.rotation}) translate(${-box.x - box.w / 2} ${-box.y - box.h / 2})`}
        >
          <line x1={box.x + PAD.l + innerW * .12} y1={box.y + PAD.t + innerH * .86} x2={box.x + PAD.l + innerW * .82} y2={box.y + PAD.t + innerH * .86} stroke="#9db3a5" />
          <line x1={box.x + PAD.l + innerW * .12} y1={box.y + PAD.t + innerH * .86} x2={box.x + PAD.l + innerW * .38} y2={box.y + PAD.t + innerH * .58} stroke="#9db3a5" />
          <text x={box.x + PAD.l + innerW * .5} y={box.y + box.h - 9} textAnchor="middle" fontSize={8.5} fill="#7c9185">拖动旋转 · 滚轮缩放 · 双击复位</text>
          {data.flatMap((s, si) => s.y.map((value, i) => value === null ? null : ({ s, si, i, value }))).filter(Boolean).map((point) => {
            if (!point) return null
            const { s, si, i, value } = point
            const xn = n <= 1 ? .5 : i / (n - 1)
            const yn = (value - d0) / (d1 - d0)
            const zn = data.length <= 1 ? .5 : si / (data.length - 1)
            const px = box.x + PAD.l + innerW * (.12 + xn * .65 - zn * .25)
            const py = box.y + PAD.t + innerH * (.86 - yn * .52 - zn * .2)
            const label = `${s.label} · ${xLabels[i] ?? i + 1}`
            return <circle key={`${s.id}-${i}`} cx={px} cy={py} r={kind === 'surface3d' ? 3 : 4} fill={s.color} opacity={.88} tabIndex={0} role="img" aria-label={`${label}: ${value.toFixed(2)}`} onMouseEnter={(event) => setHover(event, label, value.toFixed(2), s.color)} onFocus={(event) => setHover(event, label, value.toFixed(2), s.color)} />
          })}
          {kind === 'surface3d' && data.slice(0, -1).flatMap((s, si) => s.y.slice(0, -1).map((value, i) => {
            const next = s.y[i + 1]
            const below = data[si + 1]?.y[i]
            if (value === null || next === null || below === null) return null
            const p = (v: number, x: number, z: number) => {
              const xn = n <= 1 ? .5 : x / (n - 1); const yn = (v - d0) / (d1 - d0); const zn = data.length <= 1 ? .5 : z / (data.length - 1)
              return `${box.x + PAD.l + innerW * (.12 + xn * .65 - zn * .25)},${box.y + PAD.t + innerH * (.86 - yn * .52 - zn * .2)}`
            }
            return <polygon key={`surface-${si}-${i}`} points={`${p(value, i, si)} ${p(next, i + 1, si)} ${p(data[si + 1].y[i + 1] ?? value, i + 1, si + 1)} ${p(below, i, si + 1)}`} fill={s.color} opacity={.12} stroke={s.color} strokeWidth={.6} />
          }))}
        </g>
      ) : kind === 'forest' ? (
        <g onMouseLeave={clearHover}>
          {forestRows.map(({ series: s, value, index, error, ciLow, ciHigh }, row) => {
            const y = box.y + PAD.t + ((row + .5) / Math.max(forestRows.length, 1)) * innerH
            const hasCi = ciLow !== null && ciHigh !== null
            const lo = hasCi ? ciLow! : error === null ? value : value - error
            const hi = hasCi ? ciHigh! : error === null ? value : value + error
            const label = `${s.label} · ${xLabels[index] ?? index + 1}`
            const errorLabel = hasCi ? '95%CI' : panel?.errorBarMode?.toUpperCase() ?? 'ERROR'
            const valueLabel = hasCi ? `${value.toFixed(2)} [${errorLabel} ${lo.toFixed(2)}, ${hi.toFixed(2)}]` : error === null ? `${value.toFixed(2)}（CI/误差缺失）` : `${value.toFixed(2)} [${errorLabel} ${error.toFixed(2)}]`
            return <g key={`${s.id}-${index}`} tabIndex={0} role="img" aria-label={`${label}: ${valueLabel}`} onMouseEnter={(event) => setHover(event, label, valueLabel, s.color)} onFocus={(event) => setHover(event, label, valueLabel, s.color)}>
              {(hasCi || error !== null) && <>
                <line x1={forestXAt(lo)} x2={forestXAt(hi)} y1={y} y2={y} stroke={s.color} strokeWidth={1.7} />
                <line x1={forestXAt(lo)} x2={forestXAt(lo)} y1={y - 4} y2={y + 4} stroke={s.color} />
                <line x1={forestXAt(hi)} x2={forestXAt(hi)} y1={y - 4} y2={y + 4} stroke={s.color} />
              </>}
              <circle cx={forestXAt(value)} cy={y} r={4} fill={s.color} />
              <text x={box.x + PAD.l - 6} y={y + 3} textAnchor="end" fontSize={9} fill="#5b7466">{xLabels[index] ?? index + 1}</text>
            </g>
          })}
          <line x1={forestXAt(0)} x2={forestXAt(0)} y1={box.y + PAD.t} y2={box.y + PAD.t + innerH} stroke="#9aa79e" strokeDasharray="4 3" />
        </g>
      ) : kind === 'violin' ? (
        <g onMouseLeave={clearHover}>
          {violinEntries.map((entry, index) => {
            const values = entry.values
            const cx = violinXAt(index)
            const label = entry.label
            const valueLabel = `${values.length} 个观测`
            return <g key={index} tabIndex={0} role="img" aria-label={`${label}: ${valueLabel}`} onMouseEnter={(event) => setHover(event, label, valueLabel, entry.color)} onFocus={(event) => setHover(event, label, valueLabel, entry.color)}>
              <path d={violinPath(cx, values, yAt, Math.min(24, groupW * .32))} fill={entry.color} opacity={.3} stroke={entry.color} />
              {values.map((value, vi) => <circle key={vi} cx={cx + ((vi % 3) - 1) * 3} cy={yAt(value)} r={1.8} fill={entry.color} opacity={.72} />)}
            </g>
          })}
        </g>
      ) : kind === 'scatter' ? (
        scatterPairs.length ? scatterPairs.map(([xValue, yValue], index) => (
          <circle key={index} cx={scatterXAt(xValue)} cy={scatterYAt(yValue)} r={3.2} fill={data[1]?.color ?? '#315f4c'} opacity={0.82} />
        )) : (
          <text x={box.x + PAD.l + innerW / 2} y={box.y + PAD.t + innerH / 2} textAnchor="middle" fontSize={11} fill="#7c9185">散点图需要两个数值系列</text>
        )
      ) : kind === 'bar'
        ? data.map((s, si) =>
            s.y.map((v, i) => {
              if (v === null) return null
              const cx = xAt(i) + (si - (ns - 1) / 2) * barW
              const y = yAt(v)
              const err = showErrors && !norm ? s.yerr?.[i] : null
              return (
                <g key={`${s.id}-${i}`}>
                  <rect x={cx} y={y} width={barW - 1.5} height={box.y + PAD.t + innerH - y} rx={2} fill={s.color} opacity={0.92} />
                  {err !== null && err !== undefined && (
                    <g stroke={s.color} strokeWidth={1.1}>
                      <line x1={cx + (barW - 1.5) / 2} x2={cx + (barW - 1.5) / 2} y1={yAt(v - err)} y2={yAt(v + err)} />
                      <line x1={cx + (barW - 1.5) / 2 - 3} x2={cx + (barW - 1.5) / 2 + 3} y1={yAt(v - err)} y2={yAt(v - err)} />
                      <line x1={cx + (barW - 1.5) / 2 - 3} x2={cx + (barW - 1.5) / 2 + 3} y1={yAt(v + err)} y2={yAt(v + err)} />
                    </g>
                  )}
                </g>
              )
            })
          )
        : kind === 'line' ? data.map((s, si) => {
            const segments = lineSegments(s.y, xAt, yAt)
            return (
              <g key={s.id}>
                {segments.map((points, index) => (
                  <polyline key={index} points={points} fill="none" stroke={s.color} strokeWidth={1.8} />
                ))}
                {showErrors &&
                  !norm &&
                  s.yerr?.map((e, i) => {
                    const value = s.y[i]
                    if (value === null || e === null) return null
                    return (
                      <g key={i} stroke={s.color} strokeWidth={1.1}>
                        <line x1={xAt(i)} x2={xAt(i)} y1={yAt(value - e)} y2={yAt(value + e)} />
                        <line x1={xAt(i) - 3} x2={xAt(i) + 3} y1={yAt(value - e)} y2={yAt(value - e)} />
                        <line x1={xAt(i) - 3} x2={xAt(i) + 3} y1={yAt(value + e)} y2={yAt(value + e)} />
                      </g>
                    )
                  })}
                {s.y.map((v, i) =>
                  v === null ? null : <circle key={i} cx={xAt(i)} cy={yAt(v)} r={si === 0 ? 3 : 2.6} fill="#fff" stroke={s.color} strokeWidth={1.6} />
                )}
              </g>
            )
          }) : kind === 'box' ? (
            // 箱线图占位：五数概括（min/Q1/median/Q3/max）渲染矩形框 + 中位线 + 须线
            allY.length ? (() => {
              const [min, q1, med, q3, max] = fiveNumber(allY)
              const cx = box.x + PAD.l + innerW / 2
              const bw = Math.min(80, innerW * 0.3)
              const whiskerCap = bw / 4
              return (
                <g>
                  <line x1={cx} x2={cx} y1={yAt(min)} y2={yAt(max)} stroke="#5b7466" strokeWidth={1.2} />
                  <line x1={cx - whiskerCap} x2={cx + whiskerCap} y1={yAt(min)} y2={yAt(min)} stroke="#5b7466" strokeWidth={1.2} />
                  <line x1={cx - whiskerCap} x2={cx + whiskerCap} y1={yAt(max)} y2={yAt(max)} stroke="#5b7466" strokeWidth={1.2} />
                  <rect x={cx - bw / 2} y={yAt(q3)} width={bw} height={Math.max(2, yAt(q1) - yAt(q3))} fill={data[0]?.color ?? '#315f4c'} opacity={0.32} stroke="#315f4c" strokeWidth={1.4} rx={2} />
                  <line x1={cx - bw / 2} x2={cx + bw / 2} y1={yAt(med)} y2={yAt(med)} stroke="#1d3327" strokeWidth={1.8} />
                  <text x={cx} y={box.y + PAD.t + innerH + 30} textAnchor="middle" fontSize={8.5} fill="#7c9185">五数概括预览</text>
                </g>
              )
            })() : (
              <text x={box.x + PAD.l + innerW / 2} y={box.y + PAD.t + innerH / 2} textAnchor="middle" fontSize={11} fill="#7c9185">箱线图需要数值数据系列</text>
            )
          ) : (
            <text x={box.x + PAD.l + innerW / 2} y={box.y + PAD.t + innerH / 2} textAnchor="middle" fontSize={11} fill="#7c9185">暂不支持 {kind} 预览（占位）</text>
          )}
      {hovered && (
        <g pointerEvents="none" transform={`translate(${Math.min(Math.max(hovered.x + 8, box.x + 4), box.x + box.w - 142)},${Math.max(hovered.y - 34, box.y + 4)})`}>
          <rect width={136} height={29} rx={4} fill="#173326" opacity={.94} />
          <text x={7} y={12} fontSize={9} fill="#fff">{hovered.label.slice(0, 23)}</text>
          <text x={7} y={23} fontSize={10} fontWeight={650} fill="#d8f3df">{hovered.value}</text>
        </g>
      )}
      {/* v0.4.1 显著性标注：两两比较括号 + 星号（基于 Holm 校正后 p 值） */}
      {panel?.significance && panel.significance.length > 0 && (
        <g stroke="#20352a" strokeWidth={1} fill="#20352a">
          {panel.significance.map((sig, index) => {
            const i0 = xLabels.indexOf(sig.left)
            const i1 = xLabels.indexOf(sig.right)
            if (i0 < 0 || i1 < 0) return null
            const x0 = xAt(i0)
            const x1 = xAt(i1)
            const bracketY = yAt(d1) - 10 - index * 13
            return (
              <g key={`${sig.left}-${sig.right}-${index}`}>
                <line x1={x0} x2={x1} y1={bracketY} y2={bracketY} />
                <line x1={x0} x2={x0} y1={bracketY - 4} y2={bracketY + 4} />
                <line x1={x1} x2={x1} y1={bracketY - 4} y2={bracketY + 4} />
                <text x={(x0 + x1) / 2} y={bracketY - 5} textAnchor="middle" fontSize={11} fontWeight={700}>
                  {sig.stars}
                </text>
              </g>
            )
          })}
        </g>
      )}
      {kind === 'heatmap' && (
        <g>
          <defs>
            <linearGradient id={`heatmap-scale-${panel?.panel_id ?? 'panel'}`} x1="0" x2="1">
              <stop offset="0%" stopColor="#6E8FB2" />
              <stop offset="50%" stopColor="#FFFFFF" />
              <stop offset="100%" stopColor="#C16E71" />
            </linearGradient>
          </defs>
          <rect x={box.x + PAD.l} y={box.y + box.h - 20} width={Math.max(40, innerW)} height={6} fill={`url(#heatmap-scale-${panel?.panel_id ?? 'panel'})`} stroke="#d5ddd8" />
          <text x={box.x + PAD.l + innerW / 2} y={box.y + box.h - 5} textAnchor="middle" fontSize={9.5} fill="#5b7466">相关系数 −1 至 1</text>
        </g>
      )}
      {/* 轴标题 */}
      <text x={box.x + PAD.l + innerW / 2} y={box.y + box.h - 6} textAnchor="middle" fontSize={10} fill="#5b7466">
        {panel?.scales.find((sc) => sc.axis === 'x')?.label ?? ''}
      </text>
      <text transform={`translate(${box.x + 12},${box.y + PAD.t + innerH / 2}) rotate(-90)`} textAnchor="middle" fontSize={10} fill="#5b7466">
        {panel?.scales.find((sc) => sc.axis === 'y')?.label ?? ''}
      </text>
    </g>
  )
}

export function ChartPreview({ plan, large = false }: { plan: PlotPlan; large?: boolean }) {
  const { figure, panels } = plan.spec
  const W = 720
  const ratio = figure.heightIn / figure.widthIn
  const H = Math.round(W * ratio * (figure.cols > 1 ? 0.62 : 1))
  const theme = figure.theme
  const legendItems = plan.series
  const legend = panels[0]?.legend
  const legendVertical = legend?.position === 'right' || legend?.position === 'inside'
  const titleLines = wrapPreviewTitle(figure.title)
  const topReserve = previewTopReserve(figure.title, legend?.position === 'top')
  const bottomReserve = legend?.position === 'bottom' ? 22 : 8
  const contentHeight = Math.max(80, H - topReserve - bottomReserve)
  const legendX = legendVertical ? W - 118 : W / 2 - (legendItems.length * 96) / 2
  const legendY = legend?.position === 'top' ? topReserve - 16 : legendVertical ? topReserve + 10 : H - 6

  return (
    <div className={`chart-preview chart-preview--${theme}${large ? ' chart-preview--lg' : ''}`}>
      <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="xMidYMid meet" role="img" aria-label={figure.title}>
        <title>{figure.title}</title>
        <desc>科研绘图即时预览；聚焦或悬停数据元素可查看数值，最终结果以服务器验证产物为准。</desc>
        <rect x={0} y={0} width={W} height={H} fill="#ffffff" rx={8} />
        <text x={W / 2} y={18} textAnchor="middle" fontSize={13} fontWeight={680} fill="#14241b" fontFamily={figure.fontFamily === 'serif' ? 'Georgia, serif' : undefined}>
          {titleLines.map((line, index) => <tspan key={index} x={W / 2} dy={index === 0 ? 0 : 16}>{line}</tspan>)}
        </text>
        {/* 图例 */}
        {legendItems.length > 0 && legend?.visible !== false && (
          <g transform={`translate(${legendX}, ${legendY})`}>
            {legendItems.map((s, i) => (
              <g key={s.id} transform={`translate(${legendVertical ? 0 : i * 96},${legendVertical ? i * 18 : 0})`}>
                <rect x={0} y={-8} width={10} height={10} rx={2} fill={s.color} />
                <text x={15} y={1} fontSize={9.5} fill="#435d4f">
                  {s.label.length > 14 ? s.label.slice(0, 13) + '…' : s.label}
                </text>
              </g>
            ))}
          </g>
        )}
        {panels.map((panel) => {
          const cols = Math.max(1, figure.cols)
          const rows = Math.max(1, figure.rows)
          const kind = previewKind(panel.layers[0]?.kind ?? 'line')
          return (
            <Panel
              key={panel.panel_id}
              box={{ x: panel.col * (W / cols), y: topReserve + panel.row * (contentHeight / rows), w: W / cols, h: contentHeight / rows }}
              panel={panel}
              series={plan.series}
              kind={kind}
              norm={panel.panel_id.includes('norm')}
              baseline={panel.annotations.find((annotation) => annotation.kind === 'hline')?.y}
              showErrors={panel.layers.some((layer) => layer.showErrorBars) || !!panel.errorBarMode}
            />
          )
        })}
      </svg>
    </div>
  )
}
