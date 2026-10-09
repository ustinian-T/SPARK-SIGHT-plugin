// 阶段 3：多文件自动拆分/合并分析（纯函数，无外部依赖）。
// 背景（B.3）：用户一次上传 N 份 CSV，系统需要判断它们应当
//   - 合并：同一数据集被切成多个分片（part1/part2、A/B、sheet1/sheet2），或列名高度一致；
//   - 拆分：彼此独立的数据集，应当各自成为一个任务；
//   - 灰色地带：列名有部分重叠但不确定，默认拆分并标记 suggestMerge 由用户确认。
// 判定信号（可解释）：列名 Jaccard 重叠率、文件名分片模式、行数比例。
import { createHash } from 'node:crypto'
import { decodeBytes, detectDelimiter, parseCsv } from './csv.js'

// 文件名分片模式：base_part1 / base_A / base_sheet1 / base_2024-01-01
// 命中即认为两份文件来自同一数据集的显式分片（强信号）。
const SPLIT_TOKEN = /^(.*?)[_\-](part\s*\d+|[AB]|sheet\s*\d+|\d{4}[-_]?\d{2}[-_]?\d{2})$/i

// 列名标准化：去空白、统一小写，避免 "Group" vs "group " 误判为不同列
function normalizeColumnName(raw) {
  return String(raw ?? '').trim().toLowerCase()
}

// 从字节中提取单文件特征：列名集合、行数估算、编码、分隔符、文件名模式
function extractFeatures(file) {
  const fileName = String(file.fileName ?? 'upload.csv')
  const bytes = Buffer.isBuffer(file.bytes) ? file.bytes : Buffer.from(file.bytes ?? '')
  // 编码探测：复用 csv.js 的 UTF-8/GBK 严格解码，不静默替换乱码
  let encoding = 'UTF-8'
  let text = ''
  try {
    const decoded = decodeBytes(bytes)
    encoding = decoded.encoding
    text = decoded.text
  } catch {
    // 无法解码：按空文本处理，列名/行数退化为 0，不阻断整组分析
    text = ''
  }
  const delimiter = detectDelimiter(text.slice(0, 4096))
  const matrix = parseCsv(text, delimiter)
  const headerRow = matrix[0] ?? []
  const columns = headerRow.map((h) => normalizeColumnName(h)).filter(Boolean)
  const columnSet = new Set(columns)
  // 行数估算：解析出的数据行（去掉表头）；解析失败时按换行数粗估
  const estimatedRows = matrix.length > 0 ? Math.max(0, matrix.length - 1) : text.split(/\r?\n/).filter(Boolean).length

  // 文件名分片令牌：data_part1.csv → { base:'data', token:'part1' }
  const stem = fileName.replace(/\.[^.]+$/, '').replace(/^.*[\\/]/, '')
  const tokenMatch = SPLIT_TOKEN.exec(stem)
  const splitToken = tokenMatch ? { base: tokenMatch[1].toLowerCase(), token: tokenMatch[2].toLowerCase() } : null

  // 列名集合 hash：用于快速指纹比对（不直接暴露列名原文到日志）
  const columnHash = createHash('sha256')
    .update([...columnSet].sort().join('|'))
    .digest('hex')
    .slice(0, 16)

  return {
    fileName,
    bytes,
    encoding,
    delimiter: delimiter === '\t' ? '\\t' : delimiter,
    columns,
    columnSet,
    columnHash,
    estimatedRows,
    splitToken
  }
}

// Jaccard 列名相似度：|A∩B| / |A∪B|
function jaccard(a, b) {
  if (a.size === 0 && b.size === 0) return 0
  let inter = 0
  for (const name of a) if (b.has(name)) inter++
  const union = a.size + b.size - inter
  return union === 0 ? 0 : inter / union
}

// 文件名关联信号：两份文件分片令牌同 base 且不同 token → 1，否则 0
function fileNameSignal(a, b) {
  if (!a.splitToken || !b.splitToken) return 0
  if (a.splitToken.base === b.splitToken.base && a.splitToken.token !== b.splitToken.token) return 1
  return 0
}

// 行数比例：min/max（越接近 1 越可能是同表分片）
function rowRatio(a, b) {
  const max = Math.max(a.estimatedRows, b.estimatedRows)
  if (max === 0) return 0
  return Math.min(a.estimatedRows, b.estimatedRows) / max
}

// 两两关系判定（B.3）
function pairRelation(a, b) {
  const j = jaccard(a.columnSet, b.columnSet)
  const f = fileNameSignal(a, b)
  const r = rowRatio(a, b)
  const rowDiff = 1 - r
  const reasons = []

  // 文件名显式分片信号优先级最高（part1/part2、A/B、sheet1/sheet2）
  if (f === 1) {
    reasons.push(`文件名命中分片模式「${a.splitToken.token}/${b.splitToken.token}」，同 base=${a.splitToken.base}`)
    return { decision: 'merge', jaccard: j, fileNameSignal: f, rowRatio: r, reasons }
  }
  // 列名高重叠 + 行数相近 → 合并
  if (j > 0.8 && rowDiff < 0.2) {
    reasons.push(`列名重叠率 ${j.toFixed(2)}（>0.8 阈值）`)
    reasons.push(`行数差异 ${(rowDiff * 100).toFixed(0)}%（<20% 阈值）`)
    return { decision: 'merge', jaccard: j, fileNameSignal: f, rowRatio: r, reasons }
  }
  // 列名低重叠且无文件名关联 → 拆分
  if (j < 0.3 && f === 0) {
    reasons.push(`列名重叠率 ${j.toFixed(2)}（<0.3 阈值），文件名无关联模式`)
    return { decision: 'split', jaccard: j, fileNameSignal: f, rowRatio: r, reasons }
  }
  // 灰色地带（0.3–0.8）：默认拆分，但建议合并确认
  reasons.push(`列名重叠率 ${j.toFixed(2)}（处于 0.3–0.8 灰色地带），默认拆分，建议合并确认`)
  return { decision: 'gray', jaccard: j, fileNameSignal: f, rowRatio: r, reasons }
}

// 置信度：0.6*jaccard + 0.25*fileNameSignal + 0.15*rowRatio
function confidenceOf(rel) {
  return Math.round((0.6 * rel.jaccard + 0.25 * rel.fileNameSignal + 0.15 * rel.rowRatio) * 1000) / 1000
}

/**
 * 对一组上传文件做自动拆分/合并分析。
 * @param {Array<{fileName:string, bytes:Buffer}>} files
 * @returns {Array<{groupId:string, files:Array<{fileName:string,sizeBytes:number}>,
 *                  decision:'merge'|'split', suggestMerge:boolean,
 *                  confidence:number, reasons:string[]}>}
 */
export function analyzeFileGroup(files) {
  const list = Array.isArray(files) ? files : []
  const feats = list.map(extractFeatures)
  const n = feats.length
  const assigned = new Array(n).fill(false)
  const groups = []

  // 贪心聚类：以未分配文件 i 为种子，把所有与 i 构成 merge 关系的文件并入同组
  for (let i = 0; i < n; i++) {
    if (assigned[i]) continue
    assigned[i] = true
    const memberIdx = [i]
    const mergedReasons = []
    let jaccard = 0
    let fileNameSignal = 0
    let rowRatio = 1

    for (let j = i + 1; j < n; j++) {
      if (assigned[j]) continue
      const rel = pairRelation(feats[i], feats[j])
      if (rel.decision === 'merge') {
        assigned[j] = true
        memberIdx.push(j)
        mergedReasons.push(...rel.reasons)
        jaccard = Math.max(jaccard, rel.jaccard)
        fileNameSignal = Math.max(fileNameSignal, rel.fileNameSignal)
        rowRatio = Math.max(rowRatio, rel.rowRatio)
      }
    }

    const groupFiles = memberIdx.map((idx) => ({
      fileName: feats[idx].fileName,
      sizeBytes: feats[idx].bytes.length,
      rows: feats[idx].estimatedRows,
      columns: feats[idx].columns.length
    }))

    if (memberIdx.length > 1) {
      // 多文件合并组
      groups.push({
        groupId: `group_${groups.length + 1}`,
        files: groupFiles,
        decision: 'merge',
        suggestMerge: false,
        confidence: confidenceOf({ jaccard, fileNameSignal, rowRatio }),
        reasons: mergedReasons.length ? mergedReasons : ['列名高度一致，判定为同表分片']
      })
    } else {
      // 单文件组：与其余所有文件比较（含已分组文件），判断是否处于灰色地带
      let maxJ = 0
      let gray = false
      const others = []
      for (let j = 0; j < n; j++) {
        if (j === i) continue
        const rel = pairRelation(feats[i], feats[j])
        maxJ = Math.max(maxJ, rel.jaccard)
        if (rel.decision === 'gray') {
          gray = true
          others.push(feats[j].fileName)
        }
      }
      const reasons = []
      if (gray) {
        reasons.push(`与 ${others.join('、')} 列名重叠率处于 0.3–0.8 灰色地带，默认拆分但建议合并确认`)
      } else if (maxJ > 0) {
        reasons.push(`与其余文件列名重叠率 ${maxJ.toFixed(2)}，彼此独立，拆分为单独任务`)
      } else {
        reasons.push('独立数据集，单列成任务')
      }
      groups.push({
        groupId: `group_${groups.length + 1}`,
        files: groupFiles,
        decision: 'split',
        suggestMerge: gray,
        confidence: confidenceOf({ jaccard: maxJ, fileNameSignal: 0, rowRatio: 1 }),
        reasons
      })
    }
  }
  return groups
}

/**
 * 将合并组的多个 CSV 字节行拼接为单个 data.csv（共享表头，仅保留首文件表头）。
 * 仅对 analyzeFileGroup 判定为 merge 的组调用；编码与列名已由判定阶段确认一致。
 * @param {Array<{fileName:string, bytes:Buffer}>} files
 * @returns {Buffer}
 */
export function mergeCsvBuffers(files) {
  if (!files.length) return Buffer.alloc(0)
  if (files.length === 1) return Buffer.isBuffer(files[0].bytes) ? files[0].bytes : Buffer.from(files[0].bytes)
  const outLines = []
  files.forEach((file, idx) => {
    const decoded = decodeBytes(Buffer.isBuffer(file.bytes) ? file.bytes : Buffer.from(file.bytes)).text
    const lines = decoded.replace(/^\uFEFF/, '').split(/\r?\n/)
    // 首文件保留全部行（含表头）；后续文件跳过表头行，仅追加数据行
    const start = idx === 0 ? 0 : 1
    for (let k = start; k < lines.length; k++) {
      if (lines[k] !== '') outLines.push(lines[k])
    }
  })
  return Buffer.from(outLines.join('\n') + '\n', 'utf8')
}
