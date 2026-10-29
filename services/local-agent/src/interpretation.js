// 图表解读文案生成：基于证据账本（证据/结论 claims）生成结构化解读要点与可改写的中文学术分析段落。
// 所有数字均来自证据账本中的真实计算（禁止模型填数）；证据缺失的表述一律不输出，
// 保证"解读可溯源、数字可复核"（与 AGT-002 / CORE-010 一致）。
import { significanceStars } from './stats.js'

const fmt = (n, d = 3) => {
  if (!Number.isFinite(n)) return null
  return String(Math.round(n * 10 ** d) / 10 ** d)
}
const fmtP = (p, d = 6) => Number.isFinite(p) && p < 0.001 ? '<0.001' : fmt(p, d)
const dir = (v) => (v > 0 ? '上升' : v < 0 ? '下降' : '基本持平')

/**
 * 从证据账本生成图表解读。
 * @param {object} ctx { summary, evidence, claims, clarification?, chartType?, strategy?, title, caption }
 * @returns {{
 *   insights: Array<{id:string, kind:'trend'|'comparison'|'correlation'|'distribution'|'quality', title:string, text:string, evidenceId:string}>,
 *   analysisParagraph: string,
 *   captionSuggestion: string
 * }}
 */
export function buildInterpretation(ctx) {
  const { summary, evidence, claims, title, caption, chartType = '' } = ctx
  const byId = new Map((evidence ?? []).map((e) => [e.evidence_id, e]))
  const insights = []
  const insightTable = []
  const paragraph = []
  const grouped = summary?.groups

  // ---------- 1. 趋势（宽表多系列：首末变化 + 末点峰值） ----------
  const matrixLike = !grouped && (summary?.series?.length ?? 0) >= 4 && (summary?.x?.length ?? 0) <= 8
  if (!grouped && summary?.series?.length && !matrixLike) {
    const trendParts = []
    for (const s of summary.series) {
      const ev = byId.get(`ev_trend_${summary.series.indexOf(s)}`)
      if (!ev) continue
      // ev_trend.value 形如 "1 → 3（+200%）"；方向由首末值判断
      const observed = s.y.filter((v) => v !== null)
      const first = observed[0]
      const last = observed[observed.length - 1]
      if (first === undefined || last === undefined || !Number.isFinite(first) || !Number.isFinite(last)) continue
      const change = last - first
      const deltas = observed.slice(1).map((value, index) => value - observed[index])
      const positive = deltas.filter((value) => value > 0).length
      const negative = deltas.filter((value) => value < 0).length
      const shape = positive === deltas.length || negative === deltas.length ? '单调变化' : positive && negative ? '存在阶段性波动' : '变化有限'
      const turningPoints = deltas.slice(1).filter((value, index) => Math.sign(value) !== Math.sign(deltas[index]) && value !== 0 && deltas[index] !== 0).length
      const pct = first !== 0 ? Math.round(((last - first) / first) * 1000) / 10 : null
      const slope = Number.isFinite(ev.details?.slope) ? ev.details.slope : null
      const r2 = Number.isFinite(ev.details?.r2) ? ev.details.r2 : null
      const delta = pct !== null
        ? `${dir(change)} ${Math.abs(change) >= 1e-9 ? `${fmt(Math.abs(change))}（${pct > 0 ? '+' : ''}${fmt(pct)}%）` : '基本不变'}`
        : `${dir(change)} ${fmt(Math.abs(change))}（基线为 0，百分比未定义）`
      insights.push({
        id: `insight_trend_${summary.series.indexOf(s)}`,
        kind: 'trend',
        title: `${s.label} 的变化趋势`,
        text: `「${s.label}」在观测区间内${delta}，呈${shape}${turningPoints ? `，检测到${turningPoints}处方向反转` : ''}，首末值分别为 ${fmt(first)} 与 ${fmt(last)}${slope !== null && r2 !== null ? `；线性拟合斜率=${fmt(slope)}、R²=${fmt(r2)}（按观测序号）` : ''}`,
        evidenceId: ev.evidence_id
      })
      insightTable.push({ metric: `${s.label}变化`, result: `${delta}${slope !== null && r2 !== null ? `；斜率=${fmt(slope)}，R²=${fmt(r2)}` : ''}`, criterion: '描述性判断：相对变化幅度≥20%可视为明显变化；R²仅表示线性拟合程度，不代表因果或显著性。', evidenceId: ev.evidence_id })
      if (trendParts.length < 3) trendParts.push(`「${s.label}」${delta}（${fmt(first)} → ${fmt(last)}${pct !== null ? `，${pct > 0 ? '+' : ''}${fmt(pct)}%` : ''}）`)
    }
    const peakEv = byId.get('ev_peak')
    if (peakEv) {
      insights.push({
        id: 'insight_peak',
        kind: 'trend',
        title: '末点最高的系列',
        text: `同一末观测点上取值最高的是${peakEv.value.replace(/（[^）]*）$/, '')}`,
        evidenceId: 'ev_peak'
      })
      insightTable.push({ metric: '末点最高系列', result: peakEv.value.replace(/（[^）]*）$/, ''), criterion: '比较同一观测点的中心趋势；不代表统计显著或因果优势。', evidenceId: 'ev_peak' })
      trendParts.push(`末点最高为 ${peakEv.value.replace(/（[^）]*）$/, '')}`)
    }
    if (trendParts.length) paragraph.push(`变化趋势显示，${trendParts.join('；')}。`)
  }

  if (matrixLike) {
    const finitePairs = (evidence ?? []).filter((e) => e.tool === 'stats.correlation' && e.details?.r !== null)
    if (finitePairs.length) {
      const strongest = [...finitePairs].sort((a, b) => Math.abs(b.details.r) - Math.abs(a.details.r))[0]
      insights.push({ id: 'insight_matrix', kind: 'correlation', title: '相关矩阵结构', text: `该数据呈矩阵型多变量结构；最强线性相关为 ${strongest.fields[0]} 与 ${strongest.fields[1]}（r=${fmt(strongest.details.r, 4)}，n=${strongest.details.n}）。`, evidenceId: strongest.evidence_id })
      paragraph.push(`相关矩阵显示，多变量之间的线性关联应结合相关系数大小与方向解读；不将矩阵行列顺序解释为时间趋势。`)
    } else {
      insights.push({ id: 'insight_matrix_quality', kind: 'quality', title: '矩阵型数据', text: '检测到矩阵型数据，但有效成对相关观测不足，未生成趋势性解读。', evidenceId: 'ev_n' })
    }
  }

  // ---------- 2. 组间比较（ANOVA + 两两 t 检验，Holm 校正） ----------
  const anovaEv = byId.get('ev_anova')
  if (anovaEv?.details?.performed) {
    const a = anovaEv.details
    const stars = significanceStars(a.pValue)
    insights.push({
      id: 'insight_anova',
      kind: 'comparison',
      title: '组间整体差异检验',
      text: `单因素方差分析显示组间差异${a.significant ? `显著（F=${fmt(a.statistic)}，p=${fmtP(a.pValue)}，η²=${fmt(a.etaSq)}${stars ? `，${stars}` : ''}）` : `不显著（F=${fmt(a.statistic)}，p=${fmtP(a.pValue)}）`}`,
      evidenceId: 'ev_anova'
    })
    insightTable.push({ metric: '整体组间差异', result: a.significant ? `显著（p=${fmtP(a.pValue)}）` : `不显著（p=${fmtP(a.pValue)}）`, criterion: '通常以 p<0.05 判为统计学显著，同时报告效应量与置信区间。', evidenceId: 'ev_anova' })
    if (a.significant) paragraph.push(`单因素方差分析表明${grouped?.groupCol ?? '组间'}整体差异显著（F=${fmt(a.statistic)}，p=${fmtP(a.pValue)}，η²=${fmt(a.etaSq)}）。`)
  }
  const tTests = (evidence ?? []).filter((e) => e.tool === 'stats.t_test' && e.details?.performed)
  const significantPairs = tTests.filter((e) => (e.details?.pAdjusted ?? 1) < 0.05)
  if (significantPairs.length) {
    const pairTexts = significantPairs.slice(0, 3).map((e) => {
      const d = e.details
      return `${d.left} 与 ${d.right}（p_adj=${fmtP(d.pAdjusted)}${d.stars && d.stars !== 'ns' ? `，${d.stars}` : ''}）`
    })
    insights.push({
      id: 'insight_pairs',
      kind: 'comparison',
      title: '两两比较中显著的配对',
      text: `经 Holm 校正后差异显著的配对：${pairTexts.join('；')}${significantPairs.length > 3 ? `；等共 ${significantPairs.length} 对` : ''}`,
      evidenceId: significantPairs[0].evidence_id
    })
    for (const e of significantPairs.slice(0, 5)) {
      const d = e.details
      insightTable.push({ metric: `${d.left} vs ${d.right}`, result: `p_adj=${fmtP(d.pAdjusted)}`, criterion: 'Holm校正后 p_adj<0.05 通常判为显著；应结合效应量与样本量解释。', evidenceId: e.evidence_id })
    }
    paragraph.push(`经 Welch t 检验并进行 Holm 校正，显著配对为：${pairTexts.join('；')}。`)
  } else if (anovaEv?.details?.performed) {
    paragraph.push('两两比较未发现校正后仍显著的配对。')
  }

  // ---------- 3. 相关（Pearson r + p） ----------
  const corrSignifs = (evidence ?? []).filter((e) => e.tool === 'stats.significance' && e.details?.performed)
  for (const e of corrSignifs) {
    const d = e.details
    const r = d.r
    if (!Number.isFinite(r)) continue
    const strength = Math.abs(r) >= 0.8 ? '强' : Math.abs(r) >= 0.5 ? '中等' : Math.abs(r) >= 0.3 ? '弱' : '极弱'
    insights.push({
      id: `insight_corr_${e.evidence_id.replace('ev_significance_', '')}`,
      kind: 'correlation',
      title: `${e.fields[0]} 与 ${e.fields[1]} 的相关性`,
      text: `${e.fields[0]} 与 ${e.fields[1]} 呈${r > 0 ? '正' : '负'}相关（r=${fmt(r, 4)}，n=${d.n}，p=${fmtP(d.pValue)}${d.significant ? '，显著' : '，未达显著'}），相关强度${strength}`,
      evidenceId: e.evidence_id
    })
    insightTable.push({ metric: `${e.fields[0]}–${e.fields[1]}相关`, result: `r=${fmt(r, 4)}（${strength}）`, criterion: '|r|≥0.8强，0.5–0.8中等，<0.5较弱；相关不等于因果。', evidenceId: e.evidence_id })
  }
  const sigCorr = corrSignifs.filter((e) => e.details?.significant).slice(0, 2)
  if (sigCorr.length) {
    paragraph.push(sigCorr.map((e) => {
      const d = e.details
      return `${e.fields[0]} 与 ${e.fields[1]} 显著${d.r > 0 ? '正' : '负'}相关（r=${fmt(d.r, 4)}，p=${fmtP(d.pValue)}）`
    }).join('；') + '。')
  }

  // ---------- 4. 分布 / 分组描述 ----------
  const groupEv = byId.get('ev_group_stats')
  if (groupEv) {
    insights.push({
      id: 'insight_group_dist',
      kind: 'distribution',
      title: '分组均值与不确定性',
      text: groupEv.value,
      evidenceId: 'ev_group_stats'
    })
  } else {
    const ciEvs = (evidence ?? []).filter((e) => e.tool === 'stats.confidence_interval' && e.details?.lower !== null).slice(0, 3)
    if (ciEvs.length) {
      insights.push({
        id: 'insight_dist',
        kind: 'distribution',
        title: '均值及其 95% 置信区间',
        text: ciEvs.map((e) => `${e.fields[0]}：mean=${fmt(e.details.mean)}，95%CI=[${fmt(e.details.lower)}, ${fmt(e.details.upper)}]`).join('；'),
        evidenceId: ciEvs[0].evidence_id
      })
    }
  }

  // ---------- 5. 数据质量提示（缺失率 >30%） ----------
  const missingEv = byId.get('ev_missing')
  if (missingEv?.note) {
    insights.push({
      id: 'insight_quality',
      kind: 'quality',
      title: '数据质量提示',
      text: missingEv.note,
      evidenceId: 'ev_missing'
    })
  }

  // ---------- 分析段落组装（可改写的论文素材） ----------
  let analysisParagraph = paragraph.length ? paragraph.join('') : ''
  if (analysisParagraph) {
    const lead = title ? `${title}：` : '本图：'
    analysisParagraph = `${lead}${analysisParagraph}`
    // 统一收尾：结论不推断因果
    analysisParagraph += '以上结论基于图中数据与证据账本，仅描述观测结果，不代表因果。'
  } else {
    analysisParagraph = `本图（${title ?? '未命名图'}）用于呈现数据的整体形态；详细统计结论以证据账本为准。`
  }

  // ---------- 图注建议（科研图注风格：对象 + 方法 + 功能 + 统计说明） ----------
  let statNote = ''
  if (anovaEv?.details?.performed) {
    const a = anovaEv.details
    statNote = `；组间比较 ANOVA F=${fmt(a.statistic)}, p=${fmt(a.pValue)}${a.significant ? '（差异显著）' : '（无显著差异）'}，两两比较经 Holm 校正`
  } else if (sigCorr.length) {
    statNote = `；相关性标注 r 与 p 值（Pearson）`
  }
  const base = caption || (title ? `图1-1 ${title}` : '图1-1 数据可视化')
  const sampleNote = Number.isFinite(summary?.x?.length) && summary.x.length > 0 ? `；有效观测点 n=${summary.x.length}` : ''
  const captionSuggestion = `${base}${sampleNote}${statNote}`

  const typeAdvice = /箱线|小提琴/.test(chartType) ? '重点关注中位数、离散程度、异常值和多峰形态。' : /散点/.test(chartType) ? '重点关注变量关系、聚集形态和异方差；相关不等于因果。' : /热力/.test(chartType) ? '重点关注高低值区域和变量相似结构；颜色差异不等同于显著性。' : /森林/.test(chartType) ? '重点关注效应量方向、置信区间宽度及其是否跨越零。' : /堆叠/.test(chartType) ? '应分别解释总量变化与组成比例变化，不能只比较颜色面积。' : /双.?Y轴/.test(chartType) ? '双 Y 轴可能放大视觉差异，应核对单位、比例和两个尺度的独立含义。' : /三维/.test(chartType) ? '三维图受视角、遮挡和投影影响，应同时核对二维投影或数据域。' : '重点关注水平差异、变化方向和不确定性。'
  const count = summary?.series?.length ?? 0
  const chartRecommendation = /三维曲面|三维散点/.test(chartType) && count < 3
    ? '当前数值维度不足以支持三维表达。'
    : /饼图|环形图/.test(chartType) && count > 8
      ? '类别数量较多，饼图角度比较困难。'
      : ''
  const dynamicAlternatives = /三维/.test(chartType)
    ? (summary?.groups ? ['箱线图', '小提琴图', '分组柱状图'] : ['二维散点图', '折线图', '热力图'])
    : /饼图|环形图/.test(chartType) ? ['排序条形图', '点图', '堆叠条形图'] : []
  const recommendation = chartRecommendation
    ? { status: 'needs_confirmation', reason: chartRecommendation, alternatives: dynamicAlternatives }
    : { status: 'accepted', reason: '当前图型与已识别数据形态一致。', alternatives: [] }
  analysisParagraph += ` ${typeAdvice} 未提供正式检验或研究设计支持时，不使用“导致”“证明”等因果措辞。`
  const summaryText = insights.filter((item) => item.kind !== 'quality').slice(0, 3).map((item) => item.text).join('；') || '图表展示数据的主要差异与变化趋势，具体结论以统计证据为准。'
  return { insights, analysisParagraph, captionSuggestion, summaryText, insightTable, qualityNotes: ['当前文字为描述性分析，需结合样本量、重复测量结构和领域阈值复核。'], humanReview: ['核对变量含义、研究设计、章节语气和因果边界。'], chartRecommendation, recommendation, paperDraft: { status: 'needs_context', note: '如需论文级表述，请补充数据用途、论文位置和目标读者。' } }
}
