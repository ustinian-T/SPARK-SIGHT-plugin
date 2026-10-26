// 图型契约的后端镜像：候选池、澄清解析和前端占位都只使用这些稳定 id。
export const CANONICAL_CHART_TYPES = Object.freeze([
  'line', 'bar', 'scatter', 'heatmap', 'box', 'violin', 'forest', 'surface3d', 'scatter3d', 'cone3d', 'line3d', 'filled_line3d', 'dual_axis'
])

const ALIASES = Object.freeze({ boxplot: 'box', box_jitter: 'box', '三维曲面图': 'surface3d', '三维散点图': 'scatter3d', '三维锥状图': 'cone3d', '锥状图': 'cone3d', '三维折线图': 'line3d', '三维填充折线图': 'filled_line3d', 小提琴图: 'violin', 森林图: 'forest' })

export function normalizeChartType(value = '') {
  const key = String(value).trim().toLowerCase()
  return ALIASES[key] ?? key
}

export function isInteractivePlaceholderChart(value = '') {
  return ['surface3d', 'scatter3d', 'cone3d', 'forest', 'violin'].includes(normalizeChartType(value))
}
