import { useStore } from '../state/store'
import { STATE_LABEL, TERMINAL_STATES } from '../types'
import { shortHash } from '../lib/format'
import { Dot } from './common'
import { Icon } from './icons'
import { getHostBridge } from '../host/bridge'

function stateTone(state: string): 'ok' | 'warn' | 'danger' | 'info' | 'brand' {
  if (state === 'COMPLETE') return 'ok'
  if (state === 'FAILED') return 'danger'
  if (state === 'PRESENT' || state === 'ITERATE') return 'brand'
  if (state === 'NEED_INPUT') return 'warn'
  return 'info'
}

export function StatusBar() {
  const { state, toggleConsole } = useStore()
  const task = state.task
  const runningStep = task?.steps.find((s) => s.status === 'running')
  const doneSteps = task?.steps.filter((s) => s.status === 'done').length ?? 0
  const totalSteps = task?.steps.length ?? 0

  // 已有任务但后端暂时断连时，不把真实任务错误标记为演示数据。
  const connected = state.gate.status === 'available'
  let runLabel: string
  if (connected) {
    runLabel = getHostBridge() && state.gate.mode === 'local' ? '本地后端' : '服务器后端'
  } else if (task) {
    runLabel = '任务已离线（后端未连接）'
  } else {
    runLabel = getHostBridge() && state.runLocation === 'local' ? '本机 Agent 未连接' : '服务器绘图服务未连接'
  }

  return (
    <footer className="statusbar bar">
      <div className="statusbar__group">
        <span className="statusbar__item">
          {task ? (
            <>
              <Dot tone={stateTone(task.state)} pulse={!TERMINAL_STATES.has(task.state) && task.state !== 'PRESENT' && task.state !== 'ITERATE'} />
              <b>{STATE_LABEL[task.state]}</b>
            </>
          ) : (
            <>
              <Dot tone="muted" /> 就绪
            </>
          )}
        </span>
        {task && (
          <span className="statusbar__item" title="已完成 / 总工具节点">
            {runningStep ? runningStep.title : `工具节点 ${doneSteps}/${totalSteps}`}
          </span>
        )}
        {task && task.retries > 0 && <span className="badge badge--warn">自纠错 {task.retries} 次</span>}
      </div>

      <div className="statusbar__group">
        {task?.dataset && (
          <span className="statusbar__item mono" title="内容指纹 H = SHA256(file_bytes || parser_config)">
            指纹 {shortHash(task.dataset.fingerprint, 8)}
          </span>
        )}
        <span className="statusbar__item">
          {runLabel}
        </span>
        <span className="statusbar__item mono" title="当前绘图任务的修订次数，不是软件发布版本">任务修订 {task?.execution.version ?? '—'}</span>
        <button className="icon-btn" style={{ width: 28, height: 22 }} title="运行日志控制台" aria-label="运行日志控制台" onClick={() => toggleConsole()}>
          <Icon name="terminal" size={14} />
        </button>
      </div>
    </footer>
  )
}
