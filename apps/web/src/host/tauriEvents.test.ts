import { afterEach, expect, it, vi } from 'vitest'
import { readTauriPathBytes, readTauriStartupFiles } from './tauriEvents'

afterEach(() => vi.unstubAllGlobals())

it('decodes real desktop file bytes from the native base64 response', async () => {
  const invoke = vi.fn(async (command: string) => command === 'desktop_read_file' ? 'eCx5CjEsMgo=' : ['C:\\data\\plot.csv', 'C:\\data\\notes.txt'])
  vi.stubGlobal('window', { __TAURI__: { core: { invoke } } })
  expect(new TextDecoder().decode(await readTauriPathBytes('C:\\data\\plot.csv'))).toBe('x,y\n1,2\n')
  expect(await readTauriStartupFiles()).toEqual(['C:\\data\\plot.csv'])
})

it('rejects malformed native file responses rather than silently importing data', async () => {
  vi.stubGlobal('window', { __TAURI__: { core: { invoke: async () => ({ fake: true }) } } })
  await expect(readTauriPathBytes('C:\\data\\plot.csv')).rejects.toThrow('无效')
})
