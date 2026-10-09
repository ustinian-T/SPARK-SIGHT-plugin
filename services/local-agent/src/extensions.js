// 可扩展能力层：元数据插件注册、方案变体、三方文本合并、批注/显著性标记、
// 远程 R/MATLAB 授权节点与项目级实时协作记录。模块保持零第三方运行时依赖。
import { randomUUID } from 'node:crypto'
import { ApiError, ERR } from './errors.js'
import { generateCodeForSpec } from './codegen.js'

const clone = (value) => structuredClone(value)
const now = () => Date.now()
const id = (prefix) => `${prefix}_${Date.now().toString(36)}_${randomUUID().replace(/-/g, '').slice(0, 8)}`

const DEFAULT_PLUGINS = {
  charts: [
    ['grouped_bar', '分组柱状图'], ['line_error', '误差棒折线图'], ['point_scatter', '散点图'],
    ['correlation_heatmap', '相关性热力图'], ['histogram', '直方图'], ['boxplot', '箱线图'],
    ['dual_line_normalized', '1×2 复合图'], ['panel_2x2', '2×2 复合图']
  ],
  styles: [['clarity', '清晰展示'], ['convention', '论文惯例'], ['density', '高信息密度'], ['grayscale', '黑白打印']],
  engines: [['python', 'Python / Matplotlib'], ['r', 'R / ggplot2'], ['matlab', 'MATLAB']],
  tools: [['profile', '数据体检'], ['relationship', '跨表关系发现'], ['claim_verifier', '结论证据核验'], ['export', '可复现导出']],
  dataFormats: []
}

export class PluginRegistry {
  constructor(seed = DEFAULT_PLUGINS) {
    this.categories = new Map()
    for (const [category, entries] of Object.entries(seed)) {
      for (const entry of entries) this.register(category, Array.isArray(entry) ? { id: entry[0], name: entry[1], version: '1', builtin: true } : entry)
    }
  }
  register(category, plugin) {
    if (!/^[a-z][a-zA-Z0-9_-]*$/.test(String(category))) throw new ApiError(400, ERR.PLUGIN_INVALID, '插件类别不合法')
    if (!/^[a-z][a-z0-9_.-]{0,63}$/.test(String(plugin?.id ?? '')) || !String(plugin?.name ?? '').trim()) {
      throw new ApiError(400, ERR.PLUGIN_INVALID, '插件必须包含合法 id 与 name')
    }
    const map = this.categories.get(category) ?? new Map()
    const normalized = Object.freeze({ version: '1', capabilities: [], builtin: false, ...clone(plugin), category })
    map.set(normalized.id, normalized)
    this.categories.set(category, map)
    return clone(normalized)
  }
  list() { return Object.fromEntries([...this.categories].map(([category, entries]) => [category, [...entries.values()].map(clone)])) }
}

function recolor(spec, palette) {
  let index = 0
  for (const panel of spec.panels ?? []) for (const layer of panel.layers ?? []) layer.color = palette[index++ % palette.length]
}

export function generateTwoVariants(task, planId, options = {}) {
  const source = task.plans.find((plan) => plan.plan_id === planId)
  if (!source) throw new ApiError(404, ERR.PLAN_NOT_FOUND, `方案不存在：${planId}`)
  const palettes = [
    ['#2563EB', '#D97706', '#059669', '#7C3AED', '#DC2626'],
    ['#111827', '#4B5563', '#9CA3AF', '#D1D5DB', '#6B7280']
  ]
  const labels = options.labels?.length === 2 ? options.labels.map(String) : ['高对比彩色变体', '黑白打印变体']
  return palettes.map((palette, index) => {
    const variant = clone(source)
    variant.plan_id = `${source.plan_id}_variant_${index + 1}`
    variant.parentPlanId = source.plan_id
    variant.variantId = id('variant')
    variant.name = `${source.name} · ${labels[index]}`
    variant.spec.figure.title = `${source.spec.figure.title}（${labels[index]}）`
    variant.spec.figure.variant = { kind: index === 0 ? 'high_contrast' : 'grayscale', parentPlanId: source.plan_id }
    recolor(variant.spec, palette)
    const profileMeasures = task.dataset?.columns?.filter((column) => column.role === 'measure' || column.kind === 'numeric' || column.type === 'number').map((column) => column.name) ?? []
    const measures = profileMeasures.length ? profileMeasures : (source.series?.map((item) => item.label) ?? [])
    variant.code = generateCodeForSpec(variant.spec, {
      fileName: task.fileName, x: source.spec.panels?.[0]?.xLabel ?? task.dataset?.columns?.[0]?.name ?? 'x', measures,
      title: variant.spec.figure.title, yLabel: source.spec.panels?.[0]?.yLabel ?? '测量值', outputBase: variant.plan_id
    })
    variant.executionStatus = 'code_generated_not_executed'
    delete variant.verification
    return variant
  })
}

// 行级三方合并：一侧未修改时采用另一侧；双方相同修改时直接采用；其余逐项标记冲突。
export function mergeText3(baseText, currentText, incomingText) {
  const base = String(baseText ?? '').split(/\r?\n/)
  const current = String(currentText ?? '').split(/\r?\n/)
  const incoming = String(incomingText ?? '').split(/\r?\n/)
  const count = Math.max(base.length, current.length, incoming.length)
  const merged = []
  const conflicts = []
  for (let line = 0; line < count; line++) {
    const b = base[line] ?? ''
    const c = current[line] ?? ''
    const n = incoming[line] ?? ''
    if (c === n) merged.push(c)
    else if (c === b) merged.push(n)
    else if (n === b) merged.push(c)
    else {
      conflicts.push({ line: line + 1, base: b, current: c, incoming: n })
      merged.push(`<<<<<<< INTERFACE\n${c}\n=======\n${n}\n>>>>>>> CODE`)
    }
  }
  return { mergedText: merged.join('\n'), clean: conflicts.length === 0, conflicts }
}

export class CollaborationStore {
  constructor() { this.projects = new Map(); this.listeners = new Map() }
  state(projectId) {
    if (!this.projects.has(projectId)) this.projects.set(projectId, { comments: [], presence: [], sequence: 0 })
    return this.projects.get(projectId)
  }
  subscribe(projectId, listener) {
    const set = this.listeners.get(projectId) ?? new Set(); set.add(listener); this.listeners.set(projectId, set)
    return () => set.delete(listener)
  }
  emit(projectId, event) {
    const state = this.state(projectId); const stamped = { sequence: ++state.sequence, at: now(), ...event }
    for (const listener of this.listeners.get(projectId) ?? []) listener(clone(stamped))
    return stamped
  }
  addComment(projectId, user, input = {}) {
    const text = String(input.text ?? '').trim()
    if (!text) throw new ApiError(400, ERR.COMMENT_INVALID, '批注内容不能为空')
    const significance = input.significance
    if (significance) {
      const pValue = Number(significance.pValue)
      const alpha = significance.alpha === undefined ? 0.05 : Number(significance.alpha)
      if (!(pValue >= 0 && pValue <= 1) || !(alpha > 0 && alpha < 1) || !String(significance.method ?? '').trim()) {
        throw new ApiError(400, ERR.SIGNIFICANCE_INVALID, '显著性标记必须包含 method、0—1 的 pValue 与 0—1 的 alpha')
      }
    }
    const comment = {
      commentId: id('comment'), projectId, author: { userId: user.userId, displayName: user.displayName },
      text, target: clone(input.target ?? { kind: 'project', id: projectId }), significance: significance ? { method: String(significance.method), pValue: Number(significance.pValue), alpha: Number(significance.alpha ?? 0.05), significant: Number(significance.pValue) < Number(significance.alpha ?? 0.05) } : null,
      createdAt: now(), resolvedAt: null
    }
    this.state(projectId).comments.push(comment); this.emit(projectId, { type: 'comment_added', comment }); return clone(comment)
  }
  resolve(projectId, commentId, userId) {
    const comment = this.state(projectId).comments.find((item) => item.commentId === commentId)
    if (!comment) throw new ApiError(404, ERR.COMMENT_NOT_FOUND, '批注不存在')
    comment.resolvedAt = now(); comment.resolvedBy = userId; this.emit(projectId, { type: 'comment_resolved', commentId }); return clone(comment)
  }
  snapshot(projectId) { return clone(this.state(projectId)) }
}

export class RemoteNodeRegistry {
  constructor({ fetchImpl = fetch } = {}) { this.nodes = new Map(); this.fetch = fetchImpl }
  register(input = {}) {
    const engine = String(input.engine ?? '').toLowerCase()
    if (!['r', 'matlab'].includes(engine)) throw new ApiError(400, ERR.REMOTE_NODE_INVALID, '远程节点仅支持 R 或 MATLAB')
    let endpoint
    try { endpoint = new URL(String(input.endpoint)) } catch { throw new ApiError(400, ERR.REMOTE_NODE_INVALID, '远程节点 endpoint 不是合法 URL') }
    if (!['https:', 'http:'].includes(endpoint.protocol) || (endpoint.protocol === 'http:' && !['127.0.0.1', 'localhost'].includes(endpoint.hostname))) {
      throw new ApiError(400, ERR.REMOTE_NODE_INVALID, '远程节点必须使用 HTTPS；仅本机回环地址允许 HTTP')
    }
    const node = { nodeId: id('node'), name: String(input.name ?? `${engine.toUpperCase()} 节点`).slice(0, 80), engine, endpoint: endpoint.toString().replace(/\/$/, ''), credentialEnv: String(input.credentialEnv ?? '').trim(), enabled: input.enabled !== false, createdAt: now(), lastHealth: null }
    if (node.credentialEnv && !/^[A-Z][A-Z0-9_]{2,80}$/.test(node.credentialEnv)) throw new ApiError(400, ERR.REMOTE_NODE_INVALID, 'credentialEnv 必须是大写环境变量名')
    this.nodes.set(node.nodeId, node); return this.public(node)
  }
  public(node) { return { ...clone(node), credentialConfigured: !!(node.credentialEnv && process.env[node.credentialEnv]) } }
  list() { return [...this.nodes.values()].map((node) => this.public(node)) }
  headers(node) { const token = node.credentialEnv ? process.env[node.credentialEnv] : ''; return token ? { authorization: `Bearer ${token}` } : {} }
  async check(nodeId) {
    const node = this.nodes.get(nodeId); if (!node) throw new ApiError(404, ERR.REMOTE_NODE_NOT_FOUND, '远程节点不存在')
    const response = await this.fetch(`${node.endpoint}/health`, { headers: this.headers(node), signal: AbortSignal.timeout(5000) }).catch((error) => { throw new ApiError(502, ERR.REMOTE_NODE_UNAVAILABLE, `远程节点不可达：${error.name ?? 'network'}`) })
    node.lastHealth = { ok: response.ok, status: response.status, checkedAt: now() }
    if (!response.ok) throw new ApiError(502, ERR.REMOTE_NODE_UNAVAILABLE, `远程节点健康检查失败：HTTP ${response.status}`)
    return this.public(node)
  }
  async execute(request, localRunner) {
    const node = [...this.nodes.values()].find((item) => item.engine === request.engine && item.enabled)
    if (!node) return localRunner(request)
    const response = await this.fetch(`${node.endpoint}/execute`, { method: 'POST', headers: { ...this.headers(node), 'content-type': 'application/json' }, body: JSON.stringify(request), signal: AbortSignal.timeout(request.timeoutMs ?? 120000) })
    if (!response.ok) throw new Error(`REMOTE_${node.engine.toUpperCase()}_HTTP_${response.status}`)
    return response.json()
  }
}
