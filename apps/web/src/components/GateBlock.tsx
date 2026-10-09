import { useState } from 'react'
import { Icon } from './icons'
import { useStore, describeGateReason } from '../state/store'
import { getHostBridge } from '../host/bridge'
import { engineLabel } from './TitleBar'

function RuntimeDots() {
  const { state } = useStore()
  const runtimes = state.gate.runtimes
  if (!runtimes.length) return null
  return (
    <div className="gate__runtimes">
      {runtimes.map((r) => (
        <span key={r.engine} className={`gate__runtime ${r.available ? 'is-ok' : 'is-bad'}`}>
          <span className="gate__runtime-dot" />
          {engineLabel(r.engine)}
          {r.version ? ` ${r.version.split('.').slice(0, 2).join('.')}` : r.available ? '' : '（不可用）'}
        </span>
      ))}
    </div>
  )
}

function FixHints() {
  const host = !!getHostBridge()
  if (host) {
    return (
      <ul className="gate__hints">
        <li>点击「重新检测」再次连接本机绘图 Agent。</li>
        <li>若仍失败，请重启客户端；本机 Python / R 环境缺失时可在「设置」中查看。</li>
      </ul>
    )
  }
  return (
    <ul className="gate__hints">
      <li>网页端直接使用本站服务器的绘图服务，无需在您的电脑启动 Agent。</li>
      <li>请稍后重试；若持续失败，请联系站点管理员检查服务器健康状态与反向代理。</li>
      <li>需要在本机离线运行时，可使用桌面客户端或 VS Code 插件。</li>
    </ul>
  )
}

export function GateBlock() {
  const { state, refreshGate } = useStore()
  const [busy, setBusy] = useState(false)
  const gate = state.gate
  const host = !!getHostBridge()
  const retry = async () => {
    setBusy(true)
    try { await refreshGate() } finally { setBusy(false) }
  }

  return (
    <div className="gate" role="alert">
      <div className="gate__card">
        <img className="gate__logo" src="/icons/logo-light-256.png" alt="灵感视界" width={64} height={64} />
        <h1 className="gate__title">{host ? '无法连接本机绘图 Agent' : '服务器绘图服务暂不可用'}</h1>
        <p className="gate__desc">{describeGateReason(gate.reason)}</p>

        <RuntimeDots />

        {gate.detail && <p className="gate__detail">诊断信息：{gate.detail}</p>}

        <FixHints />

        <details className="gate__diag">
          <summary>查看技术诊断</summary>
          <ul>
            <li>目标地址：{gate.baseUrl || '（未配置）'}</li>
            <li>部署模式：{gate.mode || '未知'}</li>
            <li>协议版本：{gate.protocol ?? '未知'}</li>
            <li>检查时间：{new Date(gate.checkedAt).toLocaleString()}</li>
          </ul>
        </details>

        <div className="gate__actions">
          <button className="btn btn--primary" onClick={retry} disabled={busy}>
            <Icon name="status" size={14} /> {busy ? '检测中…' : '重新检测'}
          </button>
        </div>
      </div>
    </div>
  )
}
