/** 前后端共用的图型契约：别名只在这里归一化，避免各组件各自判断字符串。 */
export const CHART_TYPES = [
  'line', 'bar', 'scatter', 'heatmap', 'box', 'boxplot', 'violin', 'forest',
  'surface3d', 'scatter3d', 'cone3d', 'line3d', 'filled_line3d', 'waterfall', 'lollipop', 'bubble', 'dual_axis', 'box_jitter', 'dotplot', 'paired', 'stacked'
] as const

export type CanonicalChartType = (typeof CHART_TYPES)[number] | (string & {})

const ALIASES: Record<string, string> = {
  boxplot: 'box',
  box_jitter: 'box',
  stacked: 'bar',
  dotplot: 'line',
  paired: 'line',
  '三维曲面图': 'surface3d',
  '三维散点图': 'scatter3d',
  '三维锥状图': 'cone3d',
  '贡献瀑布图': 'waterfall',
  '排名棒棒糖图': 'lollipop',
  '气泡图': 'bubble',
  小提琴图: 'violin',
  森林图: 'forest'
}

export function canonicalChartType(kind: string): CanonicalChartType {
  const value = String(kind ?? '').trim().toLowerCase()
  return ALIASES[value] ?? value
}

export const INTERACTIVE_PLACEHOLDER_TYPES = new Set(['surface3d', 'scatter3d', 'cone3d', 'line3d', 'filled_line3d', 'waterfall', 'lollipop', 'bubble', 'forest', 'violin'])

export function hasInteractivePlaceholder(kind: string): boolean {
  return INTERACTIVE_PLACEHOLDER_TYPES.has(canonicalChartType(kind))
}
