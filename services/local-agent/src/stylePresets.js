// 学术图表样式预设（V2 中性命名）。
// 旧版预设 id 使用 Nature/Science/Cell 等期刊名，可能被误解为"官方适配"，
// V2 改为可验证的中性描述性 id，并保留旧 id 作为 alias 映射以免破坏既有引用。
// specification 字段为可验证的结构化属性（栏数/字体/图例位置/线宽），供前端与契约校验。

export const LEGEND_POSITIONS = ['top', 'bottom', 'left', 'right', 'center', 'inside']

/**
 * 样式预设表。
 * - id：中性可验证标识（不再暗示某期刊官方风格）；
 * - theme：写入 spec.figure.theme 的主题键（与 id 一致，中性命名）；
 * - specification：{ columns, fontFamily, legendPosition, lineWidth } 可验证属性。
 */
export const STYLE_PRESETS = [
  {
    id: 'two-column-sans',
    name: '双栏无衬线',
    theme: 'two-column-sans',
    fontFamily: 'sans',
    legend: 'top',
    lineWidth: 1.6,
    colors: ['#2F6B4F', '#B65C3A', '#3F6D8E'],
    specification: { columns: 2, fontFamily: 'sans', legendPosition: 'top', lineWidth: 1.6 }
  },
  {
    id: 'compact-sans-grid',
    name: '紧凑无衬线网格',
    theme: 'compact-sans-grid',
    fontFamily: 'sans',
    legend: 'right',
    lineWidth: 1.4,
    colors: ['#1B5E8C', '#A64B3C', '#6A7B3F'],
    specification: { columns: 2, fontFamily: 'sans', legendPosition: 'right', lineWidth: 1.4 }
  },
  {
    id: 'high-contrast-colorblind',
    name: '高对比色盲友好',
    theme: 'high-contrast-colorblind',
    fontFamily: 'sans',
    legend: 'bottom',
    lineWidth: 1.8,
    colors: ['#0072B2', '#D55E00', '#009E73'],
    specification: { columns: 1, fontFamily: 'sans', legendPosition: 'bottom', lineWidth: 1.8 }
  },
  {
    id: 'ieee-double-column-serif',
    name: 'IEEE 双栏衬线',
    theme: 'ieee-double-column-serif',
    fontFamily: 'serif',
    legend: 'inside',
    lineWidth: 1.2,
    colors: ['#222222', '#666666', '#999999'],
    specification: { columns: 2, fontFamily: 'serif', legendPosition: 'inside', lineWidth: 1.2 }
  },
  {
    id: 'monochrome-print',
    name: '单色打印',
    theme: 'monochrome-print',
    fontFamily: 'serif',
    legend: 'center',
    lineWidth: 1.5,
    colors: ['#111111', '#555555', '#999999'],
    specification: { columns: 1, fontFamily: 'serif', legendPosition: 'center', lineWidth: 1.5 }
  },
  {
    id: 'presentation-bold',
    name: '学术汇报粗线',
    theme: 'presentation-bold',
    fontFamily: 'sans',
    legend: 'left',
    lineWidth: 2.4,
    colors: ['#315C8C', '#C06A3B', '#5B8060'],
    specification: { columns: 1, fontFamily: 'sans', legendPosition: 'left', lineWidth: 2.4 }
  }
]

/**
 * 旧预设 id → 新中性 id 的别名映射，避免破坏既有的前端/API 引用。
 * 解析顺序：先按新 id 精确匹配，未命中再查此表。
 */
export const STYLE_PRESET_ALIASES = Object.freeze({
  nature: 'two-column-sans',
  science: 'compact-sans-grid',
  cell: 'high-contrast-colorblind',
  ieee: 'ieee-double-column-serif',
  grayscale: 'monochrome-print',
  presentation: 'presentation-bold'
})

/** 解析预设 id（兼容旧别名） */
export function resolvePresetId(presetId) {
  const hit = STYLE_PRESETS.find((item) => item.id === presetId)
  if (hit) return presetId
  const aliased = STYLE_PRESET_ALIASES[presetId]
  if (aliased && STYLE_PRESETS.find((item) => item.id === aliased)) return aliased
  return null
}

export function buildPresetPatches(plan, presetId) {
  const resolvedId = resolvePresetId(presetId)
  const preset = STYLE_PRESETS.find((item) => item.id === resolvedId)
  if (!preset) throw new Error(`STYLE_PRESET_NOT_FOUND:${presetId}`)
  const patches = []
  const push = (patch) => { if (patch.before !== patch.after) patches.push(patch) }
  push({ targetKind: 'figure', targetId: plan.spec.figure.figure_id, path: 'theme', label: `样式预设：${preset.name}`, before: plan.spec.figure.theme, after: preset.theme })
  push({ targetKind: 'figure', targetId: plan.spec.figure.figure_id, path: 'fontFamily', label: '预设字体', before: plan.spec.figure.fontFamily, after: preset.fontFamily })
  for (const panel of plan.spec.panels) {
    push({ targetKind: 'panel', targetId: panel.panel_id, path: 'legend.position', label: '预设图例位置', before: panel.legend.position, after: preset.legend })
    panel.layers.forEach((layer, index) => {
      push({ targetKind: 'panel', targetId: panel.panel_id, path: `layers.${layer.layer_id}.lineWidth`, label: `预设线宽 ${layer.label}`, before: layer.lineWidth, after: preset.lineWidth })
      push({ targetKind: 'panel', targetId: panel.panel_id, path: `layers.${layer.layer_id}.color`, label: `预设颜色 ${layer.label}`, before: layer.color, after: preset.colors[index % preset.colors.length] })
    })
  }
  return patches
}

export function applyStylePresetToPlan(plan, presetId) {
  const resolvedId = resolvePresetId(presetId)
  const preset = STYLE_PRESETS.find((item) => item.id === resolvedId)
  if (!preset) throw new Error(`STYLE_PRESET_NOT_FOUND:${presetId}`)
  const next = structuredClone(plan)
  next.spec.figure.theme = preset.theme
  next.spec.figure.fontFamily = preset.fontFamily
  for (const panel of next.spec.panels) {
    panel.legend.position = preset.legend
    panel.layers.forEach((layer, index) => {
      layer.lineWidth = preset.lineWidth
      layer.color = preset.colors[index % preset.colors.length]
    })
  }
  return next
}
