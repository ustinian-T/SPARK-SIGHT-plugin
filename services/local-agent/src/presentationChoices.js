const LABELS = [
  ['周次', 'Week'], ['时间', 'Time'], ['产量', 'Yield'], ['温度', 'Temperature'],
  ['测量值', 'Measured value'], ['原始趋势', 'Original trend'], ['相对首点变化 (%)', 'Change relative to first observation (%)'],
  ['基准 100%', 'Baseline 100%'], ['相关性矩阵', 'Correlation matrix'], ['变量关系', 'Variable relationship']
]

// Translate known display text only; preserve unfamiliar scientific terms and units.
export function displayLabel(value, language) {
  const text = String(value ?? '')
  if (!language || language === 'auto') return text
  const match = LABELS.find(([zh, en]) => text === zh || text.toLowerCase() === en.toLowerCase())
  if (!match) return text
  return language === 'en' ? match[1] : language === 'zh' ? match[0] : `${match[0]} / ${match[1]}`
}

export function applyPresentationChoices(spec, clarification) {
  if (!clarification) return spec
  const language = clarification.labelLanguage
  spec.figure.labelLanguage = language ?? 'auto'
  spec.figure.title = displayLabel(spec.figure.title, language)
  for (const panel of spec.panels) {
    panel.title = displayLabel(panel.title, language)
    if (panel.legend && clarification.legendPosition && clarification.legendPosition !== 'auto') {
      panel.legend.position = clarification.legendPosition
      panel.legend.userSpecified = true
    }
    for (const scale of panel.scales ?? []) scale.label = displayLabel(scale.label, language)
    for (const layer of panel.layers ?? []) if (layer.label) {
      layer.sourceLabel = layer.label
      layer.label = displayLabel(layer.label, language)
    }
    for (const annotation of panel.annotations ?? []) if (annotation.text) annotation.text = displayLabel(annotation.text, language)
  }
  return spec
}
