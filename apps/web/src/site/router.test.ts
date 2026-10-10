import { describe, expect, it, vi } from 'vitest'
import { navigate } from './router'
describe('webview hash navigation', () => {
  it('keeps login redirects on the webview document instead of the resource base', () => {
    const replace = vi.fn()
    vi.stubGlobal('window', {location:{href:'vscode-webview://host/index.html#/app',replace}})
    navigate('/login',{replace:true})
    expect(replace).toHaveBeenCalledWith('vscode-webview://host/index.html#/login')
    vi.unstubAllGlobals()
  })
})
