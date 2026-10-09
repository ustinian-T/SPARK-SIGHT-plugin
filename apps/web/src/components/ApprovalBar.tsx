// 阶段 6：底部非阻塞审批条。
// 监听 WS approval_requested 事件，在屏幕底部弹出审批条，不打断对话流。
// 显示“Agent 请求：{action} — {reason}”，提供 [批准] [拒绝] [本会话不再询问]。
import { useStore } from '../state/store'
import { Button, Badge } from './common'
import { Icon } from './icons'

export function ApprovalBar() {
  const { state, respondApproval } = useStore()
  // 队列中第一条待审批（FIFO）；多条时逐条处理。
  const req = state.pendingApprovals[0]
  if (!req) return null

  const isDemo = state.gate.status !== 'available'

  return (
    <div style={{
      position: 'fixed', bottom: 16, left: '50%', transform: 'translateX(-50%)',
      zIndex: 70, minWidth: 420, maxWidth: 640,
      background: 'var(--panel-bg, #fff)', border: '1px solid var(--line)',
      borderRadius: 12, padding: '12px 16px',
      boxShadow: '0 8px 30px rgba(0,0,0,0.14)',
      display: 'flex', alignItems: 'center', gap: 12
    }}>
      <span style={{ color: 'var(--warn, #b7791f)' }}>
        <Icon name="warn" size={18} />
      </span>
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, fontWeight: 600, display: 'flex', alignItems: 'center', gap: 6 }}>
          Agent 请求：{req.action}
          <Badge tone="muted">{req.category}</Badge>
          {isDemo && <Badge tone="warn">演示模式</Badge>}
          {state.pendingApprovals.length > 1 && (
            <span style={{ fontSize: 11, color: 'var(--ink-400)' }}>(+{state.pendingApprovals.length - 1} 待处理)</span>
          )}
        </div>
        <div style={{ fontSize: 11.5, color: 'var(--ink-400)', marginTop: 2, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
          {req.reason}
        </div>
      </div>
      <div style={{ display: 'flex', gap: 6, flexShrink: 0 }}>
        <Button size="sm" variant="soft" onClick={() => void respondApproval(req.requestId, false)}>拒绝</Button>
        <Button size="sm" variant="ghost" onClick={() => void respondApproval(req.requestId, true, true)}>本会话不再询问</Button>
        <Button size="sm" variant="primary" onClick={() => void respondApproval(req.requestId, true)}>批准</Button>
      </div>
    </div>
  )
}
