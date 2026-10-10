import { useEffect, useState } from 'react'
import { defaultModelSettings, loadModelSettings, saveModelSettings, isWebMode, clearModelKey } from '../client/modelSettings'
import { Button, Tooltip } from './common'
import { Icon } from './icons'
import { WebModelSettingsPanel } from './WebModelSettingsPanel'
import { ModelProviderFields } from './ModelProviderFields'

export function ModelSettingsPanel({ close }: { close: () => void }) {
  return isWebMode() ? <WebModelSettingsPanel close={close} /> : <LocalModelSettingsPanel close={close} />
}

function LocalModelSettingsPanel({ close }: { close: () => void }) {
  const [settings, setSettings] = useState(defaultModelSettings)
  const [status, setStatus] = useState('')
  const [saving, setSaving] = useState(false)
  // 网页端无宿主桥：saveModelSettings 为 no-op，必须诚实禁用，不得提示“已保存”。
  const webMode = isWebMode()
  useEffect(() => {
    void loadModelSettings()
      .then((s) => { setSettings(s); setStatus(webMode ? '当前为网页端：模型配置由服务端统一管理。' : '') })
      .catch((e) => setStatus(`读取设置失败：${e instanceof Error ? e.message : String(e)}`))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const onSave = async () => {
    setSaving(true)
    setStatus('')
    try {
      // 桌面端才真正持久化；网页端按钮已禁用，不会走到这里。
      const url = new URL(settings.baseUrl)
      if (url.protocol !== 'https:') throw new Error('API 地址需使用 HTTPS')
      await saveModelSettings(settings)
      // 回读校验：只有确实写回后端后才提示成功，杜绝 no-op 假提示。
      const saved = await loadModelSettings()
      if (saved.baseUrl !== settings.baseUrl || saved.model !== settings.model) {
        throw new Error('保存后回读不一致，设置可能未生效')
      }
      setSettings({ ...saved, apiKey: '' }); setStatus('已加密保存，下次任务生效；密钥不回传界面')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '保存失败')
    } finally {
      setSaving(false)
    }
  }

  const onClear = async () => {
    setSaving(true)
    setStatus('')
    try {
      await clearModelKey()
      const saved = await loadModelSettings()
      setSettings({ ...saved, apiKey: '' })
      setStatus('已清除 API Key')
    } catch (error) {
      setStatus(error instanceof Error ? error.message : '清除失败')
    } finally {
      setSaving(false)
    }
  }

  return <div style={{ position: 'fixed', inset: 0, zIndex: 100, background: '#0008', display: 'grid', placeItems: 'center' }}>
    <section role="dialog" aria-modal="true" aria-label="模型 API 设置" className="platform-panel" style={{ background: 'var(--paper, #fff)', width: 'min(460px, 94vw)', padding: 24, borderRadius: 12, maxHeight: '88dvh', overflowY: 'auto' }}>
      <h2 style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        模型 API 设置
        <Tooltip
          content={webMode
            ? '网页端模型配置由服务端管理，不持久化 API Key；桌面端可通过本机加密存储保存。'
            : '设置、数据与聊天记录保存在本机，模型请求由本地 Agent 直接发出。'}
          placement="right"
        >
          <span style={{ display: 'inline-flex', cursor: 'help', color: 'var(--ink-400)' }}>
            <Icon name="info" size={13} />
          </span>
        </Tooltip>
      </h2>
      <ModelProviderFields settings={settings} change={setSettings} disabled={saving} />
      <p role="status">{status}</p>
      <div style={{ display: 'flex', gap: 8 }}>
        <Button onClick={onSave} disabled={webMode || saving}>{saving ? '保存中…' : '保存'}</Button>
        <Button variant="ghost" onClick={onClear} disabled={webMode || saving}>清除密钥</Button>
        <Button variant="ghost" onClick={close}>关闭</Button>
      </div>
    </section>
  </div>
}
