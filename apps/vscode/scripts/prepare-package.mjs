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

fs.cpSync(webDist, path.join(extensionRoot, 'web', 'dist'), { recursive: true, force: true })
fs.cpSync(path.join(agentRoot, 'src'), path.join(extensionRoot, 'agent', 'src'), { recursive: true, force: true })
fs.copyFileSync(path.join(agentRoot, 'package.json'), path.join(extensionRoot, 'agent', 'package.json'))
fs.copyFileSync(path.join(repoRoot, 'LICENSE'), path.join(extensionRoot, 'LICENSE'))
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
