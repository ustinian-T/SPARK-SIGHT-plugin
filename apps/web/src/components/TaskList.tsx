// 任务列表（Sidebar 中部）：展示当前项目下的任务，支持打开历史任务、删除任务、新建任务入口。
// 状态圆点颜色：running=蓝 / done=绿 / failed=红 / 其他=灰。
import { useState } from 'react'
import { useStore } from '../state/store'
import { Button, Dot, Tooltip } from './common'
import { Icon } from './icons'
import { cx } from '../lib/format'
import { STATE_LABEL, type AgentState } from '../types'

// 运行中的中间态 → 蓝色圆点；完成 → 绿；失败 → 红；其余（等待/取消）→ 灰。
function toneOf(state: AgentState): 'info' | 'ok' | 'danger' | 'muted' {
  if (['INGEST', 'UNDERSTAND', 'PLAN', 'ANALYZE', 'DESIGN', 'EXECUTE', 'VERIFY', 'REPAIR'].includes(state)) return 'info'
  if (state === 'COMPLETE') return 'ok'
  if (state === 'FAILED') return 'danger'
  return 'muted'
}

export function TaskList() {
  const { state, openTask, deleteProjectTask, startNewTask } = useStore()
  const [confirmClear, setConfirmClear] = useState(false)
  const tasks = state.projectTasks
  const currentId = state.task?.taskId

  const onDelete = async (taskId: string, title: string) => {
    if (!window.confirm(`删除任务「${title}」？删除后原始数据与产物将不可达。`)) return
    try {
      await deleteProjectTask(state.currentProjectId, taskId)
    } catch (e) {
      window.alert(`删除任务失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  const failedTasks = tasks.filter((task) => task.state === 'FAILED')
  const clearFailed = async () => {
    if (!confirmClear) { setConfirmClear(true); return }
    setConfirmClear(false)
    await Promise.allSettled(failedTasks.map((task) => deleteProjectTask(state.currentProjectId, task.taskId)))
  }

  return (
    <div className="tasklist col-stack" style={{ minHeight: 0, flex: 1 }}>
      <Tooltip content="上传一份 CSV，开始一次新的分析任务。" placement="right">
        <Button size="sm" variant="primary" icon="plus" style={{ flex: 'none' }} onClick={() => startNewTask()}>
          新建任务
        </Button>
      </Tooltip>
      {failedTasks.length > 0 && (
        <Button size="xs" variant="ghost" icon="close" onClick={() => void clearFailed()} title="批量移除失败任务（不可恢复）">
          {confirmClear ? `再次点击确认清理 ${failedTasks.length} 条失败任务` : `清理失败任务（${failedTasks.length}）`}
        </Button>
      )}

      {state.projectsError && (
        <div className="inline-alert inline-alert--danger" style={{ padding: '6px 8px', fontSize: 11.5 }} role="alert">
          <Icon name="warn" size={12} /> <span>{state.projectsError}</span>
        </div>
      )}

      <div className="thin-scroll" style={{ overflowY: 'auto', minHeight: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 4 }}>
        {tasks.length === 0 ? (
          <div className="empty" style={{ padding: '18px 8px', textAlign: 'center' }}>
            <p style={{ fontSize: 11.5, color: 'var(--ink-500)', margin: 0 }}>暂无任务，点击“新建任务”上传数据开始分析。</p>
          </div>
        ) : (
          tasks.map((t) => {
            const active = t.taskId === currentId
            return (
              <div
                key={t.taskId}
                className={cx('task-item', active && 'is-active')}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  padding: '7px 8px',
                  borderRadius: 7,
                  cursor: 'pointer',
                  background: active ? 'var(--brand-50, rgba(37,99,235,0.08))' : 'transparent'
                }}
                onClick={() => void openTask(t.taskId)}
                onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); void openTask(t.taskId) } }}
                role="button"
                tabIndex={0}
                aria-current={active ? 'page' : undefined}
                data-task-id={t.taskId}
                data-task-state={t.state}
                title={`打开任务：${t.title}`}
              >
                <Dot tone={toneOf(t.state)} pulse={toneOf(t.state) === 'info'} />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ fontSize: 12, color: 'var(--ink-800)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }} title={t.title}>
                    {t.title}
                  </div>
                  <div style={{ fontSize: 10.5, color: 'var(--ink-400)' }}>{STATE_LABEL[t.state]}</div>
                </div>
                <button
                  type="button"
                  className="task-item__del"
                  style={{ border: 'none', background: 'transparent', cursor: 'pointer', color: 'var(--ink-400)', padding: 2, opacity: 0 }}
                  title="删除任务"
                  onClick={(e) => { e.stopPropagation(); void onDelete(t.taskId, t.title) }}
                >
                  <Icon name="close" size={12} />
                </button>
              </div>
            )
          })
        )}
      </div>
    </div>
  )
}
