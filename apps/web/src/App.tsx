import { useEffect, useRef, useState } from 'react'
import { ModelSettingsPanel } from './components/ModelSettingsPanel'
import { useStore, type MainView } from './state/store'
import { TitleBar } from './components/TitleBar'
import { ActivityBar } from './components/ActivityBar'
import { Sidebar } from './components/Sidebar'
import { ChatPanel } from './components/ChatPanel'
import { CompareView } from './components/CompareView'
import { CodeViewer } from './components/CodeViewer'
import { GalleryView } from './components/GalleryView'
import { Inspector } from './components/Inspector'
import { EvidencePanel } from './components/EvidencePanel'
import { PreferencesPanel } from './components/PreferencesPanel'
import { ConsolePanel } from './components/ConsolePanel'
import { StatusBar } from './components/StatusBar'
import { PatchModal } from './components/PatchModal'
import { GrantDialog } from './components/GrantDialog'
import { ApprovalBar } from './components/ApprovalBar'
import { PlatformPanel } from './components/PlatformPanel'
import { GateBlock } from './components/GateBlock'
import { Button } from './components/common'
import { SAMPLE_CSV, SAMPLE_FILE } from './mock/sample'
import { uid } from './lib/format'
import { setupTauriEvents } from './host/bridge'
import { readTauriPathBytes, readTauriStartupFiles } from './host/tauriEvents'

// 仅在 URL 带 ?demo 时自动载入内置“合成示例”，用于无头截图与功能走查；正常打开不受影响。
const DEMO_PROMPT = '比较对照组与两种施氮处理随观测周次的响应，突出组间差异与趋势，需要误差棒，用于论文结果部分。'

// 居中标题截断：项目名-任务名 合计最多 8 个字，超出以 … 省略，避免长文件名撑破横栏。
function truncateHeader(value: string, max = 8): string {
  const v = String(value ?? '')
  const chars = Array.from(v)
  return chars.length > max ? `${chars.slice(0, max).join('')}...` : v
}

const VIEW_TITLE: Record<MainView, string> = {
  chat: '对话',
  compare: '方案对比',
  code: '代码',
  platform: '项目',
  gallery: '图库',
  inspector: '检测器',
  evidence: '证据',
  preferences: '偏好'
}

export function App() {
  const embedded = !!window.__SPARK_VSCODE__
  const [nativeError, setNativeError] = useState('')
  const nativeAction = async (action: (() => Promise<unknown>) | undefined) => {
    setNativeError('')
    try { await action?.() } catch (error) { setNativeError(error instanceof Error ? error.message : String(error)) }
  }
  const [settingsOpen, setSettingsOpen] = useState(false)
  const { state, setView, setActivePlan, toggleConsole, choosePlan, start, proposePatch } = useStore()
  const task = state.task
  // 居中标题：项目名-任务名（任务名取文件名去扩展名；无任务时回退为当前视图名），合计截断 8 字。
  const projectName = state.projects.find((p) => p.projectId === state.currentProjectId)?.name ?? ''
  const taskName = task?.title ? task.title.replace(/\.[^.]+$/, '') : VIEW_TITLE[state.mainView]
  const headerLabel = truncateHeader(projectName ? `${projectName}-${taskName}` : taskName)
  // 后端不可用时明确阻断新任务，不能用演示客户端伪装为真实执行。
  const blocked = state.gate.status === 'unavailable' && !task
  const demoRef = useRef(false)
  const [leftOpen, setLeftOpen] = useState(() => window.innerWidth > 980 && localStorage.getItem('layout.leftOpen') !== '0')
  const setPane = (open: boolean) => {
    localStorage.setItem('layout.leftOpen', open ? '1' : '0')
    setLeftOpen(open)
  }

  // ?demo 仅开发态走查使用；生产页面不会在未操作时自动提交示例数据。
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const q = new URLSearchParams(window.location.search)
    if (!q.has('demo') || demoRef.current) return
    demoRef.current = true
    const bytes = new TextEncoder().encode(SAMPLE_CSV)
    void start({ fileName: SAMPLE_FILE, bytes, prompt: q.get('prompt') ?? DEMO_PROMPT })
  }, [start])

  // VS Code 命令通过宿主消息传入真实文件内容；UI 就绪后再请求，避免消息早于监听。
  const startRef = useRef(start)
  startRef.current = start
  const webviewReadyRef = useRef(false)
  useEffect(() => {
    const onOpenData = (event: Event) => {
      const payload = (event as CustomEvent<{ fileName?: string; bytesBase64?: string }>).detail
      if (!payload?.fileName || !payload.bytesBase64) return
      try {
        const binary = atob(payload.bytesBase64)
        const bytes = Uint8Array.from(binary, (char) => char.charCodeAt(0))
        void startRef.current({ fileName: payload.fileName, bytes, prompt: `请分析 ${payload.fileName} 并生成可复现的科研图表。` })
      } catch (error) {
        window.alert(`读取 VS Code 文件失败：${error instanceof Error ? error.message : String(error)}`)
      }
    }
    window.addEventListener('deep-imaging:open-data', onOpenData)
    return () => window.removeEventListener('deep-imaging:open-data', onOpenData)
  }, [])
  useEffect(() => {
    if (state.gate.status === 'checking' || webviewReadyRef.current || !window.__DEEP_IMAGING_HOST__) return
    webviewReadyRef.current = true
    window.dispatchEvent(new Event('deep-imaging:webview-ready'))
  }, [state.gate.status])

  // P1-3：注册桌面端 Tauri 文件事件监听（open-files / drag-drop / open-diff）。
  // 用 ref 持有最新回调，保证 effect 只注册一次，却总能拿到最新的 start/setView。
  const pendingTauriPaths = useRef<string[]>([])
  const tauriHandlersRef = useRef<{ onFiles: (paths: string[]) => void; onDiff: (payload: unknown) => void } | null>(null)
  tauriHandlersRef.current = {
    onFiles: (paths) => {
      if (state.gate.status !== 'available') {
        pendingTauriPaths.current = paths
        return
      }
      const first = paths[0]
      if (paths.length > 1) window.alert(`一次仅自动打开一个文件。本次将打开 ${first.split(/[\\/]/).pop()}；其余 ${paths.length - 1} 个文件未导入，请使用页面的批量上传入口。`)
      const fileName = first.split(/[\\/]/).pop() ?? first
      void (async () => {
        const bytes = await readTauriPathBytes(first)
        await start({ fileName, bytes, prompt: `（打开文件 ${fileName}，请分析数据并生成科研图表）` })
      })().catch((error) => window.alert(`打开 ${fileName} 失败：${error instanceof Error ? error.message : String(error)}`))
    },
    onDiff: (payload) => {
      const p = (payload ?? {}) as Record<string, unknown>
      // payload 含 uri / proposedText 时，切到代码与 Diff 视图，便于查看；
      // 具体 Diff 面板渲染与宿主协议对齐（待验证）。
      if (typeof p.uri === 'string' || typeof p.proposedText === 'string') {
        setView('code')
        console.info('[tauri-events] 收到 open-diff 请求', payload)
      }
    }
  }
  useEffect(() => {
    if (state.gate.status !== 'available' || pendingTauriPaths.current.length === 0) return
    const paths = pendingTauriPaths.current
    pendingTauriPaths.current = []
    tauriHandlersRef.current?.onFiles(paths)
  }, [state.gate.status])
  useEffect(() => {
    let unlisten: (() => void) | undefined
    let cancelled = false
    void setupTauriEvents({
      onFiles: (paths) => tauriHandlersRef.current?.onFiles(paths),
      onDiff: (payload) => tauriHandlersRef.current?.onDiff(payload)
    }).then(async (fn) => {
      if (!cancelled) unlisten = fn
      else { fn(); return }
      const startupFiles = await readTauriStartupFiles()
      if (!cancelled && startupFiles.length) tauriHandlersRef.current?.onFiles(startupFiles)
    })
    return () => {
      cancelled = true
      unlisten?.()
    }
  }, [])

  // ?demo：三方案就绪后按 URL 参数定位视图、选中方案、右侧栏与控制台。
  const planCount = state.task?.plans.length ?? 0
  const taskState = state.task?.state
  const positionedDemoTask = useRef('')
  useEffect(() => {
    if (!import.meta.env.DEV) return
    const q = new URLSearchParams(window.location.search)
    if (!q.has('demo') || planCount !== 3 || taskState !== 'PRESENT') return
    if (!state.task || positionedDemoTask.current === state.task.taskId) return
    positionedDemoTask.current = state.task.taskId
    const plans = state.task?.plans ?? []
    const view = q.get('view') ?? 'compare'
    const selId = q.get('select') ?? (view === 'code' ? 'plan_convention' : 'plan_clarity')
    const plan = plans.find((p) => p.plan_id === selId) ?? plans[0]
    if (view === 'code') {
      setActivePlan(plan.plan_id)
      setView('code')
    } else {
      choosePlan(plan) // 内部会进入三方案比较视图并选中该方案
      if (view === 'chat') setView('chat')
    }
    const right = q.get('right')
    if (right === 'inspector' || right === 'evidence' || right === 'preferences') setView(right)
    if (q.has('console')) toggleConsole(true)
    // 可选：自动发起一次受控编辑补丁，用于走查补丁弹窗（title=最小 Diff；color=代码主导模式）。
    const patchKind = q.get('patch')
    if (patchKind === 'title') {
      proposePatch(plan.plan_id, {
        patch_id: uid('patch'), targetKind: 'figure', targetId: plan.spec.figure.figure_id,
        path: 'figure.title', label: '图标题', before: plan.spec.figure.title,
        after: '施氮处理对作物响应的影响（修订标题）'
      })
    } else if (patchKind === 'color') {
      const pnl = plan.spec.panels[0]
      const lyr = pnl.layers[0]
      proposePatch(plan.plan_id, {
        patch_id: uid('patch'), targetKind: 'layer', targetId: lyr.layer_id,
        path: `panels.${pnl.panel_id}.layers.${lyr.layer_id}.color`, label: `颜色 ${lyr.label}`,
        before: lyr.color, after: '#C0392B'
      })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [planCount, taskState])

  return (
    <>
      {settingsOpen && <ModelSettingsPanel close={() => setSettingsOpen(false)} />}
      <div className="app-bg" />
      <div className={`app ${embedded ? 'app--vscode' : ''} ${leftOpen ? '' : 'app--sidebar-collapsed'}`}>
        {!embedded && <TitleBar />}
        {!embedded && <ActivityBar onOpenSettings={() => setSettingsOpen(true)} />}
        {embedded && <header className="spark-toolbar">
          <select aria-label="切换工作区" value={state.mainView} onChange={event => setView(event.target.value as MainView)}>
            {Object.entries(VIEW_TITLE).map(([value,label]) => <option key={value} value={value}>{label}</option>)}
          </select>
          <button onClick={() => setPane(!leftOpen)} title="项目与数据">项目</button>
          <button onClick={() => void nativeAction(window.__SPARK_VSCODE__?.useSelection)} title="使用 VS Code 选中的代码">选中代码</button>
          <button onClick={() => void nativeAction(window.__SPARK_VSCODE__?.runCurrent)} title="在 VS Code 中运行当前脚本">运行</button>
          <button onClick={() => setSettingsOpen(true)} title="模型设置">设置</button>
        </header>}
        <Sidebar />
        {leftOpen && <button className="layout-backdrop" aria-label="关闭侧栏" onClick={() => setPane(false)} />}

        <main className="workarea">
          <div className="workbar bar">
            <div className="workbar__left">
              <Button size="sm" variant="ghost" icon="chevronR" className={!leftOpen ? 'workbar__icon-button' : undefined} onClick={() => setPane(!leftOpen)} title={leftOpen ? '收起项目与数据栏' : '展开项目与数据栏'} aria-label={leftOpen ? '收起项目与数据栏' : '展开项目与数据栏'}>
                {leftOpen ? '收起左栏' : null}
              </Button>
            </div>
            <span className="workbar__title workbar__title--center" title={projectName ? `${projectName}-${taskName}` : taskName}>
              {headerLabel}
            </span>
          </div>

          {nativeError && <div className="notebox notebox--warn" role="alert">{nativeError}</div>}
          <div className="view-body">
            {blocked ? (
              <GateBlock />
            ) : (
              <>
                {state.mainView === 'chat' && <ChatPanel />}
                {state.mainView === 'compare' && <CompareView />}
                {state.mainView === 'code' && <CodeViewer />}
                {state.mainView === 'platform' && <PlatformPanel />}
                {state.mainView === 'gallery' && <GalleryView />}
                {state.mainView === 'inspector' && <Inspector />}
                {state.mainView === 'evidence' && <section className="utility-view panel" aria-label="证据"><EvidencePanel /></section>}
                {state.mainView === 'preferences' && <section className="utility-view panel" aria-label="偏好"><PreferencesPanel /></section>}
              </>
            )}
          </div>
        </main>

        {state.consoleOpen && <ConsolePanel />}
        <StatusBar />
        <PatchModal />
        <GrantDialog />
        <ApprovalBar />
      </div>
    </>
  )
}
