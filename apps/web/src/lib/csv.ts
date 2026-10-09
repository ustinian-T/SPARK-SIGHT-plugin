// CSV 解析、列类型推断、数据体检与内容指纹（前端真实实现，对应 CORE-002 / H 定义）。
// 后端就绪后，网页端可改为调用 services/local-agent 的 probe 接口；桌面端保留本地实现。
import type { ColumnProfile, ColumnType, DatasetProfile } from '../types'

export interface ParserConfig {
  encoding: string
  delimiter: string
  hasHeader: boolean
}

// ---- 编码读取：优先 UTF-8（严格），失败回退 GBK，不静默替换乱码 ----
export async function readFileWithEncoding(file: File): Promise<{ text: string; encoding: string }> {
  const bytes = new Uint8Array(await file.arrayBuffer())
  try {
    const utf = new TextDecoder('utf-8', { fatal: true })
    return { text: utf.decode(bytes), encoding: 'UTF-8' }
  } catch {
    try {
      const gbk = new TextDecoder('gbk')
      return { text: gbk.decode(bytes), encoding: 'GBK' }
    } catch {
      // 最后以替换字符解码并明确告警，而不是静默成功
      return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'UTF-8（含无法识别字符）' }
    }
  }
}

export function readBytesWithEncoding(bytes: Uint8Array): { text: string; encoding: string } {
  try {
    return { text: new TextDecoder('utf-8', { fatal: true }).decode(bytes), encoding: 'UTF-8' }
  } catch {
    return { text: new TextDecoder('gbk').decode(bytes), encoding: 'GBK' }
  }
}

// ---- 分隔符探测 ----
export function detectDelimiter(head: string): string {
  const candidates = [',', '\t', ';', '|']
  const firstLine = head.split(/\r?\n/, 1)[0] ?? ''
  let best = ','
  let bestScore = -1
  for (const c of candidates) {
    const n = firstLine.split(c).length
    if (n > bestScore) {
      bestScore = n
      best = c
    }
  }
  return best
}

// ---- 最小 CSV 解析（支持引号、转义双引号、CRLF）----
export function parseCsv(text: string, delimiter: string): string[][] {
  const rows: string[][] = []
  let field = ''
  let row: string[] = []
  let inQuotes = false
  const pushField = () => {
    row.push(field)
    field = ''
  }
  const pushRow = () => {
    pushField()
    rows.push(row)
    row = []
  }
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i++
        } else inQuotes = false
      } else field += ch
    } else if (ch === '"') {
      inQuotes = true
    } else if (ch === delimiter) {
      pushField()
    } else if (ch === '\n') {
      pushRow()
    } else if (ch === '\r') {
      if (text[i + 1] === '\n') i++
      pushRow()
    } else {
      field += ch
    }
  }
  if (field.length > 0 || row.length > 0) pushRow()
  return rows.filter((r) => r.length > 1 || (r.length === 1 && r[0].trim() !== ''))
}

function isBoolean(v: string): boolean {
  return /^(true|false|是|否|yes|no|y|n)$/i.test(v.trim())
}
function isDateTime(v: string): boolean {
  const s = v.trim()
  if (!/^\d{2,4}[-/]\d{1,2}([-/]\d{1,2})?/.test(s)) return false
  const t = Date.parse(s.replace(/\//g, '-'))
  return !Number.isNaN(t)
}
function toNumber(v: string): number | null {
  const s = v.trim().replace(/,/g, '').replace(/%$/, '')
  if (s === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

function quantile(sorted: number[], q: number): number {
  if (sorted.length === 0) return NaN
  const pos = (sorted.length - 1) * q
  const base = Math.floor(pos)
  const rest = pos - base
  return sorted[base + 1] !== undefined
    ? sorted[base] + rest * (sorted[base + 1] - sorted[base])
    : sorted[base]
}

function inferType(values: string[]): ColumnType {
  const nonEmpty = values.filter((v) => v.trim() !== '')
  if (nonEmpty.length === 0) return 'unknown'
  const boolHits = nonEmpty.filter(isBoolean).length
  if (boolHits / nonEmpty.length >= 0.9) return 'boolean'
  const numHits = nonEmpty.filter((v) => toNumber(v) !== null).length
  if (numHits / nonEmpty.length >= 0.9) return 'numeric'
  const dateHits = nonEmpty.filter(isDateTime).length
  if (dateHits / nonEmpty.length >= 0.8) return 'datetime'
  return 'categorical'
}

function profileColumn(name: string, index: number, raw: string[]): ColumnProfile {
  const total = raw.length
  const missing = raw.filter((v) => v.trim() === '').length
  const nonEmpty = raw.filter((v) => v.trim() !== '')
  const uniqueSet = new Set(nonEmpty.map((v) => v.trim()))
  const inferredType = inferType(raw)
  const col: ColumnProfile = {
    name,
    index,
    inferredType,
    missing,
    missingRate: total ? missing / total : 0,
    unique: uniqueSet.size
  }
  if (inferredType === 'numeric') {
    const nums = nonEmpty.map(toNumber).filter((v): v is number => v !== null).sort((a, b) => a - b)
    if (nums.length) {
      const mean = nums.reduce((s, v) => s + v, 0) / nums.length
      const variance = nums.reduce((s, v) => s + (v - mean) ** 2, 0) / nums.length
      col.min = nums[0]
      col.max = nums[nums.length - 1]
      col.mean = mean
      col.median = quantile(nums, 0.5)
      col.std = Math.sqrt(variance)
    }
  } else if (inferredType === 'categorical' || inferredType === 'boolean') {
    const counts = new Map<string, number>()
    nonEmpty.forEach((v) => counts.set(v.trim(), (counts.get(v.trim()) ?? 0) + 1))
    col.topValues = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([value, count]) => ({ value, count }))
  }
  return col
}

function buildQuality(dataRows: string[][], header: string[], columns: ColumnProfile[]): DatasetProfile['quality'] {
  const seen = new Map<string, number>()
  const duplicateRowNumbers: number[] = []
  dataRows.forEach((row, index) => {
    const key = header.map((_, i) => (row[i] ?? '').trim()).join('\u001f')
    if (seen.has(key)) duplicateRowNumbers.push(index + 2)
    else seen.set(key, index + 2)
  })

  const mixedTypeColumns: DatasetProfile['quality']['mixedTypeColumns'] = []
  const outliers: DatasetProfile['quality']['outliers'] = []
  for (const column of columns) {
    const cells = dataRows.map((row) => row[column.index] ?? '')
    const nonEmpty = cells.filter((value) => value.trim() !== '')
    const numericCount = nonEmpty.filter((value) => toNumber(value) !== null).length
    if (numericCount > 0 && numericCount < nonEmpty.length) {
      mixedTypeColumns.push({
        field: column.name,
        numericCount,
        invalidCount: nonEmpty.length - numericCount,
        invalidRate: (nonEmpty.length - numericCount) / nonEmpty.length
      })
    }
    if ((column.userType ?? column.inferredType) !== 'numeric') continue
    const observed = cells
      .map((value, index) => ({ value: toNumber(value), rowNumber: index + 2 }))
      .filter((item): item is { value: number; rowNumber: number } => item.value !== null)
    if (observed.length < 4) continue
    const sorted = observed.map((item) => item.value).sort((a, b) => a - b)
    const q1 = quantile(sorted, 0.25)
    const q3 = quantile(sorted, 0.75)
    const iqr = q3 - q1
    const lower = q1 - 1.5 * iqr
    const upper = q3 + 1.5 * iqr
    const rowNumbers = observed.filter((item) => item.value < lower || item.value > upper).map((item) => item.rowNumber)
    if (rowNumbers.length) outliers.push({ field: column.name, count: rowNumbers.length, lower, upper, rowNumbers })
  }

  const smallGroups: DatasetProfile['quality']['smallGroups'] = []
  for (const column of columns.filter((item) => ['categorical', 'boolean'].includes(item.userType ?? item.inferredType))) {
    const counts = new Map<string, number>()
    dataRows.forEach((row) => {
      const value = (row[column.index] ?? '').trim()
      if (value !== '') counts.set(value, (counts.get(value) ?? 0) + 1)
    })
    for (const [value, count] of counts) if (count < 3) smallGroups.push({ field: column.name, value, count })
  }

  return {
    duplicateRows: { count: duplicateRowNumbers.length, rowNumbers: duplicateRowNumbers },
    outliers,
    constantColumns: columns.filter((column) => column.unique <= 1).map((column) => column.name),
    mixedTypeColumns,
    smallGroups,
    highMissingColumns: columns
      .filter((column) => column.missingRate > 0.3)
      .map((column) => ({ field: column.name, missing: column.missing, rate: column.missingRate }))
  }
}

async function fingerprint(bytes: Uint8Array, config: ParserConfig): Promise<string> {
  const enc = new TextEncoder()
  const cfgBytes = enc.encode(JSON.stringify(config))
  const merged = new Uint8Array(bytes.length + cfgBytes.length)
  merged.set(bytes, 0)
  merged.set(cfgBytes, bytes.length)
  const digest = await crypto.subtle.digest('SHA-256', merged)
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('')
}

export async function buildProfile(
  fileName: string,
  bytes: Uint8Array,
  override?: Partial<ParserConfig>
): Promise<DatasetProfile> {
  const { text, encoding: autoEnc } = readBytesWithEncoding(bytes)
  const delimiter = override?.delimiter ?? detectDelimiter(text.slice(0, 4096))
  const matrix = parseCsv(text, delimiter)
  const hasHeader = override?.hasHeader ?? true
  const header = hasHeader ? matrix[0].map((h) => h.trim()) : matrix[0].map((_, i) => `列 ${i + 1}`)
  const dataRows = hasHeader ? matrix.slice(1) : matrix
  const columns = header.map((name, i) => profileColumn(name, i, dataRows.map((r) => r[i] ?? '')))
  const warnings: string[] = []
  const ragged = dataRows.filter((r) => r.length !== header.length).length
  if (ragged > 0) warnings.push(`${ragged} 行列数与表头不一致，已按空值处理`)
  const highMissing = columns.filter((c) => c.missingRate > 0.3).map((c) => c.name)
  if (highMissing.length) warnings.push(`列 ${highMissing.join('、')} 缺失率超过 30%`)
  const encoding = override?.encoding ?? autoEnc
  if (encoding.includes('无法识别')) warnings.push('存在无法识别的字符，请确认编码（不静默替换乱码）')
  const config: ParserConfig = { encoding, delimiter, hasHeader }
  const headRows = dataRows.slice(0, 6).map((r) => {
    const obj: Record<string, string> = {}
    header.forEach((h, i) => (obj[h] = r[i] ?? ''))
    return obj
  })
  const fp = await fingerprint(bytes, config)
  const quality = buildQuality(dataRows, header, columns)
  return {
    fileName,
    encoding,
    delimiter: delimiter === '\t' ? '\\t' : delimiter,
    hasHeader,
    rows: dataRows.length,
    cols: header.length,
    sizeBytes: bytes.length,
    parserConfig: JSON.stringify(config),
    fingerprint: fp,
    columns,
    quality,
    warnings,
    headRows
  }
}
