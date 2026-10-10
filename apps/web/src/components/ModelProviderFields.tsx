import { useState } from 'react'
import { getModelCatalog, type ModelSettings } from '../client/modelSettings'

export function ModelProviderFields({ settings, change, disabled = false }: { settings: ModelSettings; change: (value: ModelSettings) => void; disabled?: boolean }) {
  const [modelId, setModelId] = useState('')
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState('')
  const add = () => {
    const id = modelId.trim()
    if (!id || id.length > 200) return
    change({ ...settings, models: [...new Set([...(settings.models ?? []), id])], model: settings.model || id })
    setModelId('')
  }
  return <fieldset disabled={disabled || loading} style={{ border: 0, padding: 0, minWidth: 0 }}>
    <p>自定义模型 API：连接您选择的兼容 OpenAI / Anthropic 服务。模型服务商会接收任务需求与数据列名，请使用您信任的服务。</p>
    <label className="form-label" htmlFor="provider-id">Provider ID</label>
    <input id="provider-id" className="form-control" value={settings.providerId ?? 'custom-api'} pattern="[a-z][a-z0-9_-]*" maxLength={64} onChange={e => change({ ...settings, providerId: e.target.value })} />
    <small>以小写字母开头，仅使用小写字母、数字、下划线和连字符。</small>
    <label className="form-label" htmlFor="provider-name">显示名称</label>
    <input id="provider-name" className="form-control" maxLength={80} value={settings.displayName ?? 'Custom API'} onChange={e => change({ ...settings, displayName: e.target.value })} />
    <label className="form-label" htmlFor="provider-url">API 地址</label>
    <input id="provider-url" className="form-control" type="url" placeholder="https://gateway.example/v1" value={settings.baseUrl} onChange={e => change({ ...settings, baseUrl: e.target.value })} />
    <label className="form-label" htmlFor="provider-protocol">API 协议</label>
    <select id="provider-protocol" className="form-control" value={settings.protocol} onChange={e => { const protocol = e.target.value as ModelSettings['protocol']; change({ ...settings, protocol, provider: protocol === 'anthropic_messages' ? 'anthropic' : 'openai' }) }}>
      <option value="chat_completions">OpenAI Chat Completions</option><option value="responses">OpenAI Responses</option><option value="anthropic_messages">Anthropic Messages</option>
    </select>
    <label className="form-label" htmlFor="provider-key">API 密钥</label>
    <input id="provider-key" className="form-control" type="password" autoComplete="off" value={settings.apiKey} placeholder={settings.configured ? '已保存；留空保留原密钥' : '输入 API 密钥'} onChange={e => change({ ...settings, apiKey: e.target.value })} />
    <h3>模型目录</h3>
    <button type="button" className="sd-btn sd-btn--ghost sd-btn--sm" onClick={async () => {
      setLoading(true); setNotice('')
      try { const models = await getModelCatalog(settings); change({ ...settings, models }); setNotice(models.length ? '已获取模型目录' : '目录为空，可手动添加模型 ID') }
      catch (error) { setNotice(error instanceof Error ? error.message : '请手动添加模型 ID') }
      finally { setLoading(false) }
    }}>{loading ? '正在获取…' : '获取可用模型'}</button>
    <ul>{(settings.models ?? []).map(id => <li key={id}><span>{id}</span> <button type="button" aria-label={`移除模型 ${id}`} onClick={() => change({ ...settings, models: settings.models?.filter(item => item !== id) })}>移除</button></li>)}</ul>
    <div style={{ display: 'flex', gap: 8 }}><input className="form-control" aria-label="添加模型 ID" value={modelId} maxLength={200} onChange={e => setModelId(e.target.value)} /><button type="button" onClick={add}>添加模型</button></div>
    <label className="form-label" htmlFor="provider-model">当前模型 ID</label>
    <input id="provider-model" className="form-control" list="provider-models" value={settings.model} maxLength={200} placeholder="可直接填写目录之外的模型 ID" onChange={e => change({ ...settings, model: e.target.value })} />
    <datalist id="provider-models">{(settings.models ?? []).map(id => <option key={id} value={id} />)}</datalist>
    <p role="status">{notice}</p>
  </fieldset>
}
