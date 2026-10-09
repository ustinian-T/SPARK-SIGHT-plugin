// Data-format plugin registry. Every parser returns one or more normalized
// table datasets so the Agent pipeline remains format-agnostic.
import { createHash } from 'node:crypto'
import path from 'node:path'
import { ingestFile, parseCsv } from './csv.js'
import { parseXlsx } from './xlsx.js'
import { ApiError, ERR } from './errors.js'

export function csvEncode(rows) {
  return rows.map((row) => row.map((value) => {
    const text = String(value ?? '')
    return /[",\r\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
  }).join(',')).join('\r\n') + '\r\n'
}

function inferRowsFromJson(value) {
  const rows = Array.isArray(value) ? value : Array.isArray(value?.data) ? value.data : null
  if (!rows?.length || rows.some((row) => !row || typeof row !== 'object' || Array.isArray(row))) {
    throw new ApiError(400, ERR.INVALID_JSON, 'JSON 必须是非空对象数组，或包含 data 对象数组')
  }
  const keys = [...new Set(rows.flatMap((row) => Object.keys(row)))]
  if (!keys.length) throw new ApiError(400, ERR.INVALID_JSON, 'JSON 对象没有可绘制字段')
  const table = [keys]
  for (const row of rows) {
    table.push(keys.map((key) => {
      const cell = row[key]
      if (cell === null || cell === undefined) return ''
      if (typeof cell === 'object') return JSON.stringify(cell)
      return String(cell)
    }))
  }
  return table
}

function baseName(fileName) {
  return path.basename(String(fileName ?? 'upload').replace(/\\/g, '/'))
}

export class FormatRegistry {
  constructor() { this.formats = new Map() }
  register(plugin) {
    if (!plugin?.id || !Array.isArray(plugin.extensions) || typeof plugin.parse !== 'function') throw new Error('INVALID_FORMAT_PLUGIN')
    this.formats.set(plugin.id, Object.freeze({ ...plugin }))
    return this
  }
  list() { return [...this.formats.values()].map(({ parse, ...meta }) => structuredClone(meta)) }
  resolve(fileName) {
    const ext = path.extname(baseName(fileName)).toLowerCase()
    return [...this.formats.values()].find((plugin) => plugin.extensions.includes(ext))
  }
  parse(fileName, buffer, options = {}) {
    const plugin = this.resolve(fileName)
    if (!plugin) throw new ApiError(415, ERR.UNSUPPORTED_DATA_FORMAT, `不支持的数据格式：${path.extname(fileName) || '(无扩展名)'}`, { supported: this.list().flatMap((item) => item.extensions) })
    return { plugin: plugin.id, datasets: plugin.parse(baseName(fileName), buffer, options) }
  }
}

function csvDataset(name, buffer, extra = {}) {
  const ingest = ingestFile(name.endsWith('.csv') ? name : `${name}.csv`, buffer)
  return {
    datasetId: `ds_${createHash('sha256').update(buffer).digest('hex').slice(0, 12)}`,
    name,
    csvName: name.endsWith('.csv') ? name : `${name}.csv`,
    csvBuffer: buffer,
    profile: ingest.profile,
    rows: parseCsv(ingest.text, ingest.rawDelimiter),
    rawDelimiter: ingest.rawDelimiter,
    ...extra
  }
}

export function createDefaultFormatRegistry() {
  return new FormatRegistry()
    .register({
      id: 'csv', name: 'CSV', extensions: ['.csv'], version: '1', capabilities: ['preview', 'profile', 'execute'],
      parse: (name, buffer) => [csvDataset(name, buffer)]
    })
    .register({
      id: 'json', name: 'JSON records', extensions: ['.json'], version: '1', capabilities: ['preview', 'profile', 'execute'],
      parse: (name, buffer) => {
        let value
        try { value = JSON.parse(buffer.toString('utf8')) } catch { throw new ApiError(400, ERR.INVALID_JSON, 'JSON 解析失败，请使用 UTF-8 编码的合法 JSON') }
        const csv = Buffer.from(csvEncode(inferRowsFromJson(value)), 'utf8')
        return [csvDataset(name.replace(/\.json$/i, '.csv'), csv, { sourceFormat: 'json' })]
      }
    })
    .register({
      id: 'xlsx', name: 'Excel Workbook', extensions: ['.xlsx'], version: '1', capabilities: ['sheets', 'preview', 'profile', 'execute'],
      security: ['zip-limits', 'no-macros', 'no-external-links', 'cached-formulas-only'],
      parse: (name, buffer, options) => {
        const workbook = parseXlsx(buffer, options)
        const selected = Array.isArray(options.selectedSheets) ? new Set(options.selectedSheets) : null
        return workbook.sheets.filter((sheet) => !selected || selected.has(sheet.name) || selected.has(sheet.sheetId)).map((sheet) => {
          if (sheet.rows.length < 2) throw new ApiError(400, ERR.NOT_TABULAR, `工作表「${sheet.name}」没有数据行`)
          const csv = Buffer.from(csvEncode(sheet.rows), 'utf8')
          return csvDataset(`${name.replace(/\.xlsx$/i, '')}_${sheet.name}.csv`, csv, {
            sourceFormat: 'xlsx', workbookName: name, sheetId: sheet.sheetId, sheetName: sheet.name, warnings: sheet.warnings
          })
        })
      }
    })
}
