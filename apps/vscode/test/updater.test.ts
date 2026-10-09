import { describe, expect, it, vi } from 'vitest'
import { selectRelease, verifyArtifact, trustedDownload, ARTIFACT_NAME, UPDATE_ORIGIN } from '../src/updater'
import { createHash } from 'node:crypto'
import { EventEmitter } from 'node:events'
import { request } from 'node:https'
vi.mock('node:https', () => ({ request: vi.fn() }))

const bytes = Buffer.from('verified package')
const file = { name: 'Deep-Imaging-VSCode-Windows-x64.vsix', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
describe('trusted release selection and integrity', () => {
  it('compares numeric versions and selects only the expected filename', () => {
    expect(selectRelease({ version: '0.1.10', files: [file] }, '0.1.9')?.version).toBe('0.1.10')
    expect(selectRelease({ version: '0.1.9', files: [file] }, '0.1.10')).toBeNull()
    expect(() => selectRelease({ version: '2.0.0', files: [{ ...file, name: '../evil.vsix' }] }, '0.1.2')).toThrow()
  })
  it('rejects malformed manifests and corrupt or truncated downloads', () => {
    expect(() => selectRelease({ version: '2.0.0', files: [{ ...file, sha256: 'bad' }] }, '0.1.2')).toThrow()
    expect(() => verifyArtifact(Buffer.from('corrupt package!'), file)).toThrow()
    expect(() => verifyArtifact(bytes.subarray(0, 2), file)).toThrow()
    expect(() => verifyArtifact(bytes, file)).not.toThrow()
  })
  it('pins HTTPS to the official publisher and refuses redirects', async () => {
    const response = Object.assign(new EventEmitter(), { statusCode: 302, resume: vi.fn() })
    const req = Object.assign(new EventEmitter(), { end: () => {}, destroy: vi.fn() })
    vi.mocked(request).mockImplementation(((url: string, options: unknown, callback: (res: unknown) => void) => {
      // 断言下载地址被固定在配置的发布源上，不接受任何用户可控输入拼接。
      expect(url).toBe(`${UPDATE_ORIGIN}/downloads/${ARTIFACT_NAME}`)
      req.end = () => callback(response)
      return req
    }) as never)
    await expect(trustedDownload(ARTIFACT_NAME, 100)).rejects.toThrow('HTTP 302')
  })
  it('rejects downloads larger than the manifest declares', async () => {
    const response = Object.assign(new EventEmitter(), { statusCode: 200, resume: vi.fn(), destroy: (error: Error) => response.emit('error', error) })
    const req = Object.assign(new EventEmitter(), { end: () => {}, destroy: vi.fn() })
    vi.mocked(request).mockImplementation(((_url: string, _options: unknown, callback: (res: unknown) => void) => {
      req.end = () => { callback(response); response.emit('data', Buffer.alloc(101)) }
      return req
    }) as never)
    await expect(trustedDownload(ARTIFACT_NAME, 100)).rejects.toThrow('下载超过')
  })
})
