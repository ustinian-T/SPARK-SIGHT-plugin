import { useEffect, useState } from 'react'
import { useStore } from '../state/store'
import { Badge, Button, EmptyState, Meter, Modal } from './common'
import { Icon } from './icons'
import { ChartPreview } from './ChartPreview'
import { RealSvgPreview } from './SvgPreview'
import { STRATEGY_LABEL, type PlotPlan, type UtilityScore } from '../types'

const KIND_LABEL: Record<string, string> = {
  trend: '趋势',
  comparison: '比较',
  correlation: '相关',
  distribution: '分布',
  quality: '质量'
}

function copyText(text: string) {
  if (navigator.clipboard?.writeText) void navigator.clipboard.writeText(text)
}

/** v0.4.1 图表解读文案：结构化要点 + 可改写分析段落 + 图注建议（全部数字可溯源到证据） */
function InterpretationBlock({ plan }: { plan: PlotPlan }) {
  const interp = plan.interpretation
  if (!interp) return null
  const { generatePaperDraft, confirmChartRecommendation } = useStore()
  const [purpose, setPurpose] = useState('')
  const [section, setSection] = useState('')
  const [paperBusy, setPaperBusy] = useState(false)
  const [paperError, setPaperError] = useState('')
  return (
    <div className="interpretation">
      <div className="interpretation__head">
        <strong>解读要点</strong>
        <Button size="xs" variant="ghost" icon="copy" title="复制分析段落与图注" onClick={() => copyText(`【分析段落】\n${interp.analysisParagraph}\n\n【图注建议】\n${interp.captionSuggestion}`)}>
          复制
        </Button>
      </div>
      <ul className="interpretation__insights">
        {interp.insights.map((insight) => (
          <li key={insight.id}>
            <span className="badge badge--info">{KIND_LABEL[insight.kind] ?? insight.kind}</span>
            <span>{insight.text}</span>
          </li>
        ))}
      </ul>
      {interp.insightTable && interp.insightTable.length > 0 && (
        <table className="interpretation__table">
          <thead><tr><th>指标</th><th>结果</th><th>一般评定标准</th></tr></thead>
          <tbody>{interp.insightTable.map((row) => <tr key={`${row.evidenceId}-${row.metric}`}><td>{row.metric}</td><td>{row.result}</td><td>{row.criterion}</td></tr>)}</tbody>
        </table>
      )}
      {interp.qualityNotes?.map((note) => <small key={note} className="form-hint">{note}</small>)}
      {interp.chartRecommendation && <small className="form-hint">图型建议：{interp.chartRecommendation}</small>}
      {interp.recommendation?.status === 'needs_confirmation' && <div className="form-error">建议先确认替代图型：{interp.recommendation.alternatives.join('、')} <Button size="xs" variant="ghost" onClick={() => void confirmChartRecommendation(interp.recommendation?.alternatives[0] ?? '')}>采用首选建议</Button></div>}
      <details className="interpretation__details">
        <summary>分析素材（需结合研究语境改写）</summary>
        <p>{interp.analysisParagraph}</p>
      </details>
      <details className="interpretation__details">
        <summary>论文级表述（需补充用途与章节位置）</summary>
        {interp.paperDraft?.status === 'ready' ? <p>{interp.paperDraft.text}</p> : <>
          <p>{interp.paperDraft?.note ?? '请先说明数据用途和论文位置，再生成论文级表述。'}</p>
          <input className="input" value={purpose} onChange={(e) => setPurpose(e.target.value)} placeholder="数据用于回答什么研究问题？" />
          <input className="input" value={section} onChange={(e) => setSection(e.target.value)} placeholder="拟放在哪个章节或图号？" />
          <Button size="xs" variant="primary" disabled={paperBusy} onClick={async () => { setPaperError(''); setPaperBusy(true); try { await generatePaperDraft(plan.plan_id, purpose, section) } catch (error) { setPaperError(error instanceof Error ? error.message : '生成失败，请检查后端连接后重试') } finally { setPaperBusy(false) } }}>{paperBusy ? '生成中…' : '生成论文级表述'}</Button>
          {paperError && <small className="form-error">{paperError}</small>}
        </>}
        {interp.humanReview?.map((item) => <small key={item} className="form-hint">人工核对：{item}</small>)}
      </details>
      <details className="interpretation__details">
        <summary>图注建议</summary>
        <p className="mono">{interp.captionSuggestion}</p>
      </details>
    </div>
  )
}

const SCORE_DIMS = ['DataFit', 'TaskFit', 'Readability', 'ScientificConvention', 'PreferenceFit', 'Executability'] as const
type ScoreDim = (typeof SCORE_DIMS)[number]
const SCORE_LABEL: Record<ScoreDim, string> = {
  DataFit: '数据契合',
  TaskFit: '任务契合',
  Readability: '可读性',
  ScientificConvention: '科学惯例',
  PreferenceFit: '偏好契合',
  Executability: '可执行性'
}

function Scores({ score }: { score: UtilityScore }) {
  return (
    <div className="score-details__body">
      {SCORE_DIMS.map((k) => {
        const value = score[k] as number
        return (
          <div className="scoreline" key={k}>
            <span>{SCORE_LABEL[k]}</span>
            <Meter value={value} tone={value >= 0.85 ? 'brand' : value >= 0.7 ? 'warn' : 'danger'} />
            <b>{value.toFixed(2)}</b>
          </div>
        )
      })}
      <div className="scoreline" style={{ marginTop: 3 }}>
        <span style={{ fontWeight: 700, color: 'var(--ink-800)' }}>加权总分</span>
        <Meter value={score.total} />
        <b style={{ color: 'var(--brand-700)' }}>{score.total.toFixed(2)}</b>
      </div>
    </div>
  )
}

function VerificationSummary({ plan }: { plan: PlotPlan }) {
  const checks = plan.verification?.checks ?? []
  if (checks.length === 0) return null
  return (
    <details className="score-details score-details--compact">
      <summary>执行与制图检查 <b>{plan.verification?.passed ? '通过' : '需修复'}</b></summary>
      <div style={{ display: 'flex', flexDirection: 'column', gap: 5, marginTop: 7 }}>
        {plan.verification?.quality && <div style={{ fontSize: 11.2, color: plan.verification.quality.grade === 'blocked' ? 'var(--danger, #991b1b)' : plan.verification.quality.grade === 'ready' ? 'var(--ok, #166534)' : 'var(--warn, #92400e)' }}>
          <b>质量等级：{plan.verification.quality.grade} · {plan.verification.quality.score}/100</b>
          <div style={{ color: 'var(--ink-500)', marginTop: 2 }}>{plan.verification.quality.summary}</div>
        </div>}
        {checks.map((check) => (
          <div key={check.name} style={{ fontSize: 11.2, color: check.passed ? 'var(--ok, #166534)' : 'var(--danger, #991b1b)' }}>
            <b>{check.passed ? '✓' : '✕'} {check.name}</b>
            <div style={{ color: 'var(--ink-500)', marginTop: 2 }}>{check.detail}</div>
            {check.violations?.filter((v) => v && typeof v === 'object' && 'message' in v).map((v, index) => (
              <div key={index} style={{ color: (v as { level?: string }).level === 'error' ? 'var(--danger, #991b1b)' : 'var(--warn, #92400e)', marginTop: 2 }}>
                · {(v as { message: string }).message}
              </div>
            ))}
            {check.warnings?.map((warning, index) => <div key={`warning-${index}`} style={{ color: 'var(--warn, #92400e)', marginTop: 2 }}>· {warning}</div>)}
          </div>
        ))}
      </div>
    </details>
  )
}

function PlanCard({ plan, onZoom, realSvg }: { plan: PlotPlan; onZoom: () => void; realSvg?: string }) {
  const { state, choosePlan, rejectPlan, setView, setActivePlan } = useStore()
  const selected = state.task?.selectedPlanId === plan.plan_id
  return (
    <article className={`plancard ${selected ? 'plancard--selected' : ''}`}>
      <div className="plancard__head">
        <div className="plancard__name">
          {selected && <Icon name="check" size={15} style={{ color: 'var(--brand-600)' }} />}
          {plan.name}
        </div>
        <div className="plancard__strat">
          <Badge tone="brand">{plan.comparisonRole === 'user_request_converged' ? '按用户要求 · 图型已收敛' : plan.comparisonRole === 'user_request' ? '按用户要求' : `系统推荐 · ${STRATEGY_LABEL[plan.strategy]}`}</Badge>{' '}
          <Badge tone="muted">{plan.chartType}</Badge>
        </div>
      </div>

      <div
        className="plancard__chart"
        onClick={onZoom}
        onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onZoom() } }}
        role="button"
        tabIndex={0}
        title="点击放大查看"
      >
        {realSvg ? <RealSvgPreview svg={realSvg} /> : <ChartPreview plan={plan} />}
      </div>

      <div className="plancard__body">
        <p className="plancard__rationale">{plan.rationale}</p>
        <div className="chart-insight">
          <strong>这张图说明什么</strong>
          <span>{plan.insightSummary ?? '用于呈现数据中的主要差异与变化趋势。'}</span>
          {plan.focusExplanation && <small>{plan.focusExplanation}</small>}
        </div>
        <InterpretationBlock plan={plan} />
        <VerificationSummary plan={plan} />
        <details className="score-details">
          <summary>查看详细评分 <b>{plan.score.total.toFixed(2)}</b></summary>
          <Scores score={plan.score} />
        </details>
        <details className="score-details score-details--compact">
          <summary>方案差异与配色</summary>
          <div className="dimtags">
            {plan.diffDimensions.map((d) => (
              <span key={d} className="badge badge--info">{d}</span>
            ))}
          </div>
          {plan.palette && (
            <div className="palette-note">
              <span>{plan.palette.name}</span>
              <span className="palette-swatches">{plan.palette.colors.slice(0, 8).map((color) => <i key={color} style={{ background: color }} title={color} />)}</span>
              <small>{plan.palette.reason}</small>
              {plan.palette.metrics && (
                <small>
                  可辨性：CVD {plan.palette.metrics.cvdPass === false ? '未通过' : '通过'} · 灰度 {plan.palette.metrics.grayscalePass === false ? '未通过' : '通过'} · ΔE00 {plan.palette.metrics.minDeltaE?.toFixed(1) ?? '—'}
                </small>
              )}
              {plan.palette.warnings?.map((warning) => <small key={warning} className="text-warn">{warning}</small>)}
            </div>
          )}
        </details>
        <div className="kv"><span className="kv__k">适用场景</span><span className="kv__v" style={{ textAlign: 'right' }}>{plan.applicableScene}</span></div>
        <div className="kv"><span className="kv__k">依赖</span><span className="kv__v mono" style={{ textAlign: 'right' }}>{plan.dependencies.join('、')}</span></div>
      </div>

      <div className="plancard__foot">
        <Button
          size="sm"
          variant={selected ? 'glass' : 'primary'}
          icon={selected ? 'check' : 'spark'}
          className="btn--block"
          onClick={() => choosePlan(plan)}
        >
          {selected ? '已选择' : '选择此方案'}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          icon="code"
          title="查看完整源码"
          onClick={() => { setActivePlan(plan.plan_id); setView('code') }}
        >
          源码
        </Button>
        <Button size="sm" variant="ghost" icon="close" title="记为负向偏好" onClick={() => rejectPlan(plan)} />
      </div>
    </article>
  )
}

function Lightbox({ plan, realSvg, onClose }: { plan: PlotPlan; realSvg?: string; onClose: () => void }) {
  const { choosePlan, state, setView, setActivePlan } = useStore()
  const selected = state.task?.selectedPlanId === plan.plan_id
  // 复用统一 Modal：遮罩 / ESC / 焦点陷阱 / 焦点返回由其内置
  return (
    <Modal open title={plan.name} onClose={onClose} width={1080}>
      <div className="lightbox__card">
        <div className="lightbox__head">
          <div style={{ display: 'flex', alignItems: 'center', gap: 9 }}>
            <strong>{plan.name}</strong>
            <Badge tone="brand">{STRATEGY_LABEL[plan.strategy]}</Badge>
            <Badge tone="muted">{plan.chartType}</Badge>
          </div>
          <Button size="sm" variant="ghost" icon="close" onClick={onClose}>关闭</Button>
        </div>
        <div className="lightbox__body">
          {realSvg ? <RealSvgPreview svg={realSvg} /> : <ChartPreview plan={plan} large />}
        </div>
        <div style={{ padding: '10px 16px', display: 'flex', gap: 8, justifyContent: 'flex-end', borderTop: '1px solid var(--line)' }}>
          <Button size="sm" variant="ghost" icon="code" onClick={() => { setActivePlan(plan.plan_id); setView('code'); onClose() }}>查看源码</Button>
          <Button size="sm" variant="primary" icon="check" onClick={() => { choosePlan(plan); onClose() }}>
            {selected ? '已选择' : '选择此方案'}
          </Button>
        </div>
      </div>
    </Modal>
  )
}

export function CompareView() {
  const { state, client } = useStore()
  const plans = state.task?.plans ?? []
  const [zoom, setZoom] = useState<string | null>(null)
  const [previewSvgs, setPreviewSvgs] = useState<Record<string, string>>({})
  useEffect(() => {
    let cancelled = false
    const runtime = client.current
    const task = state.task
    if (!runtime || !task) {
      setPreviewSvgs({})
      return () => { cancelled = true }
    }
    const ready = task.plans.filter((plan) => task.planArtifacts?.[plan.plan_id])
    void Promise.allSettled(ready.map(async (plan) => [plan.plan_id, (await runtime.getPreview(plan.plan_id)).svg] as const)).then((results) => {
      if (cancelled) return
      const next: Record<string, string> = {}
      for (const result of results) if (result.status === 'fulfilled') next[result.value[0]] = result.value[1]
      setPreviewSvgs(next)
    })
    return () => { cancelled = true }
  }, [client, state.task?.taskId, state.task?.currentRevision, state.task?.plans, state.task?.planArtifacts])
  if (plans.length === 0) {
    return (
      <div className="panel" style={{ display: 'grid', placeItems: 'center' }}>
        <EmptyState
          icon="grid"
          title="尚未生成候选方案"
          desc="在对话中上传 CSV 并描述需求后，将呈现三套差异化方案供比较与选择。"
        />
      </div>
    )
  }
  const zoomPlan = plans.find((p) => p.plan_id === zoom)
  return (
    <div className="panel" style={{ overflow: 'hidden' }}>
      <div className="compare">
        {plans.map((p) => (
          <PlanCard key={p.plan_id} plan={p} realSvg={previewSvgs[p.plan_id]} onZoom={() => setZoom(p.plan_id)} />
        ))}
      </div>
      {zoomPlan && <Lightbox plan={zoomPlan} realSvg={previewSvgs[zoomPlan.plan_id]} onClose={() => setZoom(null)} />}
    </div>
  )
}
