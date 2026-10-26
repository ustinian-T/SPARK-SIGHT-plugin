import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { restoreHostSession, siteApi } from './session'

const mocks = vi.hoisted(() => ({ getHostBridge: vi.fn() }))
vi.mock('../host/bridge', () => ({ getHostBridge: mocks.getHostBridge }))
const user = { userId: 'account-1', username: 'researcher', displayName: 'Researcher', role: 'user' }
const stale = { token: 'stale-token', baseUrl: 'http://127.0.0.1:5100', user, loginAt: 1 }

beforeEach(() => {
  mocks.getHostBridge.mockReset()
  mocks.getHostBridge.mockReturnValue(null)
  vi.stubGlobal('window', { location: { origin: 'https://www.example.com' }, dispatchEvent: vi.fn() })
  vi.stubGlobal('localStorage', { getItem: vi.fn(() => JSON.stringify(stale)), setItem: vi.fn(), removeItem: vi.fn() })
})
afterEach(() => vi.unstubAllGlobals())

describe('host session restoration', () => {
  it('uses the current host port and boot token to restore the retained account session', async () => {
    mocks.getHostBridge.mockReturnValue({ getAgentConfig: vi.fn().mockResolvedValue({ baseUrl: 'http://127.0.0.1:6200', token: 'current-boot-token' }) })
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ session: { token: 'restored-account-token', user } }) })
    vi.stubGlobal('fetch', fetch)
    const result = await restoreHostSession()
    expect(result).toMatchObject({ token: 'restored-account-token', baseUrl: 'http://127.0.0.1:6200', user })
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:6200/api/auth/local-session', expect.objectContaining({ headers: expect.objectContaining({ authorization: 'Bearer current-boot-token' }) }))
    expect(localStorage.getItem).not.toHaveBeenCalled()
  })

  it('returns no session when host storage is empty even when an old browser session exists', async () => {
    mocks.getHostBridge.mockReturnValue({ getAgentConfig: vi.fn().mockResolvedValue({ baseUrl: 'http://127.0.0.1:6201', token: 'boot-token' }) })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, json: async () => ({ session: null }) }))
    await expect(restoreHostSession()).resolves.toBeNull()
    expect(localStorage.getItem).not.toHaveBeenCalled()
  })

  it('does not recover a stale session when the current Agent rejects restoration', async () => {
    mocks.getHostBridge.mockReturnValue({ getAgentConfig: vi.fn().mockResolvedValue({ baseUrl: 'http://127.0.0.1:6202', token: 'boot-token' }) })
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 401, json: async () => ({ error: { message: '会话失效' } }) }))
    await expect(restoreHostSession()).rejects.toThrow('会话失效')
    expect(localStorage.getItem).not.toHaveBeenCalled()
  })

  it('does not contact an old port or use a stale bearer when host configuration fails', async () => {
    mocks.getHostBridge.mockReturnValue({ getAgentConfig: vi.fn().mockRejectedValue(new Error('Agent unavailable')) })
    const fetch = vi.fn()
    vi.stubGlobal('fetch', fetch)
    await expect(restoreHostSession()).rejects.toThrow('Agent unavailable')
    expect(fetch).not.toHaveBeenCalled()
    expect(localStorage.getItem).not.toHaveBeenCalled()
  })

  it('keeps ordinary webpage restoration on its browser session', async () => {
    await expect(restoreHostSession()).resolves.toEqual(stale)
  })
})

describe('native admin login transport', () => {
  it('sends admin role validation to the local cloud-account proxy rather than the web origin', async () => {
    mocks.getHostBridge.mockReturnValue({})
    const fetch = vi.fn().mockResolvedValue({ ok: true, json: async () => ({ user: { ...user, role: 'admin' }, token: 'account-token' }) })
    vi.stubGlobal('fetch', fetch)
    const body = JSON.stringify({ username: 'administrator', password: 'test-password', expectedRole: 'admin' })
    await siteApi('http://127.0.0.1:6203', '/api/auth/login', { method: 'POST', body })
    expect(fetch).toHaveBeenCalledWith('http://127.0.0.1:6203/api/auth/login', expect.objectContaining({ method: 'POST', body, headers: expect.objectContaining({ 'x-agent-protocol': '1', 'content-type': 'application/json' }) }))
    expect(fetch.mock.calls[0][0]).not.toContain('token=')
  })
})
