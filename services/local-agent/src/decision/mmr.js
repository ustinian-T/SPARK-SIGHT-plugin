// MMR 多样性选择（算法说明书 8.3 伪代码的可执行实现）。
// selected=[argmax U(c)]；随后 Score(c)=U(c)-λ·max Sim(c,s)，逐步贪心入选直到 k 个。
// 8.4：不可执行/无法验证的候选不得进入最终三套；8.3：最终三套至少在两个设计维度存在差异。
import {
  UTILITY_WEIGHTS,
  SIMILARITY_WEIGHTS,
  DEFAULT_LAMBDA,
  DEFAULT_SELECT_COUNT,
  MIN_DIFFERENCE_DIMENSIONS,
  DecisionError,
  utilityScore,
  round3
} from './weights.js'
import { candidateSimilarity, diffDimensionLabels } from './features.js'

const idOf = (c) => c.candidateId ?? c.id
const featuresOf = (c) => c.features ?? c
const scoreOf = (c) => c.score?.total ?? c.utility ?? null

/**
 * 给候选补算效用总分（若仅有六维子分）。
 */
function withUtility(candidate, weights = UTILITY_WEIGHTS) {
  if (typeof scoreOf(candidate) === 'number') return candidate
  if (!candidate.score) throw new DecisionError('INVALID_CANDIDATE', `候选 ${idOf(candidate)} 缺少效用分`)
  return { ...candidate, score: utilityScore(candidate.score, weights) }
}

/**
 * MMR 选择。
 * @param {object[]} rawCandidates 候选数组（含 features 与 score；executable=false 会被剔除）
 * @param {object} opts
 * @param {number} opts.k 最终方案数，默认 3
 * @param {number} opts.lambda λ，默认 0.5
 * @param {boolean} opts.executableOnly 是否只允许可执行候选（默认 true，对应 8.4）
 * @param {number} opts.minDiversityDims 最小差异维度数，默认 2
 * @param {boolean} opts.strict 候选不足/差异不满足时抛错（true）还是返回 warnings（false）
 * @returns {{selected:object[], rejected:object[], trace:object[], metrics:object, warnings:string[], diversityOk:boolean}}
 */
export function selectMMR(rawCandidates, opts = {}) {
  const {
    k = DEFAULT_SELECT_COUNT,
    lambda = DEFAULT_LAMBDA,
    executableOnly = true,
    minDiversityDims = MIN_DIFFERENCE_DIMENSIONS,
    strict = true,
    utilityWeights = UTILITY_WEIGHTS,
    similarityWeights = SIMILARITY_WEIGHTS
  } = opts

  if (!Number.isInteger(k) || k < 1) {
    throw new DecisionError('INVALID_SELECT_COUNT', `最终方案数 k 必须是 ≥1 的整数，收到 ${k}`)
  }
  if (typeof lambda !== 'number' || !Number.isFinite(lambda) || lambda < 0 || lambda > 1) {
    throw new DecisionError('INVALID_LAMBDA', `λ 必须是 [0,1] 内有限数值，收到 ${lambda}`)
  }
  if (!Array.isArray(rawCandidates)) {
    throw new DecisionError('INVALID_CANDIDATE', '候选必须是数组')
  }

  // 去重（同 candidateId 视为重复候选，只保留效用更高者；同分时保留先出现者——确定性）
  const dedup = new Map()
  const duplicateIds = []
  for (const c of rawCandidates) {
    const id = idOf(c)
    if (!id) throw new DecisionError('INVALID_CANDIDATE', '存在缺少 candidateId 的候选')
    const scored = withUtility(c, utilityWeights)
    if (dedup.has(id)) {
      duplicateIds.push(id)
      if (scoreOf(scored) > scoreOf(dedup.get(id))) dedup.set(id, scored)
    } else {
      dedup.set(id, scored)
    }
  }

  const rejected = []
  let pool = [...dedup.values()]
  if (executableOnly) {
    const infeasible = pool.filter((c) => c.executable === false)
    for (const c of infeasible) {
      rejected.push({ candidateId: idOf(c), reason: c.infeasibleReason ?? 'NOT_EXECUTABLE' })
    }
    pool = pool.filter((c) => c.executable !== false)
  }
  if (pool.length === 0) {
    throw new DecisionError('NO_VALID_CANDIDATE', '没有可执行候选：无法选出最终方案（说明书 8.4：重新生成或明确失败）', {
      rejected
    })
  }
  if (strict && pool.length < k) {
    throw new DecisionError('INSUFFICIENT_CANDIDATES', `可执行候选 ${pool.length} 个，少于最终方案数 k=${k}`, {
      executableCount: pool.length,
      required: k,
      rejected
    })
  }

  // 确定性排序键：效用降序、candidateId 升序（保证无随机、可复现）
  const byUtility = (a, b) => scoreOf(b) - scoreOf(a) || (idOf(a) < idOf(b) ? -1 : 1)

  const trace = []
  const selected = []
  const remaining = [...pool]

  // 第一步：argmax U
  remaining.sort(byUtility)
  const first = remaining.shift()
  selected.push(first)
  trace.push({ step: 1, candidateId: idOf(first), utility: scoreOf(first), maxSimilarity: null, mmrScore: scoreOf(first) })

  // 后续：argmax U - λ·max Sim
  while (selected.length < Math.min(k, pool.length)) {
    let best = null
    let bestSim = 0
    let bestScore = -Infinity
    for (const c of remaining) {
      let maxSim = 0
      for (const s of selected) {
        const sim = candidateSimilarity(featuresOf(c), featuresOf(s), similarityWeights).total
        if (sim > maxSim) maxSim = sim
      }
      const mmr = scoreOf(c) - lambda * maxSim
      // 确定性 tie-break：MMR 分降序，再效用降序，再 id 升序
      if (
        mmr > bestScore + 1e-12 ||
        (Math.abs(mmr - bestScore) <= 1e-12 &&
          (scoreOf(c) > scoreOf(best ?? {}) ||
            (scoreOf(c) === scoreOf(best ?? {}) && idOf(c) < idOf(best ?? {}))))
      ) {
        best = c
        bestSim = maxSim
        bestScore = mmr
      }
    }
    remaining.splice(remaining.indexOf(best), 1)
    selected.push(best)
    trace.push({
      step: selected.length,
      candidateId: idOf(best),
      utility: scoreOf(best),
      maxSimilarity: round3(bestSim),
      mmrScore: round3(bestScore)
    })
  }

  // 差异约束校验（8.3：任意两套至少 minDiversityDims 个维度不同；这里取所有配对）
  const pairDiffs = []
  let diversityOk = true
  for (let i = 0; i < selected.length; i++) {
    for (let j = i + 1; j < selected.length; j++) {
      const sim = candidateSimilarity(featuresOf(selected[i]), featuresOf(selected[j]), similarityWeights)
      pairDiffs.push({
        a: idOf(selected[i]),
        b: idOf(selected[j]),
        similarity: sim.total,
        diffDimensions: sim.diffDimensions,
        diffLabels: diffDimensionLabels(sim.diffDimensions)
      })
      if (sim.diffDimensions.length < minDiversityDims) diversityOk = false
    }
  }

  const warnings = []
  if (duplicateIds.length) warnings.push(`检测到重复候选 id：${[...new Set(duplicateIds)].join('、')}（已按效用保留一份）`)
  if (pool.length < k) warnings.push(`可执行候选 ${pool.length} 个，少于最终方案数 k=${k}（说明书要求重新生成或明确失败）`)
  if (!diversityOk) {
    warnings.push(`最终方案存在差异维度不足 ${minDiversityDims} 的配对（8.3 约束未满足，应重新生成候选）`)
  }

  const metrics = selectionMetrics(selected, { similarityWeights, pairDiffs, rejectedCount: rejected.length, poolSize: pool.length, warnings })

  if (strict && !diversityOk) {
    throw new DecisionError('SELECTION_CONSTRAINT_UNMET', warnings.join('；'), { metrics, rejected, trace })
  }
  return { selected, rejected, trace, metrics, warnings, diversityOk }
}

/**
 * 选择结果的基线指标：入选效用、两两相似度、差异维度、淘汰数、稳定性外部用 selectionStability 计算。
 */
export function selectionMetrics(selected, extras = {}) {
  const pairDiffs =
    extras.pairDiffs ??
    (selected.length >= 2
      ? (() => {
          const pairs = []
          for (let i = 0; i < selected.length; i++) {
            for (let j = i + 1; j < selected.length; j++) {
              const sim = candidateSimilarity(featuresOf(selected[i]), featuresOf(selected[j]))
              pairs.push({
                a: idOf(selected[i]),
                b: idOf(selected[j]),
                similarity: sim.total,
                diffDimensions: sim.diffDimensions
              })
            }
          }
          return pairs
        })()
      : [])
  const utilities = selected.map((c) => scoreOf(c))
  const sims = pairDiffs.map((p) => p.similarity)
  const minPairDims = pairDiffs.length ? Math.min(...pairDiffs.map((p) => p.diffDimensions.length)) : null
  return {
    selectedIds: selected.map(idOf),
    selectedUtility: utilities,
    selectedUtilitySum: round3(utilities.reduce((a, b) => a + b, 0)),
    selectedUtilityMin: utilities.length ? Math.min(...utilities) : null,
    pairwiseSimilarity: sims,
    pairwiseSimilarityMean: sims.length ? round3(sims.reduce((a, b) => a + b, 0) / sims.length) : null,
    pairwiseSimilarityMax: sims.length ? Math.max(...sims) : null,
    minPairDifferenceDims: minPairDims,
    pairDiffs,
    infeasibleRejected: extras.rejectedCount ?? null,
    poolSize: extras.poolSize ?? selected.length,
    warnings: extras.warnings ?? []
  }
}

/**
 * 选择稳定性：对候选做 n 次洗牌后重复 MMR，入选 id 集合完全一致的比例（1=完全稳定）。
 */
export function selectionStability(candidates, opts = {}, n = 20) {
  const base = selectMMR(candidates, opts)
  const baseIds = [...base.metrics.selectedIds].sort().join('|')
  let stable = 0
  const rng = opts.rng ?? Math.random
  for (let i = 0; i < n; i++) {
    const shuffled = [...candidates]
    for (let j = shuffled.length - 1; j > 0; j--) {
      const p = Math.floor(rng() * (j + 1))
      ;[shuffled[j], shuffled[p]] = [shuffled[p], shuffled[j]]
    }
    const run = selectMMR(shuffled, opts)
    if ([...run.metrics.selectedIds].sort().join('|') === baseIds) stable++
  }
  return { stability: round3(stable / n), runs: n, selectedIds: base.metrics.selectedIds }
}
