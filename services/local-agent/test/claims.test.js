import { test } from 'node:test'
import assert from 'node:assert/strict'
import { verifyClaims } from '../src/claims.js'

test('拒绝无方法证据的因果结论和不存在的证据引用', () => {
  const evidence = [{ evidence_id: 'ev_mean', fields: ['value'], scope: 'n=4', value: { mean: 2.5 } }]
  const claims = [
    {
      claimId: 'claim_causal',
      evidenceId: 'ev_mean',
      fields: ['value'],
      sampleScope: 'n=4',
      numbers: [2.5],
      relation: 'causal',
      text: '处理导致均值为 2.5'
    },
    {
      claimId: 'claim_missing',
      evidenceId: 'ev_missing',
      fields: ['value'],
      sampleScope: 'n=4',
      numbers: [],
      relation: 'descriptive',
      text: '描述'
    }
  ]

  const result = verifyClaims(claims, evidence)
  assert.equal(result.passed, false)
  assert.deepEqual(result.rejected.map((item) => item.code), ['UNSUPPORTED_CAUSAL_LANGUAGE', 'EVIDENCE_NOT_FOUND'])
})

test('接受字段、范围和数值均由证据支持的描述性结论', () => {
  const evidence = [{ evidence_id: 'ev_trend', fields: ['value'], scope: '全部 6 行', value: '12.3 → 25.6（+108.1%）' }]
  const claims = [{
    claimId: 'claim_trend',
    evidenceId: 'ev_trend',
    fields: ['value'],
    sampleScope: '全部 6 行',
    numbers: [12.3, 25.6, 108.1],
    relation: 'descriptive',
    text: 'value 从 12.3 变为 25.6，变化 108.1%'
  }]

  const result = verifyClaims(claims, evidence)
  assert.equal(result.passed, true)
  assert.deepEqual(result.accepted.map((item) => item.claimId), ['claim_trend'])
  assert.deepEqual(result.rejected, [])
})

test('数值、字段或样本范围不一致时拒绝发布', () => {
  const evidence = [{ evidence_id: 'ev_mean', fields: ['value'], scope: 'n=4', value: 'mean=2.5' }]
  const base = { claimId: 'claim', evidenceId: 'ev_mean', fields: ['value'], sampleScope: 'n=4', numbers: [2.5], relation: 'descriptive', text: '均值 2.5' }
  const result = verifyClaims([
    { ...base, claimId: 'bad_number', numbers: [3.5] },
    { ...base, claimId: 'bad_field', fields: ['other'] },
    { ...base, claimId: 'bad_scope', sampleScope: 'n=5' }
  ], evidence)

  assert.deepEqual(result.rejected.map((item) => item.code), [
    'EVIDENCE_VALUE_MISMATCH',
    'EVIDENCE_FIELD_MISMATCH',
    'EVIDENCE_SCOPE_MISMATCH'
  ])
})


test('precise trend values and distinct Chinese correlation fields survive evidence verification', async () => {
  const { ingestFile } = await import('../src/csv.js')
  const { runDeterministicAnalysis } = await import('../src/stats.js')
  const q = ingestFile('中文字段.csv', Buffer.from('时刻标签,时间_min,电价_元每kWh,小区负荷_kW,光伏预测功率_kW\n1,10,0.4248,3439.8466,900.24\n2,20,0.75,3900.57,1400.63\n3,30,0.4276,3444.7259,1100.24\n4,40,0.86,4600.88,1600.52\n'))
  const a = runDeterministicAnalysis({ profile: q.profile, text: q.text, rawDelimiter: q.rawDelimiter, fileName: '中文字段.csv' })
  assert.equal(new Set(a.evidence.map(x => x.evidence_id)).size, a.evidence.length, 'every evidence record has a unique ID')
  assert.deepEqual(verifyClaims(a.claims, a.evidence).rejected, [])
})

test('structured precision does not permit fabricated claim numbers', () => {
  const e = { evidence_id: 'trend', fields: ['price'], scope: 'n=2', value: '0.4 → 0.4', details: { first: 0.4248, last: 0.4276 } }
  const c = { evidenceId: 'trend', fields: ['price'], sampleScope: 'n=2', numbers: [0.99] }
  assert.equal(verifyClaims([c], [e]).rejected[0].code, 'EVIDENCE_VALUE_MISMATCH')
})
