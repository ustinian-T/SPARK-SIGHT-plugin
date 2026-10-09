import { useEffect, useRef, useState } from 'react'
import { useStore } from '../state/store'
import { Badge, Button, EmptyState, Tooltip } from './common'
import { Icon } from './icons'
import { PaletteSelect } from './PaletteSelect'
import { uid } from '../lib/format'
import type { PanelSpec, ProjectPreferences, SpecPatch } from '../types'

type Sel =
  | { kind: 'figure' }
  | { kind: 'panel'; pid: string }
  | { kind: 'layer'; pid: string; id: string }
  | { kind: 'scale'; pid: string; id: string }
  | { kind: 'legend'; pid: string }
  | { kind: 'annotation'; pid: string; id: string }

const selKey = (s: Sel) =>
  s.kind === 'figure' ? 'figure' : s.kind === 'panel' || s.kind === 'legend' ? `${s.kind}:${s.pid}` : `${s.kind}:${s.pid}:${s.id}`

function Field({ label, hint, children }: { label: string; hint?: string; children: React.ReactNode }) {
  return (
    <div className="form-group">
      <label className="form-label" style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
        <span>{label}</span>
        {hint && (
          <Tooltip content={hint} placement="top">
            <Icon name="info" size={11} style={{ color: 'var(--ink-400)', cursor: 'help' }} />
          </Tooltip>
        )}
      </label>
      {children}
    </div>
  )
}

/**
 * 开关组件（P2-7 a11y）：role=switch + aria-checked + 可聚焦，
 * Space/Enter 切换，保留点击交互。
 */
function Switch({ value, onChange, label }: { value: boolean; onChange: (v: boolean) => void; label?: string }) {
  return (
    <span
      className={`switch__track ${value ? 'on' : ''}`}
      role="switch"
      aria-checked={value}
      aria-label={label}
      tabIndex={0}
      onClick={() => onChange(!value)}
      onKeyDown={(e) => {
        if (e.key === ' ' || e.key === 'Enter') {
          e.preventDefault()
          onChange(!value)
        }
      }}
    />
  )
}

/**
 * 受控文本草稿输入（P2-1）：本地维护 draft，onChange 仅更新预览，
 * onBlur 才提交补丁；底层 spec 值变化时同步草稿。
 */
function DraftText({ value, onCommit, readOnly, className }: { value: string; onCommit?: (next: string) => void; readOnly?: boolean; className?: string }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => { setDraft(value) }, [value])
  return (
    <input
      className={className}
      value={draft}
      readOnly={readOnly}
      onChange={(e) => setDraft(e.target.value)}
      onBlur={() => { if (onCommit && draft !== value) onCommit(draft) }}
    />
  )
}

/**
 * 受控颜色选择器（P2-2）：拖动取色时只更新本地预览，
 * 失焦时才提交补丁，避免取色过程产生补丁风暴。
 */
function DraftColor({ value, onCommit }: { value: string; onCommit: (next: string) => void }) {
  const [draft, setDraft] = useState(value)
  useEffect(() => { setDraft(value) }, [value])
  return (
    <div className="colorfield">
      <input
        type="color"
        value={draft}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={() => { if (draft !== value) onCommit(draft) }}
      />
      <span className="mono">{draft}</span>
    </div>
  )
}

/** 规格树节点（P2-6）：div onClick → 键盘可达（role=button + Enter/Space） */
function TreeNode({ active, onSelect, children }: { active: boolean; onSelect: () => void; children: React.ReactNode }) {
  return (
    <div
      className={`tree__node ${active ? 'is-active' : ''}`}
      role="button"
      tabIndex={0}
      onClick={onSelect}
      onKeyDown={(e) => {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault()
          onSelect()
        }
      }}
    >
      {children}
    </div>
  )
}

function SpecEditor() {
  const { state, setActivePlan, proposePatch, applyStylePreset, undoRevision } = useStore()
  const plans = state.task?.plans ?? []
  const plan = plans.find((p) => p.plan_id === state.activePlanId) ?? plans.find((p) => p.plan_id === state.task?.selectedPlanId) ?? plans[0]
  const [sel, setSel] = useState<Sel>({ kind: 'figure' })

  // P2-1：补丁取消（或接受）关闭后递增 resetEpoch，强制表单重挂载回到底层 spec 值；
  // 切换 plan / 修订版本时也通过容器 key 重挂载，避免旧草稿残留。
  const pending = state.pendingPatch
  const pendingSeen = useRef(false)
  const [resetEpoch, setResetEpoch] = useState(0)
  useEffect(() => {
    if (pending) {
      pendingSeen.current = true
    } else if (pendingSeen.current) {
      pendingSeen.current = false
      setResetEpoch((n) => n + 1)
    }
  }, [pending])

  if (!plan) {
    return <EmptyState icon="sliders" title="尚无可编辑的图表规格" desc="方案生成后，可在此按 Figure / Panel / Layer / Scale / Legend / Annotation 六层受控编辑。" />
  }
  const { figure, panels } = plan.spec

  const fire = (p: Omit<SpecPatch, 'patch_id'>) => proposePatch(plan.plan_id, { ...p, patch_id: uid('patch') })

  const panelOf = (pid: string): PanelSpec => panels.find((x) => x.panel_id === pid)!

  const editor = () => {
    if (sel.kind === 'figure') {
      return (
        <>
          <Field label="图标题（figure.title）">
            <DraftText className="form-control" value={figure.title} onCommit={(after) => fire({ targetKind: 'figure', targetId: figure.figure_id, path: 'figure.title', label: '图标题', before: figure.title, after })} />
          </Field>
          <Field label="副标题" hint="非最小映射属性：预览即时更新，代码进入主导模式确认。">
            <DraftText className="form-control" value={figure.subtitle ?? ''} onCommit={(after) => fire({ targetKind: 'figure', targetId: figure.figure_id, path: 'figure.subtitle', label: '副标题', before: figure.subtitle ?? '', after })} />
          </Field>
          <div className="form-row">
            <Field label="宽（英寸）"><DraftText className="form-control" value={String(figure.widthIn)} readOnly /></Field>
            <Field label="高（英寸）"><DraftText className="form-control" value={String(figure.heightIn)} readOnly /></Field>
          </div>
          <Field label="字体族">
            <select className="form-control" defaultValue={figure.fontFamily} onChange={(e) => fire({ targetKind: 'figure', targetId: figure.figure_id, path: 'figure.fontFamily', label: '字体族', before: figure.fontFamily, after: e.target.value })}>
              <option value="sans">无衬线 sans</option>
              <option value="serif">衬线 serif</option>
            </select>
          </Field>
        </>
      )
    }
    if (sel.kind === 'panel') {
      const p = panelOf(sel.pid)
      return (
        <Field label="面板标题（panel.title）">
          <DraftText className="form-control" value={p.title} onCommit={(after) => fire({ targetKind: 'panel', targetId: p.panel_id, path: `panels.${p.panel_id}.title`, label: '面板标题', before: p.title, after })} />
        </Field>
      )
    }
    if (sel.kind === 'layer') {
      const p = panelOf(sel.pid)
      const l = p.layers.find((x) => x.layer_id === sel.id)!
      const base = `panels.${p.panel_id}.layers.${l.layer_id}`
      return (
        <>
          <Field label="图层名称"><DraftText className="form-control" value={l.label} readOnly /></Field>
          <Field label="线宽（layer.lineWidth）">
            <select className="form-control" defaultValue={l.lineWidth ?? 1.4} onChange={(e) => fire({ targetKind: 'layer', targetId: l.layer_id, path: `${base}.lineWidth`, label: `线宽 ${l.label}`, before: String(l.lineWidth ?? 1.4), after: Number(e.target.value) })}>
              {[1, 1.4, 2, 2.6].map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </Field>
          <Field label="颜色" hint="颜色属高自由度样式，进入代码主导模式，不静默改写源码。">
            <DraftColor value={l.color} onCommit={(after) => fire({ targetKind: 'layer', targetId: l.layer_id, path: `${base}.color`, label: `颜色 ${l.label}`, before: l.color, after })} />
          </Field>
          <Field label="线型">
            <select className="form-control" defaultValue={l.linestyle ?? '-'} onChange={(e) => fire({ targetKind: 'layer', targetId: l.layer_id, path: `${base}.linestyle`, label: `线型 ${l.label}`, before: l.linestyle ?? '-', after: e.target.value })}>
              {['-', '--', ':', '-.'].map((v) => <option key={v} value={v}>{v}</option>)}
            </select>
          </Field>
          <div className="switch">
            <span>显示误差棒</span>
            <Switch label={`${l.label}：显示误差棒`} value={!!l.showErrorBars} onChange={(v) => fire({ targetKind: 'layer', targetId: l.layer_id, path: `${base}.showErrorBars`, label: `误差棒 ${l.label}`, before: !!l.showErrorBars, after: v })} />
          </div>
        </>
      )
    }
    if (sel.kind === 'scale') {
      const p = panelOf(sel.pid)
      const sc = p.scales.find((x) => x.scale_id === sel.id)!
      const base = `panels.${p.panel_id}.scales.${sc.scale_id}`
      return (
        <>
          <Field label={`${sc.axis === 'x' ? 'X' : 'Y'} 轴标签（scale.label）`}>
            <DraftText className="form-control" value={sc.label} onCommit={(after) => fire({ targetKind: 'scale', targetId: sc.scale_id, path: `${base}.label`, label: `${sc.axis} 轴标签`, before: sc.label, after })} />
          </Field>
          <Field label="刻度类型"><DraftText className="form-control" value={sc.type} readOnly /></Field>
          <div className="switch">
            <span>显示网格</span>
            <Switch label={`${sc.axis} 轴：显示网格`} value={!!sc.grid} onChange={(v) => fire({ targetKind: 'scale', targetId: sc.scale_id, path: `${base}.grid`, label: `网格 ${sc.axis}`, before: !!sc.grid, after: v })} />
          </div>
        </>
      )
    }
    if (sel.kind === 'legend') {
      const p = panelOf(sel.pid)
      const lg = p.legend
      const base = `panels.${p.panel_id}.legend`
      return (
        <>
          <div className="switch" style={{ marginBottom: 12 }}>
            <span>显示图例（legend.visible）</span>
            <Switch label="显示图例" value={lg.visible} onChange={(v) => fire({ targetKind: 'legend', targetId: lg.legend_id, path: `${base}.visible`, label: '图例可见性', before: lg.visible, after: v })} />
          </div>
          <Field label="图例位置（legend.position）">
            <select className="form-control" defaultValue={lg.position} onChange={(e) => fire({ targetKind: 'legend', targetId: lg.legend_id, path: `${base}.position`, label: '图例位置', before: lg.position, after: e.target.value })}>
              {[['top', '顶部'], ['bottom', '底部'], ['left', '左侧'], ['right', '右侧'], ['center', '居中'], ['inside', '图内']].map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </Field>
        </>
      )
    }
    const p = panelOf(sel.pid)
    const an = p.annotations.find((x) => x.annotation_id === sel.id)!
    return (
      <Field label="标注文本" hint="标注为代码主导属性，预览更新后请在源码确认。">
        <DraftText className="form-control" value={an.text ?? ''} onCommit={(after) => fire({ targetKind: 'annotation', targetId: an.annotation_id, path: `panels.${p.panel_id}.annotations.${an.annotation_id}.text`, label: '标注文本', before: an.text ?? '', after })} />
      </Field>
    )
  }

  const revision = state.task?.currentRevision ?? 0

  return (
    <div className="spec-editor">
      <div style={{ padding: '10px 12px 0' }}>
        <select className="form-control" value={plan.plan_id} onChange={(e) => setActivePlan(e.target.value)}>
          {plans.map((p) => <option key={p.plan_id} value={p.plan_id}>{p.name}</option>)}
        </select>
        <div style={{ display: 'flex', gap: 6, marginTop: 7 }}>
          <select className="form-control" defaultValue="" onChange={(event) => {
            if (event.target.value) void applyStylePreset(plan.plan_id, event.target.value)
            event.currentTarget.value = ''
          }}>
            <option value="" disabled>应用科研样式预设…</option>
            <option value="two-column-sans">双栏无衬线</option>
            <option value="compact-sans-grid">紧凑无衬线网格</option>
            <option value="high-contrast-colorblind">高对比色盲友好</option>
            <option value="ieee-double-column-serif">IEEE 双栏衬线</option>
            <option value="monochrome-print">单色打印</option>
            <option value="presentation-bold">学术汇报粗线</option>
          </select>
          <Button size="sm" variant="ghost" onClick={() => void undoRevision()}>撤销</Button>
        </div>
      </div>
      <div className="spec-editor__grid">
        <div className="tree thin-scroll" style={{ overflow: 'auto', borderRight: '1px solid var(--line)', paddingRight: 6 }}>
          <TreeNode active={selKey(sel) === 'figure'} onSelect={() => setSel({ kind: 'figure' })}>
            <Icon name="maximize" size={13} /> Figure<span className="tree__id">{figure.figure_id}</span>
          </TreeNode>
          {panels.map((p) => (
            <div key={p.panel_id}>
              <TreeNode active={sel.kind !== 'figure' && sel.pid === p.panel_id && sel.kind === 'panel'} onSelect={() => setSel({ kind: 'panel', pid: p.panel_id })}>
                <Icon name="layers" size={13} /> {p.title || 'Panel'}
              </TreeNode>
              <div className="tree__children">
                {p.layers.map((l) => (
                  <TreeNode key={l.layer_id} active={sel.kind === 'layer' && sel.id === l.layer_id} onSelect={() => setSel({ kind: 'layer', pid: p.panel_id, id: l.layer_id })}>
                    <Icon name="chart" size={12} /> {l.label}
                  </TreeNode>
                ))}
                {p.scales.map((sc) => (
                  <TreeNode key={sc.scale_id} active={sel.kind === 'scale' && sel.id === sc.scale_id} onSelect={() => setSel({ kind: 'scale', pid: p.panel_id, id: sc.scale_id })}>
                    <Icon name="filter" size={12} /> {sc.axis}-axis
                  </TreeNode>
                ))}
                <TreeNode active={sel.kind === 'legend' && sel.pid === p.panel_id} onSelect={() => setSel({ kind: 'legend', pid: p.panel_id })}>
                  <Icon name="grid" size={12} /> legend
                </TreeNode>
                {p.annotations.map((an) => (
                  <TreeNode key={an.annotation_id} active={sel.kind === 'annotation' && sel.id === an.annotation_id} onSelect={() => setSel({ kind: 'annotation', pid: p.panel_id, id: an.annotation_id })}>
                    <Icon name="info" size={12} /> {an.kind}
                  </TreeNode>
                ))}
              </div>
            </div>
          ))}
        </div>
        <div key={`${plan.plan_id}-${revision}-${resetEpoch}`} className="thin-scroll" style={{ overflow: 'auto', paddingLeft: 12 }}>
          <Badge tone="brand">受控编辑 → SpecPatch</Badge>
          <div style={{ height: 10 }} />
          {editor()}
        </div>
      </div>
    </div>
  )
}

/** 图表类型中文映射（chartUsage 键 → 展示名）。 */
const CHART_TYPE_LABEL: Record<string, string> = {
  bar: '柱状图', line: '折线图', scatter: '散点图', heatmap: '热力图', box: '箱线图'
}

/**
 * 阶段 4：项目偏好共享分区。
 * 在规格编辑下方展示配色/字体/DPI，支持“从当前任务继承”和“设为项目默认”。
 * 同时展示图表类型差异化建议：某类型已用 > 3 次时提示尝试其他类型。
 */
function ProjectPrefSection() {
  const { state, updateProjectPreferences, setCurrentTaskAsProjectDefault } = useStore()
  const prefs = state.projectPreferences
  const usage = state.chartUsage
  const [saving, setSaving] = useState(false)

  // 找出使用次数最多的图表类型（>3 次才提示差异化）。
  const topType = Object.entries(usage).sort((a, b) => b[1] - a[1])[0]
  const suggestType = topType && topType[1] > 3 ? topType : null
  const others = Object.keys(CHART_TYPE_LABEL).filter((k) => k !== (suggestType?.[0] ?? ''))

  const save = async (patch: ProjectPreferences) => {
    setSaving(true)
    try { await updateProjectPreferences(patch) }
    finally { setSaving(false) }
  }

  return (
    <div style={{ borderTop: '1px solid var(--line)', padding: '10px 12px', marginTop: 4 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--ink-400)', marginBottom: 8, textTransform: 'uppercase', letterSpacing: 0.5 }}>
        项目偏好
      </div>
      <div className="form-row">
        <div className="form-group">
          <label className="form-label">配色方案</label>
          <PaletteSelect value={prefs.colorPalette ?? 'auto'} disabled={saving} onChange={(value) => void save({ colorPalette: value === 'auto' ? undefined : value })}
            options={[{ id: 'auto', label: '自动推荐' }, { id: 'user_ocean', label: '预设一·青蓝递进' }, { id: 'user_garden', label: '预设二·柔和分类' }, { id: 'user_nature', label: '预设三·自然低饱和' }, { id: 'user_macaron', label: '预设四·冷暖马卡龙' }, { id: 'user_pairs', label: '预设五·成对对照' }, { id: 'okabe_ito', label: 'Okabe–Ito·色盲安全' }, { id: 'paultol_bright', label: 'Paul Tol·亮色' }, { id: 'paultol_muted', label: 'Paul Tol·柔和' }, { id: 'ggsci_npg', label: 'ggsci·NPG' }, { id: 'ggsci_nejm', label: 'ggsci·NEJM' }, { id: 'brewer_diverging', label: 'ColorBrewer·蓝红发散' }, { id: 'brewer_sequential', label: 'ColorBrewer·蓝绿顺序' }, { id: 'viridis_like', label: 'Viridis·连续渐变' }, { id: 'magma_like', label: 'Magma·连续渐变' }]} />
        </div>
        <div className="form-group">
          <label className="form-label">字体</label>
          <select
            className="form-control"
            value={prefs.font ?? 'serif'}
            disabled={saving}
            onChange={(e) => void save({ font: e.target.value })}
          >
            <option value="Times New Roman">Times New Roman</option>
            <option value="Arial">Arial</option>
            <option value="Noto Sans CJK SC">Noto Sans CJK SC</option>
            <option value="Source Han Sans SC">Source Han Sans SC</option>
            <option value="Noto Serif CJK SC">Noto Serif CJK SC</option>
            <option value="Source Han Serif SC">Source Han Serif SC</option>
            <option value="KaiTi">楷体（KaiTi）</option>
            <option value="FangSong">仿宋（FangSong）</option>
            <option value="Liberation Sans">Liberation Sans</option>
            <option value="Liberation Serif">Liberation Serif</option>
            <option value="DejaVu Sans">DejaVu Sans</option>
            <option value="SimSun">宋体</option>
            <option value="SimHei">黑体</option>
            <option value="Microsoft YaHei">微软雅黑</option>
          </select>
        </div>
      </div>
      <div className="form-group">
        <label className="form-label">DPI（72–1200）</label>
        <input
          className="form-control"
          type="number" min={72} max={1200}
          value={prefs.dpi ?? 300}
          disabled={saving}
          onChange={(e) => {
            const v = Number(e.target.value)
            if (v >= 72 && v <= 1200) void save({ dpi: v })
          }}
        />
      </div>
      <div style={{ display: 'flex', gap: 6, marginTop: 6 }}>
        <Tooltip content="把当前任务的配色 / 字体 / DPI 设为项目默认。" placement="top">
          <Button size="sm" variant="ghost" onClick={() => void setCurrentTaskAsProjectDefault()}>
            从当前任务继承
          </Button>
        </Tooltip>
      </div>

      {/* 阶段 4：图表类型差异化建议（只提示，不自动改变） */}
      {suggestType && (
        <div className="inline-alert inline-alert--info" style={{ marginTop: 10, fontSize: 12 }} role="note">
          <Icon name="info" size={13} />
          <span>
            项目内已使用{CHART_TYPE_LABEL[suggestType[0]] ?? suggestType[0]} {suggestType[1]} 次，
            建议尝试{others.slice(0, 2).map((k) => CHART_TYPE_LABEL[k] ?? k).join('、')}以差异化。
          </span>
        </div>
      )}
    </div>
  )
}

/**
 * 阶段 5：授权审计区（只读列表）。
 * 展示项目内已有的跨任务取数授权记录。
 */
function GrantAuditSection() {
  const { state } = useStore()
  const grants = state.grants
  if (grants.length === 0) return null
  return (
    <div style={{ borderTop: '1px solid var(--line)', padding: '10px 12px' }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--ink-400)', marginBottom: 6, textTransform: 'uppercase', letterSpacing: 0.5 }}>
        授权审计
      </div>
      {grants.map((g) => (
        <div key={g.grantId} style={{ fontSize: 11, padding: '4px 0', borderBottom: '1px dashed var(--line)' }}>
          <Badge tone={g.scope === 'project' ? 'brand' : 'muted'}>{g.scope === 'project' ? '永久' : '单次'}</Badge>
          <span style={{ marginLeft: 6 }} className="mono">{g.fromTaskId}</span>
          <span style={{ margin: '0 4px' }}>→</span>
          <span className="mono">{g.toTaskId}</span>
          <div style={{ color: 'var(--ink-400)', marginTop: 2 }}>字段：{g.fields.join('、')}</div>
        </div>
      ))}
    </div>
  )
}

export function Inspector() {
  return (
    <section className="utility-view panel" aria-label="检测器">
      <div className="utility-view__scroll thin-scroll">
        <SpecEditor />
        <ProjectPrefSection />
        <GrantAuditSection />
      </div>
    </section>
  )
}
