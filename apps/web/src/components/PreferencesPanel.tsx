import { useStore } from '../state/store'
import { Button, EmptyState } from './common'
import { Icon } from './icons'
import type { PreferenceKind, PreferenceScope } from '../types'
import { UserProfilePanel } from './UserProfilePanel'

const KIND_LABEL: Record<PreferenceKind, string> = {
  set_default: '设为默认',
  select_plan: '选择方案',
  manual_edit: '手动编辑',
  export: '导出',
  reject: '拒绝方案',
  browse: '浏览'
}
const SCOPE_LABEL: Record<PreferenceScope, string> = {
  global: '全局',
  project: '项目',
  chart_type: '图型',
  task: '本任务'
}

function timeOf(t: number) {
  return new Date(t).toLocaleTimeString('zh-CN', { hour12: false })
}

export function PreferencesPanel() {
  const { state, clearPrefs, setPreferencePaused, revertPreference, loadColorProfile, resetColorPreferences, recordStylePreference } = useStore()
  const prefs = state.globalPreferences.length ? state.globalPreferences : (state.task?.preferences ?? [])
  const paused = state.preferencePaused
  const profile = state.colorProfile

  return (
    <div className="thin-scroll" style={{ overflow: 'auto', padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <UserProfilePanel />
      <div className="notebox notebox--info" style={{ padding: 8 }}>
        <Icon name="info" size={13} />
        <span>偏好按事件权重与时间衰减参与排序，绝不静默改动图表；每个项目独立，可查看依据。</span>
      </div>
      <div className="switch" style={{ padding: '2px 0' }}>
        <span>暂停偏好学习</span>
        <span className={`switch__track ${paused ? 'on' : ''}`} onClick={() => setPreferencePaused(!paused)} />
      </div>
      {paused && <div className="badge badge--warn">已暂停：本轮操作不再写入偏好</div>}

      <div style={{ border: '1px solid var(--glass-border)', borderRadius: 'var(--radius)', background: 'var(--glass-bg)', padding: 10 }}>
        <div style={{ fontSize: 12, fontWeight: 650, color: 'var(--ink-700)', marginBottom: 6 }}>记录明确偏好（形成可审计学习成果）</div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
          <Button size="sm" variant="ghost" onClick={() => void recordStylePreference({ palette: '低饱和蓝色', legend: '图例置于图外右侧', font: '中文无衬线', background: '白底' })}>低饱和蓝色 + 右侧图例</Button>
          <Button size="sm" variant="ghost" onClick={() => void recordStylePreference({ palette: '高对比配色', legend: '图内顶部', font: '中文无衬线', background: '白底' })}>高对比 + 顶部图例</Button>
        </div>
        <div style={{ fontSize: 10.5, color: 'var(--ink-400)', marginTop: 5 }}>点击后会写入偏好事件，并在下方显示事件编号、摘要、置信度与时间。</div>
      </div>

      {/* v0.4.0 优化：配色学习画像区块（撤销/重置闭环）——展示学习摘要与一键重置，可解释“为什么推荐这个色板” */}
      <div style={{ border: '1px solid var(--glass-border)', borderRadius: 'var(--radius)', background: 'var(--glass-bg)', padding: 10, display: 'flex', flexDirection: 'column', gap: 8 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
          <span style={{ fontSize: 12, fontWeight: 650, color: 'var(--ink-700)' }}>配色学习画像</span>
          <Button size="sm" variant="ghost" icon="refresh" onClick={() => void loadColorProfile()} title="刷新画像">
            刷新
          </Button>
        </div>
        {state.colorProfileLoading ? (
          <EmptyState icon="spark" title="正在重建配色画像…" desc="由未撤销的配色偏好事件按时间衰减与置信度加权重建。" />
        ) : !profile || profile.eventCount === 0 ? (
          <EmptyState icon="chart" title="尚未学习配色" desc="选择方案、拒绝方案、手动编辑或保存代码时会记录配色信号；撤销即遗忘（reverted 事件不再进入画像）。" />
        ) : (
          <>
            <div style={{ fontSize: 11, color: 'var(--ink-500)' }}>
              已学习 <b>{profile.eventCount}</b> 条配色信号（90 天半衰期衰减）。后续第三轮会据此动态推荐色板：
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
              {profile.paletteStats.slice(0, 5).map((stat) => (
                <div key={stat.paletteId} style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11.5 }}>
                  <span style={{ fontWeight: 600, color: 'var(--ink-700)', minWidth: 96 }}>{stat.name}</span>
                  <span className="badge badge--muted">{stat.paletteId}</span>
                  <span style={{ color: 'var(--ink-500)' }}>
                    <span style={{ color: 'var(--ok)' }}>+{stat.positive}</span> / <span style={{ color: 'var(--danger)' }}>−{stat.negative}</span> · 共 {stat.total}
                  </span>
                  <span style={{ marginLeft: 'auto', fontSize: 10.5, color: 'var(--ink-400)' }}>
                    最近 {timeOf(stat.lastAt)}
                  </span>
                </div>
              ))}
            </div>
            <div style={{ fontSize: 10.5, color: 'var(--ink-400)', lineHeight: 1.5 }}>
              重置会遗忘全部历史配色偏好（含已撤销的），图型 / 排版等其他偏好保留，之后可重新学习。
            </div>
            <Button size="sm" variant="ghost" icon="trash" onClick={resetColorPreferences} style={{ alignSelf: 'flex-end' }}>
              重置配色学习
            </Button>
          </>
        )}
      </div>

      {prefs.length === 0 && (
        <EmptyState icon="spark" title="尚未形成偏好" desc="选择方案、手动编辑、导出或拒绝方案会形成带权重的偏好事件；可随时暂停学习或重置。" />
      )}
      {prefs.map((p) => (
        <div key={p.event_id} className="prefrow" style={p.reverted ? { opacity: 0.55 } : undefined}>
          <span className={`prefrow__w ${p.weight < 0 ? 'neg' : 'pos'}`}>
            {p.weight > 0 ? '+' : ''}{p.weight.toFixed(2)}
          </span>
          <div style={{ minWidth: 0 }}>
            <div style={{ fontWeight: 650, fontSize: 11.8 }}>
              {KIND_LABEL[p.kind]} <span className="badge badge--muted">{SCOPE_LABEL[p.scope]}</span>{' '}
              {p.reverted && <span className="badge badge--muted">已撤销</span>}
            </div>
            <div style={{ color: 'var(--ink-600)', marginTop: 2, lineHeight: 1.5 }}>{p.summary}</div>
            <div style={{ fontSize: 10.5, color: 'var(--ink-400)', marginTop: 2 }}>
              {timeOf(p.t)} · 置信度 {(p.confidence * 100).toFixed(0)}% · {p.event_id}
            </div>
          </div>
          {!p.reverted && <Button size="sm" variant="ghost" icon="undo" onClick={() => revertPreference(p.event_id)}>撤销</Button>}
        </div>
      ))}
      <Button size="sm" variant="ghost" icon="trash" onClick={clearPrefs} disabled={prefs.length === 0} style={{ marginTop: 4 }}>
        清空全部偏好事件
      </Button>
    </div>
  )
}
