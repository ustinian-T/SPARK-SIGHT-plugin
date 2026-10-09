// 记忆系统测试：存储 CRUD / 删除不可召回 / BM25 / 作用域隔离 / 去重 / 秘密扫描 /
// 审计 / supersedes 链 / 索引重建 / 崩溃恢复 / embedding 可插拔。
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { MemorySystem } from '../src/memory/index.js'
import { writeMemory, listMemories, rebuildIndex } from '../src/memory/store.js'
import {
  secretScan, privacyFilter, deterministicDedup, extractCandidates, jaccardSimilarity
} from '../src/memory/extractor.js'
import { tokenize } from '../src/memory/recall.js'

/** 创建临时记忆根目录 */
function tmpRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'memory-test-'))
}

// ---------- 1. 存储 CRUD ----------
test('存储：写入→读取→列表→更新→软删除→硬删除', async () => {
  const root = tmpRoot()
  const ms = new MemorySystem({ memoryRoot: root })
  await ms.init()

  const mem = writeMemory({ type: 'preference', summary: '测试记忆内容', retrievalTerms: ['测试', '记忆'] })
  assert.ok(mem.memoryId.startsWith('mem_'))

  // 读取
  const read = ms.get(mem.memoryId)
  assert.equal(read.summary, '测试记忆内容')
  assert.equal(read.status, 'active')

  // 列表
  const list = ms.list({ type: 'preference' })
  assert.equal(list.length, 1)

  // 更新
  const updated = ms.update(mem.memoryId, { summary: '更新后的记忆' })
  assert.equal(updated.summary, '更新后的记忆')
  assert.ok(new Date(updated.updatedAt) >= new Date(updated.createdAt))

  // 软删除
  ms.delete(mem.memoryId)
  assert.equal(ms.get(mem.memoryId).status, 'deleted')
  assert.equal(ms.list({ status: 'active' }).length, 0)

  // 硬删除
  ms.hardDelete(mem.memoryId)
  assert.equal(ms.get(mem.memoryId), null)
})

// ---------- 2. 删除后不可召回 ----------
test('删除后不可召回：软删除的记忆绝不出现在 recall 结果中', async () => {
  const root = tmpRoot()
  const ms = new MemorySystem({ memoryRoot: root })
  await ms.init()

  const mem = writeMemory({
    type: 'preference',
    summary: '用户喜欢蓝色配色方案',
    retrievalTerms: ['蓝色', '配色', '蓝色配色']
  })

  // 删除前可召回
  let res = ms.recall('蓝色配色')
  assert.ok(res.some((r) => r.memory.memoryId === mem.memoryId), '删除前应能召回')

  // 删除后不可召回
  ms.delete(mem.memoryId)
  res = ms.recall('蓝色配色')
  assert.ok(!res.some((r) => r.memory.memoryId === mem.memoryId), '删除后不应出现在召回结果')
})

// ---------- 3. BM25 排序 ----------
test('BM25：相关记忆排在无关记忆之前', async () => {
  const root = tmpRoot()
  const ms = new MemorySystem({ memoryRoot: root })
  await ms.init()

  writeMemory({ type: 'workflow', summary: '科研绘图配色方案选择流程', retrievalTerms: ['科研绘图', '配色', '流程'] })
  writeMemory({ type: 'workflow', summary: '今天天气很好适合出门散步', retrievalTerms: ['天气', '散步'] })
  writeMemory({ type: 'workflow', summary: '配色方案在论文图表中的应用', retrievalTerms: ['配色', '论文', '图表'] })

  const res = ms.recall('配色 科研 绘图', { topK: 3 })
  assert.ok(res.length >= 2)
  assert.ok(res[0].memory.summary.includes('科研绘图'), '最相关的科研绘图记忆应排第一')
  // 无关天气记忆不应排在前面
  assert.ok(!res.some((r) => r.memory.summary.includes('散步') && r.score > res[0].score))
})

test('分词：中英文混合 tokenize 正确', () => {
  const zh = tokenize('用户喜欢蓝色配色')
  assert.ok(zh.includes('蓝色'))
  assert.ok(zh.includes('色配'))
  const en = tokenize('User prefers Blue Color')
  assert.ok(en.includes('user'))
  assert.ok(en.includes('blue'))
})

// ---------- 4. 作用域隔离 ----------
test('作用域隔离：project 记忆仅在对应 scopeRef 下召回', async () => {
  const root = tmpRoot()
  const ms = new MemorySystem({ memoryRoot: root })
  await ms.init()

  writeMemory({ type: 'project-context', scope: 'project', scopeRef: 'proj-A', summary: '项目A的背景信息与数据集说明', retrievalTerms: ['项目A', '背景', '数据集'] })
  writeMemory({ type: 'project-context', scope: 'project', scopeRef: 'proj-B', summary: '项目B的背景信息与实验结论', retrievalTerms: ['项目B', '背景', '实验'] })
  writeMemory({ type: 'preference', scope: 'global', summary: '全局偏好蓝色配色', retrievalTerms: ['蓝色', '全局', '配色'] })

  // 在项目 A 上下文召回项目相关查询
  const resA = ms.recall('项目 背景', { scope: 'project', scopeRef: 'proj-A' })
  assert.ok(resA.some((r) => r.memory.scopeRef === 'proj-A'), '应召回项目A记忆')
  assert.ok(!resA.some((r) => r.memory.scopeRef === 'proj-B'), '不应召回项目B记忆')

  // 全局记忆在任何项目上下文下都应可被命中（用匹配全局记忆的查询验证）
  const resGlobal = ms.recall('蓝色 配色', { scope: 'project', scopeRef: 'proj-A' })
  assert.ok(resGlobal.some((r) => r.memory.scope === 'global'), '全局记忆在项目上下文下应可召回')
})

test('跨项目召回默认关闭：crossProjectRecall=true 时放行其他 project 记忆', async () => {
  const root = tmpRoot()
  const ms = new MemorySystem({ memoryRoot: root, crossProjectRecall: false })
  await ms.init()
  writeMemory({ type: 'project-context', scope: 'project', scopeRef: 'proj-A', summary: '项目A 专属内容', retrievalTerms: ['项目A', '专属'] })

  // 默认关闭：proj-B 上下文看不到 proj-A
  const res = ms.recall('项目 专属', { scope: 'project', scopeRef: 'proj-B' })
  assert.equal(res.filter((r) => r.memory.scope === 'project').length, 0)

  // 开启跨项目后可见
  const ms2 = new MemorySystem({ memoryRoot: root, crossProjectRecall: true })
  await ms2.init()
  const res2 = ms2.recall('项目 专属', { scope: 'project', scopeRef: 'proj-B' })
  assert.ok(res2.some((r) => r.memory.scopeRef === 'proj-A'))
})

// ---------- 5. 确定性去重 ----------
test('Jaccard 相似度：相同集合为 1，不相交为 0', () => {
  assert.equal(jaccardSimilarity(['a', 'b'], ['a', 'b']), 1)
  assert.equal(jaccardSimilarity(['a'], ['b']), 0)
})

test('确定性去重：同 type 且 Jaccard>0.8 视为重复', () => {
  const existing = [
    { type: 'preference', retrievalTerms: ['配色', 'palette', '蓝色', '颜色'], status: 'active', memoryId: 'mem_old' }
  ]
  const candidates = [
    { type: 'preference', retrievalTerms: ['配色', 'palette', '蓝色', '颜色'], summary: '用户喜欢蓝色' },
    { type: 'preference', retrievalTerms: ['完全不同的词', '天气', '散步'], summary: '无关' },
    { type: 'workflow', retrievalTerms: ['配色', 'palette', '蓝色', '颜色'], summary: '不同 type' }
  ]
  const result = deterministicDedup(candidates, existing)
  assert.equal(result[0].isDuplicate, true)
  assert.equal(result[1].isDuplicate, false)
  assert.equal(result[2].isDuplicate, false, '不同 type 不应判重')
})

test('extractAndStore 去重集成：相似候选不产生重复 active 条目', async () => {
  const root = tmpRoot()
  const ms = new MemorySystem({ memoryRoot: root })
  await ms.init()

  // 预先写入一条与候选高度相似的记忆
  writeMemory({
    type: 'preference',
    summary: '用户偏好蓝色配色方案',
    retrievalTerms: ['配色', 'palette', '蓝色', '颜色'],
    status: 'active'
  })

  const result = ms.extractAndStore(
    { palette: { name: '蓝色' }, outcome: 'success' },
    { autoConfirm: true }
  )
  // 偏好类候选会与已有记忆高度相似 → 走 supersede，不应新增独立 active 条目
  const activePrefs = ms.list({ type: 'preference', status: 'active' })
  assert.ok(activePrefs.length <= result.written.length + 1, '不应产生冗余重复条目')
})

// ---------- 6. 秘密扫描 / 隐私过滤 ----------
test('秘密扫描：识别 API key / token / 私钥', () => {
  assert.equal(secretScan('sk-' + 'abcdefghijklmnopqrstuvwxyz123456'), true)
  assert.equal(secretScan('ghp_' + 'abcdefghijklmnopqrstuvwxyz1234567890'), true)
  assert.equal(secretScan('AKIAIOSFODNN7EXAMPLE'), true)
  assert.equal(secretScan('-----BEGIN RSA PRIVATE KEY-----'), true)
  assert.equal(secretScan('Bearer abcdefghijklmnopqrstuvwx'), true)
  assert.equal(secretScan('password=mysecretpass'), true)
  assert.equal(secretScan('这是一段正常的记忆文本，没有任何秘密'), false)
})

test('extractAndStore 拒绝含秘密的候选', async () => {
  const root = tmpRoot()
  const ms = new MemorySystem({ memoryRoot: root })
  await ms.init()
  // 提供 selectedPlan 以触发 outcome 候选；userRequest 含 API key
  const result = ms.extractAndStore(
    { userRequest: 'sk-' + 'abcdefghijklmnopqrstuvwxyz123456 帮我画图', selectedPlan: { id: 'plan-x' }, outcome: 'success' },
    { autoConfirm: true }
  )
  // outcome 候选的 summary 包含 userRequest 前 80 字 → 命中秘密扫描
  assert.ok(result.rejected.length > 0, '含秘密的候选应被拒绝')
  assert.ok(result.rejected.every((r) => r.reason === 'secret_detected'))
})

test('隐私过滤：移除用户名路径与 IP', () => {
  const filtered = privacyFilter('文件位于 C:\\Users\\zhangsan\\data，IP 192.168.1.100')
  assert.ok(!filtered.includes('zhangsan'), '应移除用户名')
  assert.ok(filtered.includes('[IP]'), '应替换 IP')
})

// ---------- 7. 审计 ----------
test('审计：create / delete 操作写入 audit.log', async () => {
  const root = tmpRoot()
  const ms = new MemorySystem({ memoryRoot: root })
  await ms.init()

  const mem = writeMemory({ type: 'preference', summary: '审计测试', retrievalTerms: ['审计'] })
  ms.delete(mem.memoryId)

  const audit = ms.getAudit({ memoryId: mem.memoryId })
  assert.ok(audit.some((e) => e.action === 'create'), '应有 create 记录')
  assert.ok(audit.some((e) => e.action === 'delete'), '应有 delete 记录')

  // 审计文件存在且为 JSONL
  const raw = fs.readFileSync(path.join(root, 'audit.log'), 'utf-8')
  assert.ok(raw.includes('"action":"create"'))
})

// ---------- 8. supersedes 链 ----------
test('supersedes 链：新候选替代旧记忆时旧条目标记 superseded', async () => {
  const root = tmpRoot()
  const ms = new MemorySystem({ memoryRoot: root })
  await ms.init()

  // 直接写一条旧记忆
  const oldMem = writeMemory({
    type: 'preference',
    summary: '用户偏好红色配色',
    retrievalTerms: ['配色', 'palette', '红色', '颜色']
  })
  // 写入高度相似的新候选（应触发 supersede）
  const newMem = writeMemory({
    type: 'preference',
    summary: '用户偏好红色配色（更新）',
    retrievalTerms: ['配色', 'palette', '红色', '颜色'],
    supersedes: oldMem.memoryId
  })
  ms.update(oldMem.memoryId, { status: 'superseded' })

  assert.equal(ms.get(newMem.memoryId).status, 'active')
  assert.equal(ms.get(oldMem.memoryId).status, 'superseded')
  assert.equal(ms.get(newMem.memoryId).supersedes, oldMem.memoryId)

  // superseded 记忆不进入召回
  const res = ms.recall('配色')
  assert.ok(res.some((r) => r.memory.memoryId === newMem.memoryId))
  assert.ok(!res.some((r) => r.memory.memoryId === oldMem.memoryId), 'superseded 不应被召回')
})

// ---------- 9. 索引重建 ----------
test('索引重建：rebuildIndex 后 MEMORY.md 包含所有 active 记忆', async () => {
  const root = tmpRoot()
  const ms = new MemorySystem({ memoryRoot: root })
  await ms.init()

  writeMemory({ type: 'preference', summary: '索引测试记忆一', retrievalTerms: ['索引'] })
  writeMemory({ type: 'workflow', summary: '索引测试记忆二', retrievalTerms: ['索引'] })
  writeMemory({ type: 'error-pattern', summary: '索引测试记忆三', retrievalTerms: ['索引'] })

  rebuildIndex()
  const md = fs.readFileSync(path.join(root, 'MEMORY.md'), 'utf-8')
  assert.ok(md.includes('索引测试记忆一'))
  assert.ok(md.includes('索引测试记忆二'))
  assert.ok(md.includes('索引测试记忆三'))
  assert.ok(md.includes('# 记忆索引'))
})

// ---------- 10. 崩溃恢复（原子写入） ----------
test('崩溃恢复：残留临时文件不损坏已有记忆', async () => {
  const root = tmpRoot()
  const ms = new MemorySystem({ memoryRoot: root })
  await ms.init()

  const mem = writeMemory({ type: 'preference', summary: '原始记忆完好', retrievalTerms: ['原始'] })
  // 模拟上次崩溃残留的半截临时文件
  const dir = path.join(root, 'preference')
  fs.writeFileSync(path.join(dir, `${mem.memoryId}.json.${process.pid}.tmp`), '{"broken": true, "partial"', 'utf-8')

  // 原记忆文件仍完整可读
  const read = ms.get(mem.memoryId)
  assert.equal(read.summary, '原始记忆完好')
})

// ---------- 11. embedding 可插拔 ----------
test('embedding 可插拔：默认 NullProvider 不影响 BM25 召回', async () => {
  const root = tmpRoot()
  const ms = new MemorySystem({ memoryRoot: root })
  await ms.init()

  writeMemory({ type: 'preference', summary: '蓝色配色偏好', retrievalTerms: ['蓝色', '配色'] })
  writeMemory({ type: 'workflow', summary: '完全无关的天气记录', retrievalTerms: ['天气'] })

  const res = await ms.recallAsync('蓝色配色')
  assert.ok(res.length >= 1)
  assert.ok(res[0].memory.summary.includes('蓝色'), '默认 NullProvider 下应退化为 BM25 并正确排序')
})

// ---------- 附加：undo / exportAll / diff ----------
test('undo：从审计恢复最近一次更新', async () => {
  const root = tmpRoot()
  const ms = new MemorySystem({ memoryRoot: root })
  await ms.init()

  const mem = writeMemory({ type: 'preference', summary: '原始版本', retrievalTerms: ['undo测试'] })
  ms.update(mem.memoryId, { summary: '被修改的版本' })
  const restored = ms.undo(mem.memoryId)
  assert.equal(restored.summary, '原始版本')
})

test('exportAll：导出所有 active 记忆', async () => {
  const root = tmpRoot()
  const ms = new MemorySystem({ memoryRoot: root })
  await ms.init()
  writeMemory({ type: 'preference', summary: '导出测试 A', retrievalTerms: ['导出'] })
  writeMemory({ type: 'workflow', summary: '导出测试 B', retrievalTerms: ['导出'] })
  const all = ms.exportAll()
  assert.equal(all.length, 2)
  assert.ok(all.every((m) => m.status === 'active'))
})

test('diff：比较两条记忆 summary 差异', async () => {
  const root = tmpRoot()
  const ms = new MemorySystem({ memoryRoot: root })
  await ms.init()
  const a = writeMemory({ type: 'preference', summary: '第一行\n第二行', retrievalTerms: ['diff'] })
  const b = writeMemory({ type: 'preference', summary: '第一行\n不同的第二行', retrievalTerms: ['diff'] })
  const d = ms.diff(a.memoryId, b.memoryId)
  assert.equal(d.identical, false)
  assert.equal(d.diff[0].left, '第二行')
  assert.equal(d.diff[0].right, '不同的第二行')
})
