import test from 'node:test'
import assert from 'node:assert/strict'
import { createDefaultFormatRegistry } from '../src/formats.js'
import { buildZip } from '../src/zip.js'

function workbookZip({ external = false, macro = false } = {}) {
  const files = [
    { name: '[Content_Types].xml', content: '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"></Types>' },
    { name: 'xl/workbook.xml', content: '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>' },
    { name: 'xl/_rels/workbook.xml.rels', content: '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>' },
    { name: 'xl/sharedStrings.xml', content: '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><si><t>time</t></si><si><t>value</t></si></sst>' },
    { name: 'xl/worksheets/sheet1.xml', content: '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c></row><row r="2"><c r="A2"><v>1</v></c><c r="B2"><v>2.5</v></c></row><row r="3"><c r="A3"><v>2</v></c><c r="B3"><f>1+3</f><v>4</v></c></row></sheetData></worksheet>' }
  ]
  if (external) files.push({ name: 'xl/externalLinks/externalLink1.xml', content: '<externalLink />' })
  if (macro) files.push({ name: 'xl/vbaProject.bin', content: Buffer.from([1, 2, 3]) })
  return buildZip(files)
}

test('format registry parses JSON records into normalized executable CSV', () => {
  const registry = createDefaultFormatRegistry()
  const result = registry.parse('records.json', Buffer.from(JSON.stringify([{ time: 1, value: 2 }, { time: 2, value: 4 }])))
  assert.equal(result.plugin, 'json')
  assert.equal(result.datasets.length, 1)
  assert.equal(result.datasets[0].profile.rows, 2)
  assert.equal(result.datasets[0].profile.columns[1].inferredType, 'numeric')
})

test('safe XLSX parser exposes worksheets and cached formula values', () => {
  const registry = createDefaultFormatRegistry()
  const result = registry.parse('book.xlsx', workbookZip())
  assert.equal(result.plugin, 'xlsx')
  assert.equal(result.datasets.length, 1)
  assert.equal(result.datasets[0].sheetName, 'Data')
  assert.equal(result.datasets[0].profile.rows, 2)
  assert.ok(result.datasets[0].warnings.some((item) => item.code === 'FORMULA_CACHED_VALUE'))
})

test('safe XLSX parser rejects macros and external links', () => {
  const registry = createDefaultFormatRegistry()
  assert.throws(() => registry.parse('macro.xlsx', workbookZip({ macro: true })), { code: 'XLSX_MACRO' })
  assert.throws(() => registry.parse('external.xlsx', workbookZip({ external: true })), { code: 'XLSX_EXTERNAL_LINK' })
})
