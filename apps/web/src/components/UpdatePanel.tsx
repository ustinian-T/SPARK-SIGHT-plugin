import { useState } from 'react'
import { Icon } from './icons'

declare global { interface Window { __SPARK_UPDATES__?: { open: () => Promise<unknown> } } }
type Status = { currentVersion: string; version: string; available: boolean }
type Prepared = { id: string; version: string }
export function UpdatePanel() {
  const invoke = window.__TAURI__?.core?.invoke
  const extension = window.__SPARK_UPDATES__
  const [open, setOpen] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [status, setStatus] = useState<Status | null>(null)
  const [prepared, setPrepared] = useState<Prepared | null>(null)
  const [localPath, setLocalPath] = useState('')
  if (!invoke && !extension) return null
  const run = async (action: () => Promise<void>) => {
    setBusy(true); setError('')
    try { await action() } catch (e) { setError(e instanceof Error ? e.message : String(e)) } finally { setBusy(false) }
  }
  const check = () => run(async () => {
    if (!invoke) { await extension?.open(); return }
    setOpen(true); setPrepared(null)
    setStatus(await invoke('update_check') as Status)
  })
  return <>
    <button className="titlebar__btn" onClick={() => void check()} disabled={busy} title="检查客户端新版本"><Icon name="download" size={14} /> {busy ? '检查中…' : '检查更新'}</button>
    {open && <div role="dialog" aria-modal="true" aria-label="客户端更新" style={{ position: 'fixed', inset: 0, zIndex: 9999, background: '#10202b80', display: 'grid', placeItems: 'center' }}>
      <section style={{ background: 'var(--bg-panel, white)', color: 'var(--text-primary, #12324b)', borderRadius: 12, padding: 24, width: 'min(480px, 90vw)', display: 'grid', gap: 14 }}>
        <strong>客户端更新</strong>
        <p style={{ margin: 0 }}>{status ? `当前 ${status.currentVersion} · 最新 ${status.version}${status.available ? '（可升级）' : '（已是最新版本）'}` : '正在获取发布信息…'}</p>
        <p style={{ margin: 0, fontSize: 13 }}>通过官方 HTTPS 发布清单与 SHA-256 校验升级包。安装过程保留本地项目、数据和账户设置。</p>
        {status?.available && !prepared && <>
          <label style={{ display: 'grid', gap: 6 }}>已有升级包的完整路径（可选）<input value={localPath} onChange={(event) => setLocalPath(event.target.value)} placeholder="C:\Downloads\Deep-Imaging-Windows-x64-Setup.exe" /></label>
          <button className="titlebar__btn" disabled={busy} onClick={() => void run(async () => { setPrepared(await invoke!('update_prepare', { localPath: localPath.trim() || null }) as Prepared) })}>{busy ? '正在下载并校验…' : localPath.trim() ? '校验本地升级包' : '下载并校验升级包'}</button>
        </>}
        {prepared && <>
          <p style={{ margin: 0 }}>版本 {prepared.version} 校验成功。安装时将关闭客户端，请先保存当前工作。</p>
          <button className="titlebar__btn" disabled={busy} onClick={() => void run(async () => { await invoke!('update_apply', { id: prepared.id, confirmed: true }) })}>确认安装并关闭客户端</button>
        </>}
        {error && <p role="alert" style={{ margin: 0, color: '#b42318' }}>{error}</p>}
        <button className="titlebar__btn" disabled={busy} onClick={() => setOpen(false)}>关闭</button>
      </section>
    </div>}
  </>
}
