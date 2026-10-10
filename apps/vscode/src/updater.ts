import { loadReleaseConfig } from './releaseConfig'
import { createHash } from 'node:crypto'
import { request } from 'node:https'

/**
 * Release origin. The upstream SPARK SIGHT build points this at its own
 * publishing service; this public source release ships a placeholder so no
 * private infrastructure is published. Builds that publish their own VSIX set
 * DEEP_IMAGING_UPDATE_ORIGIN to their own HTTPS release host.
 */
export const UPDATE_ORIGIN = process.env.DEEP_IMAGING_UPDATE_ORIGIN || loadReleaseConfig().updateOrigin
export const ARTIFACT_NAME = 'Deep-Imaging-VSCode-Windows-x64.vsix'
export interface ReleaseFile { name: string; bytes: number; sha256: string }
export interface Release { version: string; file: ReleaseFile }
function versionParts(value: unknown): number[] {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+$/.test(value)) throw new Error('发布版本格式无效')
  const parts = value.split('.').map(Number)
  if (parts.some((x) => !Number.isSafeInteger(x))) throw new Error('发布版本超出范围')
  return parts
}
export function selectRelease(manifest: unknown, current: string): Release | null {
  const value = manifest as { version: string; files: ReleaseFile[] }
  const next = versionParts(value?.version), installed = versionParts(current)
  if (!Array.isArray(value.files)) throw new Error('发布清单无效')
  const file = value.files.find((entry) => entry.name === ARTIFACT_NAME)
  if (!file || !Number.isSafeInteger(file.bytes) || file.bytes <= 0 || file.bytes > 512 * 1024 * 1024 || !/^[a-f0-9]{64}$/i.test(file.sha256)) throw new Error('发布包信息无效')
  const different = next.findIndex((part, index) => part !== installed[index])
  return different >= 0 && next[different] > installed[different] ? { version: value.version, file } : null
}
export function verifyArtifact(bytes: Buffer, file: ReleaseFile): void {
  if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256.toLowerCase()) throw new Error('升级包校验失败；未安装')
}
/** Fixed origin, certificate validation on, redirects forbidden, bounded memory/time. */
export function trustedDownload(name: 'release.json' | typeof ARTIFACT_NAME, maxBytes: number): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const req = request(`${UPDATE_ORIGIN}/downloads/${name}`, { timeout: 120_000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`下载失败 HTTP ${res.statusCode}`)); return }
      const chunks: Buffer[] = []; let size = 0
      res.on('data', (chunk: Buffer) => {
        size += chunk.length
        if (size > maxBytes) { res.destroy(new Error('下载超过发布清单大小')); return }
        chunks.push(chunk)
      })
      res.on('error', reject)
      res.on('end', () => resolve(Buffer.concat(chunks)))
    })
    req.on('timeout', () => req.destroy(new Error('下载超时')))
    req.on('error', reject)
    req.end()
  })
}
export async function checkUpdate(current: string): Promise<Release | null> {
  return selectRelease(JSON.parse((await trustedDownload('release.json', 1024 * 1024)).toString('utf8')), current)
}
