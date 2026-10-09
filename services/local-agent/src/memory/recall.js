// BM25 召回（Okapi BM25，k1=1.5, b=0.75），纯内存倒排索引，零外部依赖。
// 分词：中文按字符 bigram（单字保底），英文按单词小写化，去停用词。
// 关键约束：status='deleted' 与 'superseded' 的记忆绝对不进入召回候选。
import { listMemories } from './store.js'

const K1 = 1.5
const B = 0.75
const RRF_K = 60 // Reciprocal Rank Fusion 常数

// 极简中英文停用词表（召回场景下的高频无意义词）
const STOPWORDS = new Set([
  '的', '了', '和', '是', '在', '我', '有', '也', '就', '不', '人', '都', '一', '一个',
  '上', '也', '很', '到', '说', '要', '去', '你', '会', '着', '没有', '看', '好', '自己',
  'this', 'that', 'these', 'those', 'is', 'are', 'was', 'were', 'be', 'been', 'to', 'of',
  'and', 'or', 'a', 'an', 'the', 'in', 'on', 'at', 'for', 'with', 'as', 'by', 'it', 'its',
  'this', 'that', 'from', 'by', 'we', 'you', 'they', 'i', 'he', 'she', 'them', 'their'
])

/**
 * 中英文混合分词。
 * - 中文连续片段：滑窗生成 bigram；长度为 1 时保留单字。
 * - 英文/数字片段：按单词切分，小写化。
 * - 过滤停用词与纯标点。
 * @param {string} text
 * @returns {string[]} 词元数组
 */
export function tokenize(text) {
  if (!text || typeof text !== 'string') return []
  const tokens = []
  // 先按英文/数字串与中文串切分
  // 匹配：连续中文（CJK 统一表意文字）或连续英文/数字
  const segments = text.toLowerCase().match(/[一-鿿]+|[a-z0-9]+/g) || []
  for (const seg of segments) {
    if (/^[一-鿿]/.test(seg)) {
      // 中文：bigram
      if (seg.length === 1) {
        tokens.push(seg)
      } else {
        for (let i = 0; i < seg.length - 1; i++) {
          tokens.push(seg.slice(i, i + 2))
        }
        // 同时保留单字以提升短查询召回
        for (const ch of seg) tokens.push(ch)
      }
    } else {
      // 英文/数字
      tokens.push(seg)
    }
  }
  return tokens.filter((t) => t && !STOPWORDS.has(t) && t.length > 0)
}

/**
 * 从记忆列表构建内存倒排索引。
 * @param {object[]} memories 已过滤的 active 记忆
 * @returns {{docs:object[], df:Map<string,number>, docTermFreq:Map<number,Map<string,number>>, docLen:number[], avgdl:number, N:number}}
 */
function buildIndex(memories) {
  const docs = []
  const df = new Map() // term -> 文档数
  const docTermFreq = new Map() // docIdx -> Map(term -> tf)
  const docLen = []
  memories.forEach((mem, idx) => {
    // 检索文本 = summary + retrievalTerms
    const text = `${mem.summary || ''}\n${(mem.retrievalTerms || []).join(' ')}`
    const tokens = tokenize(text)
    docs.push({ memory: mem, tokens })
    docLen.push(tokens.length)
    const tf = new Map()
    for (const t of tokens) tf.set(t, (tf.get(t) || 0) + 1)
    docTermFreq.set(idx, tf)
    for (const term of tf.keys()) df.set(term, (df.get(term) || 0) + 1)
  })
  const N = memories.length
  const avgdl = docLen.length > 0 ? docLen.reduce((a, b) => a + b, 0) / docLen.length : 1
  return { docs, df, docTermFreq, docLen, avgdl: avgdl || 1, N }
}

/** 计算单条文档对查询的 BM25 得分 */
function bm25Score(queryTokens, docIdx, index) {
  const { df, docTermFreq, docLen, avgdl, N } = index
  const tf = docTermFreq.get(docIdx)
  if (!tf) return 0
  const dl = docLen[docIdx]
  let score = 0
  const matched = []
  for (const term of queryTokens) {
    const f = tf.get(term) || 0
    if (f === 0) continue
    matched.push(term)
    // IDF，采用标准 BM25+1 公式避免负 IDF
    const n = df.get(term) || 0
    const idf = Math.log(1 + (N - n + 0.5) / (n + 0.5))
    const denom = f + K1 * (1 - B + B * dl / avgdl)
    score += idf * (f * (K1 + 1)) / denom
  }
  return { score, matchedTerms: [...new Set(matched)] }
}

/**
 * 作用域过滤：global 始终召回；同 scope 需 scopeRef 匹配。
 * 跨项目召回仅在 crossProjectRecall=true 时放行其他 project 记忆。
 */
function passesScope(mem, opts) {
  if (mem.status !== 'active') return false
  if (mem.scope === 'global') return true
  if (!opts.scope) return false
  if (mem.scope !== opts.scope) return false
  if (mem.scope === 'project' && opts.crossProjectRecall === true) return true
  return mem.scopeRef === opts.scopeRef
}

/**
 * 同步 BM25 召回。
 * @param {string} query 查询文本
 * @param {{topK?:number, scope?:string, scopeRef?:string, type?:string, memoryRoot?:string, crossProjectRecall?:boolean}} opts
 * @returns {{memory:object, score:number, matchedTerms:string[]}[]}
 */
export function recall(query, opts = {}) {
  const topK = opts.topK || 5
  // 1. 加载 active 记忆（listMemories 已可按 status 过滤）
  let candidates = listMemories({ status: 'active', type: opts.type })
  // 2. 作用域过滤
  candidates = candidates.filter((m) => passesScope(m, opts))
  if (candidates.length === 0) return []
  // 3. 构建索引并打分
  const index = buildIndex(candidates)
  const queryTokens = tokenize(query)
  if (queryTokens.length === 0) return []
  const scored = []
  for (let i = 0; i < candidates.length; i++) {
    const { score, matchedTerms } = bm25Score(queryTokens, i, index)
    if (score > 0) scored.push({ memory: candidates[i], score, matchedTerms })
  }
  scored.sort((a, b) => b.score - a.score || a.memory.memoryId.localeCompare(b.memory.memoryId))
  // 记录召回审计（仅在传入 memoryRoot 时）
  return scored.slice(0, topK)
}

/**
 * RRF（Reciprocal Rank Fusion）融合 BM25 与 embedding 排序结果。
 * @param {string} _query 保留参数（当前未使用）
 * @param {{bm25Results:Array, embeddingResults:Array, topK?:number}} opts
 * @returns {{memory:object, score:number, sources:string[]}[]}
 */
export function recallWithRrf(_query, opts = {}) {
  const bm25Results = opts.bm25Results || []
  const embeddingResults = opts.embeddingResults || []
  const topK = opts.topK || 5
  const scores = new Map() // memoryId -> { memory, score, sources:Set }
  const apply = (results, sourceName) => {
    results.forEach((r, rank) => {
      const mem = r.memory || r
      const id = mem.memoryId
      const contribution = 1 / (RRF_K + rank + 1)
      const entry = scores.get(id) || { memory: mem, score: 0, sources: new Set() }
      entry.score += contribution
      entry.sources.add(sourceName)
      scores.set(id, entry)
    })
  }
  apply(bm25Results, 'bm25')
  apply(embeddingResults, 'embedding')
  const merged = [...scores.values()].sort((a, b) => b.score - a.score)
  return merged.slice(0, topK).map((e) => ({
    memory: e.memory,
    score: e.score,
    sources: [...e.sources]
  }))
}
