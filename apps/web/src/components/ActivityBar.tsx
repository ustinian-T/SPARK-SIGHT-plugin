import { useStore, type MainView } from '../state/store'
import { IconButton } from './common'
import { Icon } from './icons'

const ITEMS: { id: MainView; icon: string; label: string }[] = [
  { id: 'chat', icon: 'chat', label: '对话与工作流' },
  { id: 'compare', icon: 'columns', label: '三方案比较' },
  { id: 'code', icon: 'code', label: '代码与 Diff' },
  { id: 'platform', icon: 'users', label: '项目、同步与协作' },
  { id: 'gallery', icon: 'image', label: '项目图库' },
  { id: 'inspector', icon: 'sliders', label: '检测器' },
  { id: 'evidence', icon: 'shield', label: '证据' },
  { id: 'preferences', icon: 'spark', label: '偏好' }
]

export function ActivityBar({ onOpenSettings }: { onOpenSettings: () => void }) {
  const { state, setView, newTask } = useStore()
  const planCount = state.task?.plans.length ?? 0

  return (
    <nav className="activity bar" aria-label="活动栏">
      <IconButton name="spark" size={18} title="新建任务" onClick={() => {
        newTask(); setView('chat')
      }} />
      <div style={{ height: 6 }} />
      {ITEMS.map((it) => (
        <IconButton
          key={it.id}
          name={it.icon}
          size={19}
          title={it.label}
          active={state.mainView === it.id}
          aria-label={it.label}
          aria-pressed={state.mainView === it.id}
          onClick={() => setView(it.id)}
        >
          {it.id === 'compare' && planCount > 0 && <span className="badge-dot" />}
        </IconButton>
      ))}
      <IconButton name="settings" size={19} title="模型 / API 设置" aria-label="模型 / API 设置" onClick={onOpenSettings} />
      <div className="activity__spacer" />
      <span title="安全：沙箱隔离 · 默认禁网 · 最小出站" aria-label="安全策略" style={{ width: 36, height: 36, display: 'grid', placeItems: 'center', color: 'var(--ink-400)' }}><Icon name="shield" size={18} /></span>
      <IconButton name="doc" size={18} title="打开项目仓库与文档" onClick={() => window.open('https://github.com/ustinian-T/deep_imaging', '_blank', 'noopener,noreferrer')} />
    </nav>
  )
}

export { Icon }
