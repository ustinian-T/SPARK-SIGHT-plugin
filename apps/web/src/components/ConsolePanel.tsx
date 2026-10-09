import { useEffect, useRef } from 'react'
import { useStore } from '../state/store'
import { Panel } from './common'
import { IconButton } from './common'

function timeOf(t: number): string {
  const d = new Date(t)
  return d.toLocaleTimeString('zh-CN', { hour12: false })
}

export function ConsolePanel() {
  const { state, toggleConsole } = useStore()
  const logs = state.task?.execution.logs ?? []
  const endRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    endRef.current?.scrollIntoView({ block: 'end' })
  }, [logs.length])

  return (
    <div className="consolewrap">
      <Panel
        title="运行日志与错误定位"
        icon="terminal"
        bodyClassName="panel__body--flush"
        right={
          <>
            <span className="badge badge--muted">{logs.length} 行</span>
            <IconButton name="close" size={15} title="收起控制台" onClick={() => toggleConsole(false)} />
          </>
        }
      >
        <div className="console__body">
          {logs.length === 0 && <div className="logline logline--info"><span className="logline__text">// 任务启动后，工具调用、沙箱执行、错误归一化与重试将在此实时输出</span></div>}
          {logs.map((l, i) => (
            <div key={i} className={`logline logline--${l.level}`}>
              <span className="logline__t">{timeOf(l.t)}</span>
              <span className="logline__tag">{l.level.toUpperCase()}</span>
              <span className="logline__text">
                {l.text}
                {l.location && <span className="logline__loc">at {l.location}</span>}
              </span>
            </div>
          ))}
          <div ref={endRef} />
        </div>
      </Panel>
    </div>
  )
}
