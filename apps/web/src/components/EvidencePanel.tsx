import { useStore } from '../state/store'
import { Badge, EmptyState } from './common'

export function EvidencePanel() {
  const { state } = useStore()
  const evidence = state.task?.evidence ?? []
  if (evidence.length === 0) {
    return <EmptyState icon="shield" title="证据账本为空" desc="确定性统计分析完成后，每条自然语言结论绑定的证据（样本量、趋势、极值、相关性）将在此可追溯呈现。" />
  }
  return (
    <div className="thin-scroll" style={{ overflow: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div className="notebox notebox--info" style={{ padding: 8 }}>
        结论必须引用证据；验证器会拦截无证据的因果或显著性表述（相关 ≠ 因果）。
      </div>
      {evidence.map((e) => (
        <div key={e.evidence_id} className="evcard">
          <div style={{ display: 'flex', justifyContent: 'space-between', gap: 8 }}>
            <span className="evcard__metric">{e.metric}</span>
            <span className="badge badge--brand">{e.tool}</span>
          </div>
          <div className="evcard__value">{e.value}</div>
          <div className="evcard__meta">
            {e.evidence_id} · 字段 {e.fields.join('、')}
          </div>
          <div className="evcard__meta" style={{ marginTop: 2 }}>范围：{e.scope}</div>
          {e.note && <div style={{ fontSize: 10.8, color: 'var(--ink-500)', marginTop: 3 }}>{e.note}</div>}
        </div>
      ))}
      <div style={{ marginTop: 4 }}>
        <Badge tone="muted">共 {evidence.length} 条证据 · 统计仅执行一次，三方案共享</Badge>
      </div>
    </div>
  )
}
