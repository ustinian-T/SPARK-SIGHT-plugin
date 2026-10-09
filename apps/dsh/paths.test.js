import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { resolvePersistentDataDir } from './lib/paths.js'
test('DSH default data survives package replacement and preserves legacy data without overwrites', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-dsh-data-'))
  try {
    const old = path.join(root, 'old-package', '.data'); fs.mkdirSync(old, { recursive: true }); fs.writeFileSync(path.join(old, 'project.json'), 'legacy')
    const options = { agentDir: path.dirname(old), home: path.join(root, 'home'), env: {}, platform: 'linux' }
    const target = resolvePersistentDataDir({}, options)
    assert.ok(target.startsWith(path.join(root, 'home')))
    assert.equal(fs.readFileSync(path.join(target, 'project.json'), 'utf8'), 'legacy')
    assert.equal(fs.readFileSync(path.join(old, 'project.json'), 'utf8'), 'legacy')
    fs.writeFileSync(path.join(target, 'project.json'), 'current')
    assert.equal(resolvePersistentDataDir({}, { ...options, agentDir: path.join(root, 'new-package') }), target)
    assert.equal(fs.readFileSync(path.join(target, 'project.json'), 'utf8'), 'current')
    assert.equal(resolvePersistentDataDir({ dataDir: '/custom' }, options), '/custom')
    assert.equal(resolvePersistentDataDir({}, { ...options, env: { LOCAL_AGENT_DATA_DIR: '/environment' } }), '/environment')
  } finally { assert.ok(path.resolve(root).startsWith(path.resolve(os.tmpdir()) + path.sep)); fs.rmSync(root, { recursive: true, force: true }) }
})
