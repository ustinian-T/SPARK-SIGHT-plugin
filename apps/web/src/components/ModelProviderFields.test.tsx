import { describe, it, expect } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { ModelProviderFields } from './ModelProviderFields'
import { defaultModelSettings } from '../client/modelSettings'

describe('custom model provider configuration', () => {
  it('exposes provider identity, three protocols, masked key and manual model selection', () => {
    const html = renderToStaticMarkup(<ModelProviderFields settings={{ ...defaultModelSettings, models: ['research-model'], model: 'outside-catalog', configured: true }} change={() => {}} />)
    for (const field of ['Provider ID', '显示名称', 'API 地址', 'API 协议', 'API 密钥', '获取可用模型', '添加模型', '当前模型 ID']) expect(html).toContain(field)
    expect(html).toContain('type="password"')
    expect(html).toContain('anthropic_messages')
    expect(html).toContain('chat_completions')
    expect(html).toContain('responses')
    expect(html).toContain('outside-catalog')
    expect(html).toContain('留空保留原密钥')
  })
  it('escapes untrusted model names and explains third party disclosure', () => {
    const html = renderToStaticMarkup(<ModelProviderFields settings={{ ...defaultModelSettings, models: ['<img src=x onerror=alert(1)>'] }} change={() => {}} />)
    expect(html).not.toContain('<img')
    expect(html).toContain('&lt;img')
    expect(html).toContain('数据列名')
  })
})
