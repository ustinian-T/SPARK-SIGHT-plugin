// 图型契约的后端镜像：候选池、澄清解析和前端占位都只使用这些稳定 id。
export const CANONICAL_CHART_TYPES = Object.freeze([
  'line', 'bar', 'scatter', 'heatmap', 'box', 'violin', 'forest', 'surface3d', 'scatter3d', 'dual_axis'
])

const ALIASES = Object.freeze({ boxplot: 'box', box_jitter: 'box', '三维曲面图': 'surface3d', '三维散点图': 'scatter3d', 小提琴图: 'violin', 森林图: 'forest' })

export function normalizeChartType(value = '') {
  const key = String(value).trim().toLowerCase()
  return ALIASES[key] ?? key
}

export function isInteractivePlaceholderChart(value = '') {
  return ['surface3d', 'scatter3d', 'forest', 'violin'].includes(normalizeChartType(value))
}
