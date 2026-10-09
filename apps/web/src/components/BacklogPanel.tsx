// 阶段 7：待办队列面板——可折叠，显示排队/执行中/已完成/已取消的待办项。
// 支持立即执行（在 step 边界打断当前任务）、上移/下移排序、删除与清空队列。
import { useState } from 'react'
import { useStore } from '../state/store'
import { Badge, Button, IconButton, Tooltip } from './common'
import { Icon } from './icons'
import { BACKLOG_STATUS_LABEL, type BacklogItem, type BacklogStatus } from '../types'

// 状态标签配色
const STATUS_TONE: Record<BacklogStatus, 'muted' | 'info' | 'brand' | 'ok' | 'danger' | 'warn'> = {
  queued: 'muted',
  blocking: 'warn',
  executing: 'brand',
  done: 'ok',
  cancelled: 'danger'
}

// 格式化创建时间：MM-DD HH:mm
function formatTime(ts: number): string {
  const d = new Date(ts)
  const mm = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  const hh = String(d.getHours()).padStart(2, '0')
  const mi = String(d.getMinutes()).padStart(2, '0')
  return `${mm}-${dd} ${hh}:${mi}`
}

function BacklogRow({ item, index, total }: { item: BacklogItem; index: number; total: number }) {
  const { executeBacklogItem, removeBacklogItem, reorderBacklog } = useStore()
  const isActive = item.status === 'executing' || item.status === 'blocking'
  const canReorder = item.status === 'queued' || item.status === 'blocking'

  return (
    <div
      style={{
        padding: '8px 10px',
        borderRadius: 6,
        marginBottom: 6,
        background: isActive ? 'var(--brand-50, rgba(49,95,76,0.06))' : 'transparent',
        border: isActive ? '1px solid var(--brand-200, rgba(49,95,76,0.2))' : '1px solid transparent'
      }}
    >
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 6 }}>
        {/* 执行中进度指示 */}
        {item.status === 'executing' && (
          <span className="dot dot--pulse" style={{ marginTop: 5 }} />
        )}
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 12.5, lineHeight: 1.4, wordBreak: 'break-word' }}>
            {item.content}
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
            <Badge tone={STATUS_TONE[item.status]}>{BACKLOG_STATUS_LABEL[item.status]}</Badge>
            <span style={{ fontSize: 10.5, color: 'var(--ink-400)' }}>{formatTime(item.createdAt)}</span>
          </div>
        </div>
      </div>
      {/* 操作按钮行 */}
      {item.status !== 'done' && item.status !== 'cancelled' && (
        <div style={{ display: 'flex', gap: 4, marginTop: 6, justifyContent: 'flex-end' }}>
          {canReorder && (
            <>
              <IconButton
                name="chevronR"
                title="上移优先级"
                style={{ transform: 'rotate(-90deg)' }}
                disabled={index === 0}
                onClick={() => reorderBacklog(item.id, 'up')}
              />
              <IconButton
                name="chevronR"
                title="下移优先级"
                style={{ transform: 'rotate(90deg)' }}
                disabled={index === total - 1}
                onClick={() => reorderBacklog(item.id, 'down')}
              />
            </>
          )}
          {item.status === 'queued' && (
            <Button
              size="sm"
              variant="primary"
              icon="play"
              onClick={() => executeBacklogItem(item.id)}
            >
              立即执行
            </Button>
          )}
          {item.status !== 'executing' && (
            <IconButton
              name="trash"
              title="删除待办"
              onClick={() => removeBacklogItem(item.id)}
            />
          )}
        </div>
      )}
    </div>
  )
}

export function BacklogPanel() {
  const { state, clearBacklog } = useStore()
  const [open, setOpen] = useState(true)
  // 排队中+待打断+执行中计入徽标数；已完成/已取消不计。
  const activeCount = state.backlog.filter(
    (item) => item.status === 'queued' || item.status === 'blocking' || item.status === 'executing'
  ).length

  return (
    <section
      style={{
        background: 'var(--glass-bg)',
        backdropFilter: 'var(--blur)',
        border: '1px solid var(--glass-border)',
        borderRadius: 'var(--radius)',
        overflow: 'hidden',
        flex: 'none'
      }}
    >
      <header
        className="panel__head"
        style={{ cursor: 'pointer', userSelect: 'none' }}
        onClick={() => setOpen((v) => !v)}
      >
        <div className="panel__title">
          <Icon name="layers" size={15} />
          <span>待办队列 ({activeCount})</span>
        </div>
        <div className="panel__right" style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
          {activeCount > 0 && open && (
            <Tooltip content="移除所有排队中的待办，不影响已执行项。" placement="bottom">
              <button
                className="btn btn--sm btn--ghost"
                onClick={(e) => { e.stopPropagation(); clearBacklog() }}
              >
                清空队列
              </button>
            </Tooltip>
          )}
          <Icon name={open ? 'chevronD' : 'chevronR'} size={14} />
        </div>
      </header>
      <div className={`backlog-body ${open ? 'is-open' : ''}`}>
        <div style={{ padding: 8, maxHeight: 220, overflowY: 'auto' }}>
          {state.backlog.length === 0 ? (
            <div style={{ padding: '16px 8px', textAlign: 'center', fontSize: 12, color: 'var(--ink-400)' }}>
              暂无待办，在输入框输入消息后点「加入待办」
            </div>
          ) : (
            state.backlog.map((item, idx) => (
              <BacklogRow key={item.id} item={item} index={idx} total={state.backlog.length} />
            ))
          )}
        </div>
      </div>
    </section>
  )
}
