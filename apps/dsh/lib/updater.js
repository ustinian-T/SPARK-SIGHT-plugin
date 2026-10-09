import { createHash } from 'node:crypto'
import { request } from 'node:https'
export const ARTIFACT_NAME = 'Spark-Sight-DSH.tgz'
// 发布源：上游构建指向官方服务；公开源码以占位符发布，避免暴露私有基础设施。
// 自行发布插件包的构建请通过 DEEP_IMAGING_UPDATE_ORIGIN 指向自己的 HTTPS 发布主机。
const ORIGIN = `${process.env.DEEP_IMAGING_UPDATE_ORIGIN || 'https://updates.example.com'}/downloads/`
const parts = (value) => {
  if (typeof value !== 'string' || !/^\d+\.\d+\.\d+$/.test(value)) throw new Error('发布版本格式无效')
  const result = value.split('.').map(Number)
  if (result.some((x) => !Number.isSafeInteger(x))) throw new Error('发布版本超出范围')
  return result
}
export function selectRelease(manifest, current) {
  const next = parts(manifest?.dshVersion), installed = parts(current)
  const file = manifest.files?.find((entry) => entry.name === ARTIFACT_NAME)
  if (!file || !Number.isSafeInteger(file.bytes) || file.bytes <= 0 || file.bytes > 512 * 1024 * 1024 || !/^[a-f0-9]{64}$/i.test(file.sha256)) throw new Error('DSH 发布包信息无效')
  const difference = next.findIndex((part, index) => part !== installed[index])
  return difference >= 0 && next[difference] > installed[difference] ? { version: manifest.dshVersion, file } : null
}
export function verifyArtifact(bytes, file) {
  if (bytes.length !== file.bytes || createHash('sha256').update(bytes).digest('hex') !== file.sha256.toLowerCase()) throw new Error('升级包校验失败')
}
function download(name, limit) {
  return new Promise((resolve, reject) => {
    const req = request(`${ORIGIN}${name}`, { timeout: 180000 }, (res) => {
      if (res.statusCode !== 200) { res.resume(); reject(new Error(`下载失败 HTTP ${res.statusCode}`)); return }
      const chunks = []; let size = 0
      res.on('data', (chunk) => { size += chunk.length; if (size > limit) { res.destroy(new Error('下载超过清单大小')); return }; chunks.push(chunk) })
      res.on('end', () => resolve(Buffer.concat(chunks)))
      res.on('error', reject)
    })
    req.on('timeout', () => req.destroy(new Error('下载超时')))
    req.on('error', reject); req.end()
  })
}
export async function checkUpdate(current) { return selectRelease(JSON.parse((await download('release.json', 1024 * 1024)).toString('utf8')), current) }
export async function downloadUpdate(current) {
  const release = await checkUpdate(current)
  if (!release) throw new Error('已是最新版本；禁止降级')
  const bytes = await download(ARTIFACT_NAME, release.file.bytes)
  verifyArtifact(bytes, release.file)
  return { release, bytes }
}
