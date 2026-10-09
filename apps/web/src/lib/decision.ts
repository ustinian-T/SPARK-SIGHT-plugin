// 决策算法纯函数（浏览器端）：效用评分、六类设计特征相似度、MMR 选择。
// 与 services/local-agent/src/decision/* 保持同一算法（说明书 8.2/8.3）；
// 后端模块是自动化测试与评测基线的权威实现，本文件为其同构 TS 版本，供 Mock 与 UI 复用。
// 注意：Mock 演示只构造 3 个候选（K=3），不满足说明书 K=6~9；真实后端 K=8，见后端 selectionAudit。
import { UTILITY_WEIGHTS, type UtilityScore } from '../types'

export const SIMILARITY_WEIGHTS = {
  chartType: 0.2,
  layout: 0.15,
  encoding: 0.2,
  statPresentation: 0.2,
  color: 0.1,
  annotation: 0.15
} as const

export type SimilarityDimension = keyof typeof SIMILARITY_WEIGHTS

export const SIMILARITY_DIMENSIONS: SimilarityDimension[] = [
  'chartType',
  'layout',
  'encoding',
  'statPresentation',
  'color',
  'annotation'
]

export const SIMILARITY_DIM_LABELS: Record<SimilarityDimension, string> = {
  chartType: '图型',
  layout: '布局',
  encoding: '视觉编码',
  statPresentation: '统计呈现',
  color: '配色',
  annotation: '注释'
}

export const DEFAULT_LAMBDA = 0.5

export interface CandidateFeatures {
  chartType: string
  layout: { rows: number; cols: number; panels: number }
  encoding: { marks: string[]; xType: string; errorBars: boolean; normalized: boolean }
  statPresentation: { raw: boolean; errorBars: boolean; normalized: boolean; significance: boolean }
  color: { mode: string; monochromePrint: boolean }
  annotation: { kinds: string[]; count: number }
}

export interface ScoredCandidate {
  candidateId: string
  features: CandidateFeatures
  score: UtilityScore
  executable?: boolean
  infeasibleReason?: string
}

export interface MmrTraceStep {
  step: number
  candidateId: string
  utility: number
  maxSimilarity: number | null
  mmrScore: number
}

function jaccard(a: string[], b: string[]): number {
  const sa = new Set(a)
  const sb = new Set(b)
  if (sa.size === 0 && sb.size === 0) return 1
  let inter = 0
  sa.forEach((x) => {
    if (sb.has(x)) inter++
  })
  const union = new Set([...sa, ...sb]).size
  return union === 0 ? 1 : inter / union
}

export function featureSimilarityPerDim(a: CandidateFeatures, b: CandidateFeatures): Record<SimilarityDimension, number> {
  const chartType = a.chartType === b.chartType ? 1 : 0
  const panelsA = a.layout.panels
  const panelsB = b.layout.panels
  const layoutSame = a.layout.rows === b.layout.rows && a.layout.cols === b.layout.cols && panelsA === panelsB
  const layout = layoutSame ? 1 : 1 - Math.abs(panelsA - panelsB) / Math.max(panelsA, panelsB, 2)
  const encoding =
    0.4 * jaccard(a.encoding.marks, b.encoding.marks) +
    0.2 * (a.encoding.xType === b.encoding.xType ? 1 : 0) +
    0.2 * (a.encoding.errorBars === b.encoding.errorBars ? 1 : 0) +
    0.2 * (a.encoding.normalized === b.encoding.normalized ? 1 : 0)
  const statKeys = (s: CandidateFeatures['statPresentation']) =>
    [s.raw ? 'raw' : null, s.errorBars ? 'errorBars' : null, s.normalized ? 'normalized' : null, s.significance ? 'significance' : null].filter(
      (x): x is string => x !== null
    )
  const statPresentation = jaccard(statKeys(a.statPresentation), statKeys(b.statPresentation))
  const color =
    0.6 * (a.color.mode === b.color.mode ? 1 : 0) + 0.4 * (a.color.monochromePrint === b.color.monochromePrint ? 1 : 0)
  const countA = a.annotation.count
  const countB = b.annotation.count
  const annotation =
    0.7 * jaccard(a.annotation.kinds, b.annotation.kinds) +
    0.3 * (Math.max(countA, countB) === 0 ? 1 : 1 - Math.abs(countA - countB) / Math.max(countA, countB))
  return { chartType, layout, encoding, statPresentation, color, annotation }
}

export interface SimilarityResult {
  total: number
  perDim: Record<SimilarityDimension, number>
  diffDimensions: SimilarityDimension[]
  diffLabels: string[]
}

export function candidateSimilarity(a: CandidateFeatures, b: CandidateFeatures): SimilarityResult {
  const perDim = featureSimilarityPerDim(a, b)
  let total = 0
  const diffDimensions: SimilarityDimension[] = []
  for (const dim of SIMILARITY_DIMENSIONS) {
    total += SIMILARITY_WEIGHTS[dim] * perDim[dim]
    if (perDim[dim] < 0.99) diffDimensions.push(dim)
  }
  return {
    total: Math.round(total * 1000) / 1000,
    perDim,
    diffDimensions,
    diffLabels: diffDimensions.map((d) => SIMILARITY_DIM_LABELS[d])
  }
}

export function utilityTotal(s: Omit<UtilityScore, 'total'>): number {
  const total =
    UTILITY_WEIGHTS.DataFit * s.DataFit +
    UTILITY_WEIGHTS.TaskFit * s.TaskFit +
    UTILITY_WEIGHTS.Readability * s.Readability +
    UTILITY_WEIGHTS.ScientificConvention * s.ScientificConvention +
    UTILITY_WEIGHTS.PreferenceFit * s.PreferenceFit +
    UTILITY_WEIGHTS.Executability * s.Executability
  return Math.round(total * 1000) / 1000
}

export interface MmrSelection {
  selected: ScoredCandidate[]
  trace: Map<string, MmrTraceStep>
  rejected: { candidateId: string; reason: string }[]
  diversityOk: boolean
}

/**
 * MMR 选择（说明书 8.3 伪代码）：首个取 argmax U，之后取 argmax U-λ·max Sim。
 * 确定性 tie-break：效用/MMR 相同按 candidateId 升序。
 */
export function selectMMR(rawCandidates: ScoredCandidate[], k = 3, lambda = DEFAULT_LAMBDA): MmrSelection {
  const rejected: { candidateId: string; reason: string }[] = []
  let pool = rawCandidates
  const feasible = rawCandidates.filter((c) => c.executable !== false)
  for (const c of rawCandidates.filter((c) => c.executable === false)) {
    rejected.push({ candidateId: c.candidateId, reason: c.infeasibleReason ?? 'NOT_EXECUTABLE' })
  }
  pool = feasible
  if (pool.length === 0) {
    throw new Error('NO_VALID_CANDIDATE')
  }
  if (pool.length < k) {
    throw new Error(`INSUFFICIENT_CANDIDATES: executable=${pool.length}, required=${k}`)
  }
  const byUtility = (a: ScoredCandidate, b: ScoredCandidate) =>
    b.score.total - a.score.total || (a.candidateId < b.candidateId ? -1 : 1)

  const remaining = [...pool].sort(byUtility)
  const selected: ScoredCandidate[] = []
  const trace = new Map<string, MmrTraceStep>()
  const first = remaining.shift()!
  selected.push(first)
  trace.set(first.candidateId, { step: 1, candidateId: first.candidateId, utility: first.score.total, maxSimilarity: null, mmrScore: first.score.total })

  while (selected.length < Math.min(k, pool.length)) {
    let best: ScoredCandidate | null = null
    let bestSim = 0
    let bestScore = -Infinity
    for (const c of remaining) {
      let maxSim = 0
      for (const s of selected) {
        const sim = candidateSimilarity(c.features, s.features).total
        if (sim > maxSim) maxSim = sim
      }
      const mmr = c.score.total - lambda * maxSim
      if (
        mmr > bestScore + 1e-12 ||
        (Math.abs(mmr - bestScore) <= 1e-12 &&
          (c.score.total > (best?.score.total ?? -1) || (c.score.total === (best?.score.total ?? -1) && c.candidateId < (best?.candidateId ?? ''))))
      ) {
        best = c
        bestSim = maxSim
        bestScore = mmr
      }
    }
    if (!best) break
    remaining.splice(remaining.indexOf(best), 1)
    selected.push(best)
    trace.set(best.candidateId, {
      step: selected.length,
      candidateId: best.candidateId,
      utility: best.score.total,
      maxSimilarity: Math.round(bestSim * 1000) / 1000,
      mmrScore: Math.round(bestScore * 1000) / 1000
    })
  }

  let diversityOk = true
  for (let i = 0; i < selected.length; i++) {
    for (let j = i + 1; j < selected.length; j++) {
      if (candidateSimilarity(selected[i].features, selected[j].features).diffDimensions.length < 2) diversityOk = false
    }
  }
  if (!diversityOk) throw new Error('SELECTION_CONSTRAINT_UNMET')
  return { selected, trace, rejected, diversityOk }
}
