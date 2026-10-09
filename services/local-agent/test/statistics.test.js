import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ingestFile } from '../src/csv.js'
import {
  runDeterministicAnalysis,
  holmAdjust,
  bhAdjust,
  cohenDIndependent,
  cohenDZ,
  hedgesG,
  classifyErrorBar,
  tTestIndependent,
  anovaOneWay,
  significanceStars,
  summarizeGroups,
  pairedTTest,
  detectOutliers,
  buildDataOverview
} from '../src/stats.js'
import { buildSemanticModel } from '../src/semanticModel.js'
import { verifyClaims } from '../src/claims.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const golden = JSON.parse(fs.readFileSync(path.join(here, 'fixtures', 'statistics-golden.json'), 'utf8'))

function analyze(csv = golden.csv) {
  const ingest = ingestFile('golden.csv', Buffer.from(csv))
  return runDeterministicAnalysis({ profile: ingest.profile, text: ingest.text, rawDelimiter: ingest.rawDelimiter, fileName: 'golden.csv' })
}

test('golden quantiles, correlations, regression, confidence interval, and effect size enter EvidenceLedger', () => {
  const analysis = analyze()
  const byId = new Map(analysis.evidence.map((item) => [item.evidence_id, item]))
  assert.deepEqual(byId.get('ev_quantiles_0').details, golden.expected.yQuantiles)
  assert.equal(byId.get('ev_corr_x_y').details.r, golden.expected.xyCorrelation)
  assert.equal(byId.get('ev_corr_x_z').details.r, golden.expected.xzCorrelation)
  assert.deepEqual(byId.get('ev_regression_0').details, { ...golden.expected.yRegression, n: 5 })
  assert.ok(Math.abs(byId.get('ev_ci_0').details.lower - golden.expected.yMeanCi95.lower) < 0.001)
  assert.ok(Math.abs(byId.get('ev_ci_0').details.upper - golden.expected.yMeanCi95.upper) < 0.001)
  assert.equal(byId.get('ev_effect_0_1').details.cohenD, golden.expected.yzCohenD)
})

test('significance evidence is assumption-gated and its claim is verifiable', () => {
  const analysis = analyze()
  const significance = analysis.evidence.find((item) => item.evidence_id === 'ev_significance_x_y')
  assert.equal(significance.method, 'Pearson correlation t-test')
  assert.equal(significance.details.performed, true)
  assert.ok(significance.details.pValue < 0.001)
  const claim = analysis.claims.find((item) => item.evidenceId === significance.evidence_id)
  assert.equal(verifyClaims([claim], analysis.evidence).passed, true)
})

test('missing pairs are excluded and constant/insufficient inputs produce explicit non-results', () => {
  const analysis = analyze('x,y,z\n1,2,5\n2,,5\n3,6,5\n4,,5\n')
  const byId = new Map(analysis.evidence.map((item) => [item.evidence_id, item]))
  assert.equal(byId.get('ev_corr_x_y').details.n, 2)
  assert.equal(byId.get('ev_corr_x_y').details.r, null)
  assert.equal(byId.get('ev_corr_x_z').details.r, null)
  assert.equal(byId.get('ev_significance_x_y').details.performed, false)
  assert.match(byId.get('ev_significance_x_y').details.reason, /样本量不足/)
})

// ---------- 阶段 C：数据语义模型 ----------
function ingest(csv, name = 'semi.csv') {
  return ingestFile(name, Buffer.from(csv, 'utf8'))
}

test('semanticModel 识别 wide / long / matrix / time-series 表格形态', () => {
  // wide：存在配对 _sd 列
  const wide = ingest('week,control,treatment,control_sd,treatment_sd\n1,12,13,0.5,0.6\n2,13,15,0.7,0.8\n')
  const mWide = buildSemanticModel(wide.profile, wide.text, wide.rawDelimiter)
  assert.equal(mWide.tableShape, 'wide')
  assert.ok(mWide.fieldRoles.error.includes('control_sd'))
  assert.ok(mWide.fieldRoles.xTime.includes('week'))

  // long：variable + value 列名模式
  const long = ingest('subject,variable,value\n1,A,10\n1,B,20\n2,A,12\n2,B,22\n')
  const mLong = buildSemanticModel(long.profile, long.text, long.rawDelimiter)
  assert.equal(mLong.tableShape, 'long')

  // matrix：行列均数值、无分类/时间列
  const matrix = ingest('a,b,c\n1,2,3\n4,5,6\n7,8,9\n')
  const mMatrix = buildSemanticModel(matrix.profile, matrix.text, matrix.rawDelimiter)
  assert.equal(mMatrix.tableShape, 'matrix')

  // time-series：datetime 列
  const ts = ingest('date,value\n2024-01-01,10\n2024-01-02,12\n2024-01-03,14\n')
  const mTs = buildSemanticModel(ts.profile, ts.text, ts.rawDelimiter)
  assert.equal(mTs.tableShape, 'time-series')
})

test('semanticModel 缺乏强信号时 designConfidence<0.6 且 researchDesign=unknown', () => {
  const ing = ingest('x,y,z\n1,2,10\n2,4,8\n3,6,6\n4,8,4\n5,10,2\n')
  const m = buildSemanticModel(ing.profile, ing.text, ing.rawDelimiter)
  assert.ok(m.designConfidence < 0.6, `期望置信度<0.6，实际 ${m.designConfidence}`)
  assert.equal(m.researchDesign, 'unknown')
  assert.ok(m.warnings.length > 0)
  // 缺失机制只能给出 unknown
  assert.equal(m.missingness.mechanism, 'unknown')
})

// ---------- 阶段 C：多重比较校正 ----------
test('holmAdjust 按升序累积最大校正（手算对照）', () => {
  // p=[0.01,0.04,0.03,0.005]，m=4
  // 升序：0.005→0.02；0.01→max(0.02,3*0.01=0.03)=0.03；0.03→max(0.03,2*0.03=0.06)=0.06；0.04→max(0.06,1*0.04)=0.06
  const { adjusted, method } = holmAdjust([0.01, 0.04, 0.03, 0.005])
  assert.equal(method, 'holm')
  assert.deepEqual(adjusted, [0.03, 0.06, 0.06, 0.02])
})

test('bhAdjust 按降序累积最小 FDR 校正（手算对照）', () => {
  // 升序：0.005→(4/1)*0.005=0.02；0.01→(4/2)*0.01=0.02；0.03→(4/3)*0.03=0.04；0.04→(4/4)*0.04=0.04
  const { adjusted, method } = bhAdjust([0.01, 0.04, 0.03, 0.005])
  assert.equal(method, 'bh')
  assert.deepEqual(adjusted, [0.02, 0.04, 0.04, 0.02])
})

// ---------- 阶段 C：效应量 ----------
test('cohenDZ 配对效应量 = mean(diff)/sd(diff)', () => {
  const a = [1, 3, 5, 7, 9]
  const b = [2, 2, 6, 6, 10]
  // diff=[-1,1,-1,1,-1]，mean=-0.2，sd=sqrt(1.2)≈1.0954
  const r = cohenDZ(a, b)
  assert.equal(r.definition, 'paired difference dz')
  assert.ok(Math.abs(r.value - (-0.2 / Math.sqrt(1.2))) < 1e-6)
})

test('hedgesG 小样本校正因子 = 1 - 3/(4(n1+n2)-9)', () => {
  const a = [1, 2, 3]
  const b = [4, 5, 6]
  // 独立样本 d = (2-5)/1 = -3；n1=n2=3，校正=1-3/15=0.8 → g=-2.4
  const d = cohenDIndependent(a, b)
  const g = hedgesG(a, b)
  assert.equal(g.n1, 3)
  assert.equal(g.n2, 3)
  assert.ok(Math.abs(g.value - (-3 * 0.8)) < 1e-6, `g=${g.value}`)
  assert.equal(d.value, -3)
})

// ---------- 阶段 C：错误棒语义 ----------
test('classifyErrorBar 区分 sd/se/ci/range/unknown', () => {
  assert.deepEqual(classifyErrorBar('control_sd'), { kind: 'sd', source: 'suffix' })
  assert.deepEqual(classifyErrorBar('mean_se'), { kind: 'se', source: 'suffix' })
  assert.deepEqual(classifyErrorBar('score_ci'), { kind: 'ci', source: 'suffix' })
  assert.deepEqual(classifyErrorBar('x_min'), { kind: 'range', source: 'suffix' })
  const u = classifyErrorBar('value', [1, 2, 3])
  assert.equal(u.kind, 'unknown')
  assert.equal(u.source, 'none')
})

// ---------- 阶段 C：研究设计门禁 ----------
test('runDeterministicAnalysis 在 unknown 设计下不输出显著性/效应量 claim', () => {
  const ing = ingest(golden.csv)
  const semanticModel = { researchDesign: 'unknown', tableShape: 'matrix', fieldRoles: { measure: ['y', 'z'] } }
  const analysis = runDeterministicAnalysis({ profile: ing.profile, text: ing.text, rawDelimiter: ing.rawDelimiter, fileName: 'g.csv', semanticModel })
  // 门禁证据存在
  const gate = analysis.evidence.find((e) => e.evidence_id === 'ev_design_gate')
  assert.ok(gate, '应写入 ev_design_gate')
  assert.match(gate.value, /推断统计已暂停/)
  // claims 中不得出现显著性或效应量结论
  for (const c of analysis.claims) {
    assert.notEqual(c.relation, 'significance', 'unknown 设计不应输出显著性 claim')
    assert.notEqual(c.relation, 'effect_size', 'unknown 设计不应输出效应量 claim')
  }
  // 效应量证据仍计算但标记 designGated
  const eff = analysis.evidence.find((e) => e.evidence_id === 'ev_effect_0_1')
  assert.equal(eff.designGated, true)
  // 推断证据带 stats-v2 元数据
  const sig = analysis.evidence.find((e) => e.evidence_id === 'ev_significance_y_z')
  assert.equal(sig.version, 'stats-v2')
  assert.ok(Array.isArray(sig.assumptions))
  assert.ok(sig.reproducibleInput.hash.length > 0)
})

test('runDeterministicAnalysis 在 independent 设计下使用 cohenDIndependent 并输出 claim', () => {
  const ing = ingest(golden.csv)
  const semanticModel = { researchDesign: 'independent', tableShape: 'wide', fieldRoles: { measure: ['y', 'z'] } }
  const analysis = runDeterministicAnalysis({ profile: ing.profile, text: ing.text, rawDelimiter: ing.rawDelimiter, fileName: 'g.csv', semanticModel })
  const eff = analysis.evidence.find((e) => e.evidence_id === 'ev_effect_0_1')
  assert.match(eff.method, /pooled/)
  // golden 中 y 与 z 均值均为 6 → d=0
  assert.equal(eff.details.cohenD, 0)
  // independent 设计下显著性 claim 应输出（仅 y-z 这一对 measure）
  const sigClaim = analysis.claims.find((c) => c.relation === 'significance')
  assert.ok(sigClaim, 'independent 设计应输出显著性 claim')
})

// ---------- 阶段 A 修复不回退 ----------
test('零基线变化率仍为 undefined（阶段 A 修复不回退）', () => {
  const analysis = analyze('x,y\n1,0\n2,10\n3,20\n')
  const trend = analysis.evidence.find((e) => e.evidence_id === 'ev_trend_0')
  assert.match(trend.value, /百分比变化未定义/)
  assert.match(trend.value, /绝对变化/)
})

test('末点范围仍使用 commonIndex（阶段 A 修复不回退）', () => {
  // b 系列末行缺失，末点比较应停在共同有值的 x=2
  const analysis = analyze('x,a,b\n1,10,100\n2,20,200\n3,30,\n')
  const peak = analysis.evidence.find((e) => e.evidence_id === 'ev_peak')
  assert.ok(peak)
  assert.match(peak.scope, /x=2/)
  assert.match(peak.note, /之后缺失|截至/)
})

// ---------- v0.4.1 统计推断扩展：t 检验 / ANOVA / 分组聚合 / 星号 ----------
test('tTestIndependent Welch 对照 R 经典值（1,2,3 vs 4,5,6 → t≈-3.674, df=4, p≈0.0214）', () => {
  const r = tTestIndependent([1, 2, 3], [4, 5, 6])
  assert.equal(r.performed, true)
  assert.ok(Math.abs(r.statistic - -3.674) < 0.01, `t=${r.statistic}`)
  assert.ok(Math.abs(r.df - 4) < 0.01, `df=${r.df}`)
  assert.ok(Math.abs(r.pValue - 0.0214) < 0.001, `p=${r.pValue}`)
  assert.equal(r.significant, true)
  assert.match(r.method, /Welch/)
})

test('tTestIndependent pooled 口径与相等样本对照', () => {
  const r = tTestIndependent([1, 2, 3], [4, 5, 6], { equalVariance: true })
  assert.ok(Math.abs(r.statistic - -3.674) < 0.01)
  assert.equal(r.df, 4)
  const same = tTestIndependent([1, 2, 3], [1, 2, 3])
  assert.equal(same.statistic, 0)
  assert.equal(same.pValue, 1)
  assert.equal(same.significant, false)
})

test('tTestIndependent 常量组/不足样本给出明确非结果', () => {
  const constBoth = tTestIndependent([1, 1, 1], [2, 2, 2])
  assert.equal(constBoth.performed, false)
  assert.match(constBoth.reason, /常量组/)
  const small = tTestIndependent([1], [2, 3])
  assert.equal(small.performed, false)
  assert.match(small.reason, /至少需要 2 个/)
})

test('anovaOneWay 对照手算经典值（3,2,1 / 5,3,4 / 5,6,7 → SSb=24, SSw=6, F=12, p=0.008, η²=0.8）', () => {
  const a = anovaOneWay([
    { name: 'A', values: [3, 2, 1] },
    { name: 'B', values: [5, 3, 4] },
    { name: 'C', values: [5, 6, 7] }
  ])
  assert.equal(a.performed, true)
  assert.equal(a.k, 3)
  assert.equal(a.dfBetween, 2)
  assert.equal(a.dfWithin, 6)
  assert.equal(a.ssBetween, 24)
  assert.equal(a.ssWithin, 6)
  assert.equal(a.statistic, 12)
  assert.equal(a.etaSq, 0.8)
  assert.ok(Math.abs(a.pValue - 0.008) < 1e-9, `p=${a.pValue}`)
  assert.equal(a.significant, true)
})

test('anovaOneWay 组数/样本不足时明确非结果', () => {
  assert.equal(anovaOneWay([{ name: 'A', values: [1, 2] }]).performed, false)
  assert.equal(anovaOneWay([{ name: 'A', values: [1, 2] }, { name: 'B', values: [5] }]).performed, false)
})

test('significanceStars 按 <0.001/** / <0.01/** / <0.05/* / 否则 ns', () => {
  assert.equal(significanceStars(0.0005), '***')
  assert.equal(significanceStars(0.005), '**')
  assert.equal(significanceStars(0.03), '*')
  assert.equal(significanceStars(0.2), 'ns')
  assert.equal(significanceStars(Number.NaN), null)
})

test('summarizeGroups 识别 长表分组形态 并聚合均值/SE/CI', () => {
  const csv = 'group,value\na,1\na,2\na,3\nb,4\nb,5\nb,6\n'
  const ing = ingest(csv)
  const groups = summarizeGroups(ing.profile, ing.text, ing.rawDelimiter)
  assert.ok(groups, '应识别分组列')
  assert.equal(groups.groupCol, 'group')
  assert.deepEqual(groups.x, ['a', 'b'])
  assert.equal(groups.series[0].label, 'a')
  assert.equal(groups.series[0].n, 3)
  assert.equal(groups.series[0].y, 2)
  assert.equal(groups.series[1].y, 5)
  // se = sd/sqrt(n)：a 组 sd=1 → se≈0.577（series.yerr 承载组标准误）
  assert.ok(Math.abs(groups.series[0].yerr - 0.57735) < 0.001)
  assert.ok(Math.abs(groups.series[1].yerr - 0.57735) < 0.001)
  // CI：n=3 → t=4.303，margin=4.303*0.577≈2.485 → a 组 [-0.485, 4.485]
  assert.ok(Math.abs(groups.series[0].ciLow - -0.485) < 0.01, `ciLow=${groups.series[0].ciLow}`)
})

test('summarizeGroups 无类别列/取值过少时返回 null', () => {
  const ing = ingest('x,y\n1,2\n2,3\n')
  assert.equal(summarizeGroups(ing.profile, ing.text, ing.rawDelimiter), null)
  const single = ingest('g,v\na,1\na,2\na,3\n')
  assert.equal(summarizeGroups(single.profile, single.text, single.rawDelimiter), null)
})

test('runDeterministicAnalysis 长表分组产出 ev_group_stats/ev_anova/ev_ttest_group 与 summary.groups', () => {
  const csv = 'group,value\na,1\na,2\na,3\nb,4\nb,5\nb,6\n'
  const ing = ingest(csv)
  const analysis = runDeterministicAnalysis({ profile: ing.profile, text: ing.text, rawDelimiter: ing.rawDelimiter, fileName: 'g.csv' })
  assert.ok(analysis.summary.groups, 'summary.groups 应存在')
  assert.equal(analysis.summary.groups.groupCol, 'group')
  assert.ok(analysis.evidence.some((e) => e.evidence_id === 'ev_group_stats'))
  const anova = analysis.evidence.find((e) => e.evidence_id === 'ev_anova')
  assert.ok(anova && anova.details.performed)
  assert.equal(anova.details.significant, true)
  assert.ok(analysis.evidence.some((e) => e.tool === 'stats.t_test' && e.evidence_id.startsWith('ev_ttest_group_')))
  assert.ok(analysis.claims.some((c) => c.claimId === 'claim_anova'))
  assert.ok(analysis.claims.some((c) => c.claimId.startsWith('claim_ttest_group_')))
})

test('runDeterministicAnalysis 宽表多系列产出 ev_ttest_series 两两检验（独立近似标注）', () => {
  const csv = 'x,a,b\n1,1,5\n2,2,6\n3,3,7\n'
  const ing = ingest(csv)
  const analysis = runDeterministicAnalysis({ profile: ing.profile, text: ing.text, rawDelimiter: ing.rawDelimiter, fileName: 'w.csv' })
  const t = analysis.evidence.find((e) => e.evidence_id.startsWith('ev_ttest_series_'))
  assert.ok(t, '宽表应产出系列两两 t 检验证据')
  assert.ok(t.details.performed)
  assert.match(t.note, /宽表|独立样本|重复测量/)
})

// ---------- v0.4.2：配对 t 检验 / 异常值检测 / 数据概览 ----------
test('pairedTTest 差值均值/sd/df/p（手算对照：a=[1,3,5], b=[2,4,6] → diff=[-1,-1,-1] 方差为 0 → 非结果）', () => {
  const r = pairedTTest([1, 3, 5], [2, 4, 6])
  assert.equal(r.performed, false)
  assert.match(r.reason, /方差为 0/)
})

test('pairedTTest 常规配对：diff=[1,2,3] → mean=2, sd=1, t=3.464, df=2, p=0.0739', () => {
  const r = pairedTTest([2, 3, 4], [1, 1, 1])
  assert.equal(r.performed, true)
  assert.equal(r.n, 3)
  assert.ok(Math.abs(r.meanDiff - 2) < 1e-6, `meanDiff=${r.meanDiff}`)
  assert.ok(Math.abs(r.statistic - 3.464) < 0.01, `t=${r.statistic}`)
  assert.equal(r.df, 2)
  assert.ok(Math.abs(r.pValue - 0.0739) < 0.001, `p=${r.pValue}`)
  assert.ok(Math.abs(r.dz - 2) < 1e-6, `dz=${r.dz}`)
  assert.equal(r.significant, false)
})

test('pairedTTest 只按完整配对计算（缺行跳过）', () => {
  const r = pairedTTest([1, 2, Number.NaN, 4], [2, 2, 2, 4])
  assert.equal(r.n, 3)
  // 配对 (1,2),(2,2),(4,4) → diff=[-1,0,0] → mean=-1/3（round 6 位 → -0.333333）
  assert.ok(Math.abs(r.meanDiff - (-1 / 3)) < 1e-4, `meanDiff=${r.meanDiff}`)
})

test('detectOutliers IQR/3σ 计数与区间（含常数列不崩溃）', () => {
  const r = detectOutliers([1, 2, 3, 4, 50])
  // Q1=1.75, Q3=3.25, IQR=1.5 → 上限 5.5，50 超限
  assert.equal(r.iqr.count, 1)
  // 3σ 正例：19 个 1 + 100 → mean≈5.95, sd≈21.9, 3σ≈65.7，100 超限
  const sigma = detectOutliers([1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1, 100])
  assert.equal(sigma.sigma3.count, 1)
  const flat = detectOutliers([5, 5, 5, 5])
  assert.equal(flat.iqr.count, 0)
  assert.equal(flat.sigma3.count, 0)
  const tiny = detectOutliers([1, 2])
  assert.equal(tiny.iqr.count, 0)
})

test('buildDataOverview 行/列/类型/缺失率/预览/异常值（数据包不变）', () => {
  const csv = 'group,value\nctrl,1\nctrl,2\nctrl,3\ntreat,100\n'
  const ing = ingest(csv)
  const overview = buildDataOverview(ing.text, ing.rawDelimiter, ing.profile)
  assert.equal(overview.rows, 4)
  assert.equal(overview.cols, 2)
  const numeric = overview.columns.find((c) => c.name === 'value')
  assert.equal(numeric.type, 'numeric')
  assert.equal(numeric.min, 1)
  assert.equal(numeric.max, 100)
  const cat = overview.columns.find((c) => c.name === 'group')
  assert.equal(cat.type, 'categorical')
  assert.equal(cat.unique, 2)
  assert.deepEqual(overview.preview[0], ['ctrl', '1'])
  // 100 相对 1/2/3 是 IQR 异常点
  const outlier = overview.outliers.find((o) => o.column === 'value')
  assert.ok(outlier && outlier.iqr.count >= 1)
  // 原始数据未被改写：文本保持一致
  assert.match(ing.text, /100/)
})

test('runDeterministicAnalysis 宽表恰好两系列产出 ev_ttest_paired 配对证据', () => {
  const csv = 'x,before,after\n1,10,12\n2,12,15\n3,11,14\n4,13,16\n'
  const ing = ingest(csv)
  const analysis = runDeterministicAnalysis({ profile: ing.profile, text: ing.text, rawDelimiter: ing.rawDelimiter, fileName: 'p.csv' })
  const paired = analysis.evidence.find((e) => e.evidence_id === 'ev_ttest_paired')
  assert.ok(paired, '宽表两系列应产出配对 t 检验证据')
  assert.ok(paired.details.performed)
  assert.match(paired.value, /meanDiff=/)
  assert.equal(paired.details.n, 4)
})
