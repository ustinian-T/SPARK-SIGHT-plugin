// 偏好学习（算法说明书第 12 节 / 架构 5.5）。
// 本文件负责“实时重排序”：偏好事件调整候选 PreferenceFit 后按六维加权总分重排；
// 说明书 12.2 的事件加权聚合 P(v)=Σ w·exp(-Δt/τ)·confidence·scope_match 与自动推荐阈值
// 在 src/decision/preference.js 中以纯函数实现（可测试、可解释、可撤销），二者不互相替代。
// 初始权重为启发式配置（非训练所得）。
import { UTILITY_WEIGHTS, utilityScore } from './decision/index.js'
import { ApiError, ERR } from './errors.js'
import { buildColorProfile, profileSummary } from './colorLearning.js'
import { PALETTE_LIBRARY } from './palettes.js'

const clamp = (v, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, v))

function total(score) {
  return utilityScore(score, UTILITY_WEIGHTS).total
}

/**
 * @param {object[]} plans 当前方案
 * @param {object} pref PreferenceEvent
 * @returns {object[]} 重新评分排序后的新方案数组
 */
export function applyPreference(plans, pref) {
  const next = plans.map((p) => ({ ...p, score: { ...p.score } }))
  const target = pref.planId ? next.find((p) => p.plan_id === pref.planId) : null
  const strength = typeof pref.weight === 'number' ? pref.weight : 0.7

  for (const p of next) {
    const isTarget = target ? p.plan_id === target.plan_id : true
    switch (pref.kind) {
      case 'select_plan':
        // 显式选择是最强偏好信号：目标方案 PreferenceFit 置满，其余略降
        if (isTarget) p.score.PreferenceFit = 1
        else p.score.PreferenceFit = clamp(p.score.PreferenceFit - 0.05)
        break
      case 'set_default':
        p.score.PreferenceFit = clamp(p.score.PreferenceFit + (isTarget ? 0.1 * strength : 0))
        break
      case 'manual_edit':
        // 人工编辑视为对该策略风格的弱正向反馈
        p.score.PreferenceFit = clamp(p.score.PreferenceFit + (isTarget ? 0.08 * strength : 0))
        break
      case 'browse':
        p.score.PreferenceFit = clamp(p.score.PreferenceFit + (isTarget ? 0.03 : 0))
        break
      case 'reject':
        if (isTarget) p.score.PreferenceFit = clamp(p.score.PreferenceFit - 0.2 * strength)
        break
      default:
        break
    }
    p.score.total = total(p.score)
  }
  next.sort((a, b) => b.score.total - a.score.total)
  // 显式选择代表用户直接决策，优先于启发式总分：被选方案固定排首位
  if (pref.kind === 'select_plan' && target) {
    const i = next.findIndex((p) => p.plan_id === target.plan_id)
    if (i > 0) {
      const [chosen] = next.splice(i, 1)
      next.unshift(chosen)
    }
  }
  return next
}

export function preferenceSummary(kind, plan) {
  switch (kind) {
    case 'select_plan':
      return `用户选择方案「${plan?.name ?? plan?.plan_id ?? ''}」，同策略初始权重提升`
    case 'reject':
      return `用户否决方案「${plan?.name ?? plan?.plan_id ?? ''}」，同策略初始权重降低`
    case 'set_default':
      return '用户设置默认风格偏好'
    case 'manual_edit':
      return '用户进行人工编辑，视为风格偏好信号'
    case 'browse':
      return '用户浏览方案，弱偏好信号'
    default:
      return '偏好反馈'
  }
}

export class PreferenceStore {
  constructor(storage = null) {
    this.storage = storage
    this.state = storage?.loadPreferences?.() ?? { paused: false, events: [] }
  }

  snapshot() {
    return structuredClone(this.state)
  }

  persist() {
    this.storage?.savePreferences?.(this.state)
  }

  setPaused(paused) {
    this.state.paused = paused === true
    this.persist()
    return this.snapshot()
  }

  append(event) {
    if (this.state.paused) return { written: false, reason: 'PREFERENCE_PAUSED' }
    const stored = { ...structuredClone(event), reverted: false }
    this.state.events.push(stored)
    this.persist()
    return { written: true, event: structuredClone(stored) }
  }

  revert(eventId) {
    const event = this.state.events.find((item) => item.event_id === eventId)
    if (!event) throw new ApiError(404, ERR.NOT_FOUND, `偏好事件不存在：${eventId}`)
    event.reverted = true
    event.revertedAt = Date.now()
    this.persist()
    return structuredClone(event)
  }

  clear() {
    const removed = this.state.events.length
    this.state.events = []
    this.persist()
    return { removed, ...this.snapshot() }
  }

  /** 仅含配色信号的事件（携带 paletteId，供配色学习画像与撤销/重置） */
  colorEvents() {
    return this.state.events.filter((e) => e.paletteId && !e.reverted)
  }

  /**
   * 重置配色学习画像：仅移除携带 paletteId 的偏好事件（含已撤销的，彻底清空），
   * 保留与配色无关的偏好（图型/排版选择等），避免误伤用户其他学习。
   */
  clearColors() {
    const kept = this.state.events.filter((e) => !e.paletteId)
    const removed = this.state.events.length - kept.length
    this.state.events = kept
    this.persist()
    return { removed, ...this.snapshot() }
  }

  /**
   * 配色学习画像查询：由当前未撤销的配色事件重建画像（90 天半衰期衰减 + 置信度加权），
   * 返回学习摘要、事件统计与逐色板亲和明细，供前端展示"为什么推荐这个色板"。
   */
  colorProfile() {
    const events = this.colorEvents()
    const profile = buildColorProfile(events)
    const byPalette = new Map()
    for (const e of events) {
      const item = byPalette.get(e.paletteId) ?? { paletteId: e.paletteId, name: PALETTE_LIBRARY[e.paletteId]?.name ?? e.paletteId, positive: 0, negative: 0, total: 0, lastAt: 0 }
      const delta = e.kind === 'reject' ? -1 : 1
      item.total += 1
      item.positive += delta > 0 ? 1 : 0
      item.negative += delta < 0 ? 1 : 0
      item.lastAt = Math.max(item.lastAt, Number(e.t) || 0)
      byPalette.set(e.paletteId, item)
    }
    const paletteStats = [...byPalette.values()].sort((a, b) => b.total - a.total)
    return {
      summary: profileSummary(profile),
      eventCount: events.length,
      paletteStats,
      eventIds: events.map((e) => e.event_id)
    }
  }
}
