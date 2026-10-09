// 确定性统计聚合的前端占位实现（对应 stats.summarize 工具节点）。
// 后端就绪后由 services/local-agent 的确定性统计工具替换；同一数据与配置必须得到相同结果。
import type { ColumnProfile, DatasetProfile, LayerKind, PreviewSeries } from '../types'
import { parseCsv } from './csv'

interface RawSeries {
  id: string
  label: string
  y: (number | null)[]
  yerr?: (number | null)[]
}

export interface SummarizeResult {
  xLabel: string
  x: (number | string)[]
  series: RawSeries[]
  /** 超出单图最多 4 个测量系列而未纳入的字段名；为空表示没有字段被截断。 */
  ignoredMeasures: string[]
}

export const MEASURE_SERIES_LIMIT = 4

const SD_PATTERN = /(_?)(sd|std|sem|se|err)$/i

function num(v: string): number | null {
  const s = v.trim().replace(/,/g, '').replace(/%$/, '')
  if (s === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

// 从完整 CSV 文本聚合；profile 提供列类型，保证与数据体检一致。
export function summarizeCsv(text: string, delimiter: string, profile: DatasetProfile): SummarizeResult {
  const matrix = parseCsv(text, delimiter === '\\t' ? '\t' : delimiter)
  const header = matrix[0].map((h) => h.trim())
  const rows = matrix.slice(1)
  const col = (name: string) => header.indexOf(name)
  const typeOf = (name: string): ColumnProfile | undefined => profile.columns.find((c) => c.name === name)

  // x 轴：优先分类/时间列，否则第一列数值
  const xCol =
    profile.columns.find((c) => ['categorical', 'datetime'].includes(c.userType ?? c.inferredType)) ??
    profile.columns.find((c) => (c.userType ?? c.inferredType) === 'numeric')
  const xIdx = xCol ? col(xCol.name) : 0
  const xLabel = header[xIdx] ?? 'x'
  const x = rows.map((r) => {
    const v = r[xIdx] ?? ''
    return num(v) ?? v
  })

  const measureCols = profile.columns.filter(
    (c) => (c.userType ?? c.inferredType) === 'numeric' && c.name !== xLabel && !SD_PATTERN.test(c.name)
  )

  const series: RawSeries[] = measureCols.slice(0, MEASURE_SERIES_LIMIT).map((c) => {
    const yi = col(c.name)
    const sdi = col(`${c.name}_sd`)
    const y = rows.map((r) => num(r[yi]))
    const item: RawSeries = { id: `series_${c.index}`, label: c.name, y }
    if (sdi >= 0) {
      const sd = rows.map((r) => num(r[sdi]))
      if (sd.some((v) => v !== null && v > 0)) item.yerr = sd
    }
    return item
  })
  // P2：超出上限的字段不静默丢弃，明确返回，供界面提示用户拆分/分批绘图。
  const ignoredMeasures = measureCols.slice(MEASURE_SERIES_LIMIT).map((c) => c.name)

  void typeOf
  return { xLabel, x, series, ignoredMeasures }
}

export function makePreviewSeries(
  result: SummarizeResult,
  kind: LayerKind,
  palette: string[]
): PreviewSeries[] {
  return result.series.map((s, i) => ({
    id: s.id,
    label: s.label,
    color: palette[i % palette.length],
    x: result.x,
    y: s.y,
    yerr: s.yerr,
    kind
  }))
}
