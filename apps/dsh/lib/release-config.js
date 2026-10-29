import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
export function validateReleaseConfig(value = {}) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid release configuration')
  const output = { accountOrigin: 'https://account.example.com', websiteOrigin: 'https://www.example.com', updateOrigin: 'https://updates.example.com' }
  for (const key of Object.keys(value)) {
    if (!Object.hasOwn(output, key)) throw new Error('Unknown release configuration field')
    if (typeof value[key] !== 'string') throw new Error('Release origin must be a string')
    const url = new URL(value[key])
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) throw new Error('Release endpoints must be public HTTPS origins')
    output[key] = url.origin
  }
  return output
}
export function loadReleaseConfig() {
  const file = path.join(packageRoot, 'resources', 'release-config.json')
  return validateReleaseConfig(fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) : {})
}
export function accountServiceOrigin(config = {}, { env = process.env, release = loadReleaseConfig() } = {}) {
  if (Object.hasOwn(config, 'cloudAccountUrl') && config.cloudAccountUrl === '') return ''
  const origin = validateReleaseConfig({ accountOrigin: config.cloudAccountUrl || env.DEEP_IMAGING_ACCOUNT_URL || release.accountOrigin }).accountOrigin
  if (origin === 'https://account.example.com') throw new Error('插件未配置账号服务，请安装官网发布的插件包或配置 cloudAccountUrl')
  return origin
}
