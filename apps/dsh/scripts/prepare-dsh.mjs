import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { validateReleaseConfig } from '../lib/release-config.js'

const script = fileURLToPath(import.meta.url)
const repository = path.resolve(path.dirname(script), '..', '..', '..')
const sensitive = /(^|[\\/])(?:\.data|\.env(?:\.[^\\/]*)?|projects|tasks|verified-updates|__pycache__)(?:[\\/]|$)|\.(?:pem|key|pfx|p12|jks|crt)$/i
function copyTree(source, target, allow = () => true) {
  fs.cpSync(source, target, { recursive: true, force: true, filter: (entry) => {
    if (sensitive.test(path.relative(source, entry))) return false
    const stat = fs.lstatSync(entry)
    if (stat.isSymbolicLink()) throw new Error(`Refusing package symlink: ${entry}`)
    return stat.isDirectory() || allow(entry)
  } })
}
export function prepareDsh({ repoRoot = repository, bundleWindowsRuntime = process.env.DEEP_IMAGING_BUNDLE_WINDOWS_RUNTIME === '1' } = {}) {
  const root = path.resolve(repoRoot)
  const resources = path.resolve(root, 'apps', 'dsh', 'resources')
  if (!resources.startsWith(root + path.sep) || path.basename(resources) !== 'resources') throw new Error('Package destination escapes workspace')
  const agent = path.join(root, 'services', 'local-agent')
  const web = path.join(root, 'apps', 'web', 'dist')
  const runtime = path.join(root, 'apps', 'desktop', 'src-tauri', 'runtime')
  for (const required of [path.join(agent, 'src', 'server.js'), path.join(web, 'index.html'), path.join(root, 'LICENSE'), path.join(root, 'NOTICE.md')]) {
    if (!fs.existsSync(required)) throw new Error(`Missing package prerequisite: ${required}`)
  }
  if (bundleWindowsRuntime && !fs.existsSync(path.join(runtime, 'python', 'python.exe'))) throw new Error('Missing prepared Windows Python runtime')
  // Only generated package resources are refreshed; application data lives elsewhere.
  fs.rmSync(resources, { recursive: true, force: true })
  fs.mkdirSync(resources, { recursive: true })
  const releaseSource = path.join(root, '.release-config.local')
  const release = validateReleaseConfig(fs.existsSync(releaseSource) ? JSON.parse(fs.readFileSync(releaseSource, 'utf8').replace(/^\uFEFF/, '')) : {})
  fs.writeFileSync(path.join(resources, 'release-config.json'), JSON.stringify(release, null, 2) + '\n')
  copyTree(path.join(agent, 'src'), path.join(resources, 'agent', 'src'), (entry) => /\.(?:js|json|otf|ttf|txt|md|conf)$/i.test(entry))
  fs.copyFileSync(path.join(agent, 'package.json'), path.join(resources, 'agent', 'package.json'))
  copyTree(web, path.join(resources, 'web', 'dist'))
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(resources, 'PROJECT-LICENSE'))
  fs.copyFileSync(path.join(root, 'NOTICE.md'), path.join(resources, 'PROJECT-NOTICE.md'))
  if (bundleWindowsRuntime) {
    // Harness already provides Node/Electron. Python and its package licenses
    // are copied from the same prepared distribution as the desktop installer.
    copyTree(path.join(runtime, 'python'), path.join(resources, 'runtime', 'python'))
  }
  return resources
}
if (process.argv[1] && path.resolve(process.argv[1]) === script) console.log(`Prepared self-contained DSH package: ${prepareDsh()}`)
