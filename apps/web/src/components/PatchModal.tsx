import { useRef } from 'react'
import { useStore } from '../state/store'
import { Button, useDialogA11y } from './common'
import { Icon } from './icons'

export function PatchModal() {
  const { state, acceptPatch, cancelPatch } = useStore()
  const pp = state.pendingPatch
  // 无遮罩浮层：复用对话框 a11y 行为（ESC / 焦点陷阱 / 焦点返回）
  const dialogRef = useRef<HTMLDivElement>(null)
  useDialogA11y(!!pp, cancelPatch, dialogRef)
  if (!pp) return null
  const { patch, result } = pp

  return (
    <div
      ref={dialogRef}
      className="patchmodal"
      role="dialog"
      aria-modal="true"
      aria-labelledby="patchmodal-title"
      tabIndex={-1}
      style={{ outline: 'none' }}
    >
      <div className="patchmodal__head">
        <span id="patchmodal-title" style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <Icon name="branch" size={15} style={{ color: 'var(--brand-600)' }} />
          受控可视化编辑补丁
        </span>
        <Button size="sm" variant="ghost" icon="close" onClick={cancelPatch} aria-label="关闭补丁预览" />
      </div>
      <div className="patchmodal__body">
        <div style={{ fontWeight: 650 }}>{patch.label}</div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 11.8, flexWrap: 'wrap' }}>
          <span className="badge badge--muted">修改前</span>
          <code style={{ background: 'var(--danger-bg)', color: 'var(--danger)', padding: '2px 7px', borderRadius: 6 }}>
            {String(patch.before) || '（空）'}
          </code>
          <Icon name="chevronR" size={13} />
          <span className="badge badge--muted">修改后</span>
          <code style={{ background: 'var(--ok-bg)', color: 'var(--ok)', padding: '2px 7px', borderRadius: 6 }}>
            {String(patch.after)}
          </code>
        </div>

        {result.codeLed ? (
          <div className="notebox notebox--warn">
            <Icon name="warn" size={14} />
            <span>{result.note ?? '该属性进入代码主导模式：预览将即时更新，但不会静默改写源码，请在代码区确认同步。'}</span>
          </div>
        ) : (
          <>
            <div style={{ fontSize: 11.5, fontWeight: 600, color: 'var(--ink-600)' }}>最小代码补丁（unified diff）</div>
            <div className="patchmodal__code">
              {result.diff.map((d, i) => (
                <div key={i} className={`diffline diffline--${d.type === 'ctx' ? 'ctx' : d.type}`}>
                  <span className="diffline__gutter">{d.type === 'add' ? '+' : d.type === 'del' ? '−' : ' '}</span>
                  <span>{d.text}</span>
                </div>
              ))}
            </div>
          </>
        )}
        {pp.preview && <div className="badge badge--ok">服务端已生成预览令牌 · 父修订 v{pp.preview.parentVersion}</div>}
        {pp.error && <div className="notebox notebox--warn"><Icon name="warn" size={14} /><span>{pp.error}</span></div>}
      </div>
      <div className="patchmodal__foot">
        <Button size="sm" variant="ghost" icon="undo" onClick={cancelPatch}>撤销</Button>
        <Button size="sm" variant="primary" icon="check" disabled={pp.applying} onClick={() => void acceptPatch()}>
          {pp.applying ? '正在执行与验证…' : '接受并重新验证'}
        </Button>
      </div>
    </div>
  )
}
