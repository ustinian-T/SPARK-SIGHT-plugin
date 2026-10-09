// 数据可信层单元测试：真实解析、指纹、类型推断、缺失率、确定性统计与证据。
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import fs from 'node:fs'
import { createHash } from 'node:crypto'
import { ingestFile, fingerprint } from '../src/csv.js'
import { runDeterministicAnalysis } from '../src/stats.js'
import { ApiError } from '../src/errors.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixture = (name) => path.join(here, 'fixtures', name)
const read = (name) => fs.readFileSync(fixture(name))

test('CSV 真实解析：行列数、分隔符、列类型、描述统计', () => {
  const { profile } = ingestFile('nitrogen_response_demo.csv', read('nitrogen_response_demo.csv'))
  assert.equal(profile.rows, 6)
  assert.equal(profile.cols, 7)
  assert.equal(profile.delimiter, ',')
  assert.equal(profile.encoding, 'UTF-8')
  assert.equal(profile.hasHeader, true)
  assert.match(profile.fingerprint, /^[0-9a-f]{64}$/)

  // 与文档定义独立对照：H = SHA256(file_bytes || JSON(parser_config))
  const cfg = JSON.parse(profile.parserConfig)
  const expectFp = createHash('sha256')
    .update(Buffer.concat([read('nitrogen_response_demo.csv'), Buffer.from(JSON.stringify(cfg), 'utf-8')]))
    .digest('hex')
  assert.equal(profile.fingerprint, expectFp)

  const control = profile.columns.find((c) => c.name === 'control')
  assert.equal(control.inferredType, 'numeric')
  // mean = (12.0+13.4+14.8+16.1+17.2+18.0)/6 = 15.25
  assert.equal(control.mean, 15.25)
  assert.equal(control.min, 12)
  assert.equal(control.max, 18)
  assert.equal(control.missing, 0)
  assert.equal(control.missingRate, 0)

  // _sd 辅助列同样是数值列
  assert.equal(profile.columns.find((c) => c.name === 'treatment_a_sd').inferredType, 'numeric')
  assert.equal(profile.headRows.length, 6)
})

test('内容指纹：H = SHA256(file_bytes || parser_config)，配置变化指纹变化且可复现', () => {
  const bytes = read('nitrogen_response_demo.csv')
  const { profile } = ingestFile('a.csv', bytes)
  const again = ingestFile('a.csv', bytes).profile
  assert.equal(again.fingerprint, profile.fingerprint)

  const cfg1 = { encoding: 'UTF-8', delimiter: ',', hasHeader: true }
  const cfg2 = { encoding: 'UTF-8', delimiter: ';', hasHeader: true }
  assert.notEqual(fingerprint(bytes, cfg1), fingerprint(bytes, cfg2))
  // 字节变化指纹变化
  const changed = Buffer.concat([bytes, Buffer.from('\n7,1,1,1,0,0,0')])
  assert.notEqual(fingerprint(changed, cfg1), fingerprint(bytes, cfg1))
})

test('GBK 编码与中文列名可正确探测解析', () => {
  const { profile } = ingestFile('gbk_demo.csv', read('gbk_demo.csv'))
  assert.equal(profile.encoding, 'GBK')
  assert.deepEqual(
    profile.columns.map((c) => c.name),
    ['周次', '对照组', '处理A', '处理B', '对照组_sd']
  )
  assert.equal(profile.columns.find((c) => c.name === '对照组').inferredType, 'numeric')
})

test('制表符分隔：对外显示为 \\t', () => {
  const { profile } = ingestFile('tab_demo.csv', read('tab_demo.csv'))
  assert.equal(profile.delimiter, '\\t')
  assert.equal(profile.cols, 3)
})

test('UTF-8 BOM 被正确去除，首列名不残留 BOM', () => {
  const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), read('nitrogen_response_demo.csv')])
  const { profile } = ingestFile('bom.csv', bom)
  assert.equal(profile.columns[0].name, 'week')
})

test('缺失率真实计算并产生质量告警', () => {
  const { profile } = ingestFile('missing_values.csv', read('missing_values.csv'))
  const a = profile.columns.find((c) => c.name === 'treatment_a')
  const b = profile.columns.find((c) => c.name === 'treatment_b')
  assert.equal(a.missing, 1)
  assert.equal(a.missingRate, 1 / 6)
  assert.equal(b.missing, 1)

  // 缺失率超过 30% 阈值时必须告警（4 行中缺 2 行 = 50%）
  const high = ingestFile('high_missing.csv', Buffer.from('week,v\n1,1.0\n2,\n3,\n4,4.0\n', 'utf-8')).profile
  const v = high.columns.find((c) => c.name === 'v')
  assert.equal(v.missingRate, 0.5)
  assert.ok(high.warnings.some((w) => w.includes('缺失率超过 30%')))
})

test('非法输入稳定报错：空文件 / 二进制 / 仅表头 / 重复列名 / 无数值列', () => {
  const expectCode = (buf, code, label) => {
    assert.throws(
      () => ingestFile('x.csv', buf),
      (e) => e instanceof ApiError && e.code === code,
      label
    )
  }
  expectCode(Buffer.alloc(0), 'EMPTY_FILE', '0 字节')
  expectCode(Buffer.from('   \n  \n', 'utf-8'), 'EMPTY_FILE', '空白')
  expectCode(Buffer.from([0x41, 0x00, 0x42, 0x0a, 0x31, 0x00]), 'BINARY_CONTENT', 'NUL 二进制')
  expectCode(Buffer.from('a,b,c\n', 'utf-8'), 'NO_DATA_ROWS', '仅表头')
  expectCode(Buffer.from('a,b,a\n1,2,3\n', 'utf-8'), 'DUPLICATE_HEADER', '重复列名')
  expectCode(Buffer.from('name,city\n张三,西安\n李四,北京\n', 'utf-8'), 'NO_NUMERIC_FIELDS', '无数值列')
})

test('确定性统计只算一次：系列识别、误差棒、首末变化率、证据账本', () => {
  const ingest = ingestFile('nitrogen_response_demo.csv', read('nitrogen_response_demo.csv'))
  const analysis = runDeterministicAnalysis({
    profile: ingest.profile,
    text: ingest.text,
    rawDelimiter: ingest.rawDelimiter,
    fileName: 'nitrogen_response_demo.csv'
  })
  // 三个测量系列（_sd 列不作为独立系列），x 轴为 week
  assert.equal(analysis.summary.series.length, 3)
  assert.equal(analysis.summary.xLabel, 'week')
  assert.deepEqual(analysis.summary.series.map((s) => s.label), ['control', 'treatment_a', 'treatment_b'])
  assert.ok(analysis.summary.series.every((s) => Array.isArray(s.yerr)), '配对 _sd 列应生成 yerr')
  assert.deepEqual(analysis.summary.series.map((s) => s.yerrKind), ['sd', 'sd', 'sd'])
  assert.equal(analysis.processingTrace.datasetFingerprint, ingest.profile.fingerprint)
  assert.equal(analysis.processingTrace.mutation, 'none')
  assert.ok(analysis.processingTrace.operations.some((item) => item.id === 'parse_numeric'))
  assert.equal(analysis.suitabilityAudit.schema, 'deep-imaging.chart-suitability.v1')

  const ids = analysis.evidence.map((e) => e.evidence_id)
  for (const id of ['ev_n', 'ev_x', 'ev_missing', 'ev_desc_0', 'ev_trend_0', 'ev_trend_1', 'ev_trend_2', 'ev_peak', 'ev_errorbars']) {
    assert.ok(ids.includes(id), `缺少证据 ${id}`)
  }
  // treatment_a: 12.3 → 25.6，变化率 = round((13.3/12.3)*1000)/10 = 108.1%
  const trendA = analysis.evidence.find((e) => e.evidence_id === 'ev_trend_1')
  assert.ok(trendA.value.includes('+108.1%'))
  assert.deepEqual(trendA.fields, ['treatment_a'])
  // 末点最高：week 6 时 treatment_a=25.6
  const peak = analysis.evidence.find((e) => e.evidence_id === 'ev_peak')
  assert.ok(peak.value.startsWith('treatment_a'))
  // 每条证据字段完整（前端 EvidenceRecord 契约）
  for (const e of analysis.evidence) {
    for (const k of ['evidence_id', 'tool', 'metric', 'fields', 'scope', 'value']) {
      assert.ok(e[k] !== undefined && e[k] !== '', `证据 ${e.evidence_id} 缺字段 ${k}`)
    }
  }
  // claims 全部为结构化结论并带 evidence_id 引用
  assert.ok(analysis.claims.every((c) => c.claimId && /^ev_[a-z_0-9]+$/.test(c.evidenceId)))
})

test('缺失值统计：缺失占位在证据 note 中声明，不静默丢弃', () => {
  const ingest = ingestFile('missing_values.csv', read('missing_values.csv'))
  const analysis = runDeterministicAnalysis({
    profile: ingest.profile,
    text: ingest.text,
    rawDelimiter: ingest.rawDelimiter,
    fileName: 'missing_values.csv'
  })
  const missingEv = analysis.evidence.find((e) => e.evidence_id === 'ev_missing')
  assert.ok(missingEv.value.includes('treatment_a=1/6'))
  assert.ok(missingEv.value.includes('treatment_b=1/6'))
})

test('缺失数值保持 null，重复行、混合类型和 IQR 异常值形成结构化质量结果', () => {
  const csv = [
    'group,value',
    'A,1',
    'B,',
    'C,bad',
    'D,1',
    'E,1',
    'F,1',
    'G,1',
    'H,1',
    'I,1',
    'J,1',
    'K,1',
    'L,100',
    'A,1'
  ].join('\n')
  const ingest = ingestFile('quality.csv', Buffer.from(csv, 'utf-8'))
  const analysis = runDeterministicAnalysis({
    profile: ingest.profile,
    text: ingest.text,
    rawDelimiter: ingest.rawDelimiter,
    fileName: 'quality.csv'
  })

  assert.deepEqual(analysis.summary.series[0].y, [1, null, null, 1, 1, 1, 1, 1, 1, 1, 1, 100, 1])
  assert.equal(ingest.profile.quality.duplicateRows.count, 1)
  assert.equal(ingest.profile.quality.mixedTypeColumns[0].field, 'value')
  assert.equal(ingest.profile.quality.mixedTypeColumns[0].invalidCount, 1)
  assert.equal(ingest.profile.quality.outliers[0].field, 'value')
  assert.deepEqual(ingest.profile.quality.outliers[0].rowNumbers, [13])
})
