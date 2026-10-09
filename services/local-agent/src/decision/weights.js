// 决策算法常量与权重（算法设计说明书 V1.0 第 8、12 节）。
// 所有数值均为“初始配置（启发式）”，不是训练所得，必须经用户测试调整（说明书 8.2 明确要求）。
// 本模块为零依赖纯函数，可在 Node 与浏览器中复用，配套 test/decision.test.js 与 scripts/eval-decision.mjs。

/**
 * 8.2 候选效用权重 U(c)：
 * U(c)=0.30·DataFit+0.20·TaskFit+0.15·Readability+0.15·ScientificConvention
 *      +0.10·PreferenceFit+0.10·Executability
 */
export const UTILITY_WEIGHTS = Object.freeze({
  DataFit: 0.3,
  TaskFit: 0.2,
  Readability: 0.15,
  ScientificConvention: 0.15,
  PreferenceFit: 0.1,
  Executability: 0.1
})

export const UTILITY_DIMENSIONS = Object.freeze([
  'DataFit',
  'TaskFit',
  'Readability',
  'ScientificConvention',
  'PreferenceFit',
  'Executability'
])

/**
 * 8.3 Sim(c,s) 六类设计特征的加权相似度。
 * 说明书只给出六个维度名称，未给出各维权重与 λ；以下为本项目初始配置（可评测、可调参）。
 */
export const SIMILARITY_WEIGHTS = Object.freeze({
  chartType: 0.2, // 图型（柱状/折线/双面板等）
  layout: 0.15, // 布局（面板行列、单/复合）
  encoding: 0.2, // 视觉编码（mark 集合、轴类型、误差棒、归一化）
  statPresentation: 0.2, // 统计呈现（原始值/误差棒/归一化/显著性）
  color: 0.1, // 配色（配色模式、黑白可打印）
  annotation: 0.15 // 注释（注释种类集合与数量）
})

export const SIMILARITY_DIMENSIONS = Object.freeze([
  'chartType',
  'layout',
  'encoding',
  'statPresentation',
  'color',
  'annotation'
])

export const SIMILARITY_DIM_LABELS = Object.freeze({
  chartType: '图型',
  layout: '布局',
  encoding: '视觉编码',
  statPresentation: '统计呈现',
  color: '配色',
  annotation: '注释'
})

/**
 * 8.3 MMR 权衡系数 λ：Score(c)=U(c)-λ·max Sim(c,s)。
 * 说明书未给定数值（属待标定参数）；0.5 为初始配置，评测脚本输出 λ 敏感性供后续调参。
 */
export const DEFAULT_LAMBDA = 0.5

/** 最终方案数量（说明书 8.3：三套差异化方案） */
export const DEFAULT_SELECT_COUNT = 3

/** 8.1 候选池规模建议 K=6~9（伪代码 k=8） */
export const CANDIDATE_COUNT_RANGE = Object.freeze([6, 9])
export const DEFAULT_CANDIDATE_COUNT = 8

/** 8.3 最终三套方案必须至少在两个设计维度存在差异 */
export const MIN_DIFFERENCE_DIMENSIONS = 2

/**
 * 12.1 偏好事件权重（说明书表 12-1）。
 */
export const EVENT_WEIGHTS = Object.freeze({
  set_default: 1.0, // 设为默认：最高置信显式选择
  select_plan: 0.7, // 选择方案
  manual_edit: 0.6, // 主动修改属性
  export: 0.45, // 导出方案（进入实际使用）
  reject: -0.8, // 拒绝/撤销（负向偏好）
  browse: 0.0 // 仅浏览，不作为偏好证据
})

/**
 * 12.2 聚合参数（说明书未给数值，初始配置）：
 * - tauMs：时间衰减常数 exp(-Δt/τ)，默认 30 天；
 * - minEffectiveEvents：有效事件不少于 3 次才自动推荐；
 * - recommendationMargin：第一名与第二名分差阈值，默认 0.15。
 */
export const PREFERENCE_CONFIG = Object.freeze({
  tauMs: 30 * 24 * 3600 * 1000,
  minEffectiveEvents: 3,
  recommendationMargin: 0.15
})

/** 作用域优先级：图表类型 > 项目 > 全局（项目级覆盖全局，12.2） */
export const SCOPE_PRIORITY = Object.freeze({ chartType: 3, project: 2, global: 1 })

const EPS = 1e-9

/**
 * 校验权重对象：维度齐全、数值有限、非负、和为 1（容差 1e-9 量级，放宽到 1e-6 兼容手写配置）。
 * @returns {string[]} 错误信息数组（空数组表示通过）
 */
export function weightValidationErrors(weights, expectedDims = UTILITY_DIMENSIONS) {
  const errors = []
  const keys = Object.keys(weights ?? {})
  for (const dim of expectedDims) {
    const v = weights?.[dim]
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      errors.push(`权重维度 ${dim} 缺失或不是有限数值`)
    } else if (v < 0 || v > 1) {
      errors.push(`权重维度 ${dim}=${v} 超出 [0,1]`)
    }
  }
  const extra = keys.filter((k) => !expectedDims.includes(k))
  if (extra.length) errors.push(`存在未知权重维度：${extra.join('、')}`)
  if (errors.length === 0) {
    const sum = expectedDims.reduce((acc, k) => acc + weights[k], 0)
    if (Math.abs(sum - 1) > 1e-6) errors.push(`权重之和必须为 1，当前为 ${sum}`)
  }
  return errors
}

function assertValidWeights(weights, expectedDims = UTILITY_DIMENSIONS) {
  const errors = weightValidationErrors(weights, expectedDims)
  if (errors.length) throw new DecisionError('INVALID_WEIGHTS', errors.join('；'), { errors })
}

/** 决策算法错误（纯数据，不带 HTTP 语义；路由层负责映射状态码） */
export class DecisionError extends Error {
  constructor(code, message, details = {}) {
    super(message)
    this.name = 'DecisionError'
    this.code = code
    this.details = details
  }
}

const round3 = (v) => Math.round(v * 1000) / 1000

/**
 * 计算 U(c)：六维加权总分。
 * @param {object} sub 六个维度子分（不含 total）
 * @param {object} weights 可选自定义权重（默认说明书初始配置）
 * @param {boolean} strict 子分越界时抛错还是裁剪
 */
export function utilityScore(sub, weights = UTILITY_WEIGHTS, strict = true) {
  assertValidWeights(weights)
  const dims = Object.keys(weights)
  const normalized = { ...sub }
  for (const dim of dims) {
    const v = sub?.[dim]
    if (typeof v !== 'number' || !Number.isFinite(v)) {
      throw new DecisionError('INVALID_SCORE', `效用维度 ${dim} 缺失或不是有限数值`)
    }
    normalized[dim] = strict ? v : Math.min(1, Math.max(0, v))
    if (strict && (v < 0 || v > 1)) {
      throw new DecisionError('INVALID_SCORE', `效用维度 ${dim}=${v} 超出 [0,1]`)
    }
  }
  let total = 0
  for (const dim of dims) total += weights[dim] * normalized[dim]
  return { ...normalized, total: round3(total) }
}

export { round3, EPS }
