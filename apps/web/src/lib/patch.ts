// ChartSpec 受控编辑：界面操作 → SpecPatch → 引擎适配器生成最小代码 Diff。
// 可稳定映射的属性给出 unified-diff 风格最小补丁；无法安全反推的自定义代码进入“代码主导模式”，不静默改写。
import type { ChartSpec, EngineKind, SpecPatch } from '../types'

export interface DiffLine {
  type: 'ctx' | 'add' | 'del'
  text: string
}

export interface PatchResult {
  spec: ChartSpec
  diff: DiffLine[]
  codeLed: boolean // true = 进入代码主导模式，仅提示不同步改写
  note?: string
}

type Seg = string

function parsePath(path: string): Seg[] {
  return path.split('.').filter(Boolean)
}

function resolveTarget(spec: ChartSpec, kind: string, id: string): unknown {
  if (kind === 'figure') return spec.figure
  const groups: Record<string, unknown[]> = {
    panel: spec.panels,
    layer: spec.panels.flatMap((p) => p.layers),
    scale: spec.panels.flatMap((p) => p.scales),
    legend: spec.panels.map((p) => p.legend),
    annotation: spec.panels.flatMap((p) => p.annotations)
  }
  return (groups[kind] ?? []).find((x) => (x as { [k: string]: unknown })[`${kind}_id`] === id)
}

function setDeep(spec: ChartSpec, path: string, value: unknown): ChartSpec {
  const next: ChartSpec = structuredClone(spec)
  const segs = parsePath(path)
  let cur: Record<string, unknown> = next as unknown as Record<string, unknown>
  for (let i = 0; i < segs.length - 1; i++) {
    const seg = segs[i]
    const nextSeg = segs[i + 1]
    const arr = cur[seg]
    if (Array.isArray(arr)) {
      // 下一段是元素稳定 id
      const el = arr.find((x) => (x as Record<string, unknown>)[idKey(seg)] === nextSeg)
      cur = el as unknown as Record<string, unknown>
      i++
    } else {
      cur = arr as Record<string, unknown>
    }
  }
  cur[segs[segs.length - 1]] = value
  return next
}

function idKey(arraySeg: string): string {
  const map: Record<string, string> = {
    panels: 'panel_id',
    layers: 'layer_id',
    scales: 'scale_id',
    annotations: 'annotation_id'
  }
  return map[arraySeg] ?? 'id'
}

const LEGEND_LOC: Record<string, string> = {
  top: 'upper left',
  right: 'upper right',
  bottom: 'lower center',
  inside: 'upper right'
}

// 返回 [旧行, 新行] 的最小替换；命中不了返回 null（进入代码主导提示）。
function mapToPython(patch: SpecPatch, code: string): [string, string] | null {
  const after = String(patch.after)
  const before = String(patch.before)
  if (patch.path === 'figure.title') {
    const hit = code.match(/^(\s*)(ax\.(?:set_title|suptitle)|fig\.suptitle|set_title)\(".*"\)/m)
    if (hit) return [`${hit[2]}("${before}")`, `${hit[2]}("${after}")`]
    return null
  }
  if (patch.path.endsWith('.label') && patch.targetKind === 'scale') {
    const axis = patch.targetId.includes('x') ? 'x' : 'y'
    const esc = before.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // 仅当源码以字面量写明该轴标签时才能安全做最小替换；若源码使用变量（如 set_xlabel(x_col)），交代码主导模式。
    const reOld = new RegExp(`\\.set_${axis}label\\("${esc}"\\)`)
    if (reOld.test(code)) return [`ax.set_${axis}label("${before}")`, `ax.set_${axis}label("${after}")`]
    return null
  }
  if (patch.path.endsWith('.position') && patch.targetKind === 'legend') {
    return [`loc="${LEGEND_LOC[before] ?? 'upper left'}"`, `loc="${LEGEND_LOC[after] ?? 'upper left'}"`]
  }
  if (patch.path.endsWith('.visible') && patch.targetKind === 'legend') {
    return ['ax.legend(...)', after === 'true' ? 'ax.legend(frameon=False)  # 显示图例' : '# ax.legend(...)  # 隐藏图例']
  }
  if (patch.path.endsWith('.lineWidth') && patch.targetKind === 'layer') {
    return [`linewidth=${before}`, `linewidth=${after}`]
  }
  if (patch.path.endsWith('.title') && patch.targetKind === 'panel') {
    return [`set_title("${before}")`, `set_title("${after}")`]
  }
  return null
}

function buildDiff(code: string, oldLine: string, newLine: string): DiffLine[] {
  const lines = code.split('\n')
  // 直接以完整旧代码行（或其稳定子串，如 loc="upper left" / linewidth=1.4）定位，避免关键词误伤注释。
  const idx = lines.findIndex((l) => l.includes(oldLine))
  const diff: DiffLine[] = []
  if (idx >= 0) {
    if (idx > 0) diff.push({ type: 'ctx', text: lines[idx - 1] })
    diff.push({ type: 'del', text: lines[idx] })
    diff.push({ type: 'add', text: lines[idx].replace(oldLine, newLine) })
  } else {
    // 定位不到原行（例如图例显隐切换属于新增/注释操作）：只给新增行，不伪造删除。
    diff.push({ type: 'ctx', text: '# 由受控编辑生成：' })
    diff.push({ type: 'add', text: newLine })
  }
  return diff
}

export function applySpecPatch(spec: ChartSpec, patch: SpecPatch, engine: EngineKind, code: string): PatchResult {
  const next = setDeep(spec, patch.path, patch.after)
  void resolveTarget
  if (engine !== 'python') {
    return { spec: next, diff: [], codeLed: true, note: `${engine} 引擎的最小补丁映射将在适配层完成；当前在代码主导模式下提供执行与预览，不静默改写代码。` }
  }
  const mapped = mapToPython(patch, code)
  if (!mapped) {
    return {
      spec: next,
      diff: [],
      codeLed: true,
      note: '该属性未能安全反推为最小代码补丁（常见于自定义控制流/动态样式），已进入代码主导模式：界面更新预览，代码请手动确认同步。'
    }
  }
  return { spec: next, diff: buildDiff(code, mapped[0], mapped[1]), codeLed: false }
}
