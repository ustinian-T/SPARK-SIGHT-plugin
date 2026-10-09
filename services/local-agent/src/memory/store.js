// 文件原生记忆存储：每条记忆一个 JSON 文件，正文为可 diff 的 Markdown。
// 布局（由 memoryRoot 指定，默认 <dataDir>/memory）：
//   memory/
//   ├─ MEMORY.md                    # 可重建索引（派生物，从 active 记忆生成）
//   ├─ identity/                    # 各类型子目录，存放 <memoryId>.json
//   ├─ preference/
//   ├─ workflow/
//   ├─ dataset-schema/
//   ├─ project-context/
//   ├─ error-pattern/
//   ├─ outcome/
//   ├─ skill-candidate/
//   ├─ sources/                     # 脱敏 JSONL 证据片段
//   └─ audit.log                    # 追加式审计
//
// 写入一律「临时文件 + rename」保证原子性：写入中途崩溃不会损坏已有记忆。
import fs from 'node:fs'
import path from 'node:path'
import { appendAudit, AUDIT_ACTIONS } from './audit.js'

/** 允许的记忆类型（与子目录一一对应） */
export const MEMORY_TYPES = Object.freeze([
  'identity',
  'preference',
  'workflow',
  'dataset-schema',
  'project-context',
  'error-pattern',
  'outcome',
  'skill-candidate'
])

/** 允许的作用域 */
export const MEMORY_SCOPES = Object.freeze(['global', 'project', 'dataset', 'session'])

let _memoryRoot = null

/**
 * 确保记忆根目录与全部子目录存在。
 * @param {string} memoryRoot 记忆根目录
 * @returns {string} 规范化后的记忆根目录
 */
export function initStore(memoryRoot) {
  if (!memoryRoot) throw new TypeError('initStore 需要 memoryRoot 参数')
  _memoryRoot = path.resolve(memoryRoot)
  fs.mkdirSync(_memoryRoot, { recursive: true })
  for (const t of MEMORY_TYPES) {
    fs.mkdirSync(path.join(_memoryRoot, t), { recursive: true })
  }
  fs.mkdirSync(path.join(_memoryRoot, 'sources'), { recursive: true })
  // 审计日志文件若不存在则创建空文件
  const auditFile = path.join(_memoryRoot, 'audit.log')
  if (!fs.existsSync(auditFile)) fs.writeFileSync(auditFile, '', 'utf-8')
  return _memoryRoot
}

/** 返回当前记忆根目录（需先 initStore） */
export function getMemoryDir() {
  if (!_memoryRoot) throw new Error('记忆存储未初始化，请先调用 initStore(memoryRoot)')
  return _memoryRoot
}

/** 生成 memoryId：mem_<timestamp>_<random4> */
function generateMemoryId() {
  const ts = Date.now()
  const rand = Math.random().toString(36).slice(2, 6).padEnd(4, '0')
  return `mem_${ts}_${rand}`
}

/**
 * 在所有类型子目录中定位 memoryId 对应的 JSON 文件。
 * @param {string} memoryId
 * @returns {string|null} 文件绝对路径；未找到返回 null
 */
function locateMemoryFile(memoryId) {
  const root = getMemoryDir()
  for (const t of MEMORY_TYPES) {
    const candidate = path.join(root, t, `${memoryId}.json`)
    if (fs.existsSync(candidate)) return candidate
  }
  return null
}

/** 校验记忆字段合法性，返回规范化后的记忆对象（不写盘） */
function normalizeMemory(memory) {
  if (!memory.type || !MEMORY_TYPES.includes(memory.type)) {
    throw new Error(`非法记忆类型: ${memory.type}`)
  }
  if (memory.scope && !MEMORY_SCOPES.includes(memory.scope)) {
    throw new Error(`非法作用域: ${memory.scope}`)
  }
  const now = new Date().toISOString()
  return {
    memoryId: memory.memoryId || generateMemoryId(),
    type: memory.type,
    scope: memory.scope || 'global',
    scopeRef: memory.scopeRef ?? null,
    summary: memory.summary || '',
    retrievalTerms: Array.isArray(memory.retrievalTerms) ? memory.retrievalTerms : [],
    confidence: typeof memory.confidence === 'number' ? memory.confidence : 0.5,
    createdAt: memory.createdAt || now,
    updatedAt: now,
    expiresAt: memory.expiresAt ?? null,
    sourceRefs: Array.isArray(memory.sourceRefs) ? memory.sourceRefs : [],
    supersedes: memory.supersedes ?? null,
    status: memory.status || 'active'
  }
}

/** 原子写入 JSON 文件：先写临时文件再 rename，避免半写损坏 */
function atomicWriteJson(file, obj) {
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf-8')
  fs.renameSync(tmp, file)
}

/**
 * 写入一条新记忆（原子），并追加审计。
 * @param {object} memory 记忆对象（memoryId 可缺省，自动生成）
 * @returns {object} 写入后的完整记忆对象
 */
export function writeMemory(memory) {
  const normalized = normalizeMemory(memory)
  const dir = path.join(getMemoryDir(), normalized.type)
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${normalized.memoryId}.json`)
  if (fs.existsSync(file)) {
    throw new Error(`记忆已存在: ${normalized.memoryId}（请用 updateMemory）`)
  }
  atomicWriteJson(file, normalized)
  appendAudit(getMemoryDir(), AUDIT_ACTIONS.CREATE, normalized.memoryId, {
    type: normalized.type, scope: normalized.scope, summary: normalized.summary
  })
  return normalized
}

/**
 * 读取单条记忆。
 * @param {string} memoryId
 * @returns {object|null}
 */
export function readMemory(memoryId) {
  const file = locateMemoryFile(memoryId)
  if (!file) return null
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'))
  } catch (e) {
    process.stderr.write(`[memory-store] 读取记忆 ${memoryId} 失败: ${e.message}\n`)
    return null
  }
}

/**
 * 列出记忆，按 type/scope/status 过滤。
 * @param {{type?:string, scope?:string, status?:string}} opts
 * @returns {object[]} 记忆数组（按 createdAt 升序）
 */
export function listMemories(opts = {}) {
  const root = getMemoryDir()
  const out = []
  const types = opts.type ? [opts.type] : MEMORY_TYPES
  for (const t of types) {
    const dir = path.join(root, t)
    if (!fs.existsSync(dir)) continue
    for (const name of fs.readdirSync(dir)) {
      if (!name.endsWith('.json')) continue
      try {
        const mem = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf-8'))
        if (opts.scope && mem.scope !== opts.scope) continue
        if (opts.status && mem.status !== opts.status) continue
        out.push(mem)
      } catch (e) {
        process.stderr.write(`[memory-store] 跳过损坏记忆文件 ${name}: ${e.message}\n`)
      }
    }
  }
  out.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)))
  return out
}

/**
 * 更新记忆。保留 supersedes 链（不允许通过 update 直接覆盖 supersedes 字段以外的元关系）。
 * @param {string} memoryId
 * @param {object} updates 待更新字段（summary/retrievalTerms/confidence/expiresAt/sourceRefs/status/scopeRef）
 * @returns {object|null} 更新后的记忆；不存在返回 null
 */
export function updateMemory(memoryId, updates) {
  const existing = readMemory(memoryId)
  if (!existing) return null
  const before = { ...existing }
  // 不允许通过 update 篡改 memoryId/type/createdAt
  const forbidden = new Set(['memoryId', 'type', 'createdAt'])
  const merged = { ...existing }
  for (const [k, v] of Object.entries(updates)) {
    if (forbidden.has(k)) continue
    merged[k] = v
  }
  merged.updatedAt = new Date().toISOString()
  // 重新校验 scope
  if (merged.scope && !MEMORY_SCOPES.includes(merged.scope)) {
    throw new Error(`非法作用域: ${merged.scope}`)
  }
  const file = locateMemoryFile(memoryId)
  atomicWriteJson(file, merged)
  appendAudit(getMemoryDir(), AUDIT_ACTIONS.UPDATE, memoryId, {
    before, after: merged
  })
  return merged
}

/**
 * 软删除：status='deleted'。删除后从召回候选中移除（recall 只取 active）。
 * 同时记录快照，供 undo 使用。
 * @param {string} memoryId
 * @returns {object|null} 删除后的记忆
 */
export function deleteMemory(memoryId) {
  const existing = readMemory(memoryId)
  if (!existing) return null
  const merged = { ...existing, status: 'deleted', updatedAt: new Date().toISOString() }
  const file = locateMemoryFile(memoryId)
  atomicWriteJson(file, merged)
  appendAudit(getMemoryDir(), AUDIT_ACTIONS.DELETE, memoryId, { snapshot: existing })
  return merged
}

/**
 * 物理删除文件（需显式调用）。删除后不可恢复。
 * @param {string} memoryId
 * @returns {boolean} 是否删除成功
 */
export function hardDeleteMemory(memoryId) {
  const file = locateMemoryFile(memoryId)
  if (!file) return false
  fs.rmSync(file, { force: true })
  // 同步删除可能存在的 .md 正文附件
  const mdFile = file.replace(/\.json$/, '.md')
  if (fs.existsSync(mdFile)) fs.rmSync(mdFile, { force: true })
  appendAudit(getMemoryDir(), AUDIT_ACTIONS.HARD_DELETE, memoryId, {})
  return true
}

/**
 * 从所有 active 记忆重建 MEMORY.md 索引（派生物，可随时重建）。
 * 索引按类型分组，列出每条记忆的 memoryId + summary 首行。
 * @returns {string} 生成的 MEMORY.md 内容
 */
export function rebuildIndex() {
  const active = listMemories({ status: 'active' })
  const lines = ['# 记忆索引 (MEMORY.md)', '']
  lines.push(`> 本文件为派生物，由 rebuildIndex() 从 active 记忆自动生成，勿手动编辑。`)
  lines.push(`> 共 ${active.length} 条 active 记忆。`, '')
  for (const t of MEMORY_TYPES) {
    const group = active.filter((m) => m.type === t)
    if (group.length === 0) continue
    lines.push(`## ${t}`, '')
    for (const m of group) {
      const firstLine = String(m.summary || '').split('\n')[0].slice(0, 80)
      const scopeTag = m.scope === 'global' ? '🌐' : (m.scope === 'project' ? '📁' : (m.scope === 'dataset' ? '🗂️' : '🔒'))
      lines.push(`- [\`${m.memoryId}\`] ${scopeTag} ${firstLine}`)
    }
    lines.push('')
  }
  const content = lines.join('\n')
  const indexFile = path.join(getMemoryDir(), 'MEMORY.md')
  // 原子写 .md：临时文件 + rename
  const tmp = path.join(getMemoryDir(), `.MEMORY.md.${process.pid}.tmp`)
  fs.writeFileSync(tmp, content, 'utf-8')
  fs.renameSync(tmp, indexFile)
  return content
}
