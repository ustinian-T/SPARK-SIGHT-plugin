import test from 'node:test'
import assert from 'node:assert/strict'
import { ingestFile } from '../src/csv.js'
import { runDeterministicAnalysis } from '../src/stats.js'
import { buildPlans } from '../src/plans.js'
import { generateCodeForSpec } from '../src/codegen.js'

const ingest = (csv, name = 'semi.csv') => ingestFile(name, Buffer.from(csv, 'utf8'))
const plansFor = (csv) => {
  const ing = ingest(csv)
  const analysis = runDeterministicAnalysis({ profile: ing.profile, text: ing.text, rawDelimiter: ing.rawDelimiter, fileName: 'd.csv' })
  return buildPlans(analysis, { fileName: 'd.csv', titleBase: '三组比较', userRequest: '', clarification: null, preferenceEvents: [], executed: false })
}

test('长表分组：plan.spec 注入 groups/errorBarMode/significance，interpretation 携带证据引用', () => {
  // a/b 组差异巨大 → ANOVA 与两两检验显著；c 与 a 接近
  const csv = 'group,value\na,1\na,2\na,3\nb,9\nb,10\nb,11\nc,1\nc,2\nc,3\n'
  const plans = plansFor(csv)
  assert.equal(plans.length, 3)
  const groupedPlan = plans.find((plan) => plan.strategy === 'clarity')
  const rawRowPlan = plans.find((plan) => plan.strategy === 'density')
  assert.equal(groupedPlan.dataProcessingTrace.series[0].aggregation, 'group_mean')
  assert.equal(groupedPlan.dataProcessingTrace.operations.find((item) => item.id === 'plot_group_mean').scope, 'chart')
  assert.equal(rawRowPlan.dataProcessingTrace.series[0].aggregation, 'none')
  assert.equal(rawRowPlan.dataProcessingTrace.operations.find((item) => item.id === 'group_summary').scope, 'evidence_only')
  for (const plan of plans) {
    assert.ok(plan.interpretation, '每个方案都应携带 interpretation')
    assert.ok(Array.isArray(plan.interpretation.insights))
    assert.ok(plan.interpretation.analysisParagraph.length > 0)
    // v0.4.2：分组语义可注入的图型（柱/折线/箱线+抖动/小提琴/误差棒点图）；密度复合方案退化为序列图不注入
    if (plan.strategy !== 'density') {
      for (const panel of plan.spec.panels) {
        const kind = panel.layers?.[0]?.kind
        if (kind === 'bar' || kind === 'line' || kind === 'box_jitter' || kind === 'violin' || kind === 'dotplot') {
          assert.ok(panel.groups, `${kind} 面板应注入 groups`)
          assert.equal(panel.groups.groupCol, 'group')
          assert.equal(panel.errorBarMode, 'se')
          if (kind === 'line') assert.equal(panel.confidenceBand, true)
        }
      }
    }
    // 应存在显著配对（a vs b、b vs c）；密度复合方案（无分组注入）不承载显著性标注
    if (plan.strategy !== 'density') {
      const sig = plan.spec.panels.flatMap((p) => p.significance ?? [])
      assert.ok(sig.some((s) => s.left === 'a' && s.right === 'b'), 'a-b 应显著')
      assert.ok(sig.some((s) => s.left === 'b' && s.right === 'c'), 'b-c 应显著')
      for (const s of sig) {
        assert.ok(['*', '**', '***'].includes(s.stars), `星号 ${s.stars} 非法`)
      }
    }
  }
})

test('长表分组：生成的 Python 代码含分组聚合，按图型含分布/误差棒与显著性标注语法', () => {
  const csv = 'group,value\na,1\na,2\na,3\nb,9\nb,10\nb,11\nc,1\nc,2\nc,3\n'
  const plans = plansFor(csv)
  const spec = plans[0].spec
  const input = { fileName: 'd.csv', x: 'group', measures: ['value'], title: '三组比较', yLabel: 'value', outputBase: 'plan_clarity', dpi: 160, fontFamily: 'SimHei', minFontSize: 10, colors: ['#0173B2', '#DE8F05', '#029E73'] }
  const python = generateCodeForSpec(spec, input).python
  // 剔除 base64 元数据行后校验代码正文
  const body = python.split('\n').filter((line) => !line.includes('@deep-imaging-spec:')).join('\n')
  assert.match(body, /groupby\("group", sort=False\)\["value"\]\.agg\(mean=/, '应分组聚合 mean/std/sem')
  const kind = spec.panels[0].layers[0].kind
  if (kind === 'box_jitter') {
    assert.match(body, /boxplot\(_gparts/, '箱线+抖动应有 boxplot')
    assert.match(body, /scatter\(np\.full/, '箱线+抖动应叠加抖动散点')
  } else if (kind === 'violin') {
    assert.match(body, /violinplot\(_vparts/, '小提琴应有 violinplot')
  } else {
    assert.match(body, /grouped\["mean"\]|grouped\["sem"\]/, '误差棒点图/柱/线应引用组均值与标准误')
    assert.match(body, /yerr=grouped\["sem"\]/, '默认误差棒为标准误')
  }
  assert.match(body, /_s\["stars"\]|annotate|_sig/, '应有显著性标注逻辑')
})

test('长表分组：R/MATLAB 代码含分组语义实现（不引用不存在的 _sd 列）', () => {
  const csv = 'group,value\na,1\na,2\na,3\nb,9\nb,10\nb,11\nc,1\nc,2\nc,3\n'
  const plans = plansFor(csv)
  const spec = plans[0].spec
  const input = { fileName: 'd.csv', x: 'group', measures: ['value'], title: '三组比较', yLabel: 'value', outputBase: 'plan_clarity', dpi: 160, fontFamily: 'SimHei', minFontSize: 10, colors: ['#0173B2'] }
  const code = generateCodeForSpec(spec, input)
  // 剔除 @deep-imaging-spec base64 元数据行（其字符集可能巧合包含 "_sd" 子串），仅校验代码正文
  const body = (engineCode) => engineCode.split('\n').filter((line) => !line.includes('@deep-imaging-spec:')).join('\n')
  const kind = spec.panels[0].layers[0].kind
  if (kind === 'bar' || kind === 'line' || kind === 'dotplot') {
    assert.match(body(code.r), /tapply|summarise|aggregate/, 'R 应分组聚合')
    assert.match(body(code.matlab), /splitapply\(@mean|grp2idx/, 'MATLAB 应分组聚合')
  } else if (kind === 'box_jitter' || kind === 'violin') {
    // 箱线/小提琴：分组形态在 R 用 formula 分面，MATLAB 用 grp2idx 分箱
    assert.match(body(code.r), /boxplot\(|vioplot/, 'R 应含分组箱线/小提琴')
    assert.match(body(code.matlab), /grp2idx|boxplot/, 'MATLAB 应含分组箱线')
  }
  // 分组模式不得引用 <列名>_sd 字符串字面量（g_sd/g_se 是聚合变量名，不算列引用）
  assert.doesNotMatch(body(code.python), /f"[^"]*_sd"|get\(f"[^"]*_sd/, 'Python 不应引用 _sd 列')
  assert.doesNotMatch(body(code.r), /\+ "_sd"|paste0\([^)]*"_sd/, 'R 不应引用 _sd 列')
  assert.doesNotMatch(body(code.matlab), /'_sd'/, 'MATLAB 不应引用 _sd 列')
})

test('宽表（多测量列）：spec 不注入 groups，interpretation 含趋势', () => {
  const csv = 'week,a,b\n1,10,12\n2,20,24\n3,30,36\n4,40,48\n'
  const plans = plansFor(csv)
  for (const plan of plans) {
    for (const panel of plan.spec.panels) {
      assert.equal(panel.groups, undefined, '宽表不应注入 groups')
    }
    const kinds = plan.interpretation.insights.map((i) => i.kind)
    assert.ok(kinds.includes('trend'), '宽表解读应含趋势')
  }
})

test('分组模式下 interpretation 的 comparison 要点引用真实证据（数字不编造）', () => {
  const csv = 'group,value\na,1\na,2\na,3\nb,9\nb,10\nb,11\nc,1\nc,2\nc,3\n'
  const plans = plansFor(csv)
  const plan = plans.find((p) => p.interpretation.insights.some((i) => i.kind === 'comparison'))
  assert.ok(plan, '应有 comparison 要点')
  const cmp = plan.interpretation.insights.find((i) => i.kind === 'comparison')
  assert.match(cmp.text, /显著|不显著/)
  // evidenceId 必须真实存在（plan.evidenceIds）
  assert.ok(plan.evidenceIds.includes(cmp.evidenceId), `要点引用不存在的证据 ${cmp.evidenceId}`)
  assert.match(plan.interpretation.analysisParagraph, /ANOVA|方差分析/)
})

// ---------- v0.4.2：新图型三引擎生成（dotplot / paired / stacked / forest / box_jitter 宽表） ----------
function clarifyPlansFor(csv, chartType, fileName = 'd.csv') {
  const ing = ingest(csv, fileName)
  const analysis = runDeterministicAnalysis({ profile: ing.profile, text: ing.text, rawDelimiter: ing.rawDelimiter, fileName })
  return buildPlans(analysis, { fileName, titleBase: 'T', userRequest: '', executed: false, clarification: { chartType, goal: 'x', title: 'T', answeredRounds: [1, 2, 3] } })
}
const bodyOf = (engineCode) => engineCode.split('\n').filter((line) => !line.includes('@deep-imaging-spec:')).join('\n')
const inputFor = (fileName, x, measures) => ({ fileName, x, measures, title: 'T', yLabel: 'value', outputBase: 'plan_x', dpi: 160, fontFamily: 'SimHei', minFontSize: 10, colors: ['#0173B2', '#DE8F05', '#029E73'] })

test('v0.4.2 dotplot 分组：spec 注入 groups 且三引擎绘制组均值±SE 点', () => {
  const csv = 'group,value\na,1\na,2\na,3\nb,9\nb,10\nb,11\nc,1\nc,2\nc,3\n'
  const plans = clarifyPlansFor(csv, 'dot_plot')
  const plan = plans.find((p) => p.chartType.includes('误差棒点图'))
  assert.ok(plan, 'dot_plot 应能强制进入方案')
  const panel = plan.spec.panels[0]
  assert.equal(panel.layers[0].kind, 'dotplot')
  assert.ok(panel.groups, 'dotplot 分组应注入 groups')
  const code = generateCodeForSpec(plan.spec, inputFor('d.csv', 'group', ['value']))
  assert.match(bodyOf(code.python), /groupby\(.+sem/, 'Python 应分组聚合')
  assert.match(bodyOf(code.python), /errorbar\(range\(len\(grouped\)\), grouped\["mean"\]/, 'Python 应画组均值±SE 点')
  assert.match(bodyOf(code.r), /tapply\(.+mean/, 'R 应分组均值')
  assert.match(bodyOf(code.matlab), /splitapply\(@mean/, 'MATLAB 应分组均值')
})

test('v0.4.2 paired：spec 注入 paired 列与配对 t 注记，三引擎画配对连线', () => {
  const csv = 'x,before,after\n1,10,12\n2,12,15\n3,11,14\n4,13,16\n'
  const plans = clarifyPlansFor(csv, 'paired_dot', 'p.csv')
  const plan = plans.find((p) => p.chartType.includes('配对连线'))
  assert.ok(plan, 'paired_dot 应能强制进入方案')
  const panel = plan.spec.panels[0]
  assert.equal(panel.layers[0].kind, 'paired')
  assert.deepEqual(panel.paired, { left: 'before', right: 'after' })
  assert.ok(panel.pairedNote.includes('p='), '配对 t 检验注记应带 p 值')
  const code = generateCodeForSpec(plan.spec, inputFor('p.csv', 'x', ['before', 'after']))
  assert.match(bodyOf(code.python), /Δmean=/, 'Python 应标注均值差')
  assert.match(bodyOf(code.r), /lines\(c\(1, 2\)/, 'R 应画配对连线')
  assert.match(bodyOf(code.matlab), /plot\(\[ones/, 'MATLAB 应画配对连线')
})

test('v0.4.2 stacked：宽表多系列正值生成堆叠柱代码', () => {
  const csv = 'x,a,b,c\n1,10,20,30\n2,12,22,32\n3,14,24,34\n'
  const plans = clarifyPlansFor(csv, 'stacked_area', 's.csv')
  const plan = plans.find((p) => p.chartType.includes('堆叠柱状'))
  assert.ok(plan, 'stacked_area 应能强制进入方案')
  assert.equal(plan.spec.panels[0].layers[0].kind, 'stacked')
  const code = generateCodeForSpec(plan.spec, inputFor('s.csv', 'x', ['a', 'b', 'c']))
  assert.match(bodyOf(code.python), /bottom=_sbottom/, 'Python 应堆叠 bottom')
  assert.match(bodyOf(code.r), /barplot\(t\(as\.matrix/, 'R 应堆叠柱')
  assert.match(bodyOf(code.matlab), /'stacked'/, 'MATLAB 应堆叠柱')
})

test('v0.4.2 forest：宽表含 _sd 列生成森林图（CI 近似），verify 检查列存在', () => {
  const csv = 'item,effect,effect_sd\nA,1.0,0.2\nB,1.5,0.3\nC,0.8,0.25\n'
  const plans = clarifyPlansFor(csv, 'forest', 'f.csv')
  const plan = plans.find((p) => p.chartType.includes('森林图'))
  assert.ok(plan, 'forest 应能强制进入方案')
  const panel = plan.spec.panels[0]
  assert.equal(panel.layers[0].kind, 'forest')
  assert.equal(panel.forest.mean, 'effect')
  const code = generateCodeForSpec(plan.spec, inputFor('f.csv', 'item', ['effect']))
  assert.match(bodyOf(code.python), /axvline\(0/, 'Python 应画参考线')
  assert.match(bodyOf(code.python), /effect_sd/, 'Python 应引用 effect_sd 做 CI 近似')
  assert.match(bodyOf(code.r), /arrows\(/, 'R 应画 CI 箭头')
  assert.match(bodyOf(code.matlab), /errorbar\(fmv/, 'MATLAB 应画水平误差棒')
})

test('v0.4.2 box_jitter 宽表：多列箱线 + 抖动散点，无 _sd 列引用', () => {
  const csv = 'x,a,b,c\n1,10,20,30\n2,12,22,32\n3,14,24,34\n'
  const plans = clarifyPlansFor(csv, 'box', 's.csv')
  const plan = plans.find((p) => p.chartType.includes('箱线'))
  assert.ok(plan, 'box 应能强制进入方案')
  assert.equal(plan.spec.panels[0].layers[0].kind, 'box_jitter')
  const code = generateCodeForSpec(plan.spec, inputFor('s.csv', 'x', ['a', 'b', 'c']))
  assert.match(bodyOf(code.python), /boxplot\(_bparts/, 'Python 宽表应画多列箱线')
  assert.match(bodyOf(code.python), /scatter\(np\.full/, 'Python 应叠加抖动')
  assert.match(bodyOf(code.r), /stripchart\(as\.list/, 'R 宽表应抖动')
  assert.match(bodyOf(code.matlab), /boxplot\(table2array/, 'MATLAB 宽表应箱线')
  assert.doesNotMatch(bodyOf(code.python), /f"[^"]*_sd/, 'Python 不应引用 _sd')
})


test('ChartSpec typography keeps installed CJK font fallback when SimHei is absent', () => {
  const plans = plansFor('week,a,b\n1,2,3\n2,3,4\n3,4,5\n')
  const plan = plans.find(p => p.strategy === 'clarity')
  const code = generateCodeForSpec(plan.spec, { fileName: 'd.csv', x: 'week', measures: ['a', 'b'], title: '中文标题', yLabel: '测量值' }).python
  assert.ok(code.includes('*plt.rcParams["font.sans-serif"]'))
  assert.ok(code.includes('Noto Sans CJK SC'))
})


test('explicit axis display labels keep the original CSV field binding in all clients', () => {
 const q = ingest('week,a,b\n1,2,3\n2,3,4\n3,4,5\n')
 const a = runDeterministicAnalysis({ profile:q.profile, text:q.text, rawDelimiter:q.rawDelimiter, fileName:'d.csv' })
 const p = buildPlans(a, {fileName:'d.csv', titleBase:'趋势', userRequest:'三条折线，横轴为周次，纵轴为产量，白底', clarification:{chartType:'line'}}).find(p=>p.strategy==='convention')
 assert.ok(p.code.python.includes('x_col = "week"'))
 assert.ok(p.code.python.includes('set_xlabel("周次")'))
 assert.ok(p.code.python.includes('set_ylabel("产量")'))
 assert.ok(p.code.r.includes('labs(x = "周次", y = "产量"'))
 assert.ok(p.code.matlab.includes("xlabel('周次'"))
})

test('grouped Python exports reserve rotated tick labels and x-axis title', () => {
 const p = plansFor('group,value\na,1\na,2\nb,4\nb,5\n').find(plan => plan.strategy === 'clarity')
 assert.match(p.code.python, /subplots_adjust\(top=0\.86, bottom=0\.30/)
 assert.match(p.code.python, /groupby\("group", sort=False\)/)
})
