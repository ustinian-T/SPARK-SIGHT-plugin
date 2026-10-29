import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { prepareDsh } from './scripts/prepare-dsh.mjs'
test('DSH package contains fresh Agent, web, fonts and licenses without local secrets/data', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-dsh-pack-'))
  const write = (name, content = 'fixture') => { const target = path.join(root, name); fs.mkdirSync(path.dirname(target), { recursive: true }); fs.writeFileSync(target, content) }
  try {
    write('services/local-agent/src/server.js'); write('services/local-agent/src/cloudAccounts.js'); write('services/local-agent/src/fonts/font.otf'); write('services/local-agent/src/fonts/fonts.conf')
    write('services/local-agent/src/session.key'); write('services/local-agent/src/.data/private.json'); write('services/local-agent/package.json', '{}')
    write('apps/web/dist/index.html'); write('apps/web/dist/assets/app.js'); write('apps/web/dist/.env')
    write('.release-config.local', JSON.stringify({ accountOrigin: 'https://accounts.example.test', websiteOrigin: 'https://www.example.test', updateOrigin: 'https://updates.example.test' }));
    write('LICENSE'); write('NOTICE.md'); write('apps/dsh/resources/stale.json')
    prepareDsh({ repoRoot: root, bundleWindowsRuntime: false })
    const resources = path.join(root, 'apps/dsh/resources')
    assert.equal(JSON.parse(fs.readFileSync(path.join(resources, 'release-config.json'), 'utf8')).accountOrigin, 'https://accounts.example.test', 'packaged login must use the configured account server')
    for (const name of ['agent/src/server.js', 'agent/src/cloudAccounts.js', 'agent/src/fonts/font.otf', 'agent/src/fonts/fonts.conf', 'web/dist/index.html', 'PROJECT-LICENSE', 'PROJECT-NOTICE.md']) assert.ok(fs.existsSync(path.join(resources, name)), name)
    for (const name of ['stale.json', 'agent/src/session.key', 'agent/src/.data', 'web/dist/.env']) assert.equal(fs.existsSync(path.join(resources, name)), false, name)
    assert.throws(() => prepareDsh({ repoRoot: root, bundleWindowsRuntime: true }), /runtime/)
  } finally { assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(root, { recursive: true, force: true }) }
})
