import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

let probe
export function wslPath(value) {
  if (!/^[A-Za-z]:[\\/]/.test(value)) throw new Error('WSL 沙箱仅接受本机绝对路径')
  return `/mnt/${value[0].toLowerCase()}${value.slice(2).replace(/\\/g, '/')}`
}
export function wslCommand(mode, payload) {
  const worker = wslPath(fileURLToPath(new URL('./isolatedWorker.js', import.meta.url)))
  return { cmd: 'wsl.exe', args: ['--distribution', process.env.DEEP_IMAGING_WSL_DISTRO || 'Ubuntu', '--exec', 'node', worker, mode, Buffer.from(JSON.stringify(payload || {})).toString('base64')] }
}
export function probeWslSandbox() {
  if (process.platform !== 'win32' || process.env.DEEP_IMAGING_SANDBOX === 'off') return null
  if (probe !== undefined) return probe
  const command = wslCommand('probe')
  const result = spawnSync(command.cmd, command.args, { timeout: 20000, encoding: 'utf8', windowsHide: true, shell: false })
  try { probe = result.status === 0 ? JSON.parse(result.stdout) : null } catch { probe = null }
  return probe
}
