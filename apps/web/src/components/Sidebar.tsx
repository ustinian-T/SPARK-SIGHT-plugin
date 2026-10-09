// 侧边栏布局：顶部项目切换器 → 中部任务列表（新建/打开/删除任务）→ 待办队列 → 数据体检面板（有任务时）→ 底部数据保留说明。
import { DatasetPanel } from './DatasetPanel'
import { BacklogPanel } from './BacklogPanel'
import { Icon } from './icons'
import { ProjectSwitcher } from './ProjectSwitcher'
import { TaskList } from './TaskList'
import { useStore } from '../state/store'

export function Sidebar() {
  const { state } = useStore()
  const hasTask = !!state.task
  return (
    <aside className="sidebar col-stack">
      <ProjectSwitcher />
      {/* 任务面板：复用 panel 视觉样式，flex:1 填满中部，任务列表内部滚动。 */}
      <section
        style={{
          flex: 'none',
          minHeight: 160,
          maxHeight: 260,
          display: 'flex',
          flexDirection: 'column',
          background: 'var(--glass-bg)',
          backdropFilter: 'var(--blur)',
          border: '1px solid var(--glass-border)',
          borderRadius: 'var(--radius)',
          overflow: 'hidden'
        }}
      >
        <header className="panel__head">
          <div className="panel__title">
            <Icon name="branch" size={15} />
            <span>任务</span>
          </div>
        </header>
        <div style={{ flex: 1, minHeight: 0, padding: 8 }}>
          <TaskList />
        </div>
      </section>
      {/* 阶段 7：待办队列——任务列表与数据体检之间，分隔线由间距体现。 */}
      <div style={{ flex: 'none', marginTop: 8 }}>
        <BacklogPanel />
      </div>
      {/* 有任务时保留数据体检面板（列类型修正/替换数据/删除任务），不破坏既有功能。 */}
      {hasTask && <DatasetPanel />}
    </aside>
  )
}
