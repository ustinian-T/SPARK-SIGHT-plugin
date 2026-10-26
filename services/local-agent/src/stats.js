// 数据可信层：确定性统计聚合 + 证据账本（EvidenceLedger）。
// 对应算法说明书 6.3 / 架构 5.3：统计在 ANALYZE 状态只执行一次，三方案共享同一结果；
// 每条统计结论生成 EvidenceRecord，自然语言结论只能引用 evidence_id（AGT-002 / CORE-010）。
import { createHash } from 'node:crypto'
import { parseCsv, toNumber, isSdColumn } from './csv.js'
import { buildSemanticModel } from './semanticModel.js'

const SD_PAIR_PATTERN = /_sd$/i

// 主图测量指标排序：科研结果字段优先于环境控制变量和成本字段。
// 角色仍完整保留在 semanticModel.fieldRoles.measure 中，只有“默认主图”使用该排序，
// 避免把温度/湿度等控制变量误选为响应趋势的纵轴；用户显式指定字段时优先服从用户。
function primaryMeasureScore(name) {
  const text = String(name)
  if (/(响应|结果|产量|response|outcome|yield)/i.test(text)) return 5
  if (/(表达|expression)/i.test(text)) return 4
  if (/(存活|survival)/i.test(text)) return 3
  if (/(指标|测量|measurement|metric)/i.test(text)) return 2
  if (/(温度|湿度|光照|经度|纬度|高程|temperature|humidity|longitude|latitude|elevation)/i.test(text)) return 0
  if (/(成本|价格|费用|cost|price)/i.test(text)) return 1
  return 1
}

function choosePrimaryMeasure(names) {
  return [...names].sort((a, b) => primaryMeasureScore(b) - primaryMeasureScore(a) || String(a).localeCompare(String(b)))[0]
}

function linearTrend(values) {
  const points = values.map((value, index) => ({ x: index, y: value })).filter((p) => Number.isFinite(p.y))
  const n = points.length
  if (n < 3) return { slope: null, intercept: null, r2: null, n }
  const meanX = points.reduce((sum, p) => sum + p.x, 0) / n
  const meanY = points.reduce((sum, p) => sum + p.y, 0) / n
  const sxx = points.reduce((sum, p) => sum + (p.x - meanX) ** 2, 0)
  const sxy = points.reduce((sum, p) => sum + (p.x - meanX) * (p.y - meanY), 0)
  const slope = sxx ? sxy / sxx : 0
  const intercept = meanY - slope * meanX
  const sst = points.reduce((sum, p) => sum + (p.y - meanY) ** 2, 0)
  const sse = points.reduce((sum, p) => sum + (p.y - (intercept + slope * p.x)) ** 2, 0)
  return { slope, intercept, r2: sst ? Math.max(0, 1 - sse / sst) : 0, n }
}

/**
 * 从已解析文本聚合测量系列（与 apps/web/src/lib/summarize.ts 同构）。
 * x 轴：优先分类/时间列，否则第一数值列；测量列：其余数值列（排除 sd/std/... 后缀），最多 4 个。
 */
function summarizeCsv(text, rawDelimiter, profile) {
  const roles = buildSemanticModel(profile, text, rawDelimiter).fieldRoles
  const identifiers = new Set([...roles.id, ...roles.replicate, ...roles.subject, ...roles.weight])
  const matrix = parseCsv(text, rawDelimiter)
  const header = matrix[0].map((h) => h.trim())
  const rows = matrix.slice(1)
  const col = (name) => header.indexOf(name)

  // 时间×分组×重复是科研时序数据的常见结构。先按“时间、组别”聚合，
  // 再把均值和误差传给绘图层，避免把每个样本编号误当成横轴观测点。
  if (roles.xTime.length && roles.group.length && roles.measure.length) {
    const timeLabel = roles.xTime[0]
    const groupLabel = roles.group[0]
    const measureLabel = choosePrimaryMeasure(roles.measure)
    const ti = col(timeLabel); const gi = col(groupLabel); const mi = col(measureLabel)
    const times = [...new Set(rows.map(r => String(r[ti] ?? '').trim()).filter(Boolean))]
    const groups = [...new Set(rows.map(r => String(r[gi] ?? '').trim()).filter(Boolean))]
    const aggregate = (values) => {
      const clean = values.filter(Number.isFinite)
      const n = clean.length
      if (!n) return { mean: null, sd: null, se: null, n: 0, values: [] }
      const mean = clean.reduce((s, v) => s + v, 0) / n
      const sd = n > 1 ? Math.sqrt(clean.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1)) : 0
      return { mean: round(mean), sd: round(sd), se: round(n > 1 ? sd / Math.sqrt(n) : 0), n, values: clean }
    }
    const series = groups.map((group, index) => {
      const cells = times.map(time => aggregate(rows.filter(r => String(r[gi] ?? '').trim() === group && String(r[ti] ?? '').trim() === time).map(r => toNumber(r[mi]))))
      return {
        id: `time_group_${index}`, label: group, x: times,
        y: cells.map(c => c.mean), yerr: cells.map(c => c.se),
        yerrKind: 'se', n: cells.map(c => c.n), sd: cells.map(c => c.sd),
        values: cells.flatMap(c => c.values), aggregation: { by: [timeLabel, groupLabel], measure: measureLabel, error: 'se' }
      }
    })
    return { xLabel: timeLabel, x: times, series, header, rows, timeGrouped: true, groupLabel, measureLabel }
  }

  const xCol =
    profile.columns.find((c) => roles.xTime.includes(c.name)) ??
    profile.columns.find((c) => ['categorical', 'datetime'].includes(c.userType ?? c.inferredType)) ??
    profile.columns.find((c) => (c.userType ?? c.inferredType) === 'numeric')
  const xIdx = xCol ? col(xCol.name) : 0
  const xLabel = header[xIdx] ?? 'x'
  const x = rows.map((r) => {
    const v = r[xIdx] ?? ''
    return toNumber(v) ?? v
  })

  const measureCols = profile.columns.filter(
    (c) => (c.userType ?? c.inferredType) === 'numeric' && c.name !== xLabel && !isSdColumn(c.name) && !identifiers.has(c.name)
  )

  const series = measureCols.slice(0, 4).map((c) => {
    const yi = col(c.name)
    const sdi = col(`${c.name}_sd`)
    const y = rows.map((r) => toNumber(r[yi]))
    const item = { id: `series_${c.index}`, label: c.name, y, values: y.filter((value) => value !== null), missing: c.missing }
    if (sdi >= 0) {
      const sd = rows.map((r) => toNumber(r[sdi]))
      if (sd.some((v) => v !== null && v > 0)) {
        item.yerr = sd
        item.yerrKind = 'sd'
      }
    }
    return item
  })

  return { xLabel, x, series, header, rows, timeGrouped: false }
}

const fmt = (n, d = 3) => {
  if (!Number.isFinite(n)) return 'NA'
  const r = Math.round(n * 10 ** d) / 10 ** d
  return String(r)
}
// 发布口径：避免浮点下溢后把极小概率写成“p=0”。
const fmtP = (p, d = 6) => Number.isFinite(p) && p < 0.001 ? 'p<0.001' : `p=${fmt(p, d)}`
const pct = (r) => `${(r * 100).toFixed(1)}%`
const round = (value, digits = 6) => Number.isFinite(value) ? Number(value.toFixed(digits)) : null

function quantile(values, probability) {
  const sorted = values.filter(Number.isFinite).slice().sort((a, b) => a - b)
  if (!sorted.length) return null
  if (sorted.length === 1) return sorted[0]
  const index = (sorted.length - 1) * probability
  const lower = Math.floor(index)
  const fraction = index - lower
  return sorted[lower] + fraction * (sorted[Math.min(lower + 1, sorted.length - 1)] - sorted[lower])
}

function paired(left, right) {
  const pairs = []
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    if (Number.isFinite(left[index]) && Number.isFinite(right[index])) pairs.push([left[index], right[index]])
  }
  return pairs
}

function pearson(left, right) {
  const pairs = paired(left, right)
  const n = pairs.length
  if (n < 3) return { n, r: null, reason: '样本量不足（Pearson 相关至少需要 3 对完整观测）' }
  const mx = pairs.reduce((sum, pair) => sum + pair[0], 0) / n
  const my = pairs.reduce((sum, pair) => sum + pair[1], 0) / n
  let covariance = 0
  let sx = 0
  let sy = 0
  for (const [x, y] of pairs) {
    covariance += (x - mx) * (y - my)
    sx += (x - mx) ** 2
    sy += (y - my) ** 2
  }
  if (sx === 0 || sy === 0) return { n, r: null, reason: '至少一个字段为常量，相关系数未定义' }
  return { n, r: round(covariance / Math.sqrt(sx * sy)) }
}

function ols(left, right) {
  const pairs = paired(left, right)
  const n = pairs.length
  if (n < 3) return { n, slope: null, intercept: null, r2: null, reason: '样本量不足（简单线性回归至少需要 3 对完整观测）' }
  const mx = pairs.reduce((sum, pair) => sum + pair[0], 0) / n
  const my = pairs.reduce((sum, pair) => sum + pair[1], 0) / n
  const sxx = pairs.reduce((sum, pair) => sum + (pair[0] - mx) ** 2, 0)
  if (sxx === 0) return { n, slope: null, intercept: null, r2: null, reason: '自变量为常量，回归斜率未定义' }
  const slope = pairs.reduce((sum, pair) => sum + (pair[0] - mx) * (pair[1] - my), 0) / sxx
  const intercept = my - slope * mx
  const total = pairs.reduce((sum, pair) => sum + (pair[1] - my) ** 2, 0)
  const residual = pairs.reduce((sum, pair) => sum + (pair[1] - (intercept + slope * pair[0])) ** 2, 0)
  return { n, slope: round(slope), intercept: round(intercept), r2: total === 0 ? null : round(1 - residual / total) }
}

const T95 = [0, 12.706, 4.303, 3.182, 2.776, 2.571, 2.447, 2.365, 2.306, 2.262, 2.228, 2.201, 2.179, 2.16, 2.145, 2.131, 2.12, 2.11, 2.101, 2.093, 2.086, 2.08, 2.074, 2.069, 2.064, 2.06, 2.056, 2.052, 2.048, 2.045]

function meanCi95(values) {
  const clean = values.filter(Number.isFinite)
  const n = clean.length
  if (n < 2) return { n, mean: n ? clean[0] : null, lower: null, upper: null, reason: '置信区间至少需要 2 个非缺失观测' }
  const mean = clean.reduce((sum, value) => sum + value, 0) / n
  const variance = clean.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (n - 1)
  const critical = n - 1 < T95.length ? T95[n - 1] : 1.96
  const margin = critical * Math.sqrt(variance / n)
  return { n, mean: round(mean), lower: round(mean - margin), upper: round(mean + margin), confidence: 0.95 }
}

/**
 * 独立样本 Cohen's d（合并标准差）。新导出函数，返回 { value, n1, n2, definition, reason? }。
 * 原有内部调用保持兼容：cohenD() 包装本函数并输出 .cohenD 字段。
 */
export function cohenDIndependent(a, b) {
  const left = (a ?? []).filter(Number.isFinite)
  const right = (b ?? []).filter(Number.isFinite)
  if (left.length < 2 || right.length < 2) {
    return { value: null, n1: left.length, n2: right.length, definition: 'independent pooled-standard-deviation', reason: '效应量每组至少需要 2 个观测' }
  }
  const ma = left.reduce((sum, value) => sum + value, 0) / left.length
  const mb = right.reduce((sum, value) => sum + value, 0) / right.length
  const va = left.reduce((sum, value) => sum + (value - ma) ** 2, 0) / (left.length - 1)
  const vb = right.reduce((sum, value) => sum + (value - mb) ** 2, 0) / (right.length - 1)
  const pooled = Math.sqrt(((left.length - 1) * va + (right.length - 1) * vb) / (left.length + right.length - 2))
  return { value: pooled === 0 ? null : round((ma - mb) / pooled), n1: left.length, n2: right.length, definition: 'independent pooled-standard-deviation' }
}

// 向后兼容包装：保留历史 .cohenD 字段（既有测试与证据账本依赖）。
function cohenD(left, right) {
  const r = cohenDIndependent(left, right)
  return { n1: r.n1, n2: r.n2, cohenD: r.value, definition: r.definition, reason: r.reason }
}

/**
 * 配对样本效应量 d_z = mean(diff) / sd(diff)，diff = a - b。
 * 入参可为两个等长数组，或一个 [a,b] 二元组数组。
 */
export function cohenDZ(a, b) {
  let pairs
  if (b === undefined) {
    // 单参数形式：[[a,b], ...]
    pairs = (Array.isArray(a) ? a : []).filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]))
  } else {
    pairs = []
    for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
      if (Number.isFinite(a[i]) && Number.isFinite(b[i])) pairs.push([a[i], b[i]])
    }
  }
  const diffs = pairs.map(([x, y]) => x - y)
  const n = diffs.length
  if (n < 2) return { value: null, n1: n, n2: n, definition: 'paired difference dz', reason: '配对效应量至少需要 2 对完整观测' }
  const mean = diffs.reduce((sum, v) => sum + v, 0) / n
  const sd = Math.sqrt(diffs.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (n - 1))
  return { value: sd === 0 ? null : round(mean / sd), n1: n, n2: n, definition: 'paired difference dz' }
}

/**
 * Hedges g：Cohen's d 的小样本无偏校正，g = d * (1 - 3 / (4*(n1+n2) - 9))。
 */
export function hedgesG(a, b) {
  const d = cohenDIndependent(a, b)
  if (d.value === null) return { value: null, n1: d.n1, n2: d.n2, definition: "Hedges g with Hedges' correction", reason: d.reason }
  const correction = 1 - 3 / (4 * (d.n1 + d.n2) - 9)
  return { value: round(d.value * correction), n1: d.n1, n2: d.n2, definition: "Hedges g with Hedges' correction" }
}

/**
 * 多重比较校正：Holm-Bonferroni 逐步法。
 * 按 p 升序排列，adjusted_(i) = max_{j<=i} (m - j + 1) * p_(j)（累积最大，封顶 1），再映回原顺序。
 */
export function holmAdjust(pValues) {
  const m = pValues.length
  const order = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p)
  const adjusted = new Array(m).fill(0)
  let runningMax = 0
  order.forEach((entry, rank) => {
    const val = (m - rank) * entry.p // rank 从 0 起，第 rank+1 小 → (m - (rank+1) + 1) = m - rank
    runningMax = Math.max(runningMax, val)
    adjusted[entry.i] = Math.min(1, runningMax)
  })
  return { adjusted: adjusted.map((v) => round(v)), method: 'holm' }
}

/**
 * 多重比较校正：Benjamini-Hochberg FDR。
 * 按 p 升序，adjusted_(i) = min_{j>=i} (m / j) * p_(j)（从大到小累积最小，封顶 1），再映回原顺序。
 */
export function bhAdjust(pValues) {
  const m = pValues.length
  const order = pValues.map((p, i) => ({ p, i })).sort((a, b) => a.p - b.p)
  const adjusted = new Array(m).fill(0)
  let runningMin = 1
  // 从最大（末位）往最小遍历，rank 升序下标
  for (let rank = m - 1; rank >= 0; rank -= 1) {
    const val = (m / (rank + 1)) * order[rank].p
    runningMin = Math.min(runningMin, val)
    adjusted[order[rank].i] = Math.min(1, runningMin)
  }
  return { adjusted: adjusted.map((v) => round(v)), method: 'bh' }
}

/**
 * 错误棒语义分类：不再仅凭 _sd 后缀笼统称作“误差”，必须记录 kind。
 * @returns {{kind:'sd'|'se'|'ci'|'range'|'unknown', source:'suffix'|'inferred'|'none'}}
 */
export function classifyErrorBar(columnName, values) {
  const name = String(columnName ?? '')
  if (/_sd$/i.test(name)) return { kind: 'sd', source: 'suffix' }
  if (/_(se|sem)$/i.test(name)) return { kind: 'se', source: 'suffix' }
  if (/_ci$/i.test(name)) return { kind: 'ci', source: 'suffix' }
  if (/_min$|_max$/i.test(name)) return { kind: 'range', source: 'suffix' }
  // 无命名后缀时，数值列本身无法区分 sd/se/ci，保守返回 unknown
  if (Array.isArray(values) && values.some((v) => Number.isFinite(v))) return { kind: 'unknown', source: 'none' }
  return { kind: 'unknown', source: 'none' }
}

function logGamma(z) {
  const coefficients = [676.5203681218851, -1259.1392167224028, 771.3234287776531, -176.6150291621406, 12.507343278686905, -0.13857109526572012, 9.984369578019572e-6, 1.5056327351493116e-7]
  if (z < 0.5) return Math.log(Math.PI) - Math.log(Math.sin(Math.PI * z)) - logGamma(1 - z)
  let x = 0.9999999999998099
  const value = z - 1
  coefficients.forEach((coefficient, index) => { x += coefficient / (value + index + 1) })
  const t = value + coefficients.length - 0.5
  return 0.5 * Math.log(2 * Math.PI) + (value + 0.5) * Math.log(t) - t + Math.log(x)
}

function betaFraction(a, b, x) {
  const maxIterations = 200
  const epsilon = 3e-12
  const tiny = 1e-30
  const qab = a + b
  const qap = a + 1
  const qam = a - 1
  let c = 1
  let d = 1 - qab * x / qap
  if (Math.abs(d) < tiny) d = tiny
  d = 1 / d
  let h = d
  for (let m = 1; m <= maxIterations; m += 1) {
    const m2 = 2 * m
    let aa = m * (b - m) * x / ((qam + m2) * (a + m2))
    d = 1 + aa * d; if (Math.abs(d) < tiny) d = tiny
    c = 1 + aa / c; if (Math.abs(c) < tiny) c = tiny
    d = 1 / d; h *= d * c
    aa = -(a + m) * (qab + m) * x / ((a + m2) * (qap + m2))
    d = 1 + aa * d; if (Math.abs(d) < tiny) d = tiny
    c = 1 + aa / c; if (Math.abs(c) < tiny) c = tiny
    d = 1 / d
    const delta = d * c
    h *= delta
    if (Math.abs(delta - 1) < epsilon) break
  }
  return h
}

function regularizedBeta(x, a, b) {
  if (x <= 0) return 0
  if (x >= 1) return 1
  const bt = Math.exp(logGamma(a + b) - logGamma(a) - logGamma(b) + a * Math.log(x) + b * Math.log(1 - x))
  return x < (a + 1) / (a + b + 2) ? bt * betaFraction(a, b, x) / a : 1 - bt * betaFraction(b, a, 1 - x) / b
}

function correlationSignificance(result) {
  if (result.r === null || result.n < 5) return { performed: false, n: result.n, r: result.r, reason: result.reason ?? '样本量不足（显著性检验要求至少 5 对完整观测）' }
  if (Math.abs(result.r) >= 1) return { performed: true, n: result.n, r: result.r, statistic: result.r > 0 ? Infinity : -Infinity, df: result.n - 2, pValue: 0, alpha: 0.05, significant: true }
  const statistic = result.r * Math.sqrt((result.n - 2) / (1 - result.r ** 2))
  const pValue = regularizedBeta((result.n - 2) / ((result.n - 2) + statistic ** 2), (result.n - 2) / 2, 0.5)
  return { performed: true, n: result.n, r: result.r, statistic: round(statistic), df: result.n - 2, pValue: round(pValue), alpha: 0.05, significant: pValue < 0.05 }
}

/**
 * 独立样本 t 检验（默认 Welch；equalVariance=true 时用合并标准差池）。
 * 双尾 p 值由 t 分布 CDF（不完全 beta）计算：p = I_{ν/(ν+t²)}(ν/2, 1/2)。
 */
export function tTestIndependent(a, b, { equalVariance = false } = {}) {
  const left = (a ?? []).filter(Number.isFinite)
  const right = (b ?? []).filter(Number.isFinite)
  if (left.length < 2 || right.length < 2) {
    return { performed: false, n1: left.length, n2: right.length, reason: 't 检验每组至少需要 2 个非缺失观测' }
  }
  const m1 = left.reduce((s, v) => s + v, 0) / left.length
  const m2 = right.reduce((s, v) => s + v, 0) / right.length
  const v1 = left.reduce((s, v) => s + (v - m1) ** 2, 0) / (left.length - 1)
  const v2 = right.reduce((s, v) => s + (v - m2) ** 2, 0) / (right.length - 1)
  const delta = m1 - m2
  if (v1 === 0 && v2 === 0) return { performed: false, n1: left.length, n2: right.length, mean1: round(m1), mean2: round(m2), reason: '两组方差均为 0（常量组），t 统计量未定义' }
  let t
  let df
  let method
  if (equalVariance) {
    const sp2 = ((left.length - 1) * v1 + (right.length - 1) * v2) / (left.length + right.length - 2)
    const se = Math.sqrt(sp2 * (1 / left.length + 1 / right.length))
    t = se === 0 ? 0 : delta / se
    df = left.length + right.length - 2
    method = 'Student t-test (pooled variance)'
  } else {
    const se = Math.sqrt(v1 / left.length + v2 / right.length)
    t = se === 0 ? 0 : delta / se
    const num = (v1 / left.length + v2 / right.length) ** 2
    const den = (v1 / left.length) ** 2 / (left.length - 1) + (v2 / right.length) ** 2 / (right.length - 1)
    df = den === 0 ? left.length + right.length - 2 : num / den
    method = 'Welch t-test (unequal variances)'
  }
  const pValue = regularizedBeta(df / (df + t * t), df / 2, 0.5)
  return {
    performed: true, n1: left.length, n2: right.length,
    mean1: round(m1), mean2: round(m2),
    statistic: round(t), df: round(df), pValue: round(pValue),
    method, alpha: 0.05, significant: pValue < 0.05
  }
}

/**
 * 单因素方差分析（ANOVA）：组间/组内平方和、F、p（F 分布右尾 = 不完全 beta）、eta²。
 * groups: [{name, values:[number]}]
 */
export function anovaOneWay(groups) {
  const clean = (groups ?? []).map((g) => ({ name: g.name, values: (g.values ?? []).filter(Number.isFinite) }))
  const valid = clean.filter((g) => g.values.length >= 2)
  if (valid.length < 2) {
    return { performed: false, k: clean.length, reason: '单因素 ANOVA 至少需要 2 组、每组至少 2 个非缺失观测' }
  }
  const k = valid.length
  const all = valid.flatMap((g) => g.values)
  const n = all.length
  const grand = all.reduce((s, v) => s + v, 0) / n
  const ssBetween = valid.reduce((s, g) => s + g.values.length * (g.values.reduce((a, v) => a + v, 0) / g.values.length - grand) ** 2, 0)
  const ssWithin = valid.reduce((s, g) => {
    const gm = g.values.reduce((a, v) => a + v, 0) / g.values.length
    return s + g.values.reduce((a, v) => a + (v - gm) ** 2, 0)
  }, 0)
  const ssTotal = ssBetween + ssWithin
  const dfBetween = k - 1
  const dfWithin = n - k
  const msBetween = ssBetween / dfBetween
  const msWithin = ssWithin / dfWithin
  const f = msWithin === 0 ? (ssBetween === 0 ? 0 : Number.POSITIVE_INFINITY) : msBetween / msWithin
  const pValue = Number.isFinite(f) && f > 0
    ? regularizedBeta(dfWithin / (dfWithin + dfBetween * f), dfWithin / 2, dfBetween / 2)
    : (f === 0 ? 1 : 0)
  return {
    performed: true, k, n, dfBetween, dfWithin,
    ssBetween: round(ssBetween), ssWithin: round(ssWithin), ssTotal: round(ssTotal),
    msBetween: round(msBetween), msWithin: round(msWithin),
    statistic: Number.isFinite(f) ? round(f) : f, pValue: round(pValue),
    etaSq: ssTotal === 0 ? null : round(ssBetween / ssTotal),
    method: 'one-way ANOVA (F-test)', alpha: 0.05, significant: pValue < 0.05
  }
}

/** p 值 → 显著性星号（科研惯例：<0.001 ***、<0.01 **、<0.05 *、否则 ns）。 */
export function significanceStars(pValue) {
  if (!Number.isFinite(pValue)) return null
  if (pValue < 0.001) return '***'
  if (pValue < 0.01) return '**'
  if (pValue < 0.05) return '*'
  return 'ns'
}

/**
 * 配对 t 检验（差值 = a − b，df = n−1，双侧；Cohen's dz 效应量）。
 * p 值口径与独立 t 检验共用 t² 双侧公式（R `t.test(a, b, paired=TRUE)` 一致）。
 */
export function pairedTTest(a, b) {
  const pairs = []
  const nMax = Math.min((a ?? []).length, (b ?? []).length)
  for (let index = 0; index < nMax; index += 1) {
    if (Number.isFinite(a[index]) && Number.isFinite(b[index])) pairs.push([a[index], b[index]])
  }
  const n = pairs.length
  if (n < 2) {
    return { performed: false, n, reason: '配对 t 检验至少需要 2 对完整观测' }
  }
  const diffs = pairs.map(([x, y]) => x - y)
  const mean = diffs.reduce((s, v) => s + v, 0) / n
  const sd = Math.sqrt(diffs.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1))
  if (sd === 0) {
    return { performed: false, n, meanDiff: round(mean), sdDiff: 0, reason: '配对差值方差为 0（全部差值相等），t 统计量未定义' }
  }
  const t = mean / (sd / Math.sqrt(n))
  const df = n - 1
  const pValue = regularizedBeta(df / (df + t * t), df / 2, 0.5)
  return {
    performed: true, n,
    meanDiff: round(mean), sdDiff: round(sd),
    statistic: round(t), df: round(df), pValue: round(pValue),
    dz: round(mean / sd), method: 'Paired t-test', alpha: 0.05, significant: pValue < 0.05
  }
}

/**
 * 异常值检测（仅诊断提示，不改动数据——数据包不变原则）：
 * IQR 法（Q1−1.5×IQR / Q3+1.5×IQR 之外）与 3σ 法（|x−mean|>3·sd），分别计数并给区间。
 */
export function detectOutliers(values) {
  const clean = (values ?? []).filter(Number.isFinite)
  const result = { iqr: { count: 0, bounds: [null, null] }, sigma3: { count: 0, bounds: [null, null] } }
  if (clean.length < 4) return result
  const q1 = quantile(clean, 0.25)
  const q3 = quantile(clean, 0.75)
  if (q1 === null || q3 === null) return result
  const iqr = q3 - q1
  if (iqr > 0) {
    const lo = q1 - 1.5 * iqr
    const hi = q3 + 1.5 * iqr
    result.iqr = { count: clean.filter((v) => v < lo || v > hi).length, bounds: [round(lo), round(hi)] }
  }
  const mean = clean.reduce((s, v) => s + v, 0) / clean.length
  const sd = clean.length > 1 ? Math.sqrt(clean.reduce((s, v) => s + (v - mean) ** 2, 0) / (clean.length - 1)) : 0
  if (sd > 0) {
    const lo = mean - 3 * sd
    const hi = mean + 3 * sd
    result.sigma3 = { count: clean.filter((v) => v < lo || v > hi).length, bounds: [round(lo), round(hi)] }
  }
  return result
}

/**
 * 数据概览（B：上传 CSV 后、进入澄清轮询前展示的体检卡数据源）。
 * 仅描述 + 诊断，不改写任何数据；异常值计数为提示，绘图仍使用原始数据。
 */
export function buildDataOverview(text, rawDelimiter, profile) {
  const matrix = parseCsv(text, rawDelimiter)
  const header = matrix[0].map((h) => h.trim())
  const rows = matrix.slice(1)
  const cap = Math.min(rows.length, 5000)
  const sample = rows.slice(0, cap)
  const columns = profile.columns.map((c) => {
    const idx = header.indexOf(c.name)
    const isNumeric = (c.userType ?? c.inferredType) === 'numeric'
    const unique = new Set()
    for (let i = 0; i < sample.length; i += 1) {
      const v = String(rows[i][idx] ?? '').trim()
      if (v !== '') unique.add(v)
      if (unique.size > 200) break
    }
    const column = {
      name: c.name,
      type: isNumeric ? 'numeric' : (c.userType ?? c.inferredType ?? 'unknown'),
      missing: c.missing ?? 0,
      missingRate: round(c.missingRate ?? 0, 4)
    }
    if (isNumeric) {
      column.min = c.min
      column.max = c.max
      column.mean = c.mean
      column.unique = null
    } else {
      column.unique = unique.size
    }
    return column
  })
  const outliers = profile.columns
    .filter((c) => (c.userType ?? c.inferredType) === 'numeric')
    .map((c) => {
      const idx = header.indexOf(c.name)
      const values = rows.map((r) => toNumber(r[idx]))
      return { column: c.name, ...detectOutliers(values) }
    })
    .filter((o) => (o.iqr.count ?? 0) > 0 || (o.sigma3.count ?? 0) > 0)
  return {
    rows: rows.length,
    cols: header.length,
    columns,
    preview: rows.slice(0, 5).map((r) => header.map((_, i) => String(r[i] ?? ''))),
    outliers,
    note: rows.length > cap ? `唯一取值与异常值统计基于前 ${cap} 行采样（共 ${rows.length} 行）` : '全部行参与统计'
  }
}

/**
 * 长表分组形态识别与聚合（科研常用：一列分组 + 一列数值）。
 * 条件：存在唯一取值 2~8 的类别列（分组列）；另有至少一个非 sd 数值列。
 * 返回 null 或 { groupCol, x, series:[{id,label,y(组均值),yerr(组标准误),n}] }，可直接驱动
 * 分组柱状图/误差棒与组间显著性检验。
 */
export function summarizeGroups(profile, text, rawDelimiter) {
  const roles = buildSemanticModel(profile, text, rawDelimiter).fieldRoles
  const measures = new Set(roles.measure)
  const matrix = parseCsv(text, rawDelimiter)
  const header = matrix[0].map((h) => h.trim())
  const rows = matrix.slice(1)
  const col = (name) => header.indexOf(name)
  // 形态判定：长表 = 一列分组（类别，2~8 个唯一取值）+ 一列数值（测量）。
  // 数值列（排除 sd 后缀）多于 1 个时按宽表（多测量列）处理，避免把宽表+备注列误判为分组。
  const numericCount = measures.size
  if (numericCount > 1) return null
  const identifiers = new Set([...roles.id, ...roles.replicate, ...roles.subject, ...roles.label])
  const catCols = profile.columns.filter((c) => !identifiers.has(c.name) && ((c.userType ?? c.inferredType) === 'categorical' || roles.group.includes(c.name)))
  if (catCols.length === 0) return null
  const candidates = catCols.map((c) => {
    const idx = col(c.name)
    const uniq = [...new Set(rows.map((r) => String(r[idx] ?? '').trim()).filter(Boolean))]
    return { col: c, idx, uniq, count: uniq.length }
  }).filter((c) => c.count >= 2 && c.count <= 8)
  if (candidates.length === 0) return null
  // 取唯一取值数量最适中的分组列（优先 3~6 组）
  candidates.sort((a, b) => Number(roles.group.includes(b.col.name)) - Number(roles.group.includes(a.col.name)) || Math.abs(a.count - 4) - Math.abs(b.count - 4) || a.count - b.count)
  const { col: groupCol, idx: gIdx, uniq: groups } = candidates[0]
  const measureNames = [...measures].filter((name) => name !== groupCol.name)
  const primaryMeasure = choosePrimaryMeasure(measureNames)
  const measureCol = profile.columns.find((c) => c.name === primaryMeasure)
  if (!measureCol) return null
  const mIdx = col(measureCol.name)
  const series = groups.map((name) => {
    const values = rows
      .filter((r) => String(r[gIdx] ?? '').trim() === name)
      .map((r) => toNumber(r[mIdx]))
      .filter(Number.isFinite)
    const n = values.length
    if (n < 1) return { name, n: 0, mean: null, sd: null, se: null, ciLow: null, ciHigh: null, values: [] }
    const mean = values.reduce((s, v) => s + v, 0) / n
    const sd = n > 1 ? Math.sqrt(values.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1)) : 0
    const se = n > 1 ? sd / Math.sqrt(n) : 0
    const ci = n > 1 ? meanCi95(values) : { lower: null, upper: null }
    return { name, n, mean: round(mean), sd: round(sd), se: round(se), ciLow: round(ci.lower), ciHigh: round(ci.upper), values }
  })
  return {
    groupCol: groupCol.name,
    measure: measureCol.name,
    x: groups,
    series: series.map((g, i) => ({
      id: `group_${i}`,
      label: g.name,
      y: g.mean,
      yerr: g.se,          // 误差棒默认标准误（组间比较科研惯例）；details 保留 sd/ci
      n: g.n,
      sd: g.sd,
      ciLow: g.ciLow,
      ciHigh: g.ciHigh,
      values: g.values
    }))
  }
}

const safeId = (value) => {
  const text = String(value)
  const label = text.replace(/[^A-Za-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'field'
  // 中文及被清洗的字段仍保留唯一原始身份，不能把多个字段都折叠为 field/kW。
  return text === label ? label : `${label}_${Buffer.from(text).toString('hex')}`
}

// 推断证据的可复现输入指纹（仅用 n 与字段名，不参与数值结果）
function reproducibleInput(n, fields) {
  return { n, fields, hash: createHash('sha256').update(JSON.stringify({ n, fields })).digest('hex').slice(0, 16) }
}

// 推断证据统一元数据块（stats-v2）
function inferenceMeta({ fields, n, assumptions = [], failedAssumptions = [], parameters = {} }) {
  return {
    version: 'stats-v2',
    parameters,
    assumptions,
    failedAssumptions,
    reproducibleInput: reproducibleInput(n, fields)
  }
}

/**
 * 执行唯一一次确定性统计，产出证据账本。所有 value 均来自真实计算，禁止模型填数。
 * @param {object} opts
 * @param {object} [opts.semanticModel] 可选数据语义模型；未传入时保持旧版无门禁行为（向后兼容）。
 * @returns {{summary: object, evidence: Array, claims: string[]}}
 */
export function runDeterministicAnalysis({ profile, text, rawDelimiter, fileName, semanticModel }) {
  const summary = summarizeCsv(text, rawDelimiter, profile)
  const evidence = []
  const colByName = new Map(profile.columns.map((c) => [c.name, c]))

  // ---------- 研究设计门禁 ----------
  // semanticModel 未传入 = 旧版调用方，不启用门禁（向后兼容，守住既有测试）。
  // 传入且 researchDesign='unknown' 时：暂停显著性结论与效应量结论，仅保留描述统计。
  const design = semanticModel ? semanticModel.researchDesign : null
  const designUnknown = design === 'unknown'
  const designGated = designUnknown
  // 重复测量/聚类设计需要专门检验，不输出 Pearson 显著性结论，但仍给描述与效应量
  const allowSignificanceClaim = !designGated && design !== 'repeated-measures' && design !== 'clustered'
  const allowEffectClaim = !designGated
  const measureSet = semanticModel ? new Set(semanticModel.fieldRoles.measure) : null

  evidence.push({
    evidence_id: 'ev_n',
    tool: 'stats.describe',
    metric: '样本量 / 字段数',
    fields: ['*'],
    scope: `文件 ${fileName}（指纹 ${profile.fingerprint.slice(0, 12)}…）`,
    value: `${profile.rows} 行 × ${profile.cols} 列`,
    note: '行数为去除表头后的有效数据行数'
  })

  evidence.push({
    evidence_id: 'ev_x',
    tool: 'stats.describe',
    metric: '横轴字段与观测点数',
    fields: [summary.xLabel],
    scope: `文件 ${fileName}`,
    value: `${summary.xLabel}，${summary.x.length} 个观测点，${new Set(summary.x.map(String)).size} 个唯一取值`
  })

  // 逐列缺失率（数据质量，CORE-002 / AGT-009）
  const missingCols = profile.columns.filter((c) => c.missing > 0)
  evidence.push({
    evidence_id: 'ev_missing',
    tool: 'stats.quality',
    metric: '逐列缺失率',
    fields: missingCols.length ? missingCols.map((c) => c.name) : ['*'],
    scope: `全部 ${profile.rows} 行`,
    value: missingCols.length
      ? missingCols.map((c) => `${c.name}=${c.missing}/${profile.rows}（${pct(c.missingRate)}）`).join('；')
      : '各列均无缺失值',
    note: missingCols.some((c) => c.missingRate > 0.3) ? '存在缺失率超过 30% 的列，推断需谨慎' : undefined
  })

  // 研究设计门禁：unknown 时暂停推断统计，仅保留描述统计
  if (designGated) {
    evidence.push({
      evidence_id: 'ev_design_gate',
      tool: 'stats.gate',
      method: 'research-design-gate',
      version: 'stats-v2',
      metric: '研究设计门禁',
      fields: ['*'],
      scope: `语义模型推断（tableShape=${semanticModel.tableShape}）`,
      value: '研究设计未确认（unknown），推断统计已暂停',
      note: '请确认独立/配对/重复测量/聚类设计后再执行显著性检验',
      ...inferenceMeta({ fields: ['*'], n: profile.rows, assumptions: ['研究设计需用户确认'], failedAssumptions: ['researchDesign=unknown'] })
    })
  }

  summary.series.forEach((s, i) => {
    const col = colByName.get(s.label)
    evidence.push({
      evidence_id: `ev_desc_${i}`,
      tool: 'stats.describe',
      metric: `「${s.label}」描述统计（n/均值/中位数/标准差/最小/最大）`,
      fields: [s.label],
      scope: `非缺失值 n=${(col?.mean !== undefined ? profile.rows - (col?.missing ?? 0) : s.y.length)}`,
      value: `n=${profile.rows - (col?.missing ?? 0)}；mean=${fmt(col?.mean)}；median=${fmt(col?.median)}；std=${fmt(col?.std)}；min=${fmt(col?.min)}；max=${fmt(col?.max)}`,
      note: s.missing > 0 ? `该列缺失 ${s.missing} 个值，绘图系列保持 null 并在数据处理摘要中声明` : undefined
    })

    const observed = s.y.map((value, index) => ({ value, index })).filter((item) => item.value !== null)
    const firstObserved = observed[0]
    const lastObserved = observed[observed.length - 1]
    const first = firstObserved?.value
    const last = lastObserved?.value
    const hasEnds = first !== undefined && first !== null && last !== undefined && last !== null
    const absChange = hasEnds ? Math.round((last - first) * 10) / 10 : null
    // 基线为 0 时百分比变化未定义（除零），如实报告绝对变化，不再伪造 0%。
    const pctChange = hasEnds && first !== 0 ? Math.round(((last - first) / first) * 1000) / 10 : null
    const trendValue = !hasEnds
      ? '缺少首/末观测，无法计算变化'
      : first === 0
        ? `${fmt(first, 1)} → ${fmt(last, 1)}（绝对变化 ${absChange >= 0 ? '+' : ''}${absChange}；基线为 0，百分比变化未定义）`
        : `${fmt(first, 1)} → ${fmt(last, 1)}（${pctChange >= 0 ? '+' : ''}${pctChange}%）`
    const fit = linearTrend(s.y)
    evidence.push({
      evidence_id: `ev_trend_${i}`,
      tool: 'stats.trend',
      metric: `「${s.label}」首末值与变化率（描述性，非因果）`,
      fields: [s.label],
      scope: `${summary.xLabel}=${summary.x[firstObserved?.index ?? 0]} → ${summary.x[lastObserved?.index ?? summary.x.length - 1]}`,
      value: trendValue,
      details: { first, last, pctChange, absChange, slope: fit.slope, intercept: fit.intercept, r2: fit.r2, n: fit.n, xUnit: '观测序号' },
      note: first === 0 ? '基线为 0，百分比变化未定义；仅报告绝对变化，不代表处理导致变化（相关 ≠ 因果，AGT-010）' : '仅描述观测区间内的变化，不代表处理导致变化（相关 ≠ 因果，AGT-010）'
    })
  })

  // 末点最高系列：必须在同一 x 上完整比较。取各系列“最后有值位置”的最小公共位置，
  // 避免某系列末点缺失时仍把范围标到最后一行（P1：末点范围）。
  if (summary.series.length > 0) {
    const lastIndexOf = (s) => {
      for (let i = s.y.length - 1; i >= 0; i--) if (s.y[i] !== null) return i
      return -1
    }
    const commonIndex = summary.series.reduce((acc, s) => Math.min(acc, lastIndexOf(s)), Number.POSITIVE_INFINITY)
    if (commonIndex >= 0) {
      const atCommon = summary.series.map((s) => ({ s, v: s.y[commonIndex] }))
      const peak = [...atCommon].sort((a, b) => b.v - a.v)[0]
      evidence.push({
        evidence_id: 'ev_peak',
        tool: 'stats.extremum',
        metric: '同一末观测点取值最高的系列',
        fields: summary.series.map((s) => s.label),
        scope: `末观测点 ${summary.xLabel}=${summary.x[commonIndex]}`,
        value: `${peak.s.label}（${fmt(peak.v, 1)}）`,
        note: commonIndex < summary.x.length - 1
          ? `部分系列在该点之后缺失，末点比较截至 ${summary.xLabel}=${summary.x[commonIndex]}`
          : undefined
      })
    }
  }

  // 误差棒可用性（来自真实的 <measure>_sd 列）
  const withSd = summary.series.filter((s) => Array.isArray(s.yerr))
  evidence.push({
    evidence_id: 'ev_errorbars',
    tool: 'stats.describe',
    metric: '不确定性（误差棒）数据可用性',
    fields: withSd.map((s) => `${s.label}_sd`),
    scope: `文件 ${fileName}`,
    value: withSd.length ? `${withSd.length} 个系列存在配对 _sd 列，可绘制误差棒：${withSd.map((s) => s.label).join('、')}` : '未发现配对的 _sd 列，误差棒不可用',
    note: '误差棒可用性本身不等同于显著性检验；满足前提的相关检验会单独记入证据账本'
  })

  const significanceClaims = []
  summary.series.forEach((series, index) => {
    const values = series.y.filter(Number.isFinite)
    const details = { q1: round(quantile(values, 0.25)), median: round(quantile(values, 0.5)), q3: round(quantile(values, 0.75)) }
    evidence.push({ evidence_id: `ev_quantiles_${index}`, tool: 'stats.quantile', method: 'R-7 linear interpolation', metric: `「${series.label}」分位数`, fields: [series.label], scope: `非缺失值 n=${values.length}`, value: `q1=${fmt(details.q1)}；median=${fmt(details.median)}；q3=${fmt(details.q3)}`, details })
    const ci = meanCi95(series.y)
    evidence.push({ evidence_id: `ev_ci_${index}`, tool: 'stats.confidence_interval', method: 'two-sided t interval for mean', metric: `「${series.label}」均值 95% 置信区间`, fields: [series.label], scope: `非缺失值 n=${ci.n}`, value: ci.lower === null ? `未执行：${ci.reason}` : `mean=${fmt(ci.mean)}；95% CI=[${fmt(ci.lower)}, ${fmt(ci.upper)}]`, details: ci })
  })

  // 相关/显著性只对“测量变量”执行；样本编号、重复编号、时间编码等数值标识不得进入成对检验。
  // 若调用方未提供语义模型，保持旧行为以兼容独立统计 API；有语义模型时严格采用 measure 角色。
  const semanticMeasures = new Set(semanticModel?.fieldRoles?.measure ?? [])
  const numericColumns = profile.columns.filter((column) => {
    if ((column.userType ?? column.inferredType) !== 'numeric' || isSdColumn(column.name)) return false
    return semanticModel ? semanticMeasures.has(column.name) : true
  })
  const numericValues = new Map(numericColumns.map((column) => {
    const index = summary.header.indexOf(column.name)
    return [column.name, summary.rows.map((row) => toNumber(row[index]))]
  }))
  for (let leftIndex = 0; leftIndex < numericColumns.length; leftIndex += 1) {
    for (let rightIndex = leftIndex + 1; rightIndex < numericColumns.length; rightIndex += 1) {
      const left = numericColumns[leftIndex].name
      const right = numericColumns[rightIndex].name
      // 语义模型在场时：仅对两个字段角色均为 measure 的列做相关（不再对全部数值列无差别两两检验）
      if (measureSet && !(measureSet.has(left) && measureSet.has(right))) continue
      const id = `${safeId(left)}_${safeId(right)}`
      const correlation = pearson(numericValues.get(left), numericValues.get(right))
      evidence.push({ evidence_id: `ev_corr_${id}`, tool: 'stats.correlation', method: 'Pearson product-moment correlation (pairwise complete)', metric: `${left} 与 ${right} 的 Pearson 相关`, fields: [left, right], scope: `成对非缺失观测 n=${correlation.n}`, value: correlation.r === null ? `r=NA；${correlation.reason}` : `r=${fmt(correlation.r, 6)}；n=${correlation.n}`, details: correlation, note: '相关不代表因果', ...inferenceMeta({ fields: [left, right], n: correlation.n, assumptions: ['线性关系', '连续等距尺度', '成对完整观测'] }) })
      const significance = correlationSignificance(correlation)
      const significanceEvidence = { evidence_id: `ev_significance_${id}`, tool: 'stats.significance', method: 'Pearson correlation t-test', metric: `${left} 与 ${right} 的相关显著性`, fields: [left, right], scope: `成对非缺失观测 n=${correlation.n}`, value: significance.performed ? `r=${fmt(significance.r, 6)}；t=${fmt(significance.statistic, 6)}；df=${significance.df}；${fmtP(significance.pValue)}；alpha=0.05` : `未执行：${significance.reason}`, details: significance, note: designGated ? '研究设计未确认（unknown），显著性结论已门禁，不输出 claim' : '仅检验线性相关是否偏离 0；独立性与抽样设计需由用户确认，不支持因果结论', ...inferenceMeta({ fields: [left, right], n: correlation.n, assumptions: ['近似正态分布', '独立观测'], failedAssumptions: designGated ? ['researchDesign=unknown'] : [] }) }
      evidence.push(significanceEvidence)
      if (significance.performed && allowSignificanceClaim) significanceClaims.push({ claimId: `claim_significance_${id}`, evidenceId: significanceEvidence.evidence_id, fields: [left, right], sampleScope: significanceEvidence.scope, numbers: [significance.r, significance.pValue], relation: 'significance', text: `${left} 与 ${right} 的 Pearson 相关检验 ${fmtP(significance.pValue)}` })
    }
  }

  const xValues = numericValues.get(summary.xLabel)
  if (xValues) summary.series.forEach((series, index) => {
    const regression = ols(xValues, series.y)
    evidence.push({ evidence_id: `ev_regression_${index}`, tool: 'stats.linear_regression', method: 'ordinary least squares with intercept', metric: `${series.label} 关于 ${summary.xLabel} 的简单线性回归`, fields: [summary.xLabel, series.label], scope: `成对非缺失观测 n=${regression.n}`, value: regression.slope === null ? `未执行：${regression.reason}` : `slope=${fmt(regression.slope, 6)}；intercept=${fmt(regression.intercept, 6)}；R2=${fmt(regression.r2, 6)}；n=${regression.n}`, details: regression, note: '回归描述线性关联，不代表因果', ...inferenceMeta({ fields: [summary.xLabel, series.label], n: regression.n, assumptions: ['线性关系', '残差独立', '自变量非常数'] }) })
  })

  // 效应量：按研究设计选择对应统计量；unknown 时仍计算证据但标记 designGated，不输出 claim
  if (summary.series.length >= 2) {
    const s0 = summary.series[0].y
    const s1 = summary.series[1].y
    let effectDetails
    let effectMethod
    if (design === 'paired') {
      effectDetails = cohenDZ(s0, s1)
      effectMethod = "Cohen's d_z (paired difference)"
    } else {
      // independent / repeated-measures / clustered / legacy(null) 均用合并标准差口径
      effectDetails = cohenDIndependent(s0, s1)
      effectMethod = "Cohen's d (pooled sample standard deviation)"
    }
    const effectEvidence = {
      evidence_id: 'ev_effect_0_1',
      tool: 'stats.effect_size',
      method: effectMethod,
      metric: `${summary.series[0].label} 与 ${summary.series[1].label} 的标准化效应量`,
      fields: [summary.series[0].label, summary.series[1].label],
      scope: `非缺失观测 n1=${effectDetails.n1}, n2=${effectDetails.n2}`,
      value: effectDetails.value === null ? `d=NA；${effectDetails.reason}` : `效应量=${fmt(effectDetails.value, 6)}（${effectDetails.definition}）`,
      details: design === 'paired'
        ? effectDetails
        : { n1: effectDetails.n1, n2: effectDetails.n2, cohenD: effectDetails.value, value: effectDetails.value, definition: effectDetails.definition, reason: effectDetails.reason },
      designGated: designGated || undefined,
      note: designGated
        ? '研究设计未确认（unknown），效应量仅作记录，不输出结论 claim'
        : design === 'repeated-measures' || design === 'clustered'
          ? '重复测量/聚类设计需专门检验，此处仅给描述性效应量'
          : undefined,
      ...inferenceMeta({ fields: [summary.series[0].label, summary.series[1].label], n: effectDetails.n1 + effectDetails.n2, assumptions: ['两组独立抽样（独立样本口径）'], failedAssumptions: designGated ? ['researchDesign=unknown'] : [] })
    }
    evidence.push(effectEvidence)
    if (allowEffectClaim && effectDetails.value !== null) {
      significanceClaims.push({
        claimId: 'claim_effect_0_1',
        evidenceId: effectEvidence.evidence_id,
        fields: effectEvidence.fields,
        sampleScope: effectEvidence.scope,
        numbers: [effectDetails.value],
        relation: 'effect_size',
        text: `${summary.series[0].label} 与 ${summary.series[1].label} 的效应量=${fmt(effectDetails.value, 6)}`
      })
    }
  }

  // ---------- 组间比较（科研高频：误差棒 + 显著性标注的数据基础） ----------
  // 优先长表分组形态（一列分组 + 一列数值 → 按组聚合均值/标准误/置信区间，并做 ANOVA 与两两 t 检验）；
  // 否则对多测量列（宽表）两两做独立样本 t 检验（整列分布比较，标注"独立近似"假设）。
  // 结果挂到 summary.groups 供 plans/codegen 绘制分组误差棒与显著性标注；相关结论入证据账本。
  const groupAnalysis = summarizeGroups(profile, text, rawDelimiter)
  const groupClaims = []
  if (groupAnalysis) {
    const groups = groupAnalysis.series
    if (!summary.timeGrouped) summary.groups = {
      groupCol: groupAnalysis.groupCol,
      measure: groupAnalysis.measure,
      x: groupAnalysis.x,
      series: groups.map((g) => ({ id: g.id, label: g.label, y: g.y, yerr: g.yerr, n: g.n, sd: g.sd, ciLow: g.ciLow, ciHigh: g.ciHigh, values: g.values }))
    }
    evidence.push({
      evidence_id: 'ev_group_stats',
      tool: 'stats.group',
      metric: '分组描述统计（组均值 ± 标准误 / 95% CI）',
      fields: [groupAnalysis.groupCol],
      scope: `分组列 ${groupAnalysis.groupCol}，${groups.length} 组`,
      value: groups.map((g) => `${g.label} n=${g.n}；mean=${fmt(g.mean)}；SE=${fmt(g.se)}；95%CI=[${fmt(g.ciLow)}, ${fmt(g.ciHigh)}]`).join('；'),
      note: '组均值为该组非缺失观测的算术平均；误差棒默认取标准误（组间比较惯例），SE/SD/CI 均保留供绘图选用'
    })
    const anova = anovaOneWay(groups.map((g) => ({ name: g.label, values: g.values })))
    const anovaEvidence = {
      evidence_id: 'ev_anova',
      tool: 'stats.anova',
      method: anova.method,
      metric: `单因素方差分析：${groupAnalysis.groupCol} 对组间均值差异的整体检验`,
      fields: [groupAnalysis.groupCol],
      scope: `k=${anova.k} 组，n=${anova.n}，df=${anova.dfBetween},${anova.dfWithin}`,
      value: anova.performed
        ? `F=${fmt(anova.statistic, 6)}；${fmtP(anova.pValue)}；η²=${fmt(anova.etaSq, 6)}；alpha=0.05`
        : `未执行：${anova.reason}`,
      details: anova,
      note: designGated ? '研究设计未确认（unknown），ANOVA 结论仅记录不输出 claim' : 'ANOVA 检验组均值间是否存在整体差异；显著不指向具体哪两组，需结合两两比较',
      ...inferenceMeta({ fields: [groupAnalysis.groupCol], n: anova.n ?? 0, assumptions: ['组间观测独立', '近似正态', '方差齐性（近似）'], failedAssumptions: designGated ? ['researchDesign=unknown'] : [] })
    }
    evidence.push(anovaEvidence)
    // 两两 Welch t 检验 + Holm-Bonferroni 校正（k≤8 已由 summarizeGroups 限制，组合可控）
    const pairTests = []
    const rawP = []
    const pairMeta = []
    for (let i = 0; i < groups.length; i += 1) {
      for (let j = i + 1; j < groups.length; j += 1) {
        const test = tTestIndependent(groups[i].values, groups[j].values)
        pairMeta.push({ i, j, test })
        if (test.performed) rawP.push(test.pValue)
      }
    }
    const holm = holmAdjust(rawP)
    pairMeta.forEach(({ i, j, test }, index) => {
      const adjusted = holm.adjusted[index]
      pairTests.push({
        left: groups[i].label, right: groups[j].label,
        ...test, pAdjusted: adjusted, stars: significanceStars(adjusted)
      })
      const tEvidence = {
        evidence_id: `ev_ttest_group_${safeId(groups[i].label)}_${safeId(groups[j].label)}`,
        tool: 'stats.t_test',
        method: test.method,
        metric: `${groups[i].label} 与 ${groups[j].label} 的组间均值差异（Welch t 检验，Holm 校正）`,
        fields: [groupAnalysis.groupCol],
        scope: `n1=${test.n1}, n2=${test.n2}`,
        value: test.performed
          ? `mean1=${fmt(test.mean1, 6)}；mean2=${fmt(test.mean2, 6)}；t=${fmt(test.statistic, 6)}；df=${fmt(test.df, 6)}；${fmtP(test.pValue)}；p_adjusted=${fmt(adjusted, 6)}（Holm）；stars=${significanceStars(adjusted) ?? 'ns'}`
          : `未执行：${test.reason}`,
        details: { left: groups[i].label, right: groups[j].label, ...test, pAdjusted: adjusted, stars: significanceStars(adjusted) },
        note: '两两比较 p 值经 Holm-Bonferroni 多重比较校正，图上星号基于校正后 p 值',
        ...inferenceMeta({ fields: [groupAnalysis.groupCol], n: test.n1 + test.n2, assumptions: ['组间观测独立', '近似正态'], failedAssumptions: designGated ? ['researchDesign=unknown'] : [] })
      }
      evidence.push(tEvidence)
      if (test.performed && adjusted < 0.05 && allowSignificanceClaim) {
        groupClaims.push({
          claimId: `claim_ttest_group_${safeId(groups[i].label)}_${safeId(groups[j].label)}`,
          evidenceId: tEvidence.evidence_id,
          fields: [groupAnalysis.groupCol],
          sampleScope: tEvidence.scope,
          numbers: [test.mean1, test.mean2, adjusted],
          relation: 'significance',
        text: `${groups[i].label} 与 ${groups[j].label} 组间均值差异显著（t=${fmt(test.statistic, 6)}，p_adj=${adjusted < 0.001 ? '<0.001' : fmt(adjusted, 6)}）`
        })
      }
    })
    if (anova.performed && anova.significant && allowSignificanceClaim) {
      groupClaims.push({
        claimId: 'claim_anova',
        evidenceId: anovaEvidence.evidence_id,
        fields: [groupAnalysis.groupCol],
        sampleScope: anovaEvidence.scope,
        numbers: [anova.statistic, anova.pValue],
        relation: 'significance',
        text: `单因素方差分析显示 ${groupAnalysis.groupCol} 组间差异显著（F=${fmt(anova.statistic, 6)}，${fmtP(anova.pValue)}）`
      })
    }
  } else if (summary.series.length >= 2 && summary.series.length <= 4) {
    // 宽表：系列两两 Welch t 检验（整列分布比较）。列间可能共享行（重复测量），故标注独立近似假设。
    // v0.4.2：恰好两个系列时，另按行做配对 t 检验（重复测量/前后对照场景的诚实依据），供配对连线图使用。
    if (summary.series.length === 2) {
      const pairedTest = pairedTTest(summary.series[0].y, summary.series[1].y)
      const pairedEvidence = {
        evidence_id: 'ev_ttest_paired',
        tool: 'stats.t_test',
        method: pairedTest.method,
        metric: `${summary.series[0].label} 与 ${summary.series[1].label} 的配对差值检验（逐行配对）`,
        fields: [summary.series[0].label, summary.series[1].label],
        scope: `成对非缺失观测 n=${pairedTest.n}`,
        value: pairedTest.performed
          ? `meanDiff=${fmt(pairedTest.meanDiff, 6)}；sdDiff=${fmt(pairedTest.sdDiff, 6)}；t=${fmt(pairedTest.statistic, 6)}；df=${pairedTest.df}；p=${fmt(pairedTest.pValue, 6)}；dz=${fmt(pairedTest.dz, 6)}；alpha=0.05`
          : `未执行：${pairedTest.reason}`,
        details: pairedTest,
        note: '配对 t 检验以两列同一行作为配对单位；若行序不代表真实配对关系，请勿据此下因果结论',
        ...inferenceMeta({ fields: [summary.series[0].label, summary.series[1].label], n: pairedTest.n, assumptions: ['差值近似正态', '配对单位按行对齐'], failedAssumptions: designGated ? ['researchDesign=unknown'] : [] })
      }
      evidence.push(pairedEvidence)
      if (pairedTest.performed && pairedTest.pValue < 0.05 && allowSignificanceClaim) {
        groupClaims.push({
          claimId: 'claim_ttest_paired',
          evidenceId: pairedEvidence.evidence_id,
          fields: [summary.series[0].label, summary.series[1].label],
          sampleScope: pairedEvidence.scope,
          numbers: [pairedTest.meanDiff, pairedTest.pValue],
          relation: 'significance',
          text: `${summary.series[0].label} 与 ${summary.series[1].label} 配对差值显著偏离 0（t=${fmt(pairedTest.statistic, 6)}，p=${fmt(pairedTest.pValue, 6)}）`
        })
      }
    }
    const rawP = []
    const pairMeta = []
    for (let i = 0; i < summary.series.length; i += 1) {
      for (let j = i + 1; j < summary.series.length; j += 1) {
        const test = tTestIndependent(summary.series[i].y, summary.series[j].y)
        pairMeta.push({ i, j, test })
        if (test.performed) rawP.push(test.pValue)
      }
    }
    const holm = holmAdjust(rawP)
    pairMeta.forEach(({ i, j, test }, index) => {
      const adjusted = holm.adjusted[index]
      const tEvidence = {
        evidence_id: `ev_ttest_series_${safeId(summary.series[i].label)}_${safeId(summary.series[j].label)}`,
        tool: 'stats.t_test',
        method: test.method,
        metric: `${summary.series[i].label} 与 ${summary.series[j].label} 的整体分布比较（Welch t 检验，Holm 校正）`,
        fields: [summary.series[i].label, summary.series[j].label],
        scope: `n1=${test.n1}, n2=${test.n2}`,
        value: test.performed
          ? `mean1=${fmt(test.mean1, 6)}；mean2=${fmt(test.mean2, 6)}；t=${fmt(test.statistic, 6)}；df=${fmt(test.df, 6)}；p=${fmt(test.pValue, 6)}；p_adjusted=${fmt(adjusted, 6)}（Holm）；stars=${significanceStars(adjusted) ?? 'ns'}`
          : `未执行：${test.reason}`,
        details: { left: summary.series[i].label, right: summary.series[j].label, ...test, pAdjusted: adjusted, stars: significanceStars(adjusted) },
        note: '该表为宽表结构，系列间按独立样本口径近似比较；若观测行间存在配对关系，需按重复测量设计复核（不输出因果结论）',
        ...inferenceMeta({ fields: [summary.series[i].label, summary.series[j].label], n: test.n1 + test.n2, assumptions: ['系列间近似独立（宽表近似）', '近似正态'], failedAssumptions: designGated ? ['researchDesign=unknown'] : [] })
      }
      evidence.push(tEvidence)
      if (test.performed && adjusted < 0.05 && allowSignificanceClaim) {
        groupClaims.push({
          claimId: `claim_ttest_series_${safeId(summary.series[i].label)}_${safeId(summary.series[j].label)}`,
          evidenceId: tEvidence.evidence_id,
          fields: [summary.series[i].label, summary.series[j].label],
          sampleScope: tEvidence.scope,
          numbers: [test.mean1, test.mean2, adjusted],
          relation: 'significance',
          text: `${summary.series[i].label} 与 ${summary.series[j].label} 整体分布差异显著（t=${fmt(test.statistic, 6)}，p_adj=${fmt(adjusted, 6)}）`
        })
      }
    })
  }

  // 结构化结论（发布前由 ClaimVerifier 独立核对字段、范围、数值与证据引用）
  const claims = [
    {
      claimId: 'claim_n',
      evidenceId: 'ev_n',
      fields: ['*'],
      sampleScope: evidence.find((item) => item.evidence_id === 'ev_n').scope,
      numbers: [profile.rows, profile.cols],
      relation: 'descriptive',
      text: `样本量 ${profile.rows} 行 × ${profile.cols} 列`
    },
    ...summary.series.map((s, i) => {
      const ev = evidence.find((e) => e.evidence_id === `ev_trend_${i}`)
      const observed = s.y.filter((value) => value !== null)
      const first = observed[0]
      const last = observed[observed.length - 1]
      const hasEnds = first !== undefined && last !== undefined
      // 基线为 0 时百分比未定义，numbers 只保留首末值，不放入伪造的 0。
      const pctChange = hasEnds && first !== 0 ? Math.round(((last - first) / first) * 1000) / 10 : null
      return {
        claimId: `claim_trend_${i}`,
        evidenceId: `ev_trend_${i}`,
        fields: [s.label],
        sampleScope: ev.scope,
        numbers: [first, last, pctChange].filter((value) => Number.isFinite(value)),
        relation: 'descriptive',
        text: `「${s.label}」${ev.value.replace(/（[^）]*）$/, '')}`
      }
    })
  ]
  const peakEv = evidence.find((e) => e.evidence_id === 'ev_peak')
  if (peakEv) {
    const number = collectEvidenceNumber(peakEv.value)
    claims.push({
      claimId: 'claim_peak',
      evidenceId: 'ev_peak',
      fields: peakEv.fields,
      sampleScope: peakEv.scope,
      numbers: number === null ? [] : [number],
      relation: 'descriptive',
      text: `末点最高系列为 ${peakEv.value}`
    })
  }
  claims.push(...significanceClaims, ...groupClaims)

  const numericFields = profile.columns.filter((c) => (c.userType ?? c.inferredType) === 'numeric' && !isSdColumn(c.name)).map((c) => c.name)
  // 空间字段既支持英文标准列名，也支持科研数据中常见的中文坐标命名；仅凭“有三列数值”
  // 不足以进入三维候选，避免把处理组/响应指标误当成 XYZ。
  const spatialFields = numericFields.filter((name) => /^(x|y|z|x坐标|y坐标|z坐标|横坐标|纵坐标|深度|纬度|经度|高程|高度|lat|latitude|lon|long|longitude|east(?:ing)?|north(?:ing)?|depth|elevation|height)$/i.test(name.trim()))
  const spatialValues = new Map(spatialFields.map((name) => {
    const idx = profile.columns.findIndex((column) => column.name === name)
    const values = (parseCsv(text, rawDelimiter).slice(1) ?? []).map((row) => toNumber(row[idx])).filter(Number.isFinite)
    return [name, { unique: new Set(values).size, finite: values.length }]
  }))
  const spatialRows = parseCsv(text, rawDelimiter).slice(1)
  const spatialIndices = spatialFields.map((name) => profile.columns.findIndex((column) => column.name === name))
  const spatialDiagnostics = {
    fields: spatialFields,
    completeRows: spatialFields.length >= 3
      ? spatialRows.filter((row) => spatialIndices.every((index) => Number.isFinite(toNumber(row[index])))).length
      : 0,
    uniqueCounts: Object.fromEntries([...spatialValues.entries()].map(([name, value]) => [name, value.unique])),
    varied: spatialFields.length >= 3 && [...spatialValues.values()].slice(0, 3).every((value) => value.unique >= 2)
  }
  const overview = buildDataOverview(text, rawDelimiter, profile)
  const processingTrace = {
    schema: 'deep-imaging.data-processing.v1',
    datasetFingerprint: profile.fingerprint,
    inputShape: { rows: profile.rows, columns: profile.cols },
    plottedFields: { x: summary.xLabel, measures: summary.series.map((series) => series.label) },
    operations: [
      { id: 'parse_csv', description: '按原始 CSV 表头解析数据；未对数据行排序或筛选' },
      { id: 'parse_numeric', description: '数值字段转换为数值；空白/非法值保留为缺失，不进行插补' },
      ...(summary.timeGrouped ? [{ id: 'time_group_aggregate', scope: 'plotting', timeField: summary.xLabel, groupField: summary.groupLabel, measure: summary.measureLabel, error: 'se', description: '按时间×分组聚合均值与标准误；原始观测保留在 values/n 中' }] : []),
      ...(summary.groups ? [{ id: 'group_summary', scope: 'evidence_only', groupField: summary.groups.groupCol, measure: summary.groups.measure, description: '按组计算统计证据中的均值/标准误；是否用于图表聚合由每个方案单独记录' }] : [])
    ],
    series: summary.series.map((series) => ({
      field: series.label,
      observed: series.values.length,
      missing: series.y.length - series.values.length,
      plottedRows: series.y.length,
      aggregation: 'none'
    })),
    outlierPolicy: '仅诊断提示，不自动删除或缩尾',
    mutation: 'none'
  }
  const suitabilityAudit = {
    schema: 'deep-imaging.chart-suitability.v1',
    observations: summary.x.length,
    numericMeasures: numericFields.length,
    plottedMeasures: summary.series.length,
    grouped: Boolean(summary.groups),
    warnings: [
      ...(semanticModel?.fieldRoles?.xTime?.length && semanticModel?.fieldRoles?.group?.length && new Set(summary.x.map(String)).size < summary.x.length
        ? ['检测到时间×分组重复观测；当前候选应按时间与分组聚合后绘图，禁止直接把重复样本编号铺满横轴'] : []),
      ...(summary.x.length < 3 ? ['观测数少于 3，趋势/回归类表达应谨慎'] : []),
      ...(summary.series.some((series) => series.values.length < series.y.length) ? ['至少一个绘图系列含缺失值；未插补，图形可能出现断点或少量点缺失'] : []),
      ...(overview.outliers.length ? [`检测到 ${overview.outliers.length} 个字段有 IQR/3σ 离群值提示；保留原始观测，请核对研究背景`] : []),
      ...(summary.groups?.series.some((group) => group.n < 2) ? ['至少一个分组有效样本量小于 2，无法稳定估计组内变异'] : [])
    ]
  }
  return { summary, evidence, claims, semanticModel: semanticModel ?? null, chartContext: { numericFields, numericMeasureCount: numericFields.length, spatialFields, spatialReady: spatialFields.length >= 3 && spatialDiagnostics.completeRows >= 8 && spatialDiagnostics.varied, spatialDiagnostics }, overview, processingTrace, suitabilityAudit, sdPairPattern: SD_PAIR_PATTERN }
}

function collectEvidenceNumber(value) {
  const match = /[-+]?\d+(?:\.\d+)?/.exec(String(value))
  return match ? Number(match[0]) : null
}
