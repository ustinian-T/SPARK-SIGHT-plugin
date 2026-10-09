import { Icon } from './icons'
import { useStore } from '../state/store'
import { getHostBridge } from '../host/bridge'
import { APPROVAL_MODE_LABEL, type ApprovalMode, type EngineKind } from '../types'
import { loadSession, logoutSession } from '../site/session'
import { navigate } from '../site/router'
import { UpdatePanel } from './UpdatePanel'

export function engineLabel(engine: EngineKind): string {
  if (engine === 'python') return 'Python'
  if (engine === 'r') return 'R'
  return 'MATLAB'
}

function majorOf(version: string | null | undefined): string {
  if (!version) return ''
  const head = version.match(/\d+\.\d+/)?.[0] ?? ''
  return head ? ` ${head}` : ''
}

export function TitleBar() {
  const { state, setEngine, exportArtifact, setApprovalMode } = useStore()
  // 网页端把 Python 与 R 作为一等语言始终展示；探测到不可用时在选项后标注“未安装”，
  // 由代码视图给出安装引导，而不是把 R 隐藏、让用户误以为不支持。
  const runtimeByEngine: Record<string, { available?: boolean; version?: string | null }> =
    Object.fromEntries(state.gate.runtimes.map((r) => [r.engine, r]))
  const isHost = !!getHostBridge()
  const selectableEngines: EngineKind[] = isHost ? ['python', 'r', 'matlab'] : ['python', 'r']
  const showUnavailable = state.gate.status === 'unavailable'
  const showChecking = state.gate.status === 'checking'

  return (
    <header className="titlebar">
      <a className="titlebar__brand" href="/" title="灵感视界 SPARK SIGHT · 科研绘图智能体">
        <img
          className="titlebar__brand-logo"
          src="/brand/logo.png"
          srcSet="/brand/logo.png 1x, /brand/logo@2x.png 2x"
          alt="灵感视界 SPARK SIGHT"
          height={36}
        />
      </a>

      <div className="titlebar__actions">
        <UpdatePanel />
        {!isHost && (
          <a className="titlebar__btn titlebar__download" href="/downloads/Deep-Imaging-Windows-x64-Setup.exe" download title="下载 Windows 客户端安装包">
            <Icon name="download" size={14} /> <span>下载 Windows 版</span>
          </a>
        )}
        {showChecking && (
          <span className="titlebar__badge titlebar__badge--muted" title="正在探测后端能力…">
            <Icon name="status" size={12} /> 正在连接后端…
          </span>
        )}
        {showUnavailable && (
          <span className="titlebar__badge titlebar__badge--danger" title={state.gate.detail ?? '后端不可用'}>
            <Icon name="status" size={12} /> {isHost ? '本机 Agent 不可用' : '服务器不可用'}
          </span>
        )}
        {state.runLocation === 'local' && state.gate.status === 'available' && (
          <span className="titlebar__badge" title="已连接本机绘图 Agent">
            <Icon name="status" size={12} /> {isHost ? '本机 Agent' : '服务器 Agent'}
          </span>
        )}
        <select
          className="titlebar__select"
          value={state.activeEngine}
          onChange={(e) => setEngine(e.target.value as EngineKind)}
          title="新建任务的绘图语言；网页端由服务器执行，桌面端与插件由本机 Agent 执行。R 需要 Rscript 和 ggplot2。"
        >
          {selectableEngines.map((eng) => {
            const rt = runtimeByEngine[eng]
            const unavailable = rt?.available === false
            return (
              <option key={eng} value={eng}>
                {engineLabel(eng)}{majorOf(rt?.version)}{unavailable ? '（未安装）' : ''}
              </option>
            )
          })}
        </select>
        <select
          className="titlebar__select"
          value={state.approvalMode}
          onChange={(e) => void setApprovalMode(e.target.value as ApprovalMode)}
          title="审批模式：用户审批 / 自动审批 / 完全同意"
        >
          {(Object.keys(APPROVAL_MODE_LABEL) as ApprovalMode[]).map((m) => (
            <option key={m} value={m}>{APPROVAL_MODE_LABEL[m]}</option>
          ))}
        </select>
        <button className="titlebar__btn titlebar__export" onClick={() => exportArtifact('reproduce')} title="导出复现包（代码、数据、证据、产物）">
          <Icon name="download" size={14} /> <span>导出</span>
        </button>
        <SessionChip />
      </div>
    </header>
  )
}

// 会话用户区：显示当前登录用户；管理员可直达管理控制台；支持退出登录。
function SessionChip() {
  const session = loadSession()
  if (!session) return null
  const user = session.user
  return (
    <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      {!getHostBridge() && user.role === 'admin' && (
        <button
          className="titlebar__btn"
          onClick={() => navigate('/admin')}
          title="打开管理控制台（用户管理与邀请码管理）"
        >
          <Icon name="status" size={13} /> 管理控制台
        </button>
      )}
      <span className="session-chip" title={`账户名：${user.username}`}>
        <span style={{ width: 22, height: 22, borderRadius: '50%', background: 'linear-gradient(135deg,#2fce93,#0e7a52)', color: '#04150c', display: 'inline-grid', placeItems: 'center', fontWeight: 700, fontSize: 11 }}>
          {(user.displayName || user.username).slice(0, 1)}
        </span>
        <span style={{ maxWidth: 90, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{user.displayName || user.username}</span>
      </span>
      <button
        className="titlebar__btn"
        onClick={() => { void logoutSession().catch(() => {}).finally(() => navigate('/login', { replace: true })) }}
        title="退出登录（清除本地会话）"
      >
        退出
      </button>
    </div>
  )
}
