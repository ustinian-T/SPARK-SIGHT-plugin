import { useEffect, useState } from 'react'
import { defaultModelSettings, type ModelSettings } from '../client/modelSettings'
import { loadSession, siteApi } from '../site/session'
import { Button } from './common'
import { ModelProviderFields } from './ModelProviderFields'

type Summary = { configured: boolean; provider?: ModelSettings['provider']; protocol?: ModelSettings['protocol']; baseUrl?: string; model?: string }
type Access = {
  source: 'none' | 'own' | 'shared'
  permissions: { allowOwn: boolean; allowShared: boolean }
  own: Summary
  shared: Summary
}

const account = () => {
  const session = loadSession()
  if (!session) throw new Error('请先登录账号')
  return session.token
}

export function WebModelSettingsPanel({ close }: { close: () => void }) {
  const [access, setAccess] = useState<Access | null>(null)
  const [settings, setSettings] = useState<ModelSettings>(defaultModelSettings)
  const [message, setMessage] = useState('')
  const [busy, setBusy] = useState(false)

  useEffect(() => {
    let active = true
    let token: string
    try { token = account() } catch (error) { setMessage(error instanceof Error ? error.message : '请先登录账号'); return }
    void siteApi<Access>(window.location.origin, '/api/me/model-config', { token }).then((value) => {
      if (!active) return
      setAccess(value)
      setSettings({ ...defaultModelSettings, ...value.own, apiKey: '' })
    }, (error) => { if (active) setMessage(error instanceof Error ? error.message : '读取模型授权失败') })
    return () => { active = false }
  }, [])

  const save = async () => {
    setBusy(true); setMessage('')
    try {
      if (new URL(settings.baseUrl).protocol !== 'https:') throw new Error('API 地址需使用 HTTPS')
      const result = await siteApi<Access>(window.location.origin, '/api/me/model-config', {
        method: 'PUT', token: account(), body: JSON.stringify(settings)
      })
      setAccess(result)
      setSettings({ ...settings, apiKey: '' })
      setMessage('个人 API 已在服务器保存，下次任务生效；密钥不会回传浏览器。')
    } catch (error) { setMessage(error instanceof Error ? error.message : '保存失败') }
    finally { setBusy(false) }
  }
  const clear = async () => {
    setBusy(true); setMessage('')
    try {
      setAccess(await siteApi<Access>(window.location.origin, '/api/me/model-config', { method: 'DELETE', token: account() }))
      setSettings({ ...settings, apiKey: '' })
      setMessage('个人 API Key 已清除')
    } catch (error) { setMessage(error instanceof Error ? error.message : '清除失败') }
    finally { setBusy(false) }
  }
  const choose = async (source: Access['source']) => {
    setBusy(true); setMessage('')
    try {
      setAccess(await siteApi<Access>(window.location.origin, '/api/me/model-source', {
        method: 'PUT', token: account(), body: JSON.stringify({ source })
      }))
      setMessage('模型来源已更新，下次任务生效。')
    } catch (error) { setMessage(error instanceof Error ? error.message : '切换失败') }
    finally { setBusy(false) }
  }

  return <div style={{ position: 'fixed', inset: 0, zIndex: 100, background: '#0008', display: 'grid', placeItems: 'center' }}>
    <section role="dialog" aria-modal="true" aria-label="模型 API 设置" className="platform-panel" style={{ background: 'var(--paper, #fff)', width: 'min(480px, 94vw)', padding: 24, borderRadius: 12, maxHeight: '88vh', overflowY: 'auto' }}>
      <h2>模型 API 设置</h2>
      <p>网页端由本站服务器调用模型 API。公开测试期间仅开放个人配置，统一配置不向普通用户开放；密钥不会保存在浏览器。</p>
      {access && <>
        <label className="form-label" htmlFor="model-source">任务使用的模型来源</label>
        <select id="model-source" className="form-control" value={access.source} disabled={busy} onChange={(event) => void choose(event.target.value as Access['source'])}>
          <option value="none">不使用模型 API（确定性绘图）</option>
          {access.permissions.allowShared && <option value="shared" disabled={!access.shared.configured}>管理员统一配置{access.shared.configured ? ` · ${access.shared.model}` : '（尚未配置）'}</option>}
          {access.permissions.allowOwn && <option value="own" disabled={!access.own.configured}>我的 API{access.own.configured ? ` · ${access.own.model}` : '（尚未配置）'}</option>}
        </select>
        {!access.permissions.allowOwn && !access.permissions.allowShared && <p>管理员尚未授权模型 API；仍可使用不依赖模型的绘图流程。</p>}
        {access.permissions.allowOwn && <>
          <h3>我的 API 配置</h3>
          <ModelProviderFields settings={settings} change={setSettings} disabled={busy} />
        </>}
      </>}
      <p role="status">{message}</p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
        {access?.permissions.allowOwn && <Button onClick={save} disabled={busy}>保存我的 API</Button>}
        {access?.permissions.allowOwn && <Button variant="ghost" onClick={clear} disabled={busy || !access.own.configured}>清除我的密钥</Button>}
        <Button variant="ghost" onClick={close}>关闭</Button>
      </div>
    </section>
  </div>
}
