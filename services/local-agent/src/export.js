// 代码与产物导出：零依赖 ZIP（src/zip.js），包含三引擎源码、原始数据、ChartSpec、
// 证据账本（JSON + 可读 Markdown）、沙箱真实产物（SVG/PNG/PDF）与运行说明。
import { buildZip } from './zip.js'
import fs from 'node:fs'
import { createHash } from 'node:crypto'

function sha256(value) {
  return createHash('sha256').update(value ?? '').digest('hex')
}

function evidenceMarkdown(task, plan) {
  const lines = []
  lines.push(`# 证据账本 — ${task.title}`, '')
  lines.push(`- 数据指纹：${task.dataset?.fingerprint ?? 'NA'}`)
  lines.push(`- 数据性质：${task.dataNature === 'synthetic_demo' ? '构造数据，仅用于功能演示，不代表真实科研结论' : task.dataNature === 'real_research' ? '真实研究数据（需按授权和隐私要求使用）' : '未声明'}`)
  if (task.dataDisclosure) lines.push(`- 数据披露：${task.dataDisclosure}`)
  lines.push(`- 数据规模：${task.dataset?.rows} 行 × ${task.dataset?.cols} 列`)
  lines.push(`- 方案：${plan?.plan_id}（${plan?.name ?? ''}）`)
  lines.push(`- 验证状态：${plan?.executionStatus ?? '未执行'}`, '')
  lines.push('> 相关 ≠ 因果；描述统计与满足前提的推断结果分别记录 method、n 和假设，不得据此声称因果。', '')
  for (const e of task.evidence) {
    lines.push(`## [${e.evidence_id}] ${e.metric}`)
    lines.push(`- 工具：${e.tool}`)
    lines.push(`- 字段：${(e.fields ?? []).join(', ')}`)
    lines.push(`- 范围：${e.scope}`)
    lines.push(`- 结果：${e.value}`)
    if (e.note) lines.push(`- 备注：${e.note}`)
    lines.push('')
  }
  if (plan?.verification) {
    lines.push('## 独立验证')
    for (const c of plan.verification.checks ?? []) lines.push(`- ${c.name}：${c.passed ? '通过' : '未通过'} — ${c.detail}`)
    lines.push('')
  }
  return lines.join('\n')
}

function readmeText(task, plan) {
  return `科研绘图辅助智能体 — 方案导出
================================

方案：${plan.plan_id}（${plan.name}）
图表类型：${plan.chartType}
数据性质：${task.dataNature === 'synthetic_demo' ? '构造数据，仅用于功能演示，不代表真实科研结论' : task.dataNature === 'real_research' ? '真实研究数据' : '未声明'}
适用场景：${plan.applicableScene}
设计理由：${plan.rationale}
图中信息：${plan.insightSummary ?? '见 evidence.md'}
侧重点说明：${plan.focusExplanation ?? '按数据结构自动生成'}
配色：${plan.palette?.name ?? '默认'} — ${plan.palette?.reason ?? ''}
数据处理摘要：${plan.dataProcessingSummary}
复现版本：数据指纹 ${task.dataset?.fingerprint ?? 'NA'}；方案修订 ${task.currentRevision ?? 'NA'}；处理明细见 data-processing.json

文件说明
--------
plot.py / plot.R / plot.m   三引擎源码（执行所用为 ${plan.verification?.engine ?? 'python'}）
data.csv                    原始数据（与服务端内容指纹一致）
ChartSpec.json              声明式图表规格（单一事实源）
evidence.json / evidence.md 证据账本（统计结论与 evidence_id 绑定）
data-processing.json       数据来源指纹、数值解析、缺失值和聚合记录
suitability-audit.json     图型适配警告与统计表达边界
quality-report.json        本方案 SVG/PNG 质量验收结果
manifest.json              导出包内文件 SHA-256 清单，用于完整性核验
artifacts/                  沙箱真实执行产物（SVG/PNG/PDF）

运行（Python）
-------------
pip install pandas matplotlib numpy
python plot.py

合规声明
--------
- MATLAB 代码仅可在已合法安装并授权 MATLAB 的节点运行，本产品不打包 MATLAB 运行时。
- 统计证据包含明确方法、样本量与前提；相关和显著性结果不代表因果。
`
}

function chartDescription(plan) {
  return `# 图表说明\n\n## 图注\n\n${plan.spec?.figure?.title ?? plan.name}\n\n## 图中能看出什么\n\n${plan.insightSummary ?? '请结合证据账本读取图中差异与趋势。'}\n\n## 按用户侧重点说明\n\n${plan.focusExplanation ?? '未指定额外侧重点。'}\n\n## 为什么采用此图型\n\n${plan.rationale}\n\n## 配色依据\n\n${plan.palette?.name ?? '默认配色'}：${plan.palette?.reason ?? '按图表用途自动选择。'}\n`
}

function getInline(task, planId, fileName) {
  const a = task.artifacts?.[planId]
  if (!a?.inline) return null
  if (fileName.endsWith('.svg')) return a.inline.svg ? Buffer.from(a.inline.svg, 'utf-8') : null
  if (fileName.endsWith('.png')) return a.inline.pngBase64 ? Buffer.from(a.inline.pngBase64, 'base64') : null
  if (fileName.endsWith('.pdf')) return a.inline.pdfBase64 ? Buffer.from(a.inline.pdfBase64, 'base64') : null
  return null
}

/**
 * @param storage 可选 FileStorage（恢复任务的产物从磁盘读取）
 */
export function buildExport(task, planId, storage = null, options = {}) {
  const plan = task.plans.find((p) => p.plan_id === planId)
  const settings = {
    includeCode: options.includeCode !== false,
    includeData: options.includeData !== false,
    includeEvidence: options.includeEvidence !== false,
    includeArtifacts: options.includeArtifacts !== false,
    colorMode: ['color', 'grayscale'].includes(options.colorMode) ? options.colorMode : 'color',
    dpi: Math.max(72, Math.min(1200, Number(options.dpi ?? 300))),
    transparent: options.transparent === true,
    requestedFormats: Array.isArray(options.requestedFormats) ? options.requestedFormats.filter((item) => ['svg', 'png', 'pdf'].includes(item)) : ['svg', 'png', 'pdf']
  }
  const verifiedArtifact = task.artifacts?.[planId]
  const activeCodeHash = plan.verification?.engine ? sha256(plan.code?.[plan.verification.engine] ?? '') : null
  const versionBinding = {
    revision: plan.verification?.revision ?? task.currentRevision ?? null,
    codeHash: activeCodeHash,
    verifiedCodeMatches: !plan.verification?.codeHash || plan.verification.codeHash === activeCodeHash,
    dataFingerprint: task.dataset?.fingerprint ?? null,
    verifiedDataMatches: !plan.verification?.dataFingerprint || plan.verification.dataFingerprint === task.dataset?.fingerprint,
    artifactHash: verifiedArtifact?.hash ?? plan.verification?.artifactHash ?? null,
    verifiedArtifactMatches: !verifiedArtifact?.hash || !plan.verification?.artifactHash || verifiedArtifact.hash === plan.verification.artifactHash
  }
  const artifactVersionConsistent = versionBinding.verifiedCodeMatches && versionBinding.verifiedDataMatches && versionBinding.verifiedArtifactMatches
  const reproducibility = {
    schema: 'deep-imaging.reproducibility.v1',
    generatedAt: new Date().toISOString(),
    taskId: task.taskId,
    planId: plan.plan_id,
    datasetFingerprint: task.dataset?.fingerprint ?? null,
    dataNature: task.dataNature ?? 'unknown',
    dataDisclosure: task.dataDisclosure ?? '',
    dataVersion: task.dataVersions?.find((item) => item.current)?.version ?? null,
    planRevision: task.currentRevision ?? null,
    chartSpecSha256: sha256(JSON.stringify(plan.spec ?? {})),
    processingTraceSha256: sha256(JSON.stringify(plan.dataProcessingTrace ?? null)),
    sourceSha256: {
      python: sha256(plan.code?.python ?? ''),
      r: sha256(plan.code?.r ?? ''),
      matlab: sha256(plan.code?.matlab ?? '')
    },
    execution: {
      engine: plan.verification?.engine ?? null,
      status: plan.executionStatus ?? null,
      artifactHash: plan.verification?.artifactHash ?? null,
      versionBinding,
      node: process.version,
      platform: process.platform,
      arch: process.arch,
      timezone: Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'UTC'
    },
    exportSettings: settings
  }
  const files = [
    ...(settings.includeCode ? [{ name: 'plot.py', content: plan.code.python }, { name: 'plot.R', content: plan.code.r }, { name: 'plot.m', content: plan.code.matlab }] : []),
    ...(settings.includeData ? [{ name: 'data.csv', content: task.bytes ?? Buffer.alloc(0) }] : []),
    { name: 'ChartSpec.json', content: JSON.stringify(plan.spec, null, 2) },
    { name: 'chart-description.md', content: chartDescription(plan) },
    ...(settings.includeEvidence ? [{ name: 'evidence.json', content: JSON.stringify(task.evidence, null, 2) }, { name: 'evidence.md', content: evidenceMarkdown(task, plan) }] : []),
    { name: 'data-processing.json', content: JSON.stringify(plan.dataProcessingTrace ?? { schema: 'deep-imaging.data-processing.v1', datasetFingerprint: task.dataset?.fingerprint ?? null, mutation: 'unknown_legacy' }, null, 2) },
    { name: 'suitability-audit.json', content: JSON.stringify(plan.dataSuitability ?? { schema: 'deep-imaging.chart-suitability.v1', status: 'not_recorded' }, null, 2) },
    { name: 'quality-report.json', content: JSON.stringify({ schema: 'deep-imaging.quality-report.v2', passed: Boolean(plan.verification?.passed && artifactVersionConsistent), status: artifactVersionConsistent ? plan.executionStatus ?? 'unverified' : 'stale_version_artifacts_omitted', quality: plan.verification?.quality ?? null, checks: plan.verification?.checks ?? [], artifactHash: plan.verification?.artifactHash ?? null, versionBinding }, null, 2) },
    { name: 'reproducibility.json', content: JSON.stringify(reproducibility, null, 2) },
    { name: 'export-settings.json', content: JSON.stringify(settings, null, 2) },
    { name: 'README.txt', content: readmeText(task, plan) }
  ]

  // 沙箱产物（优先内存，其次磁盘）
  const canExportArtifacts = settings.includeArtifacts && plan.executionStatus === 'verified' && plan.verification?.passed === true && artifactVersionConsistent
  for (const ext of canExportArtifacts ? settings.requestedFormats : []) {
    const name = `plan_${plan.strategy}.${ext}`
    let buf = getInline(task, planId, name)
    if (!buf && storage) {
      const fp = storage.readArtifact(task.taskId, planId, name)
      if (fp) buf = fs.readFileSync(fp)
    }
    if (buf) files.push({ name: `artifacts/${name}`, content: buf })
  }
  const manifest = {
    schema: 'deep-imaging.export-manifest.v1',
    taskId: task.taskId,
    planId: plan.plan_id,
    files: files.map((file) => ({ path: file.name, sha256: sha256(file.content) }))
  }
  files.push({ name: 'manifest.json', content: JSON.stringify(manifest, null, 2) })
  return buildZip(files)
}
