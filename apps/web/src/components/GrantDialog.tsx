// 阶段 5：跨任务取数授权对话框。
// 监听 WS grant_requested 事件弹出模态，显示请求任务/目标任务/字段/用途，
// 提供 [单次允许] [本项目永久允许] [拒绝] 三按钮。
// 风险必须显式呈现，绝不默认批准。
import { useStore } from '../state/store'
import { Button, Badge, Modal } from './common'
import { Icon } from './icons'

export function GrantDialog() {
  const { state, resolveGrant } = useStore()
  const pending = state.pendingGrant
  const open = !!pending

  // Mock 演示模式：无真实后端连接时打“演示模式”标签。
  const isDemo = state.gate.status !== 'available'

  return (
    <Modal open={open} onClose={() => { /* 关闭=拒绝（不选字段即视为拒绝） */ pending && void resolveGrant(pending.requestId, false, 'once') }} title="跨任务取数授权请求" width={560}>
      <div style={{
        background: 'var(--panel-bg, #fff)', borderRadius: 12, padding: 24,
        boxShadow: '0 20px 60px rgba(0,0,0,0.18)'
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
          <Icon name="lock" size={18} />
          <h3 style={{ margin: 0, fontSize: 16 }}>跨任务取数授权请求</h3>
          {isDemo && <Badge tone="warn">演示模式</Badge>}
        </div>

        <div className="inline-alert inline-alert--warn" style={{ marginBottom: 16 }} role="alert">
          <Icon name="warn" size={14} />
          <span>
            另一个任务正在请求读取本项目其他任务的数据字段。请确认用途合理后再授权；
            授权后目标任务将可访问这些字段，永久授权会持续生效直至你手动撤销。
          </span>
        </div>

        {pending && (
          <>
            <div style={{ display: 'grid', gap: 10, fontSize: 13 }}>
              <div>
                <div style={{ color: 'var(--ink-400)', fontSize: 11, marginBottom: 2 }}>请求任务</div>
                <div className="mono" style={{ fontWeight: 600 }}>{pending.fromTaskId}</div>
              </div>
              <div>
                <div style={{ color: 'var(--ink-400)', fontSize: 11, marginBottom: 2 }}>目标数据任务</div>
                <div className="mono" style={{ fontWeight: 600 }}>{pending.toTaskId}</div>
              </div>
              <div>
                <div style={{ color: 'var(--ink-400)', fontSize: 11, marginBottom: 2 }}>请求字段</div>
                <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                  {pending.fields.map((f) => (
                    <Badge key={f} tone="brand">{f}</Badge>
                  ))}
                </div>
              </div>
              <div>
                <div style={{ color: 'var(--ink-400)', fontSize: 11, marginBottom: 2 }}>用途说明</div>
                <div style={{ lineHeight: 1.5, padding: 8, background: 'var(--bg-subtle, #f6f6f6)', borderRadius: 6 }}>
                  {pending.purpose || '（未提供用途说明）'}
                </div>
              </div>
            </div>

            <div style={{ display: 'flex', gap: 8, marginTop: 20, justifyContent: 'flex-end' }}>
              <Button variant="soft" onClick={() => void resolveGrant(pending.requestId, false, 'once')}>
                拒绝
              </Button>
              <Button variant="ghost" onClick={() => void resolveGrant(pending.requestId, true, 'once')}>
                单次允许
              </Button>
              <Button variant="primary" onClick={() => void resolveGrant(pending.requestId, true, 'project')}>
                本项目永久允许
              </Button>
            </div>
          </>
        )}
      </div>
    </Modal>
  )
}
