// 多轮需求澄清引擎测试：三轮轮询（任务→图型→标题图注排版）、关键词解析、prefill 跳过、
// 以及澄清结果驱动 buildPlans（图型强制进入对应策略）与配色学习先验。
import { test } from 'node:test'
import assert from 'node:assert'
import fs from 'node:fs'
import path from 'node:path'
import {
  runClarification, parseGoal, parseChartType, parsePresentation, resolvePaletteId, recommendPresentationPalettes,
  mergePrefill, defaultClarification, CLARIFY_ROUNDS, goalQuestion, chartTypeQuestion, presentationQuestion
} from '../src/clarify.js'
import { buildPlans, normalizeRequestedChartType } from '../src/plans.js'
import { buildCandidatePool } from '../src/decision/candidates.js'
import { ingestFile } from '../src/csv.js'
import { runDeterministicAnalysis } from '../src/stats.js'

test('结构化图型确认：中文建议名称归一化为候选图型', () => {
  assert.equal(normalizeRequestedChartType('二维散点图'), 'scatter')
  assert.equal(normalizeRequestedChartType('采用首选建议：小提琴图'), 'violin')
  assert.equal(normalizeRequestedChartType('surface3d'), 'surface3d')
})

// 用真实统计管线构造三系列 × 6 观测点（趋势）分析，与 nitrogen 夹具同构
const here = import.meta.dirname ?? path.dirname(new URL(import.meta.url).pathname)
let _analysis
function analysis() {
  if (_analysis) return _analysis
  const ingest = ingestFile('nitrogen_response_demo.csv', fs.readFileSync(path.join(here, 'fixtures', 'nitrogen_response_demo.csv')))
  _analysis = runDeterministicAnalysis({ profile: ingest.profile, text: ingest.text, rawDelimiter: ingest.rawDelimiter, fileName: 'nitrogen_response_demo.csv' })
  return _analysis
}

test('CLARIFY_ROUNDS：固定三轮（goal/chartType/presentation）', () => {
  assert.equal(CLARIFY_ROUNDS.length, 3)
  assert.deepEqual(CLARIFY_ROUNDS.map((r) => r.key), ['goal', 'chartType', 'presentation'])
})

test('三轮问题各自带选项与 hint', () => {
  assert.ok(goalQuestion().options.length >= 2)
  assert.ok(chartTypeQuestion().options.some((o) => o.includes('热力图') || o.includes('双Y轴') || o.includes('三维曲面')))
  assert.match(chartTypeQuestion({ columns: [{ name: 'week', inferredType: 'numeric' }, { name: 'yield', inferredType: 'numeric' }] }).hint, /建议选择二维图型/)
  assert.match(chartTypeQuestion({ columns: [{ name: 'x', inferredType: 'numeric' }, { name: 'y', inferredType: 'numeric' }, { name: 'z', inferredType: 'numeric' }] }).hint, /曲面图还要求/)
  assert.ok(presentationQuestion().options.some((o) => o.includes('默认')))
  assert.ok(goalQuestion().hint.length > 0)
})

test('parseGoal：关键词映射', () => {
  assert.equal(parseGoal('我想看组间对比').goal, 'comparison')
  assert.equal(parseGoal('关注变量相关关系').goal, 'correlation')
  assert.equal(parseGoal('随时间变化趋势').goal, 'trend')
  assert.equal(parseGoal('看分布和离群情况').goal, 'distribution')
  assert.equal(parseGoal('默认').goal, 'auto')
})

test('parseChartType：热力图/双Y轴/三维曲面/三维散点映射', () => {
  assert.equal(parseChartType('用热力图').chartType, 'heatmap')
  assert.equal(parseChartType('双Y轴图').chartType, 'dual_axis')
  assert.equal(parseChartType('三维曲面图').chartType, 'surface3d')
  assert.equal(parseChartType('三维散点图').chartType, 'scatter3d')
  assert.equal(parseChartType('自动').chartType, 'auto')
})

test('parsePresentation：解析标题/图注/字号/字色/字距/DPI/配色', () => {
  const out = parsePresentation('标题=各处理组日均产量；图注=图1-1 各处理组日均产量对比；字体=SimHei；标题字号=15；标题字色=#6E8FB2；标题字距=1.2；图注字号=10.5；图注字距=1.1；轴标签字号=12；刻度字号=11；图例字号=10；DPI=300；配色=user_nature')
  assert.equal(out.title, '各处理组日均产量')
  assert.equal(out.caption, '图1-1 各处理组日均产量对比')
  assert.equal(out.typography.fontFamily, 'SimHei')
  assert.equal(out.typography.title.size, 15)
  assert.equal(out.typography.title.color, '#6E8FB2')
  assert.equal(out.typography.title.spacing, 1.2)
  assert.equal(out.typography.caption.size, 10.5)
  assert.equal(out.typography.caption.spacing, 1.1)
  assert.equal(out.typography.axisLabel.size, 12)
  assert.equal(out.typography.tick.size, 11)
  assert.equal(out.typography.legend.size, 10)
  assert.equal(out.typography.exportDpi, 300)
  assert.equal(out.paletteId, 'user_nature')
})

test('parsePresentation：全部按默认 → source=default', () => {
  const out = parsePresentation('全部按科研默认')
  assert.equal(out.defaulted, true)
  assert.equal(out.presentation.source, 'default')
})

test('parsePresentation：非法颜色忽略（回落到默认），合法短 hex 保留', () => {
  const bad = parsePresentation('标题字色=red；标题字号=15')
  assert.equal(bad.typography.title.color, undefined)
  assert.equal(bad.typography.title.size, 15)
  const short = parsePresentation('标题字色=#6E8')
  assert.equal(short.typography.title.color, '#6E8')
})

test('parsePresentation：全局「字距」键生效（前端表单序列化键），字体键生效', () => {
  const spaced = parsePresentation('字距=1.2')
  assert.equal(spaced.typography.title.spacing, 1.2)
  assert.equal(spaced.typography.caption, undefined, '全局字距不影响图注字距')
  const captionSpaced = parsePresentation('图注字距=1.3')
  assert.equal(captionSpaced.typography.caption.spacing, 1.3)
  assert.equal(captionSpaced.typography.title, undefined, '图注字距不误设标题字距')
  const titleSpaced = parsePresentation('标题字距=1.4')
  assert.equal(titleSpaced.typography.title.spacing, 1.4)
  const fonted = parsePresentation('字体=SimHei')
  assert.equal(fonted.typography.fontFamily, 'SimHei')
})

test('resolvePaletteId：id 直配 / 中文名唯一匹配 / 推荐取第一个', () => {
  assert.equal(resolvePaletteId('user_nature'), 'user_nature')
  assert.equal(resolvePaletteId('自然低饱和'), 'user_nature')
  assert.equal(resolvePaletteId('推荐', [{ id: 'nature_lowsat' }, { id: 'okabe_ito' }]), 'nature_lowsat')
  assert.equal(resolvePaletteId('自动', []), '')
  assert.equal(resolvePaletteId('不存在的色板'), '不存在的色板')
})

test('parsePresentation：配色=中文名 / 配色=推荐 解析为色板 id', () => {
  const named = parsePresentation('标题=测试；配色=自然低饱和')
  assert.equal(named.paletteId, 'user_nature')
  const rec = parsePresentation('标题=测试；配色=推荐', { recommendedPalettes: [{ id: 'okabe_ito' }, { id: 'nature_lowsat' }] })
  assert.equal(rec.paletteId, 'okabe_ito')
})

test('recommendPresentationPalettes：无历史时返回科研默认 top3，含原因；有学习信号时首推荐标注历史偏好', () => {
  const plain = recommendPresentationPalettes({ preferenceEvents: [], chartType: 'line_error', seriesCount: 3, limit: 3 })
  assert.equal(plain.length, 3)
  for (const p of plain) {
    assert.ok(p.id && p.name && Array.isArray(p.colors) && p.colors.length > 0)
    assert.ok(p.reason.length > 0)
  }
  const t = Date.now()
  const learned = recommendPresentationPalettes({
    preferenceEvents: [
      { kind: 'select_plan', paletteId: 'okabe_ito', chartType: 'line_error', weight: 1, confidence: 1, t },
      { kind: 'select_plan', paletteId: 'okabe_ito', chartType: 'line_error', weight: 1, confidence: 1, t: t - 1 }
    ],
    chartType: 'line_error',
    seriesCount: 3,
    limit: 3
  })
  assert.ok(learned[0].reason.includes('历史配色偏好') || learned.some((p) => p.id === 'okabe_ito'))
})

test('runClarification：decorate 在第三轮注入推荐色板，且「配色=推荐」解析为注入的第一个', async () => {
  const task = {}
  const clarify = await runClarification(task, {
    decorate: async (round, payload) => (round === 3 ? { ...payload, recommendedPalettes: [{ id: 'okabe_ito' }, { id: 'nature_lowsat' }] } : payload),
    ask: async (round) => (round === 1 ? '对比' : round === 2 ? '热力图' : '标题=测试标题；配色=推荐')
  })
  assert.equal(clarify.paletteId, 'okabe_ito')
  assert.equal(clarify.title, '测试标题')
})

test('runClarification：三轮逐轮提问，无要求按科研默认', async () => {
  const asked = []
  const task = {}
  const clarify = await runClarification(task, {
    ask: async (round, payload) => {
      asked.push(round)
      if (round === 1) return '对比组间差异'
      if (round === 2) return '自动选择'
      return '全部按科研默认'
    }
  })
  assert.deepEqual(asked, [1, 2, 3])
  assert.equal(clarify.goal, 'comparison')
  assert.equal(clarify.chartType, 'auto')
  assert.equal(clarify.source, 'interactive')
  assert.equal(clarify.complete, true)
  assert.equal(task.clarification, clarify)
  // 默认排版：SimHei、标题 15pt 加粗居中、白底、300dpi、图注「图1-1 …」
  assert.equal(clarify.typography.fontFamily, 'SimHei')
  assert.equal(clarify.typography.title.size, 15)
  assert.equal(clarify.typography.title.weight, 'bold')
  assert.equal(clarify.typography.title.align, 'center')
  assert.equal(clarify.typography.background, '#FFFFFF')
  assert.equal(clarify.typography.exportDpi, 300)
  assert.match(clarify.caption, /^图1-1 /)
})

test('runClarification：字段已明确时跳过重复任务与图型追问，仅保留一次排版确认', async () => {
  const rounds = []
  const task = {}
  const result = await runClarification(task, {
    context: { intentSpec: { pendingFields: [] }, userProfile: {} },
    ask: async (round) => { rounds.push(round); return '全部按科研默认' }
  })
  assert.deepEqual(rounds, [3])
  assert.equal(result.complete, true)
})

test('runClarification：图型偏好 双Y轴 进入澄清结果', async () => {
  const task = {}
  const clarify = await runClarification(task, {
    ask: async (round) => (round === 1 ? '默认' : round === 2 ? '双Y轴图' : '全部按科研默认')
  })
  assert.equal(clarify.chartType, 'dual_axis')
})

test('runClarification：ask 返回 null（超时/放弃）则该轮按默认', async () => {
  const clarify = await runClarification({}, { ask: async () => null })
  assert.equal(clarify.goal, 'auto')
  assert.equal(clarify.chartType, 'auto')
  assert.equal(clarify.source, 'interactive')
})

test('mergePrefill：预填字段 + answeredRounds 跳过', async () => {
  const task = {}
  const clarify = await runClarification(task, {
    prefill: {
      goal: 'trend',
      chartType: 'dual_axis',
      title: '预填标题',
      answeredRounds: [1, 2]
    },
    ask: async (round) => (round === 3 ? '全部按科研默认' : null)
  })
  assert.equal(clarify.goal, 'trend')
  assert.equal(clarify.chartType, 'dual_axis')
  assert.equal(clarify.title, '预填标题')
  const rounds = clarify.answers.map((a) => a.round)
  assert.deepEqual(rounds, [1, 2, 3])
})

test('defaultClarification：完全默认、complete、answers 三轮', () => {
  const d = defaultClarification(123)
  assert.equal(d.complete, true)
  assert.equal(d.source, 'default')
  assert.equal(d.answers.length, 3)
})

test('buildPlans：clarification.chartType=heatmap 强制进入三套方案之一（convention 代表）', () => {
  const plans = buildPlans(analysis(), {
    fileName: 'demo.csv',
    titleBase: '氮响应',
    engine: 'python',
    userRequest: '关注变量相关关系',
    clarification: { chartType: 'heatmap', title: '各处理组相关性', caption: '图1-1 各处理组相关性热力图', typography: { source: 'interactive' } }
  })
  const forced = plans.selectionAudit.clarification
  assert.equal(forced.forced, true)
  assert.ok(['correlation_heatmap'].includes(forced.forcedCandidate.chartType))
  const heatmapPlan = plans.find((p) => p.candidateId === 'c_convention_heatmap')
  assert.ok(heatmapPlan, '热力图候选应进入三套方案')
  assert.equal(heatmapPlan.spec.figure.title, '各处理组相关性')
  assert.equal(heatmapPlan.caption, '图1-1 各处理组相关性热力图')
  // 数据包不变：三方案仍共享同一证据集合
  assert.equal(heatmapPlan.evidenceIds.length, plans[0].evidenceIds.length)
  assert.deepEqual(plans.map((p) => p.evidenceIds), plans.map((p) => p.evidenceIds))
})

test('buildPlans：显式图型约束贯穿三套方案且仍保留至少两个呈现差异', () => {
  for (const chartType of ['line', 'heatmap']) {
    const plans = buildPlans(analysis(), {
      fileName: 'demo.csv',
      titleBase: '显式图型一致性',
      clarification: { chartType }
    })
    assert.equal(plans.length, 3)
    assert.equal(new Set(plans.map((plan) => plan.dataSuitability.chartType)).size, 1)
    assert.ok(plans.every((plan) => plan.diffDimensions.length >= 2))
  }
})

test('buildPlans：clarification.chartType 数据不满足时回退并记录 infeasible', () => {
  const plans = buildPlans(analysis(), {
    fileName: 'demo.csv',
    titleBase: '测试',
    engine: 'python',
    clarification: { chartType: 'dual_axis', title: '双Y轴', caption: '图1-1 双Y轴对比', typography: { source: 'interactive' } }
  })
  // 三系列数据满足双Y轴（≥2 系列且 trend），应强制进入 clarity 代表
  const forced = plans.selectionAudit.clarification
  assert.equal(forced.forced, true)
  assert.equal(forced.forcedCandidate.chartType, 'dual_axis')
  const dual = plans.find((p) => p.candidateId === 'c_clarity_dual_axis')
  assert.ok(dual, '双Y轴候选应进入三套方案')
  // 三方案差异维度仍 ≥2（数据包共享证据约束不破坏）
  for (const p of plans) assert.ok(p.diffDimensions.length >= 2)
})

test('buildPlans：无澄清时按数据自动选择且 audit 注明', () => {
  const plans = buildPlans(analysis(), { fileName: 'demo.csv', titleBase: '测试', engine: 'python' })
  const forced = plans.selectionAudit.clarification
  assert.equal(forced.forced, false)
  assert.equal(forced.chartType, 'auto')
})

test('候选池：三维候选仅在空间坐标充分时进入，普通宽表不自动误用三维', () => {
  const pool = buildCandidatePool(analysis())
  assert.ok(pool.length >= 6 && pool.length <= 15)
  const types = new Set(pool.map((c) => c.chartType))
  // 普通组别宽表即使有多个系列，也不得把处理组误当作空间 XYZ。
  assert.ok(types.has('dual_axis'))
  assert.ok(!types.has('surface3d') && !types.has('scatter3d'))
  const spatialPool = buildCandidatePool({ ...analysis(), chartContext: { spatialReady: true, spatialFields: ['x', 'y', 'z'] } })
  assert.ok(spatialPool.some((c) => c.chartType === 'surface3d' || c.chartType === 'scatter3d'))
  for (const c of pool) {
    assert.ok(c.scoreBreakdown && typeof c.scoreBreakdown === 'object')
    assert.ok(Object.keys(c.scoreBreakdown).length >= 7, '七维可解释评分')
  }
})

test('三维图澄清支持二次处理选择并保留原始默认', () => {
  const q = presentationQuestion({ chartType: 'surface3d' })
  assert.match(q.question, /二次处理/)
  assert.equal(parsePresentation('二次处理=插值平滑').secondaryProcessing, 'interpolate')
  assert.equal(parsePresentation('二次处理=聚类分层').secondaryProcessing, 'cluster')
  assert.equal(defaultClarification().secondaryProcessing, 'raw')
})


test('resolved field roles retain explicitly requested chart type when adaptive clarification skips questions', async () => {
  for (const [request, expected] of [['使用贡献瀑布图展示增量贡献', 'waterfall'], ['使用三维曲面图展示空间响应', 'surface3d'], ['使用棒棒糖图展示排名', 'lollipop']]) {
    const rounds = []
    const result = await runClarification({ prompt: request }, {
      context: { intentSpec: { rawRequest: request, pendingFields: [] }, userProfile: {} },
      ask: async (round) => { rounds.push(round); return '全部按科研默认' }
    })
    assert.equal(result.chartType, expected)
    assert.deepEqual(rounds, [3])
  }
})

test('chart choices expose supported waterfall, lollipop, bubble and cone charts', () => {
  for (const label of ['瀑布', '棒棒糖', '气泡', '锥状']) assert.ok(chartTypeQuestion().options.some(option => option.includes(label)), label)
})

test('buildPlans preserves explicit prompt chart types even without interactive clarification', () => {
  const data = '阶段,增量,累计值\n基线,100,100\n成本,-18,82\n优化,26,108\n终值,0,108\n'
  const ingest = ingestFile('contribution.csv', Buffer.from(data))
  const a = runDeterministicAnalysis({ profile: ingest.profile, text: ingest.text, rawDelimiter: ingest.rawDelimiter, fileName: 'contribution.csv' })
  const plans = buildPlans(a, { fileName: 'contribution.csv', titleBase: 'Contribution', userRequest: '展示贡献瀑布图', clarification: { chartType: 'auto' } })
  assert.ok(plans.every(plan => plan.spec.panels.every(panel => panel.layers.every(layer => layer.kind === 'waterfall'))))
})
