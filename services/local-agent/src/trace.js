// 执行轨迹（Trace）：从结构化事件日志重建可审计时间线，便于复盘与问题定位。
// 不重新计算任何结论，只做事件聚合；与前端事件流同源（events.jsonl / task.events）。
export function buildTrace(task) {
  const states = []
  const retries = []
  const errors = []
  const plansReady = []
  for (const e of task.events) {
    if (e.type === 'state_delta' && e.state) states.push({ state: e.state, at: e.at, seq: e.seq })
    if (e.type === 'retry') retries.push({ at: e.at, seq: e.seq, retries: e.retries })
    if (e.type === 'execution_update' && e.execution?.errorCategory) {
      errors.push({
        at: e.at,
        seq: e.seq,
        category: e.execution.errorCategory,
        signature: e.execution.normalizedError
      })
    }
    if (e.type === 'plans_ready') plansReady.push({ at: e.at, seq: e.seq, count: e.plans.length })
    if (e.type === 'error') errors.push({ at: e.at, seq: e.seq, code: e.code, message: e.message })
  }
  const first = task.events[0]?.at ?? task.createdAt
  const last = task.events.at(-1)?.at ?? first
  return {
    taskId: task.taskId,
    title: task.title,
    prompt: task.prompt,
    engine: task.execution.engine,
    fingerprint: task.dataset?.fingerprint,
    parserConfig: task.dataset ? { encoding: task.dataset.encoding, delimiter: task.dataset.delimiter } : undefined,
    dimensions: task.dataset ? { rows: task.dataset.rows, cols: task.dataset.cols } : undefined,
    restored: task.restored ?? false,
    createdAt: task.createdAt,
    finishedAt: task.state === 'COMPLETE' || task.state === 'PRESENT' || task.state === 'FAILED' ? last : undefined,
    durationMs: last - first,
    state: task.state,
    states,
    steps: task.steps.map((s) => ({
      step_id: s.step_id,
      tool: s.tool,
      title: s.title,
      status: s.status,
      durationMs: s.durationMs,
      attempts: s.attempts,
      outputSummary: s.outputSummary
    })),
    evidenceIds: task.evidence.map((e) => e.evidence_id),
    retries,
    errors,
    verification: task.verification
      ? {
          passed: task.verification.passed,
          difference: task.verification.difference,
          perPlan: Object.fromEntries(
            Object.entries(task.verification.perPlan ?? {}).map(([k, v]) => [
              k,
              { passed: v.passed, engine: v.engine, attempts: v.attempts, failedChecks: (v.checks ?? []).filter((c) => !c.passed).map((c) => c.name) }
            ])
          )
        }
      : undefined,
    preferences: task.preferences,
    revisions: (task.planVersions ?? []).map((v) => ({
      version: v.version,
      at: v.at,
      reason: v.reason,
      feedback: v.feedback,
      selectedPlanId: v.selectedPlanId,
      plans: v.plans.map((p) => ({
        plan_id: p.plan_id,
        strategy: p.strategy,
        executionStatus: p.executionStatus,
        verified: p.verification?.passed ?? false,
        artifactHash: p.verification?.artifactHash
      }))
    })),
    artifacts: Object.fromEntries(
      Object.entries(task.artifacts ?? {}).map(([k, a]) => [
        k,
        { attempts: a.attempts, verified: a.verified, engine: a.engine, png: a.png, svgBytes: a.svgBytes, hash: a.hash }
      ])
    ),
    eventCount: task.events.length
  }
}

export function buildTraceList(store, predicate = () => true) {
  return [...store.tasks.values()]
    .filter(predicate)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map((t) => ({
      taskId: t.taskId,
      title: t.title,
      state: t.state,
      createdAt: t.createdAt,
      engine: t.execution.engine,
      rows: t.dataset?.rows,
      cols: t.dataset?.cols,
      fingerprint: t.dataset?.fingerprint,
      verified: t.verification?.passed ?? false,
      restored: t.restored ?? false
    }))
}
