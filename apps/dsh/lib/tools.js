/**
 * SPARK SIGHT for DeepSeek Harness — model-callable plotting tools.
 *
 * The DSH model drives the bundled local-agent through these tools: it opens a
 * CSV from the Session workspace, creates a plotting task, follows the
 * three-round clarification, compares plans, renders a preview, applies
 * feedback, and exports a reproducible ZIP. DSH owns the model turn and the
 * polling loop; SPARK SIGHT owns the plotting pipeline.
 */

import fs from 'node:fs'
import path from 'node:path'
import { AGENT_ERROR_CODES, codedError, defaultStop } from './agent-client.js'

const MAX_CSV_BYTES = 24 * 1024 * 1024
const MAX_SUMMARY_CHARS = 24_000
const ENGINE_ENUM = ['python', 'r', 'matlab']

function str(value, fallback = '') {
  return typeof value === 'string' ? value : value === undefined || value === null ? fallback : String(value)
}

function bool(value, fallback = false) {
  return typeof value === 'boolean' ? value : value === 'true' ? true : value === 'false' ? false : fallback
}

function finite(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) ? number : fallback
}

function clip(text, max = MAX_SUMMARY_CHARS) {
  const value = String(text ?? '')
  return value.length <= max ? value : `${value.slice(0, max)}\n…（已截断 ${value.length - max} 字符）`
}

function oneLine(value, max = 220) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length <= max ? text : `${text.slice(0, max)}…`
}

function csvName(name) {
  const base = path.basename(String(name || 'upload.csv')).replace(/[^\w.\-\u4e00-\u9fff]+/g, '_')
  return base.toLowerCase().endsWith('.csv') ? base : `${base}.csv`
}

export function formatTaskSummary(snapshot, { maxPlans = 5 } = {}) {
  if (!snapshot || typeof snapshot !== 'object') return 'SPARK SIGHT 未返回任务快照。'
  const lines = []
  const state = str(snapshot.state, 'UNKNOWN')
  lines.push(`任务 ${str(snapshot.taskId, '(unknown)')} · 状态 ${state}`)
  if (snapshot.title) lines.push(`标题：${oneLine(snapshot.title)}`)
  if (snapshot.dataset) {
    const rows = finite(snapshot.dataset.rows, undefined)
    const columns = Array.isArray(snapshot.dataset.columns) ? snapshot.dataset.columns.length : finite(snapshot.dataset.columnCount, undefined)
    if (rows !== undefined || columns !== undefined) lines.push(`数据：${rows ?? '?'} 行 × ${columns ?? '?'} 列`)
  }
  if (snapshot.selectedPlanId) lines.push(`已选方案：${snapshot.selectedPlanId}`)

  const question = snapshot.pendingQuestion
  if (question?.question) {
    lines.push('', `需要用户确认：${oneLine(question.question, 600)}`)
    if (Array.isArray(question.options) && question.options.length > 0) {
      lines.push(`可选：${question.options.map((option) => oneLine(option, 80)).join(' / ')}`)
    }
    if (question.hint) lines.push(`提示：${oneLine(question.hint, 500)}`)
    lines.push('下一步：把问题原样转述给用户，得到回答后调用 sparksight_answer。')
  } else if (Array.isArray(question?.choiceGroups) && question.choiceGroups.length > 0) {
    for (const group of question.choiceGroups) {
      lines.push(`${oneLine(group.label ?? group.key)}：${(group.options ?? []).map((option) => oneLine(option, 60)).join(' / ')}`)
    }
  }

  const plans = Array.isArray(snapshot.plans) ? snapshot.plans : []
  if (plans.length > 0) {
    lines.push('', `候选方案（${plans.length}）：`)
    for (const [index, plan] of plans.slice(0, maxPlans).entries()) {
      const score = finite(plan?.score?.total, undefined)
      const flags = [
        plan?.executionStatus ? `执行 ${plan.executionStatus}` : '',
        (plan?.verification?.passed ?? plan?.verification?.verified) === true ? '已验证' : '',
        (plan?.verification?.passed ?? plan?.verification?.verified) === false ? '未通过验证' : '',
      ].filter(Boolean).join('，')
      lines.push(`${index + 1}. ${str(plan?.plan_id)} · ${str(plan?.chartType ?? plan?.name, '图表')}${score === undefined ? '' : ` · 评分 ${score.toFixed(2)}`}${flags ? ` · ${flags}` : ''}`)
      if (plan?.rationale) lines.push(`   理由：${oneLine(plan.rationale, 320)}`)
      if (plan?.recommended) lines.push('   标记：系统推荐')
    }
    if (plans.length > maxPlans) lines.push(`…另有 ${plans.length - maxPlans} 个方案`)
    const artifacts = snapshot.planArtifacts ?? {}
    const rendered = Object.keys(artifacts).filter((id) => artifacts[id]?.svgBytes || artifacts[id]?.png)
    if (rendered.length > 0) lines.push(`已有渲染产物：${rendered.join(', ')}`)
    lines.push('下一步：可用 sparksight_preview 查看指定方案，或用 sparksight_select 选中方案；用户要求修改时调用 sparksight_feedback。')
  }

  if (snapshot.error?.message) lines.push('', `错误：${oneLine(snapshot.error.message, 800)}`)
  if (state === 'COMPLETE') lines.push('', '任务已冻结完成；可继续用 sparksight_export 导出复现包。')
  else if (state === 'FAILED') lines.push('', '任务失败：先向用户说明错误，必要时重新 sparksight_plot。')
  else if (state === 'CANCELLED') lines.push('', '任务已取消。')
  else if (plans.length === 0 && !question?.question) {
    lines.push('', '任务仍在生成方案；稍后用 sparksight_status 轮询（建议间隔 2–5 秒）。')
  }
  return clip(lines.join('\n'))
}

function workspaceCwd(ctx, exec) {
  try {
    const service = ctx.get?.('workingDirectory')
    if (service && exec?.agent?.session) {
      const value = service.get(exec.agent.session)
      if (value) return String(value)
    }
  } catch { /* fall through */ }
  const candidate = exec?.agent?.session?.cwd ?? exec?.agent?.cwd
  return candidate ? String(candidate) : process.cwd()
}

function resolveDataPath(ctx, exec, input) {
  const raw = str(input).trim()
  if (!raw) throw codedError('DATA_PATH_REQUIRED', '请提供 CSV 文件路径')
  const cwd = workspaceCwd(ctx, exec)
  const target = path.isAbsolute(raw) ? raw : path.resolve(cwd, raw)
  if (!/\.(csv|tsv)$/i.test(target)) throw codedError('DATA_TYPE_UNSUPPORTED', '目前只支持 .csv 或 .tsv 数据文件')
  return target
}

function safeOutputPath(ctx, exec, input, fallbackName) {
  const cwd = workspaceCwd(ctx, exec)
  const raw = str(input).trim()
  const target = raw ? (path.isAbsolute(raw) ? raw : path.resolve(cwd, raw)) : path.join(cwd, 'sparksight', fallbackName)
  if (!target) throw codedError('OUTPUT_PATH_INVALID', '输出路径无效')
  return target
}

function taskToken(auth) {
  return auth.ensure()
}

function hasArtifact(snapshot, planId) {
  const artifacts = snapshot?.planArtifacts ?? {}
  if (planId) {
    const artifact = artifacts[planId]
    return Boolean(artifact?.svgBytes || artifact?.png)
  }
  return Object.keys(artifacts).some((id) => artifacts[id]?.svgBytes || artifacts[id]?.png)
}

function formatPreview(saved, preview) {
  const lines = [
    `方案 ${preview.planId} 预览已保存：${saved.svgPath}`,
  ]
  if (saved.pngPath) lines.push(`PNG 已保存：${saved.pngPath}`)
  if (preview.width && preview.height) lines.push(`画布：${preview.width} × ${preview.height}px`)
  if (preview.engine) lines.push(`渲染引擎：${preview.engine}`)
  const verification = preview.verification
  if (verification) {
    const passed = verification.passed ?? verification.verified
    lines.push(`验证：${passed === true ? '通过' : passed === false ? '未通过' : '未提供'}`)
    if (verification.quality?.score !== undefined) lines.push(`质量分：${verification.quality.score}（${verification.quality.grade ?? ''}）`)
    if (Array.isArray(verification.checks) && verification.checks.length > 0) {
      lines.push(`检查项：${verification.checks.slice(0, 12).map((item) => oneLine(typeof item === 'string' ? item : item?.name ?? item?.message, 60)).join('；')}`)
    }
  }
  lines.push('在 Harness 的“绘图”页签中可直接查看该预览。若用户确认，使用 sparksight_export 导出复现包。')
  return lines.join('\n')
}

function makeTool({ name, description, parameters = {}, run, timeoutMs }) {
  const properties = {}
  const required = []
  for (const [key, schema] of Object.entries(parameters)) {
    const { required: isRequired, ...rest } = schema ?? {}
    properties[key] = rest
    if (isRequired === true) required.push(key)
  }
  return {
    name,
    description,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties,
      ...(required.length > 0 ? { required } : {}),
    },
    ...(timeoutMs ? { timeoutMs } : {}),
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: String(value) }],
    },
    async execute(args = {}, exec) {
      return run(args ?? {}, exec)
    },
  }
}

export function createSparksightTools({ ctx, client, auth, log = () => {} }) {
  const tools = []

  tools.push(makeTool({
    name: 'sparksight_plot',
    description: 'Create a SPARK SIGHT research figure from a CSV in the Session workspace. Use for data plots (bar/line/scatter/box/forest/heatmap/3D) when the user asks to draw, plot, chart, visualize, restyle, or export research data. Do not use for architecture diagrams or flowcharts. Returns a task id, clarification question, or candidate plans.',
    parameters: {
      dataPath: { type: 'string', required: true, description: 'CSV/TSV path, absolute or relative to the Session working directory. Never invent data.' },
      prompt: { type: 'string', required: true, description: 'The user plotting request in their own words, including variables, chart preference, title, caption, palette, or journal requirements.' },
      engine: { type: 'string', enum: ENGINE_ENUM, description: 'Rendering engine. Default python; r and matlab require a local installation.' },
      clarify: { type: 'boolean', description: 'Run the three-round clarification (default true). Set false only when the user already answered every detail.' },
      waitSeconds: { type: 'number', description: 'How long to wait for the first plans or question before returning a task id for polling. Default 20, max 90.' },
      projectId: { type: 'string', description: 'Optional SPARK SIGHT project id.' },
    },
    timeoutMs: 150_000,
    async run(args, exec) {
      const token = taskToken(auth)
      const target = resolveDataPath(ctx, exec, args.dataPath)
      let stat
      try { stat = await fs.promises.stat(target) } catch { throw codedError('DATA_NOT_FOUND', `找不到数据文件：${target}`) }
      if (!stat.isFile()) throw codedError('DATA_NOT_FILE', `数据路径不是文件：${target}`)
      if (stat.size > MAX_CSV_BYTES) throw codedError('DATA_TOO_LARGE', `CSV 超过 ${Math.round(MAX_CSV_BYTES / 1024 / 1024)}MB 上限`)
      const bytes = await fs.promises.readFile(target)
      const engine = ENGINE_ENUM.includes(args.engine) ? args.engine : 'python'
      const created = await client.createTask({
        bytes,
        fileName: csvName(target),
        prompt: str(args.prompt),
        engine,
        clarify: bool(args.clarify, true),
        projectId: args.projectId ? str(args.projectId) : undefined,
        token,
        signal: exec?.signal,
      })
      const taskId = created.taskId
      const waitSeconds = Math.max(2, Math.min(90, finite(args.waitSeconds, 20)))
      const { snapshot, timedOut } = await client.waitTask(taskId, token, {
        timeoutMs: waitSeconds * 1000,
        signal: exec?.signal,
      })
      const header = `已创建绘图任务 ${taskId}（引擎 ${engine}${timedOut ? '，仍在生成' : ''}）。`
      return clip(`${header}\n\n${formatTaskSummary(snapshot)}`)
    },
  }))

  tools.push(makeTool({
    name: 'sparksight_status',
    description: 'Read or poll a SPARK SIGHT plotting task. Returns state, clarification question, candidate plans, verification, and the next recommended action.',
    parameters: {
      taskId: { type: 'string', required: true, description: 'Task id returned by sparksight_plot.' },
      waitSeconds: { type: 'number', description: 'Optional poll duration in seconds (default 0, max 60).' },
    },
    timeoutMs: 70_000,
    async run(args, exec) {
      const token = taskToken(auth)
      const taskId = str(args.taskId).trim()
      if (!taskId) throw codedError('TASK_ID_REQUIRED', '需要 taskId')
      let snapshot
      const waitSeconds = Math.max(0, Math.min(60, finite(args.waitSeconds, 0)))
      if (waitSeconds > 0) {
        snapshot = (await client.waitTask(taskId, token, { timeoutMs: waitSeconds * 1000, signal: exec?.signal })).snapshot
      } else {
        snapshot = await client.task(taskId, token, { signal: exec?.signal })
      }
      return clip(formatTaskSummary(snapshot))
    },
  }))

  tools.push(makeTool({
    name: 'sparksight_preview',
    description: 'Render a task plan and save its real SVG (and PNG when available) into the Session workspace so the user can inspect it in the Plot tab. Returns file paths and verification summary.',
    parameters: {
      taskId: { type: 'string', required: true, description: 'Task id.' },
      planId: { type: 'string', description: 'Plan id; defaults to the selected plan or the first rendered plan.' },
      outputPath: { type: 'string', description: 'Optional SVG output path relative to the Session working directory.' },
    },
    timeoutMs: 90_000,
    async run(args, exec) {
      const token = taskToken(auth)
      const taskId = str(args.taskId).trim()
      let snapshot = await client.task(taskId, token, { signal: exec?.signal })
      const requestedPlan = str(args.planId).trim()
      if (!hasArtifact(snapshot, requestedPlan || undefined)) {
        const waited = await client.waitTask(taskId, token, {
          timeoutMs: 45_000,
          signal: exec?.signal,
          stop: (value) => hasArtifact(value, requestedPlan || undefined),
        })
        snapshot = waited.snapshot
      }
      const renderedIds = Object.keys(snapshot.planArtifacts ?? {}).filter((id) => hasArtifact(snapshot, id))
      const planId = requestedPlan
        || str(snapshot.selectedPlanId).trim()
        || renderedIds[0]
      if (!planId) throw codedError('PLAN_NOT_FOUND', '该任务还没有可预览的方案，请先等待方案生成')
      if (!hasArtifact(snapshot, planId)) {
        throw codedError('ARTIFACT_NOT_READY', `方案 ${planId} 尚未渲染完成；可稍后用 sparksight_status 查看，或先 sparksight_select 触发渲染`)
      }
      const preview = await client.preview(taskId, { planId }, token, { signal: exec?.signal })
      const svgPath = safeOutputPath(ctx, exec, args.outputPath, `${taskId}-${planId}.svg`)
      await fs.promises.mkdir(path.dirname(svgPath), { recursive: true })
      await fs.promises.writeFile(svgPath, preview.svg, 'utf8')
      let pngPath
      if (preview.png?.dataBase64) {
        pngPath = svgPath.replace(/\.svg$/i, '.png')
        await fs.promises.writeFile(pngPath, Buffer.from(preview.png.dataBase64, 'base64'))
      }
      return formatPreview({ svgPath, pngPath }, preview)
    },
  }))

  tools.push(makeTool({
    name: 'sparksight_select',
    description: 'Select one candidate plan for a plotting task and re-render/preview it. Use after the user chooses among plans.',
    parameters: {
      taskId: { type: 'string', required: true, description: 'Task id.' },
      planId: { type: 'string', required: true, description: 'Plan id to select.' },
    },
    timeoutMs: 120_000,
    async run(args, exec) {
      const token = taskToken(auth)
      const taskId = str(args.taskId).trim()
      const planId = str(args.planId).trim()
      if (!planId) throw codedError('PLAN_ID_REQUIRED', '需要 planId')
      await client.select(taskId, planId, token, { signal: exec?.signal })
      const { snapshot, timedOut } = await client.waitTask(taskId, token, {
        timeoutMs: 45_000,
        signal: exec?.signal,
        stop: (value) => value?.selectedPlanId === planId && Boolean(value?.planArtifacts?.[planId]?.svgBytes || value?.planArtifacts?.[planId]?.png),
      })
      return clip(`已选择方案 ${planId}${timedOut ? '（渲染仍在进行）' : ''}。\n\n${formatTaskSummary(snapshot)}`)
    },
  }))

  tools.push(makeTool({
    name: 'sparksight_answer',
    description: 'Answer the current SPARK SIGHT clarification question (goal, chart type, typography, or title/caption) for a task.',
    parameters: {
      taskId: { type: 'string', required: true, description: 'Task id.' },
      answer: { type: 'string', required: true, description: 'The user answer, verbatim or summarized; include explicit title/caption/format details when present.' },
      waitSeconds: { type: 'number', description: 'Optional wait for the next question or plans (default 15, max 60).' },
    },
    timeoutMs: 80_000,
    async run(args, exec) {
      const token = taskToken(auth)
      const taskId = str(args.taskId).trim()
      const answer = str(args.answer).trim()
      if (!answer) throw codedError('ANSWER_REQUIRED', '需要回答内容')
      await client.answer(taskId, answer, token, { signal: exec?.signal })
      const waitSeconds = Math.max(2, Math.min(60, finite(args.waitSeconds, 15)))
      const { snapshot, timedOut } = await client.waitTask(taskId, token, { timeoutMs: waitSeconds * 1000, signal: exec?.signal })
      return clip(`已提交回答${timedOut ? '（继续生成中）' : ''}。\n\n${formatTaskSummary(snapshot)}`)
    },
  }))

  tools.push(makeTool({
    name: 'sparksight_feedback',
    description: 'Request a revision of a rendered plan (colors, labels, typography, chart type, title/caption). Keeps the prior versions as an auditable revision lineage.',
    parameters: {
      taskId: { type: 'string', required: true, description: 'Task id.' },
      feedback: { type: 'string', required: true, description: 'Concrete revision request in the user words.' },
      planId: { type: 'string', description: 'Optional plan id to revise; defaults to the selected plan.' },
      waitSeconds: { type: 'number', description: 'Optional wait for revised plans (default 20, max 90).' },
    },
    timeoutMs: 110_000,
    async run(args, exec) {
      const token = taskToken(auth)
      const taskId = str(args.taskId).trim()
      const feedback = str(args.feedback).trim()
      if (!feedback) throw codedError('FEEDBACK_REQUIRED', '需要修改意见')
      await client.feedback(taskId, feedback, { planId: args.planId ? str(args.planId) : undefined }, token, { signal: exec?.signal })
      const waitSeconds = Math.max(1, Math.min(10, finite(args.waitSeconds, 3)))
      await new Promise((resolve) => setTimeout(resolve, waitSeconds * 1000))
      const snapshot = await client.task(taskId, token, { signal: exec?.signal })
      return clip(`已提交修改意见，后台正在生成新版本。请稍后用 sparksight_status 轮询，或直接 sparksight_preview 查看。\n\n${formatTaskSummary(snapshot)}`)
    },
  }))

  tools.push(makeTool({
    name: 'sparksight_export',
    description: 'Freeze a plotting task and export a reproducible ZIP (SVG/PNG/PDF, code, data, evidence, spec) into the Session workspace. Use after the user approves a plan.',
    parameters: {
      taskId: { type: 'string', required: true, description: 'Task id.' },
      planId: { type: 'string', description: 'Optional plan id; defaults to the selected plan.' },
      outputPath: { type: 'string', description: 'Optional ZIP path relative to the Session working directory.' },
      formats: { type: 'string', description: 'Comma-separated artifact formats (default svg,png,pdf).' },
      dpi: { type: 'number', description: 'Raster DPI (default 300).' },
      transparent: { type: 'boolean', description: 'Transparent background (default false).' },
      includeCode: { type: 'boolean', description: 'Include reproducible code (default true).' },
      includeData: { type: 'boolean', description: 'Include the CSV (default true).' },
    },
    timeoutMs: 180_000,
    async run(args, exec) {
      const token = taskToken(auth)
      const taskId = str(args.taskId).trim()
      let snapshot = await client.task(taskId, token, { signal: exec?.signal })
      const exportable = (state) => ['PRESENT', 'ITERATE', 'COMPLETE'].includes(String(state))
      if (!exportable(snapshot.state)) {
        const waited = await client.waitTask(taskId, token, {
          timeoutMs: 90_000,
          signal: exec?.signal,
          stop: (value) => exportable(value.state) || ['FAILED', 'CANCELLED'].includes(String(value.state)),
        })
        snapshot = waited.snapshot
      }
      if (['FAILED', 'CANCELLED'].includes(String(snapshot.state))) {
        throw codedError('TASK_NOT_EXPORTABLE', `任务当前状态为 ${snapshot.state}，无法导出`)
      }
      if (!exportable(snapshot.state)) {
        throw codedError('EXPORT_NOT_READY', '任务仍在执行，尚无最终方案可导出；请稍后重试')
      }
      const planId = str(args.planId).trim() || str(snapshot.selectedPlanId).trim() || str(snapshot.plans?.[0]?.plan_id).trim()
      const exportResult = await client.exportTask(taskId, {
        planId: planId || undefined,
        formats: str(args.formats, 'svg,png,pdf'),
        dpi: Math.max(72, Math.min(1200, finite(args.dpi, 300))),
        transparent: bool(args.transparent, false),
        includeCode: bool(args.includeCode, true),
        includeData: bool(args.includeData, true),
      }, token, { signal: exec?.signal })
      const zipPath = safeOutputPath(ctx, exec, args.outputPath, `${taskId}${planId ? `-${planId}` : ''}.zip`)
      await fs.promises.mkdir(path.dirname(zipPath), { recursive: true })
      await fs.promises.writeFile(zipPath, exportResult.bytes)
      return clip([
        `导出完成：${zipPath}`,
        `大小：${(exportResult.bytes.length / 1024).toFixed(1)} KB`,
        `方案：${planId || '(默认)'}`,
        '如用户需要，可在“绘图”页签继续查看任务状态或打开工作台。',
      ].join('\n'))
    },
  }))

  const disposers = tools.map((tool) => ctx.tools.register(tool))
  log(`registered ${tools.length} SPARK SIGHT tools`)
  return () => {
    for (const dispose of disposers) {
      try { dispose() } catch { /* already disposed */ }
    }
  }
}

export function registerSparksightPrompt(ctx) {
  const bashOrder = Number(ctx.systemPrompt.getSectionOrder?.('TOOL_BASH'))
  const order = Number.isFinite(bashOrder) ? bashOrder + 10 : 1200
  return ctx.systemPrompt.section({
    name: 'sparksight:research-plotting',
    order,
    text: [
      '## SPARK SIGHT research plotting',
      'When the user asks for a research data figure (bar, line, scatter, box, violin, forest, heatmap, dual-axis, 3D surface/scatter/line, or a revision/export of one), use the `sparksight_*` tools instead of writing plotting code from scratch.',
      '1. Locate the actual CSV/TSV in the Session workspace; never fabricate data. If no data file exists, ask the user to attach it first.',
      '2. Call `sparksight_plot` with the real `dataPath` and the user request as `prompt`. Keep the task id.',
      '3. If the result contains a clarification question, relay it to the user and send their answer with `sparksight_answer`. Repeat until plans arrive.',
      '4. When plans exist, summarize the 2–3 strongest candidates (chart type, rationale, verification), render the recommended one with `sparksight_preview`, and ask the user to choose unless they already specified a plan.',
      '5. Use `sparksight_select` for a choice, `sparksight_feedback` for revisions, and `sparksight_export` only after the user approves the figure.',
      '6. Report exact generated file paths. The user can also open the native “绘图” tab next to Trajectory for a live preview and settings.',
      'Do not use these tools for architecture diagrams, flowcharts, or schematic illustrations — they are only for tabular research figures.',
      'If a tool returns `AUTH_REQUIRED`, tell the user to click the “绘图” switch next to the model selector and sign in, then retry.',
    ].join('\n'),
  })
}

export function registerSparksightTools(ctx, options) {
  return {
    tools: createSparksightTools({ ctx, ...options }),
    prompt: registerSparksightPrompt(ctx),
  }
}
