// 用户配色学习模型（"根据用户前期喜好建立学习算法，随时动态调整配色搭配与推荐"）。
// 设计：
//   - 从偏好事件（select_plan / reject / manual_edit / browse，携带 paletteId 与 chartType）在线学习；
//   - 维护三个亲和度视图：色板亲和度 paletteAffinity、角色亲和度 roleAffinity（分类/连续/发散/成对）、
//     图型-色板亲和度 chartPaletteAffinity（同一图型下用户更偏好哪类色板）；
//   - 时间衰减（半衰期 90 天）与置信度加权，参考说明书 12.2 P(v)=Σ w·exp(-Δt/τ)·confidence 的聚合形式；
//   - 学习结果作为"有界先验"注入 recommendPalette，绝不允许压过可读性/容量/语义等硬约束。
// 学习来源：① 开源算法色系（OKLab 感知均匀、色盲安全算法生成的色板）；② 公开科研文章常用色系
// （Nature/NEJM/Lancet/JAMA/Science 等，均以中性来源标注）；③ 用户历史选择与反馈。
import { PALETTE_LIBRARY } from './palettes.js'

const HALF_LIFE_MS = 90 * 86_400_000 // 90 天半衰期
const decay = (ageMs) => Math.exp(-ageMs / HALF_LIFE_MS)

/** 事件对亲和度的符号强度 */
function eventStrength(kind, weight = 0.5) {
  switch (kind) {
    case 'select_plan': return 1.0 * (weight || 0.7)
    case 'set_default': return 0.8 * (weight || 0.5)
    case 'manual_edit': return 0.5 * (weight || 0.5)
    case 'browse': return 0.15 * (weight || 0.3)
    case 'reject': return -0.9 * (weight || 0.6)
    default: return 0
  }
}

const ROLE_OF_PALETTE = (palette) => palette?.roles?.[0] ?? 'general'

/** 从空开始构建用户配色画像 */
export function createColorProfile(now = Date.now()) {
  return {
    version: 1,
    updatedAt: now,
    paletteAffinity: {}, // { [paletteId]: number }
    roleAffinity: {},    // { [role]: number }
    chartPaletteAffinity: {} // { [chartTypeBase]: { [paletteId]: number } }
  }
}

/** 图型基名（去掉布局/变体后缀，保持跨任务可比） */
export function chartTypeBase(chartType = '') {
  return String(chartType)
    .replace(/^(dual_line_normalized|panel)_/g, '')
    .replace(/_(error|normalized|2x1|2x2|err|3d|plot)$/gi, '')
    .replace(/^correlation_/g, '')
}

/**
 * 用一条偏好事件更新画像（在线学习；幂等累积）。
 * @param {object} profile 画像（会就地更新并返回新对象）
 * @param {object} event 偏好事件 {kind, paletteId?, chartType?, planId?, weight?, confidence?, t?}
 * @param {number} [now] 当前参考时刻（缺省 Date.now()）；事件按 (now - t) 相对该时刻衰减，
 *   因此重建画像（历史事件）时旧事件自然衰减，在线学习（事件即当前）保持满强度。
 */
export function learnFromEvent(profile, event, now = Date.now()) {
  // 撤销（reverted）事件不参与画像：撤销后重建画像时旧信号不得残留（撤销即遗忘）
  if (!event || event.reverted || profile.reverted) return profile
  const t = Number(event.t) || now
  const strength = eventStrength(event.kind, event.weight) * (Number(event.confidence) || 0.7) * decay(Math.max(0, now - t))
  const paletteId = event.paletteId
  if (paletteId && PALETTE_LIBRARY[paletteId]) {
    profile.paletteAffinity[paletteId] = (profile.paletteAffinity[paletteId] ?? 0) + strength
    const role = ROLE_OF_PALETTE(PALETTE_LIBRARY[paletteId])
    profile.roleAffinity[role] = (profile.roleAffinity[role] ?? 0) + strength
    const base = chartTypeBase(event.chartType ?? event.planId ?? '')
    if (base) {
      profile.chartPaletteAffinity[base] = profile.chartPaletteAffinity[base] ?? {}
      profile.chartPaletteAffinity[base][paletteId] = (profile.chartPaletteAffinity[base][paletteId] ?? 0) + strength
    }
  } else if (paletteId) {
    // 未知 paletteId（如旧事件未带色板）：仍记录角色级信号
    profile.roleAffinity[event.role ?? 'general'] = (profile.roleAffinity[event.role ?? 'general'] ?? 0) + strength * 0.5
  }
  profile.updatedAt = Math.max(profile.updatedAt ?? 0, now)
  return profile
}

/** 从历史事件列表重建画像（启动恢复/持久化后调用） */
export function buildColorProfile(events = [], now = Date.now()) {
  const profile = createColorProfile(now)
  for (const e of events) learnFromEvent(profile, { ...e, confidence: e.confidence ?? 0.7 }, now)
  return profile
}

/**
 * 计算画像给出的色板先验分（tanh 有界，范围约 (-1.5, 1.5)）。
 * @param {object} profile 画像
 * @param {string} paletteId 色板 id
 * @param {string} [chartType] 当前图型（命中图型-色板亲和时加成）
 */
export function profilePaletteScore(profile, paletteId, chartType = '') {
  if (!profile) return 0
  const base = profile.paletteAffinity?.[paletteId] ?? 0
  const baseRaw = profile.roleAffinity?.[ROLE_OF_PALETTE(PALETTE_LIBRARY[paletteId])] ?? 0
  let score = 0.55 * base + 0.25 * baseRaw
  const baseKey = chartTypeBase(chartType)
  if (baseKey) {
    const chartScore = profile.chartPaletteAffinity?.[baseKey]?.[paletteId] ?? 0
    score += 0.35 * chartScore
  }
  return 1.5 * Math.tanh(score / 3)
}

/** 画像摘要（用于展示"为什么推荐这个色板"） */
export function profileSummary(profile) {
  if (!profile) return null
  const topPalette = Object.entries(profile.paletteAffinity ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([id, score]) => ({ paletteId: id, name: PALETTE_LIBRARY[id]?.name ?? id, affinity: Math.round(score * 1000) / 1000 }))
  const topRoles = Object.entries(profile.roleAffinity ?? {})
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .map(([role, score]) => ({ role, affinity: Math.round(score * 1000) / 1000 }))
  return {
    version: profile.version,
    updatedAt: profile.updatedAt,
    topPalettes: topPalette,
    topRoles: topRoles,
    totalEvents: Object.keys(profile.paletteAffinity ?? {}).length
  }
}
