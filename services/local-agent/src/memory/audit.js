// 审计日志：只追加（append-only）的 JSONL，记录记忆系统的全部关键操作。
// 每行一条 { timestamp, action, memoryId, details }，不可修改、不可删除。
import fs from 'node:fs'
import path from 'node:path'

/** 允许的审计动作枚举 */
export const AUDIT_ACTIONS = Object.freeze({
  CREATE: 'create',
  UPDATE: 'update',
  DELETE: 'delete',
  HARD_DELETE: 'hard_delete',
  RECALL: 'recall',
  SUPERSEDE: 'supersede',
  EXPORT: 'export'
})

/**
 * 追加一条审计记录到 audit.log。
 * 审计日志只追加，写入使用 fs.appendFileSync（原子性由 OS 追加写保证，单行 < PIPE_BUF）。
 * @param {string} memoryRoot 记忆根目录
 * @param {string} action 动作（见 AUDIT_ACTIONS）
 * @param {string|null} memoryId 关联的记忆 ID（recall/export 可为空）
 * @param {object} details 附加详情（会被 JSON 序列化）
 */
export function appendAudit(memoryRoot, action, memoryId, details = {}) {
  const file = path.join(memoryRoot, 'audit.log')
  const entry = {
    timestamp: new Date().toISOString(),
    action,
    memoryId: memoryId ?? null,
    details
  }
  // 单行 JSONL，追加写；超长对象截断以避免单行过大
  let line
  try {
    line = JSON.stringify(entry)
  } catch {
    line = JSON.stringify({ ...entry, details: '[unserializable]' })
  }
  if (line.length > 64 * 1024) line = line.slice(0, 64 * 1024)
  fs.appendFileSync(file, line + '\n', 'utf-8')
}

/**
 * 读取审计日志。
 * @param {string} memoryRoot 记忆根目录
 * @param {{limit?:number, memoryId?:string}} opts limit: 返回条数（倒序，最新在前）；memoryId: 仅返回该记忆的记录
 * @returns {object[]} 审计条目数组
 */
export function readAudit(memoryRoot, opts = {}) {
  const file = path.join(memoryRoot, 'audit.log')
  if (!fs.existsSync(file)) return []
  const raw = fs.readFileSync(file, 'utf-8')
  const lines = raw.split(/\r?\n/).filter(Boolean)
  let entries = lines.map((line) => {
    try { return JSON.parse(line) } catch { return null }
  }).filter(Boolean)
  if (opts.memoryId) entries = entries.filter((e) => e.memoryId === opts.memoryId)
  // 倒序（最新在前）
  entries = entries.reverse()
  if (typeof opts.limit === 'number' && opts.limit > 0) entries = entries.slice(0, opts.limit)
  return entries
}
