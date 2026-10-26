import test from 'node:test'
import assert from 'node:assert/strict'
import { ingestFile } from '../src/csv.js'
import { runDeterministicAnalysis } from '../src/stats.js'
import { buildInterpretation } from '../src/interpretation.js'

const ingest = (csv, name = 'semi.csv') => ingestFile(name, Buffer.from(csv, 'utf8'))
const analyze = (csv) => {
  const ing = ingest(csv)
  return runDeterministicAnalysis({ profile: ing.profile, text: ing.text, rawDelimiter: ing.rawDelimiter, fileName: 's.csv' })
}

test('长表分组：解读产出 comparison（ANOVA/两两）与 distribution，段落含 F 与 p', () => {
  const analysis = analyze('group,value\na,1\na,2\na,3\nb,4\nb,5\nb,6\nc,4\nc,5\nc,6\n')
  const interp = buildInterpretation({
    summary: analysis.summary, evidence: analysis.evidence, claims: analysis.claims,
    title: '三组均值比较', caption: '图1-1 三组均值比较'
  })
  const kinds = interp.insights.map((i) => i.kind)
  assert.ok(kinds.includes('comparison'), `应包含组间比较 insight，实际 ${kinds.join(',')}`)
  assert.ok(kinds.includes('distribution'), '应包含分组分布 insight')
  assert.match(interp.analysisParagraph, /单因素方差分析表明/)
  assert.match(interp.analysisParagraph, /F=/)
  assert.match(interp.analysisParagraph, /p=/)
  assert.match(interp.captionSuggestion, /ANOVA/)
  // 每条 insight 必须携带证据引用
  for (const i of interp.insights) {
    assert.ok(i.evidenceId, `insight ${i.id} 缺 evidenceId`)
    assert.ok(analysis.evidence.some((e) => e.evidence_id === i.evidenceId), `insight ${i.id} 引用不存在的证据 ${i.evidenceId}`)
  }
})

test('宽表多系列：解读产出 trend 与 correlation，段落含趋势与相关（n≥5 满足显著性前提）', () => {
  const analysis = analyze('x,y,z\n1,2,4\n2,4,8\n3,6,12\n4,8,16\n5,10,20\n6,12,24\n')
  const interp = buildInterpretation({
    summary: analysis.summary, evidence: analysis.evidence, claims: analysis.claims,
    title: '随时间的变化', caption: '图1-1 随时间的变化'
  })
  const kinds = interp.insights.map((i) => i.kind)
  assert.ok(kinds.includes('trend'), '应包含趋势 insight')
  assert.ok(kinds.includes('correlation'), '应包含相关 insight')
  assert.match(interp.analysisParagraph, /变化趋势/)
})

test('解读段落所有数字均来自证据（不编造）：无 ANOVA/无显著相关时不出现对应表述', () => {
  // y 与 x 仅弱相关（r≈0.354, n=5, p 不显著），ANOVA 不适用 → 段落不得出现这些表述
  const analysis = analyze('x,y\n1,3\n2,1\n3,4\n4,1\n5,5\n')
  const interp = buildInterpretation({
    summary: analysis.summary, evidence: analysis.evidence, claims: analysis.claims,
    title: '单列趋势', caption: '图1-1 单列趋势'
  })
  assert.doesNotMatch(interp.analysisParagraph, /单因素方差分析/)
  assert.doesNotMatch(interp.analysisParagraph, /显著正相关/)
  assert.doesNotMatch(interp.analysisParagraph, /显著负相关/)
  assert.match(interp.analysisParagraph, /变化趋势/)
  assert.ok(interp.insights.length >= 1)
})

test('解读段落始终存在且以标题开头；无任何证据时给出兜底句', () => {
  const interp = buildInterpretation({ summary: null, evidence: [], claims: [], title: '空图', caption: '' })
  assert.match(interp.analysisParagraph, /空图/)
  assert.equal(interp.insights.length, 0)
  assert.ok(interp.captionSuggestion.includes('图1-1'))
})

test('不适用图型给出动态替代方案并要求确认', () => {
  const analysis = analyze('x,y\n1,3\n2,4\n3,5\n')
  const interp = buildInterpretation({ summary: analysis.summary, evidence: analysis.evidence, claims: analysis.claims, chartType: '三维曲面图', title: '三维测试' })
  assert.equal(interp.recommendation.status, 'needs_confirmation')
  assert.ok(interp.recommendation.alternatives.includes('二维散点图'))
})
