const GRAYS = ['#111111', '#555555', '#888888', '#BBBBBB']

function explicitValue(text, patterns) {
  for (const pattern of patterns) {
    const match = pattern.exec(text)
    const value = match?.[1]?.trim().replace(/[。；;]+$/, '')
    if (value) return value
  }
  return undefined
}

function legendPosition(text) {
  if (!/图例/.test(text)) return undefined
  if (/右上|图内/.test(text)) return 'inside'
  if (/右侧|右边/.test(text)) return 'right'
  if (/下方|底部|下面/.test(text)) return 'bottom'
  if (/上方|顶部|上面/.test(text)) return 'top'
  return undefined
}

function academicTitle(xLabel) {
  return `不同处理组随 ${xLabel || '观测条件'} 的响应变化`
}

function suffixFor(title) {
  return title.match(/（[^（）]+）$/)?.[0] ?? ''
}

export function applyFeedbackToPlans(sourcePlans, feedback, { planId, xLabel } = {}) {
  const plans = structuredClone(sourcePlans)
  const text = String(feedback ?? '').trim()
  const targets = planId ? plans.filter((plan) => plan.plan_id === planId) : plans
  const changes = []
  const unresolved = []

  let title = explicitValue(text, [
    /(?:图表?标题|标题)\s*(?:改为|修改为|换成|设为|使用)\s*[：:]?\s*([^，,。；;]+)/i,
    /(?:图表?标题|标题)\s*[：:]\s*([^，,。；;]+)/i
  ])
  if (/标题.*(?:更学术|学术化|论文)/.test(text)) title = academicTitle(xLabel)

  const yLabel = explicitValue(text, [
    /(?:纵轴|[Yy]\s*轴)(?:标签|名称)?\s*(?:改为|修改为|换成|设为|标注为)\s*[：:]?\s*([^，,。；;]+)/i,
    /(?:纵轴|[Yy]\s*轴)(?:标签|名称)?\s*[：:]\s*([^，,。；;]+)/i
  ])
  if (/(?:纵轴|[Yy]\s*轴).*(?:单位|含义)/i.test(text) && !yLabel) {
    unresolved.push('纵轴单位未提供；请使用“纵轴改为：指标名称（单位）”明确指定')
  }

  const position = legendPosition(text)
  const hideLegend = /(?:隐藏|去掉|移除|不要).{0,4}图例|图例.{0,4}(?:隐藏|去掉|移除)/.test(text)
  const showLegend = /(?:显示|保留).{0,4}图例|图例.{0,4}(?:显示|保留)/.test(text)
  const lineWidth = Number(/(?:线宽|线条宽度).{0,8}?(\d+(?:\.\d+)?)/.exec(text)?.[1]) || undefined
  const removeDecor = /弱化装饰|数据墨水比|减少网格|去掉网格|简洁/.test(text)
  const blackWhite = /黑白|灰度|单色/.test(text)
  if (!title && blackWhite) title = '黑白印刷友好的期刊图'
  const disableErrors = /(?:不要|隐藏|去掉|移除).{0,4}误差棒/.test(text)
  const enableErrors = !disableErrors && /(?:增加|添加|显示|需要|保留)?.{0,4}误差棒/.test(text)

  for (const plan of targets) {
    if (title) {
      const suffix = planId ? '' : suffixFor(plan.spec.figure.title)
      plan.spec.figure.title = `${title}${suffix}`
      changes.push(`${plan.plan_id}: 标题`)
    }
    if (blackWhite) {
      plan.spec.figure.theme = 'convention'
      plan.series.forEach((series, index) => { series.color = GRAYS[index % GRAYS.length] })
      plan.spec.panels.forEach((panel) => panel.layers.forEach((layer, index) => { layer.color = GRAYS[index % GRAYS.length] }))
      changes.push(`${plan.plan_id}: 黑白配色`)
    }
    for (const panel of plan.spec.panels) {
      if (yLabel) {
        const scale = panel.scales.find((item) => item.axis === 'y')
        if (scale) scale.label = yLabel
      }
      if (position) panel.legend.position = position
      if (hideLegend) panel.legend.visible = false
      if (showLegend) panel.legend.visible = true
      if (removeDecor) panel.scales.forEach((scale) => { scale.grid = false })
      for (const layer of panel.layers) {
        if (lineWidth && layer.kind === 'line') layer.lineWidth = lineWidth
        if (enableErrors) layer.showErrorBars = true
        if (disableErrors) layer.showErrorBars = false
      }
    }
    if (yLabel) changes.push(`${plan.plan_id}: 纵轴标签`)
    if (position) changes.push(`${plan.plan_id}: 图例位置`)
    if (hideLegend || showLegend) changes.push(`${plan.plan_id}: 图例显隐`)
    if (lineWidth) changes.push(`${plan.plan_id}: 线宽`)
    if (removeDecor) changes.push(`${plan.plan_id}: 弱化装饰`)
    if (enableErrors || disableErrors) changes.push(`${plan.plan_id}: 误差棒`)
  }

  if (!changes.length && !unresolved.length) unresolved.push('未识别可安全应用的图表属性，请明确标题、纵轴、图例位置、线宽、误差棒或黑白样式')
  return { plans, changes: [...new Set(changes)], unresolved }
}
