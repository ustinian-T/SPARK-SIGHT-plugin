// 图表解读文案生成：基于证据账本（证据/结论 claims）生成结构化解读要点与可改写的中文学术分析段落。
// 所有数字均来自证据账本中的真实计算（禁止模型填数）；证据缺失的表述一律不输出，
// 保证"解读可溯源、数字可复核"（与 AGT-002 / CORE-010 一致）。
import { significanceStars } from './stats.js'

const fmt = (n, d = 3) => {
  if (!Number.isFinite(n)) return null
  return String(Math.round(n * 10 ** d) / 10 ** d)
}
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
  const { summary, evidence, claims, title, caption } = ctx
  const byId = new Map((evidence ?? []).map((e) => [e.evidence_id, e]))
  const insights = []
  const insightTable = []
  const paragraph = []
  const grouped = summary?.groups

  // ---------- 1. 趋势（宽表多系列：首末变化 + 末点峰值） ----------
  if (!grouped && summary?.series?.length) {
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
      const pct = first !== 0 ? Math.round(((last - first) / first) * 1000) / 10 : null
      const delta = pct !== null
        ? `${dir(change)} ${Math.abs(change) >= 1e-9 ? `${fmt(Math.abs(change))}（${pct > 0 ? '+' : ''}${fmt(pct)}%）` : '基本不变'}`
        : `${dir(change)} ${fmt(Math.abs(change))}（基线为 0，百分比未定义）`
      insights.push({
        id: `insight_trend_${summary.series.indexOf(s)}`,
        kind: 'trend',
        title: `${s.label} 的变化趋势`,
        text: `「${s.label}」在观测区间内${delta}，首末值分别为 ${fmt(first)} 与 ${fmt(last)}`,
        evidenceId: ev.evidence_id
      })
      insightTable.push({ metric: `${s.label}变化`, result: delta, criterion: '描述性判断：相对变化幅度≥20%可视为明显变化；需结合领域阈值复核。', evidenceId: ev.evidence_id })
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
    if (trendParts.length) paragraph.push(`描述性结果显示，${trendParts.join('；')}。`)
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
      text: `单因素方差分析显示组间差异${a.significant ? `显著（F=${fmt(a.statistic)}，p=${fmt(a.pValue)}，η²=${fmt(a.etaSq)}${stars ? `，${stars}` : ''}）` : `不显著（F=${fmt(a.statistic)}，p=${fmt(a.pValue)}）`}`,
      evidenceId: 'ev_anova'
    })
    insightTable.push({ metric: '整体组间差异', result: a.significant ? `显著（p=${fmt(a.pValue)}）` : `不显著（p=${fmt(a.pValue)}）`, criterion: '通常以 p<0.05 判为统计学显著，同时报告效应量与置信区间。', evidenceId: 'ev_anova' })
    if (a.significant) paragraph.push(`单因素方差分析表明${grouped?.groupCol ?? '组间'}整体差异显著（F=${fmt(a.statistic)}，p=${fmt(a.pValue)}，η²=${fmt(a.etaSq)}）。`)
  }
  const tTests = (evidence ?? []).filter((e) => e.tool === 'stats.t_test' && e.details?.performed)
  const significantPairs = tTests.filter((e) => (e.details?.pAdjusted ?? 1) < 0.05)
  if (significantPairs.length) {
    const pairTexts = significantPairs.slice(0, 3).map((e) => {
      const d = e.details
      return `${d.left} 与 ${d.right}（p_adj=${fmt(d.pAdjusted)}${d.stars && d.stars !== 'ns' ? `，${d.stars}` : ''}）`
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
      insightTable.push({ metric: `${d.left} vs ${d.right}`, result: `p_adj=${fmt(d.pAdjusted)}`, criterion: 'Holm校正后 p_adj<0.05 通常判为显著；应结合效应量与样本量解释。', evidenceId: e.evidence_id })
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
      text: `${e.fields[0]} 与 ${e.fields[1]} 呈${r > 0 ? '正' : '负'}相关（r=${fmt(r, 4)}，n=${d.n}，p=${fmt(d.pValue)}${d.significant ? '，显著' : '，未达显著'}），相关强度${strength}`,
      evidenceId: e.evidence_id
    })
    insightTable.push({ metric: `${e.fields[0]}–${e.fields[1]}相关`, result: `r=${fmt(r, 4)}（${strength}）`, criterion: '|r|≥0.8强，0.5–0.8中等，<0.5较弱；相关不等于因果。', evidenceId: e.evidence_id })
  }
  const sigCorr = corrSignifs.filter((e) => e.details?.significant).slice(0, 2)
  if (sigCorr.length) {
    paragraph.push(sigCorr.map((e) => {
      const d = e.details
      return `${e.fields[0]} 与 ${e.fields[1]} 显著${d.r > 0 ? '正' : '负'}相关（r=${fmt(d.r, 4)}，p=${fmt(d.pValue)}）`
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

  const summaryText = insights.filter((item) => item.kind !== 'quality').slice(0, 3).map((item) => item.text).join('；') || '图表展示数据的主要差异与变化趋势，具体结论以统计证据为准。'
  return { insights, analysisParagraph, captionSuggestion, summaryText, insightTable }
}
