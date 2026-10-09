// 记忆系统主入口：封装存储、召回、抽取、审计、embedding 为一个统一的 MemorySystem 类。
// 设计原则：
//   - 任务前 recall（同步 BM25，零等待）；任务后 extractAndStore（异步，含抽取+去重+写盘）。
//   - 删除的记忆（status='deleted'）绝不进入召回候选。
//   - embedding 默认 Null，不硬依赖外部向量 API。
import path from 'node:path'
import {
  initStore, writeMemory, readMemory, listMemories, updateMemory,
  deleteMemory, hardDeleteMemory, rebuildIndex, getMemoryDir
} from './store.js'
import { recall, recallWithRrf, tokenize } from './recall.js'
import { extractCandidates, deterministicDedup, secretScan, privacyFilter } from './extractor.js'
import { appendAudit, readAudit, AUDIT_ACTIONS } from './audit.js'
import { getEmbeddingProvider, setEmbeddingProvider } from './embedding.js'

export class MemorySystem {
  /**
   * @param {{memoryRoot:string, crossProjectRecall?:boolean, embeddingProvider?:object}} opts
   */
  constructor(opts = {}) {
    if (!opts.memoryRoot) throw new TypeError('MemorySystem 需要 memoryRoot')
    this.memoryRoot = path.resolve(opts.memoryRoot)
    this.crossProjectRecall = opts.crossProjectRecall === true
    if (opts.embeddingProvider) setEmbeddingProvider(opts.embeddingProvider)
  }

  /** 初始化：建目录、重建索引 */
  async init() {
    initStore(this.memoryRoot)
    rebuildIndex()
  }

  /**
   * 同步 BM25 召回（不调用 embedding）。
   * @param {string} query
   * @param {{topK?:number, scope?:string, scopeRef?:string, type?:string}} opts
   */
  recall(query, opts = {}) {
    const results = recall(query, {
      ...opts,
      memoryRoot: this.memoryRoot,
      crossProjectRecall: this.crossProjectRecall
    })
    // 记录召回审计（轻量）
    try {
      appendAudit(this.memoryRoot, AUDIT_ACTIONS.RECALL, null, {
        query, topK: opts.topK || 5, memoryIds: results.map((r) => r.memory.memoryId)
      })
    } catch { /* 审计失败不阻断召回 */ }
    return results
  }

  /**
   * 异步召回：若 embedding provider 可用则计算向量结果并 RRF 融合，否则退化为 BM25。
   * @param {string} query
   * @param {object} opts 同 recall
   */
  async recallAsync(query, opts = {}) {
    const bm25Results = this.recall(query, opts)
    const provider = getEmbeddingProvider()
    if (!provider.available) return bm25Results
    // provider 可用：对 active 记忆做向量相似度
    try {
      const active = listMemories({ status: 'active' })
      const texts = active.map((m) => `${m.summary}\n${(m.retrievalTerms || []).join(' ')}`)
      const [qVec, docVecs] = await Promise.all([
        provider.embed([query]),
        provider.embed(texts)
      ])
      const q = qVec[0] || []
      const scored = active.map((mem, i) => {
        const d = docVecs[i] || []
        return { memory: mem, score: cosineSim(q, d) }
      }).filter((r) => r.score > 0).sort((a, b) => b.score - a.score)
      const embeddingResults = scored.slice(0, opts.topK || 5)
      return recallWithRrf(query, { bm25Results, embeddingResults, topK: opts.topK || 5 })
    } catch (e) {
      process.stderr.write(`[memory] embedding 召回失败，退化为 BM25: ${e.message}\n`)
      return bm25Results
    }
  }

  /**
   * 任务后抽取 + 去重 + 写盘。
   * @param {object} taskResult 见 extractor.extractCandidates 入参
   * @param {{autoConfirm?:boolean}} opts autoConfirm=true 时直接写入；否则返回候选待确认
   * @returns {{written:object[], skipped:object[], rejected:object[]}}
   */
  extractAndStore(taskResult, opts = {}) {
    const candidates = extractCandidates(taskResult)
    const existing = listMemories({ status: 'active' })
    const deduped = deterministicDedup(candidates, existing)
    const written = []
    const skipped = []
    const rejected = []
    for (const { candidate, isDuplicate, existing: dupMem } of deduped) {
      // 秘密扫描：命中则拒绝
      if (secretScan(candidate.summary)) {
        rejected.push({ candidate, reason: 'secret_detected' })
        continue
      }
      // 隐私过滤
      const clean = privacyFilter(candidate.summary)
      candidate.summary = clean
      candidate.retrievalTerms = candidate.retrievalTerms.map((t) => privacyFilter(t))
      if (isDuplicate && dupMem) {
        // 重复：新候选成为 active 记忆，旧条目标记 superseded，形成 supersedes 链
        const newMem = writeMemory({
          ...candidate,
          summary: clean,
          retrievalTerms: candidate.retrievalTerms,
          supersedes: dupMem.memoryId
        })
        updateMemory(dupMem.memoryId, { status: 'superseded' })
        appendAudit(this.memoryRoot, AUDIT_ACTIONS.SUPERSEDE, newMem.memoryId, { oldMemoryId: dupMem.memoryId })
        written.push(newMem)
        continue
      }
      if (opts.autoConfirm === false) {
        skipped.push(candidate)
        continue
      }
      // autoConfirm 默认 true（任务后自动写入）
      const mem = writeMemory(candidate)
      written.push(mem)
    }
    // 写盘后重建索引
    if (written.length > 0) rebuildIndex()
    return { written, skipped, rejected }
  }

  /** 读取单条记忆 */
  get(memoryId) { return readMemory(memoryId) }

  /** 列表过滤 */
  list(opts = {}) { return listMemories(opts) }

  /** 更新记忆 */
  update(memoryId, updates) { return updateMemory(memoryId, updates) }

  /** 软删除（status='deleted'），删除后不可召回 */
  delete(memoryId) {
    const res = deleteMemory(memoryId)
    if (res) rebuildIndex()
    return res
  }

  /** 物理删除（不可恢复） */
  hardDelete(memoryId) {
    const res = hardDeleteMemory(memoryId)
    if (res) rebuildIndex()
    return res
  }

  /**
   * 撤销最近一次对该记忆的变更（从审计日志恢复）。
   * 仅支持 undo 最近一次 update 或 delete；hard_delete 不可撤销。
   */
  undo(memoryId) {
    const entries = readAudit(this.memoryRoot, { memoryId, limit: 20 })
    for (const e of entries) {
      if (e.action === AUDIT_ACTIONS.HARD_DELETE) return null
      if (e.action === AUDIT_ACTIONS.DELETE && e.details?.snapshot) {
        const snap = e.details.snapshot
        // 直接覆盖文件以恢复快照（status 回到快照中的状态，通常为 active）
        const restored = updateMemory(memoryId, snap)
        return restored
      }
      if (e.action === AUDIT_ACTIONS.UPDATE && e.details?.before) {
        return updateMemory(memoryId, e.details.before)
      }
    }
    return null
  }

  /** 比较两条记忆 summary 的差异（简单行级 diff） */
  diff(memoryIdA, memoryIdB) {
    const a = readMemory(memoryIdA)
    const b = readMemory(memoryIdB)
    if (!a || !b) return null
    const linesA = String(a.summary).split('\n')
    const linesB = String(b.summary).split('\n')
    const maxLen = Math.max(linesA.length, linesB.length)
    const diff = []
    for (let i = 0; i < maxLen; i++) {
      if (linesA[i] === linesB[i]) continue
      diff.push({ line: i + 1, left: linesA[i] ?? null, right: linesB[i] ?? null })
    }
    return { a: memoryIdA, b: memoryIdB, identical: diff.length === 0, diff }
  }

  /** 导出所有 active 记忆为 JSON 数组 */
  exportAll() {
    const active = listMemories({ status: 'active' })
    appendAudit(this.memoryRoot, AUDIT_ACTIONS.EXPORT, null, { count: active.length })
    return active
  }

  /** 读取审计日志 */
  getAudit(opts = {}) { return readAudit(this.memoryRoot, opts) }

  /** 重建索引 */
  rebuildIndex() { return rebuildIndex() }
}

/** 余弦相似度（向量需等长） */
function cosineSim(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length === 0 || a.length !== b.length) return 0
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

// 导出 tokenize 供测试复用
export { tokenize }
