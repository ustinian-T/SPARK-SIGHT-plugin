import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const extensionRoot = path.resolve(here, '..')
const repoRoot = path.resolve(extensionRoot, '..', '..')
const webDist = path.join(repoRoot, 'apps', 'web', 'dist')
const agentRoot = path.join(repoRoot, 'services', 'local-agent')

if (!fs.existsSync(path.join(webDist, 'index.html'))) throw new Error('Build apps/web before packaging the VS Code extension')
if (!fs.existsSync(path.join(extensionRoot, 'dist', 'extension.js'))) throw new Error('Build apps/vscode before packaging')
if (!fs.existsSync(path.join(agentRoot, 'src', 'server.js'))) throw new Error('Local Agent source is missing')

// Remove only these generated assembly directories so stale hashed assets cannot be loaded.
for (const parts of [['web', 'dist'], ['agent', 'src']]) {
  const target = path.resolve(extensionRoot, ...parts)
  if (!target.startsWith(path.resolve(extensionRoot) + path.sep)) throw new Error('Assembly target outside extension')
  fs.rmSync(target, {recursive:true,force:true})
}
fs.cpSync(webDist, path.join(extensionRoot, 'web', 'dist'), { recursive: true, force: true })
fs.cpSync(path.join(agentRoot, 'src'), path.join(extensionRoot, 'agent', 'src'), { recursive: true, force: true })
fs.copyFileSync(path.join(agentRoot, 'package.json'), path.join(extensionRoot, 'agent', 'package.json'))
fs.copyFileSync(path.join(repoRoot, 'LICENSE-MIT'), path.join(extensionRoot, 'LICENSE'))
fs.copyFileSync(path.join(repoRoot, 'LICENSE'), path.join(extensionRoot, 'LICENSE-SHARED'))
fs.writeFileSync(path.join(extensionRoot, 'LICENSE.txt'), [
  'Deep Imaging VS Code extension — component licenses',
  'The extension adapter (dist/) is MIT licensed. The bundled Agent (agent/) and Web UI (web/) are governed by the Deep Imaging Noncommercial Attribution License 1.0. Font and third-party licenses remain applicable. See THIRD_PARTY_NOTICES.md and NOTICE.md.',
  '\n=== Extension adapter: MIT ===\n',
  fs.readFileSync(path.join(repoRoot, 'LICENSE-MIT'), 'utf8'),
  '\n=== Shared Agent and Web UI ===\n',
  fs.readFileSync(path.join(repoRoot, 'LICENSE'), 'utf8')
].join('\n'))
fs.copyFileSync(path.join(repoRoot, 'THIRD_PARTY_NOTICES.md'), path.join(extensionRoot, 'THIRD_PARTY_NOTICES.md'))
fs.copyFileSync(path.join(repoRoot, 'NOTICE.md'), path.join(extensionRoot, 'NOTICE.md'))
const desktopRuntime = path.join(repoRoot, 'apps', 'desktop', 'src-tauri', 'runtime')
if (process.env.DEEP_IMAGING_BUNDLE_WINDOWS_RUNTIME === '1') {
  for (const component of ['node', 'python']) {
    const source = path.join(desktopRuntime, component)
    if (!fs.existsSync(source)) throw new Error(`Missing bundled Windows runtime: ${component}`)
    fs.cpSync(source, path.join(extensionRoot, 'runtime', component), { recursive: true, force: true })
  }
}
console.log('Packaged shared Web UI and real local Agent for VS Code')

const releaseSource = path.join(repoRoot, '.release-config.local')
const { validateReleaseConfig } = await import('../dist/releaseConfig.js')
const releaseConfig = validateReleaseConfig(fs.existsSync(releaseSource) ? JSON.parse(fs.readFileSync(releaseSource, 'utf8').replace(/^\uFEFF/, '')) : {})
fs.writeFileSync(path.join(extensionRoot, 'release-config.json'), JSON.stringify(releaseConfig, null, 2) + '\n')
