// Safe, dependency-free XLSX reader for the recommendation gate.
// XLSX is treated as an untrusted ZIP container: encrypted entries, traversal,
// macros, external links, excessive entry counts/sizes and unsupported methods
// are rejected before any worksheet XML is parsed.
import zlib from 'node:zlib'
import { ApiError, ERR } from './errors.js'

const SIG_EOCD = 0x06054b50
const SIG_CENTRAL = 0x02014b50
const SIG_LOCAL = 0x04034b50

function fail(code, message, details) {
  throw new ApiError(400, code, message, details)
}

function xmlDecode(value = '') {
  return value
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&#([0-9]+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'").replace(/&amp;/g, '&')
}

function safeEntryName(name) {
  const normalized = name.replace(/\\/g, '/')
  if (!normalized || normalized.startsWith('/') || /^[A-Za-z]:/.test(normalized) || normalized.split('/').includes('..')) {
    fail(ERR.XLSX_UNSAFE, 'Excel 压缩包包含不安全路径', { entry: name })
  }
  return normalized
}

export function readZipEntries(buffer, options = {}) {
  const maxEntries = options.maxEntries ?? 2000
  const maxUncompressedBytes = options.maxUncompressedBytes ?? 100 * 1024 * 1024
  const maxEntryBytes = options.maxEntryBytes ?? 25 * 1024 * 1024
  let eocd = -1
  for (let i = Math.max(0, buffer.length - 65_557); i <= buffer.length - 22; i++) {
    if (buffer.readUInt32LE(i) === SIG_EOCD) eocd = i
  }
  if (eocd < 0) fail(ERR.XLSX_INVALID, '文件不是有效的 XLSX/ZIP 容器')
  const count = buffer.readUInt16LE(eocd + 10)
  let offset = buffer.readUInt32LE(eocd + 16)
  if (count > maxEntries) fail(ERR.XLSX_UNSAFE, 'Excel 条目数超过安全上限', { count, maxEntries })
  const files = new Map()
  let total = 0
  for (let i = 0; i < count; i++) {
    if (offset + 46 > buffer.length || buffer.readUInt32LE(offset) !== SIG_CENTRAL) fail(ERR.XLSX_INVALID, 'Excel 中央目录损坏')
    const flags = buffer.readUInt16LE(offset + 8)
    const method = buffer.readUInt16LE(offset + 10)
    const compressed = buffer.readUInt32LE(offset + 20)
    const uncompressed = buffer.readUInt32LE(offset + 24)
    const nameLength = buffer.readUInt16LE(offset + 28)
    const extraLength = buffer.readUInt16LE(offset + 30)
    const commentLength = buffer.readUInt16LE(offset + 32)
    const localOffset = buffer.readUInt32LE(offset + 42)
    const name = safeEntryName(buffer.toString('utf8', offset + 46, offset + 46 + nameLength))
    if (flags & 0x1) fail(ERR.XLSX_ENCRYPTED, '暂不支持加密的 Excel 工作簿')
    if (![0, 8].includes(method)) fail(ERR.XLSX_INVALID, 'Excel 包含不支持的压缩方法', { entry: name, method })
    if (uncompressed > maxEntryBytes) fail(ERR.XLSX_UNSAFE, 'Excel 单个条目解压后过大', { entry: name, bytes: uncompressed })
    total += uncompressed
    if (total > maxUncompressedBytes) fail(ERR.XLSX_UNSAFE, 'Excel 解压后总大小超过安全上限', { total, maxUncompressedBytes })
    if (compressed > 0 && uncompressed / compressed > 250) fail(ERR.XLSX_UNSAFE, 'Excel 条目压缩比异常，疑似压缩炸弹', { entry: name })
    if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== SIG_LOCAL) fail(ERR.XLSX_INVALID, 'Excel 本地条目损坏', { entry: name })
    const localNameLength = buffer.readUInt16LE(localOffset + 26)
    const localExtraLength = buffer.readUInt16LE(localOffset + 28)
    const start = localOffset + 30 + localNameLength + localExtraLength
    if (start + compressed > buffer.length) fail(ERR.XLSX_INVALID, 'Excel 条目内容越界', { entry: name })
    const raw = buffer.subarray(start, start + compressed)
    let content
    try { content = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw) } catch { fail(ERR.XLSX_INVALID, 'Excel 条目解压失败', { entry: name }) }
    if (content.length !== uncompressed && uncompressed !== 0) fail(ERR.XLSX_INVALID, 'Excel 条目大小校验失败', { entry: name })
    files.set(name, content)
    offset += 46 + nameLength + extraLength + commentLength
  }
  return files
}

function texts(xml, tag = 't') {
  return [...xml.matchAll(new RegExp(`<(?:\\w+:)?${tag}\\b[^>]*>([\\s\\S]*?)<\\/(?:\\w+:)?${tag}>`, 'g'))]
    .map((match) => xmlDecode(match[1].replace(/<[^>]+>/g, '')))
}

function sharedStrings(files) {
  const entry = files.get('xl/sharedStrings.xml')
  if (!entry) return []
  const xml = entry.toString('utf8')
  return [...xml.matchAll(/<(?:\w+:)?si\b[^>]*>([\s\S]*?)<\/(?:\w+:)?si>/g)].map((match) => texts(match[1]).join(''))
}

function workbookSheets(files) {
  const workbook = files.get('xl/workbook.xml')?.toString('utf8')
  const rels = files.get('xl/_rels/workbook.xml.rels')?.toString('utf8')
  if (!workbook || !rels) fail(ERR.XLSX_INVALID, 'Excel 缺少 workbook.xml 或关系表')
  const targets = new Map()
  for (const match of rels.matchAll(/<(?:\w+:)?Relationship\b([^>]+)\/?\s*>/g)) {
    const attrs = match[1]
    const id = /\bId="([^"]+)"/.exec(attrs)?.[1]
    const target = /\bTarget="([^"]+)"/.exec(attrs)?.[1]
    if (id && target) targets.set(id, target.replace(/^\/?xl\//, '').replace(/^\/?/, ''))
  }
  const out = []
  for (const match of workbook.matchAll(/<(?:\w+:)?sheet\b([^>]+)\/?\s*>/g)) {
    const attrs = match[1]
    const name = xmlDecode(/\bname="([^"]+)"/.exec(attrs)?.[1] ?? `Sheet${out.length + 1}`)
    const relId = /(?:r:)?id="([^"]+)"/.exec(attrs)?.[1]
    const target = targets.get(relId)
    if (target) out.push({ name, path: target.startsWith('xl/') ? target : `xl/${target}` })
  }
  return out
}

function columnIndex(ref) {
  const letters = /^([A-Z]+)/i.exec(ref)?.[1]?.toUpperCase() ?? 'A'
  let n = 0
  for (const ch of letters) n = n * 26 + ch.charCodeAt(0) - 64
  return n - 1
}

function parseSheet(xml, strings, { maxRows = 1_000_000, maxCols = 16_384, maxCellChars = 32_768 } = {}) {
  const rows = []
  const warnings = []
  for (const rowMatch of xml.matchAll(/<(?:\w+:)?row\b[^>]*>([\s\S]*?)<\/(?:\w+:)?row>/g)) {
    if (rows.length >= maxRows) fail(ERR.XLSX_UNSAFE, 'Excel 工作表行数超过安全上限', { maxRows })
    const row = []
    for (const cellMatch of rowMatch[1].matchAll(/<(?:\w+:)?c\b([^>]*)>([\s\S]*?)<\/(?:\w+:)?c>/g)) {
      const attrs = cellMatch[1]
      const body = cellMatch[2]
      const ref = /\br="([^"]+)"/.exec(attrs)?.[1] ?? 'A1'
      const index = columnIndex(ref)
      if (index >= maxCols) fail(ERR.XLSX_UNSAFE, 'Excel 工作表列数超过安全上限', { maxCols })
      const type = /\bt="([^"]+)"/.exec(attrs)?.[1]
      const formula = /<(?:\w+:)?f\b[^>]*>([\s\S]*?)<\/(?:\w+:)?f>/.exec(body)?.[1]
      const inline = type === 'inlineStr' ? texts(body).join('') : undefined
      const raw = /<(?:\w+:)?v\b[^>]*>([\s\S]*?)<\/(?:\w+:)?v>/.exec(body)?.[1]
      let value = inline ?? (raw === undefined ? '' : xmlDecode(raw))
      if (type === 's') value = strings[Number(value)] ?? ''
      if (type === 'b') value = value === '1' ? 'true' : 'false'
      if (formula) {
        if (/\b(DDE|HYPERLINK|WEBSERVICE)\b/i.test(xmlDecode(formula))) warnings.push({ code: 'FORMULA_EXTERNAL_OR_DDE', cell: ref })
        warnings.push({ code: 'FORMULA_CACHED_VALUE', cell: ref })
      }
      value = String(value)
      if (value.length > maxCellChars) fail(ERR.XLSX_UNSAFE, 'Excel 单元格内容超过安全上限', { cell: ref, maxCellChars })
      while (row.length < index) row.push('')
      row[index] = value
    }
    rows.push(row)
  }
  while (rows.length && rows.at(-1).every((value) => value === '' || value === undefined)) rows.pop()
  const width = Math.max(0, ...rows.map((row) => row.length))
  for (const row of rows) while (row.length < width) row.push('')
  return { rows, warnings }
}

export function parseXlsx(buffer, options = {}) {
  const files = readZipEntries(buffer, options)
  const names = [...files.keys()]
  if (names.some((name) => /(^|\/)vbaProject\.bin$/i.test(name))) fail(ERR.XLSX_MACRO, '含宏工作簿不在首版支持范围，未执行任何宏')
  if (names.some((name) => name.startsWith('xl/externalLinks/'))) fail(ERR.XLSX_EXTERNAL_LINK, '工作簿包含外部链接，已按安全策略拒绝主动访问')
  const strings = sharedStrings(files)
  const sheets = workbookSheets(files).map((sheet, index) => {
    const entry = files.get(sheet.path)
    if (!entry) fail(ERR.XLSX_INVALID, '工作表关系指向缺失文件', { sheet: sheet.name })
    const parsed = parseSheet(entry.toString('utf8'), strings, options)
    return { sheetId: `sheet_${index + 1}`, name: sheet.name, ...parsed }
  })
  if (!sheets.length) fail(ERR.XLSX_INVALID, '工作簿不包含可读取的工作表')
  return { sheets, entryCount: files.size }
}
