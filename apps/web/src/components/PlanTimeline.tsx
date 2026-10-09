import type { PlanStep } from '../types'
import { Icon } from './icons'
import { fmtMs } from '../lib/format'

const STATUS_ICON: Record<PlanStep['status'], string> = {
  pending: 'clock',
  running: 'refresh',
  done: 'check',
  failed: 'error',
  skipped: 'close'
}

export function PlanTimeline({ steps }: { steps: PlanStep[] }) {
  if (steps.length === 0) return null
  return (
    <div className="plan-card">
      <div className="plan-card__head">
        <Icon name="branch" size={14} />
        <span>可观察执行计划（PlanGraph）</span>
        <span className="badge badge--muted" style={{ marginLeft: 'auto' }}>
          {steps.filter((s) => s.status === 'done').length}/{steps.length}
        </span>
      </div>
      <div>
        {steps.map((s) => (
          <div key={s.step_id} className={`step step--${s.status}`}>
            <div className="step__rail">
              <span className="step__node">
                {s.status === 'done' && <Icon name="check" size={9} style={{ color: '#fff' }} />}
                {s.status === 'failed' && <Icon name="error" size={9} style={{ color: '#fff' }} />}
              </span>
              <span className="step__line" />
            </div>
            <div className="step__main">
              <div className="step__title">
                {s.title}
                <span className="step__tool">{s.tool}</span>
                {s.attempts && s.attempts > 0 ? <span className="badge badge--warn">重试 {s.attempts}</span> : null}
              </div>
              {(s.status === 'running' || s.status === 'done' || s.status === 'failed') && (s.inputSummary || s.outputSummary) && (
                <div className="step__io">
                  {s.status === 'running' && s.inputSummary ? `输入：${s.inputSummary}` : s.outputSummary ?? s.inputSummary}
                </div>
              )}
              {s.status === 'failed' && s.errorSignature && (
                <div className="step__io" style={{ color: 'var(--danger)' }}>
                  错误签名：{s.errorSignature}（已归一化并进入自纠错）
                </div>
              )}
              {s.durationMs ? (
                <div className="step__meta">
                  <span>{fmtMs(s.durationMs)}</span>
                  {s.dependsOn.length > 0 && <span>依赖 {s.dependsOn.length}</span>}
                </div>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}

export { STATUS_ICON }
