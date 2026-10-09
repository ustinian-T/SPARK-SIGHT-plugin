// 数据可信层：CSV 编码探测、RFC4180 最小解析、列类型推断、数据体检与内容指纹。
// 与 apps/web/src/lib/csv.ts 保持同构：同一字节 + 同一解析配置必须得到同一画像与指纹。
// 指纹定义（算法说明书 6.1 / 架构 7.2）：H = SHA256(file_bytes || JSON(parser_config))。
import { createHash } from 'node:crypto'
import { ApiError, ERR } from './errors.js'

// ---------- 编码读取：优先 UTF-8（严格），失败回退 GBK，不静默替换乱码 ----------
export function decodeBytes(bytes) {
  const tryDecode = (label, fatal) => {
    try {
      return new TextDecoder(label, { fatal }).decode(bytes)
    } catch {
      return null
    }
  }
  const utf8 = tryDecode('utf-8', true)
  if (utf8 !== null) return { text: utf8, encoding: 'UTF-8', undecodable: false }
  const gbk = tryDecode('gbk', true)
  if (gbk !== null) return { text: gbk, encoding: 'GBK', undecodable: false }
  // 最后以替换字符解码并明确告警，而不是静默成功（与前端策略一致）
  return { text: new TextDecoder('utf-8').decode(bytes), encoding: 'UTF-8（含无法识别字符）', undecodable: true }
}

// ---------- 分隔符探测（与前端 detectDelimiter 一致） ----------
export function detectDelimiter(head) {
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

// ---------- 最小 CSV 解析（支持引号、转义双引号、CRLF，与前端 parseCsv 一致） ----------
export function parseCsv(text, delimiter) {
  const rows = []
  let field = ''
  let row = []
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

const isBoolean = (v) => /^(true|false|是|否|yes|no|y|n)$/i.test(v.trim())
function isDateTime(v) {
  const s = v.trim()
  if (!/^\d{2,4}[-/]\d{1,2}([-/]\d{1,2})?/.test(s)) return false
  const t = Date.parse(s.replace(/\//g, '-'))
  return !Number.isNaN(t)
}
export function toNumber(v) {
  const s = v.trim().replace(/,/g, '').replace(/%$/, '')
  if (s === '') return null
  const n = Number(s)
  return Number.isFinite(n) ? n : null
}

function quantile(sorted, q) {
  if (sorted.length === 0) return NaN
  const pos = (sorted.length - 1) * q
  const base = Math.floor(pos)
  const rest = pos - base
  return sorted[base + 1] !== undefined ? sorted[base] + rest * (sorted[base + 1] - sorted[base]) : sorted[base]
}

function inferType(values) {
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

function round6(n) {
  return Math.round(n * 1e6) / 1e6
}

function profileColumn(name, index, raw) {
  const total = raw.length
  const missing = raw.filter((v) => v.trim() === '').length
  const nonEmpty = raw.filter((v) => v.trim() !== '')
  const uniqueSet = new Set(nonEmpty.map((v) => v.trim()))
  const inferredType = inferType(raw)
  const col = {
    name,
    index,
    inferredType,
    missing,
    missingRate: total ? missing / total : 0,
    unique: uniqueSet.size
  }
  if (inferredType === 'numeric') {
    const nums = nonEmpty.map(toNumber).filter((v) => v !== null).sort((a, b) => a - b)
    if (nums.length) {
      const mean = nums.reduce((s, v) => s + v, 0) / nums.length
      const variance = nums.reduce((s, v) => s + (v - mean) ** 2, 0) / nums.length
      col.min = round6(nums[0])
      col.max = round6(nums[nums.length - 1])
      col.mean = round6(mean)
      col.median = round6(quantile(nums, 0.5))
      col.std = round6(Math.sqrt(variance))
    }
  } else if (inferredType === 'categorical' || inferredType === 'boolean') {
    const counts = new Map()
    nonEmpty.forEach((v) => counts.set(v.trim(), (counts.get(v.trim()) ?? 0) + 1))
    col.topValues = [...counts.entries()]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 5)
      .map(([value, count]) => ({ value, count }))
  }
  return col
}

function buildQuality(dataRows, header, columns) {
  const seen = new Map()
  const duplicateRowNumbers = []
  dataRows.forEach((row, index) => {
    const key = header.map((_, i) => (row[i] ?? '').trim()).join('\u001f')
    if (seen.has(key)) duplicateRowNumbers.push(index + 2)
    else seen.set(key, index + 2)
  })

  const mixedTypeColumns = []
  const outliers = []
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
      .filter((item) => item.value !== null)
    if (observed.length < 4) continue
    const sorted = observed.map((item) => item.value).sort((a, b) => a - b)
    const q1 = quantile(sorted, 0.25)
    const q3 = quantile(sorted, 0.75)
    const iqr = q3 - q1
    const lower = q1 - 1.5 * iqr
    const upper = q3 + 1.5 * iqr
    const rowNumbers = observed.filter((item) => item.value < lower || item.value > upper).map((item) => item.rowNumber)
    if (rowNumbers.length) {
      outliers.push({ field: column.name, count: rowNumbers.length, lower: round6(lower), upper: round6(upper), rowNumbers })
    }
  }

  const smallGroups = []
  for (const column of columns.filter((item) => ['categorical', 'boolean'].includes(item.userType ?? item.inferredType))) {
    const counts = new Map()
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

export function fingerprint(bytes, config) {
  const cfgBytes = Buffer.from(JSON.stringify(config), 'utf-8')
  return createHash('sha256').update(Buffer.concat([bytes, cfgBytes])).digest('hex')
}

/**
 * 真实接入并体检一个 CSV 文件；任何非法输入都抛 ApiError（稳定错误码），不返回 Mock。
 * @param {string} fileName
 * @param {Buffer} bytes 原始文件字节（参与指纹，禁止先解码字符串）
 * @param {{encoding?:string,delimiter?:string,hasHeader?:boolean}} [override]
 */
export function ingestFile(fileName, bytes, override = {}) {
  if (!bytes || bytes.length === 0) {
    throw new ApiError(400, ERR.EMPTY_FILE, '上传文件为空：CSV 必须包含表头与至少一行数据', { fileName })
  }
  // NUL 字节视为二进制内容（CSV 为文本格式）
  if (bytes.includes(0)) {
    throw new ApiError(400, ERR.BINARY_CONTENT, '文件包含二进制/NUL 字节，不是合法的文本 CSV', { fileName })
  }
  const { text: decoded, encoding: autoEnc, undecodable } = decodeBytes(bytes)
  if (undecodable) {
    throw new ApiError(400, ERR.ENCODING_UNSUPPORTED, '文件编码无法识别（UTF-8/GBK 均解码失败），请另存为 UTF-8 后重试', {
      fileName
    })
  }
  // 去除 UTF-8 BOM（指纹仍基于含 BOM 的原始字节，文件身份不变）
  const text = decoded.replace(/^\uFEFF/, '')
  if (text.trim() === '') {
    throw new ApiError(400, ERR.EMPTY_FILE, '文件内容为空白：CSV 必须包含表头与至少一行数据', { fileName })
  }
  const delimiter = override.delimiter ?? detectDelimiter(text.slice(0, 4096))
  const matrix = parseCsv(text, delimiter)
  if (matrix.length === 0) {
    throw new ApiError(400, ERR.NOT_TABULAR, '未解析出任何表格行，请检查分隔符与文件格式', { fileName })
  }
  const hasHeader = override.hasHeader ?? true
  const header = hasHeader
    ? matrix[0].map((h) => h.trim())
    : matrix[0].map((_, i) => `列 ${i + 1}`)
  const dataRows = hasHeader ? matrix.slice(1) : matrix

  if (dataRows.length === 0) {
    throw new ApiError(400, ERR.NO_DATA_ROWS, 'CSV 仅包含表头、没有数据行，无法进行统计分析与绘图', {
      fileName,
      header
    })
  }
  const dup = header.filter((h, i) => h !== '' && header.indexOf(h) !== i)
  if (dup.length > 0) {
    throw new ApiError(400, ERR.DUPLICATE_HEADER, `CSV 存在重复列名：${[...new Set(dup)].join('、')}，字段标识必须唯一`, {
      fileName,
      duplicate: [...new Set(dup)]
    })
  }

  const columns = header.map((name, i) => profileColumn(name, i, dataRows.map((r) => r[i] ?? '')))
  const warnings = []
  const ragged = dataRows.filter((r) => r.length !== header.length).length
  if (ragged > 0) warnings.push(`${ragged} 行列数与表头不一致，已按空值处理`)
  const highMissing = columns.filter((c) => c.missingRate > 0.3).map((c) => c.name)
  if (highMissing.length) warnings.push(`列 ${highMissing.join('、')} 缺失率超过 30%`)
  const encoding = override.encoding ?? autoEnc
  if (encoding.includes('无法识别')) warnings.push('存在无法识别的字符，请确认编码（不静默替换乱码）')
  const constantCols = columns.filter((c) => c.unique <= 1).map((c) => c.name)
  if (constantCols.length) warnings.push(`列 ${constantCols.join('、')} 为常量列，不推荐作为坐标或趋势变量`)
  if (dataRows.length < 5) warnings.push(`仅 ${dataRows.length} 行数据，样本量过小，不作显著性推断（AGT-009）`)

  const config = { encoding, delimiter, hasHeader }
  const headRows = dataRows.slice(0, 6).map((r) => {
    const obj = {}
    header.forEach((h, i) => (obj[h] = r[i] ?? ''))
    return obj
  })
  const fp = fingerprint(bytes, config)
  const quality = buildQuality(dataRows, header, columns)
  const profile = {
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
  // 语义前置校验：没有任何数值测量列则无法产出图表方案（证据不足，禁止编造）
  const measures = measureColumns(profile)
  if (measures.length === 0) {
    throw new ApiError(
      422,
      ERR.NO_NUMERIC_FIELDS,
      '数据中没有可用于绘图的数值列（标准差辅助列除外），无法生成三方案；请补充数值测量字段',
      { fileName, columns: columns.map((c) => ({ name: c.name, inferredType: c.inferredType })) }
    )
  }
  return { profile, text, rawDelimiter: delimiter }
}

// 标准差/误差辅助列命名（与前端 summarize.ts 一致）
const SD_PATTERN = /(_?)(sd|std|sem|se|err)$/i
export function isSdColumn(name) {
  return SD_PATTERN.test(name)
}

// 测量列：数值列，排除后续会被选为 x 轴的分类/时间列由调用方处理
export function numericColumns(profile) {
  return profile.columns.filter((c) => (c.userType ?? c.inferredType) === 'numeric')
}
export function measureColumns(profile) {
  return numericColumns(profile).filter((c) => !isSdColumn(c.name))
}
