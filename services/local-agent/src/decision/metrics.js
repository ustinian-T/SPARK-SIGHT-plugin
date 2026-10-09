// 决策质量校准指标（阶段 C 新建）。
// 这些是离线评估工具函数，不直接影响线上推荐逻辑；用于在有标注集时衡量推荐排序质量。
// 纯函数、零依赖。

/**
 * NDCG@K：归一化折转累积增益。
 * DCG@K = Σ_{i=1..min(k,n)} (2^rel_i - 1) / log2(i+1)
 * IDCG@K 为将 relevanceScores 降序排列后的理想 DCG。
 * @param {number[]} relevanceScores 按"模型预测顺序"给出的每档相关度（0~3 常见）
 * @param {number} k 截断位置
 * @returns {number} 0~1（理想排序为 1；无正相关项时为 0）
 */
export function ndcgAtK(relevanceScores, k = 3) {
  const rel = (Array.isArray(relevanceScores) ? relevanceScores : []).map(Number)
  const n = Math.max(1, k)
  const dcgOf = (list) => list.reduce((sum, r, i) => sum + (2 ** Math.max(0, r) - 1) / Math.log2(i + 2), 0)
  const dcg = dcgOf(rel.slice(0, n))
  const ideal = [...rel].sort((a, b) => b - a).slice(0, n)
  const idcg = dcgOf(ideal)
  if (idcg <= 0) return 0
  return Math.round((dcg / idcg) * 10000) / 10000
}

/**
 * Top-1 接受率：预测排名首位是否等于理想排名首位。
 * @param {Array<string[]>} predictions 每个样本预测的 id 有序列表
 * @param {Array<string[]>} groundTruth 每个样本理想的 id 有序列表
 * @returns {number} 0~1
 */
export function top1Acceptance(predictions, groundTruth) {
  const preds = Array.isArray(predictions) ? predictions : []
  const truths = Array.isArray(groundTruth) ? groundTruth : []
  if (!preds.length) return 0
  let hits = 0
  for (let i = 0; i < preds.length; i += 1) {
    if (preds[i]?.[0] != null && preds[i][0] === truths[i]?.[0]) hits += 1
  }
  return Math.round((hits / preds.length) * 10000) / 10000
}

/**
 * 校准报告：综合 NDCG@3、Top-1 接受率与样本数。
 * 理想排名位置 i 映射为分级相关度 rel = len - i（越靠前越相关）。
 * @param {Array<string[]>} predictedRanking 预测 id 排名数组
 * @param {Array<string[]>} groundTruthRanking 理想 id 排名数组
 * @returns {{ndcgAt3:number, top1Acceptance:number, predictionCount:number}}
 */
export function calibrationReport(predictedRanking, groundTruthRanking) {
  const preds = Array.isArray(predictedRanking) ? predictedRanking : []
  const truths = Array.isArray(groundTruthRanking) ? groundTruthRanking : []
  const n = preds.length
  if (!n) return { ndcgAt3: 0, top1Acceptance: 0, predictionCount: 0 }
  let ndcgSum = 0
  let top1Hits = 0
  for (let i = 0; i < n; i += 1) {
    const pred = preds[i] ?? []
    const truth = truths[i] ?? []
    const gtIndex = new Map(truth.map((id, idx) => [id, idx]))
    // 分级相关度：理想排名越靠前 rel 越高；未出现于理想集的项 rel=0
    const rel = pred.map((id) => {
      const idx = gtIndex.get(id)
      return idx === undefined ? 0 : truth.length - idx
    })
    ndcgSum += ndcgAtK(rel, 3)
    if (pred[0] === truth[0]) top1Hits += 1
  }
  return {
    ndcgAt3: Math.round((ndcgSum / n) * 10000) / 10000,
    top1Acceptance: Math.round((top1Hits / n) * 10000) / 10000,
    predictionCount: n
  }
}
