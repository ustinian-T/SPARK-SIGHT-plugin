import { test } from 'node:test'
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { selectRelease, verifyArtifact } from './lib/updater.js'
test('DSH release refuses downgrade and corrupt packages', () => {
  const bytes = Buffer.from('DSH package')
  const file = { name: 'Spark-Sight-DSH.tgz', bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') }
  const manifest = { version: '0.1.2', dshVersion: '0.4.10', files: [file] }
  assert.equal(selectRelease(manifest, '0.4.9').version, '0.4.10')
  assert.equal(selectRelease(manifest, '0.5.0'), null)
  assert.throws(() => selectRelease({ ...manifest, files: [{ ...file, name: '../evil.tgz' }] }, '0.4.0'))
  assert.doesNotThrow(() => verifyArtifact(bytes, file))
  assert.throws(() => verifyArtifact(Buffer.from('corrupt'), file))
})
