import { afterEach, describe, expect, it, vi } from 'vitest'
import { getAnonymousToken } from './realAgentClient'

afterEach(() => vi.unstubAllGlobals())

describe('anonymous Agent session', () => {
  it('reuses the same identity for concurrent and later project requests', async () => {
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ token: 'one-user-token' }) }))
    vi.stubGlobal('fetch', fetchSpy)
    const base = 'http://127.0.0.1:5199'
    expect(await Promise.all([getAnonymousToken(base), getAnonymousToken(base)])).toEqual(['one-user-token', 'one-user-token'])
    expect(await getAnonymousToken(base)).toBe('one-user-token')
    expect(fetchSpy).toHaveBeenCalledTimes(1)
  })

  it('retries after a failed anonymous request', async () => {
    const fetchSpy = vi.fn()
      .mockResolvedValueOnce({ ok: false, status: 503 })
      .mockResolvedValueOnce({ ok: true, json: async () => ({ token: 'recovered-token' }) })
    vi.stubGlobal('fetch', fetchSpy)
    const base = 'http://127.0.0.1:5200'
    await expect(getAnonymousToken(base)).rejects.toThrow('503')
    await expect(getAnonymousToken(base)).resolves.toBe('recovered-token')
    expect(fetchSpy).toHaveBeenCalledTimes(2)
  })
})
