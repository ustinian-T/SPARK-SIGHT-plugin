import fs from 'node:fs'
import path from 'node:path'
export interface ReleaseConfig { accountOrigin: string; websiteOrigin: string; updateOrigin: string }
export function validateReleaseConfig(value: unknown): ReleaseConfig {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid release configuration')
  const data = value as Record<string, unknown>
  const defaults = {accountOrigin:'https://account.example.com',websiteOrigin:'https://www.example.com',updateOrigin:'https://updates.example.com'}
  for (const key of Object.keys(data)) if (!Object.hasOwn(defaults, key)) throw new Error('Unknown release configuration field')
  const output = {...defaults}
  for (const key of Object.keys(defaults) as (keyof ReleaseConfig)[]) {
    if (data[key] === undefined) continue
    if (typeof data[key] !== 'string') throw new Error('Release origin must be a string')
    const url = new URL(data[key])
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Release endpoints must be public HTTPS origins')
    output[key] = url.origin
  }
  return output
}
export function loadReleaseConfig(): ReleaseConfig {
  const file = path.join(__dirname, '..', 'release-config.json')
  return validateReleaseConfig(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {})
}

/** Fail explicitly for unconfigured source builds; never silently use a local account database. */
export function accountServiceOrigin(override = process.env.DEEP_IMAGING_ACCOUNT_URL, release = loadReleaseConfig()): string {
  const origin = validateReleaseConfig({ accountOrigin: override || release.accountOrigin }).accountOrigin
  if (origin === 'https://account.example.com') throw new Error('扩展未配置账号服务，请安装官网发布的 VSIX 或配置 DEEP_IMAGING_ACCOUNT_URL')
  return origin
}
