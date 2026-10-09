// 偏好聚合（算法说明书 12.1/12.2）。
// P(v)=Σ w_event·exp(-Δt/τ)·confidence·scope_match；全局/项目/图表类型三作用域分别聚合，
// 项目级覆盖全局（实现取最具体的非空作用域）；有效事件 ≥3 且前两名分差超过阈值才自动推荐。
// 纯函数：事件数组进，推荐结论出；不修改候选、不触碰数据事实（12.2：偏好只影响 PreferenceFit 与排序）。
import {
  EVENT_WEIGHTS,
  PREFERENCE_CONFIG,
  SCOPE_PRIORITY,
  DecisionError,
  round3
} from './weights.js'

/**
 * @typedef {object} PreferenceEvent
 * @property {string} kind       set_default|select_plan|manual_edit|export|reject|browse
 * @property {string} attribute  偏好属性，如 strategy / chartType / colorMode
 * @property {string} value      属性值，如 convention / line_error / mono
 * @property {number} t          事件时间戳 ms
 * @property {number} [confidence=1] 置信度 0~1
 * @property {('global'|'project'|'chartType')} [scope='global'] 作用域
 * @property {string} [chartType] scope=chartType 时限定的图型
 */

export function eventWeight(kind) {
  if (!Object.prototype.hasOwnProperty.call(EVENT_WEIGHTS, kind)) {
    throw new DecisionError('INVALID_PREFERENCE_EVENT', `未知偏好事件类型：${kind}`)
  }
  return EVENT_WEIGHTS[kind]
}

/** 单条事件对某属性值的贡献（带符号、时间衰减、置信度） */
export function eventContribution(event, now, tauMs = PREFERENCE_CONFIG.tauMs) {
  const w = eventWeight(event.kind)
  const confidence = Math.min(1, Math.max(0, event.confidence ?? 1))
  const dt = Math.max(0, now - (event.t ?? now))
  const decay = Math.exp(-dt / tauMs)
  return round3(w * decay * confidence)
}

/**
 * 按 (attribute,value,scope) 聚合偏好分。
 * @returns {Map<string, {attribute,value,scope,score,events:number,effectiveEvents:number}>}
 */
export function aggregatePreferences(events, opts = {}) {
  const now = opts.now ?? Date.now()
  const tauMs = opts.tauMs ?? PREFERENCE_CONFIG.tauMs
  const agg = new Map()
  for (const e of events) {
    if (!e?.attribute || e.value === undefined || e.value === null) {
      throw new DecisionError('INVALID_PREFERENCE_EVENT', '偏好事件缺少 attribute/value')
    }
    const scope = e.scope ?? 'global'
    if (!SCOPE_PRIORITY[scope]) {
      throw new DecisionError('INVALID_PREFERENCE_EVENT', `未知作用域：${scope}`)
    }
    const key = `${e.attribute}\u0000${e.value}\u0000${scope}${scope === 'chartType' ? `\u0000${e.chartType ?? ''}` : ''}`
    if (!agg.has(key)) {
      agg.set(key, {
        attribute: e.attribute,
        value: String(e.value),
        scope,
        chartType: e.chartType ?? null,
        score: 0,
        events: 0,
        effectiveEvents: 0
      })
    }
    const row = agg.get(key)
    const c = eventContribution(e, now, tauMs)
    row.score = round3(row.score + c)
    row.events += 1
    // browse 权重为 0，不计入有效事件（12.1：仅浏览不作为偏好证据）
    if (e.kind !== 'browse') row.effectiveEvents += 1
  }
  return agg
}

/** 在某属性上按作用域优先级选出有效值（chartType > project > global），返回各作用域候选 */
function rankAttribute(agg, attribute, chartType = null) {
  const rows = [...agg.values()].filter((r) => r.attribute === attribute)
  const byScope = (scope) =>
    rows
      .filter((r) => r.scope === scope && (scope !== 'chartType' || r.chartType === chartType))
      .sort((a, b) => b.score - a.score || (a.value < b.value ? -1 : 1))
  const scoped = {
    chartType: byScope('chartType'),
    project: byScope('project'),
    global: byScope('global')
  }
  // 负向偏好（reject 主导）时，最具体作用域可能全为负分；仍按规则取最具体非空作用域
  const effective = scoped.chartType[0] ? scoped.chartType : scoped.project[0] ? scoped.project : scoped.global
  return { scoped, effective }
}

/**
 * 自动推荐判定（12.2）：有效事件 ≥ minEffectiveEvents 且第一名与第二名分差 > margin。
 * @returns {{shouldRecommend:boolean, value?:string, score?:number, runnerUp?:object, margin?:number, effectiveEvents:number, reasons:string[]}}
 */
export function recommend(events, attribute, opts = {}) {
  const now = opts.now ?? Date.now()
  const tauMs = opts.tauMs ?? PREFERENCE_CONFIG.tauMs
  const minEvents = opts.minEffectiveEvents ?? PREFERENCE_CONFIG.minEffectiveEvents
  const marginThreshold = opts.margin ?? PREFERENCE_CONFIG.recommendationMargin
  const agg = aggregatePreferences(events, { now, tauMs })
  const { effective } = rankAttribute(agg, attribute, opts.chartType ?? null)

  const reasons = []
  if (!effective.length) {
    return { shouldRecommend: false, effectiveEvents: 0, reasons: ['没有该属性的偏好事件'] }
  }
  const top = effective[0]
  const runnerUp = effective[1] ?? null
  const margin = runnerUp ? round3(top.score - runnerUp.score) : top.score
  const enoughEvents = top.effectiveEvents >= minEvents
  const enoughMargin = margin > marginThreshold

  if (!enoughEvents) reasons.push(`有效事件 ${top.effectiveEvents} 次，少于阈值 ${minEvents} 次，仅提供可选建议`)
  if (!enoughMargin) reasons.push(`前两名分差 ${margin}，未超过阈值 ${marginThreshold}，仅提供可选建议`)
  if (top.score < 0) reasons.push('首位偏好分为负（拒绝信号主导），不自动推荐')

  const shouldRecommend = enoughEvents && enoughMargin && top.score >= 0
  if (shouldRecommend) {
    reasons.push(`有效事件 ${top.effectiveEvents} 次、前两名分差 ${margin}，满足自动推荐条件`)
  }
  return {
    shouldRecommend,
    attribute,
    value: top.value,
    score: top.score,
    scope: top.scope,
    runnerUp: runnerUp ? { value: runnerUp.value, score: runnerUp.score } : null,
    margin,
    effectiveEvents: top.effectiveEvents,
    reasons
  }
}
