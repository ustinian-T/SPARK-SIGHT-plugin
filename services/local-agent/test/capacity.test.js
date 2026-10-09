import test from 'node:test'
import assert from 'node:assert/strict'
import { performance } from 'node:perf_hooks'
import { ingestFile } from '../src/csv.js'

function dataset(rows, padding = 0) {
  const lines = new Array(rows + 1)
  lines[0] = 'x,a,b,label'
  const tail = 'x'.repeat(padding)
  for (let index = 0; index < rows; index += 1) lines[index + 1] = `${index},${index % 997},${(index * 3) % 991},${tail}`
  return Buffer.from(lines.join('\n'))
}

test('approximately 10 MB CSV produces first deterministic profile within 30 seconds', () => {
  const bytes = dataset(220_000, 28)
  assert.ok(bytes.length >= 8 * 1024 * 1024, `fixture too small: ${bytes.length}`)
  const started = performance.now()
  const result = ingestFile('capacity-10mb.csv', bytes)
  const elapsed = performance.now() - started
  assert.equal(result.profile.rows, 220_000)
  assert.ok(elapsed <= 30_000, `10 MB ingest took ${elapsed.toFixed(0)}ms`)
})

test('opt-in heavy profile accepts 1,000,000 rows and at least 50 MB', { skip: process.env.DEEP_IMAGING_HEAVY !== '1' }, () => {
  const bytes = dataset(1_000_000, 42)
  assert.ok(bytes.length >= 50 * 1024 * 1024, `fixture too small: ${bytes.length}`)
  const result = ingestFile('capacity-50mb.csv', bytes)
  assert.equal(result.profile.rows, 1_000_000)
})
