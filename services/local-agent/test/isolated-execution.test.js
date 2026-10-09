import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { isolationAvailable, isolatedCommand } from '../src/isolatedRunner.js'
import { runInSandbox, sandboxCapabilities } from '../src/sandbox.js'
import { generateCode, expectedArtifacts } from '../src/codegen.js'
import { ingestFile } from '../src/csv.js'
import { runDeterministicAnalysis } from '../src/stats.js'

const isolated = isolationAvailable()
const csv = fs.readFileSync(new URL('./fixtures/nitrogen_response_demo.csv', import.meta.url))
const fileName = 'nitrogen_response_demo.csv'
const ingested = ingestFile(fileName, csv)
const analysis = runDeterministicAnalysis({ profile: ingested.profile, text: ingested.text, rawDelimiter: ingested.rawDelimiter, fileName })
const input = { fileName, x: analysis.summary.xLabel, measures: analysis.summary.series.map((s) => s.label), title: 'Sandbox acceptance', yLabel: 'Response' }

test('real isolated Python and R produce SVG/PNG for all three strategies, including edited code', { skip: !isolated }, async () => {
  for (const engine of ['python', 'r']) {
    for (const strategy of ['clarity', 'convention', 'density']) {
      const code = generateCode(strategy, input)[engine]
      const result = await runInSandbox({ engine, code: `${code}\n# user edit`, sourceKind: 'custom', workdir: fs.mkdtempSync(path.join(os.tmpdir(), 'isolated-render-')), csvBuffer: csv, csvName: fileName, expected: expectedArtifacts(strategy, engine) })
      assert.equal(result.status, 'success', `${engine}/${strategy}: ${result.stderr}`)
      assert.ok(result.artifacts.find((artifact) => artifact.name.endsWith('.svg'))?.svg.includes('<svg'))
      assert.ok(result.artifacts.find((artifact) => artifact.name.endsWith('.png'))?.png.width > 300)
    }
  }
})

test('OS isolation hides external files, secrets and network and enforces limits', { skip: !isolated || process.platform !== 'linux' }, () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'isolated-boundary-'))
  const outside = path.join(os.tmpdir(), `outside-${process.pid}.txt`)
  fs.writeFileSync(outside, 'private data')
  fs.writeFileSync(path.join(dir, 'boundary.py'), `import os,socket,resource,json\nassert not os.path.exists(${JSON.stringify(outside)})\nassert not os.path.exists('/app/src/server.js')\nassert 'ISOLATION_TEST_SECRET' not in os.environ\nassert resource.getrlimit(resource.RLIMIT_AS)[0] == 1073741824\ntry:\n socket.create_connection(('1.1.1.1',443),timeout=1)\n raise AssertionError('network escaped')\nexcept OSError:\n print('boundary enforced')\n`)
  try {
    const command = isolatedCommand({ engine: 'python', script: 'boundary.py', workdir: dir })
    const result = spawnSync(command.cmd, command.args, { env: { ...process.env, ISOLATION_TEST_SECRET: 'test-only-value' }, timeout: 5000, encoding: 'utf8' })
    assert.equal(result.status, 0, result.stderr)
    assert.match(result.stdout, /boundary enforced/)
  } finally { fs.unlinkSync(outside) }
})

test('legacy strong-sandbox flag alone cannot grant custom execution', () => {
  if (isolated) return
  const old = process.env.DEEP_IMAGING_STRONG_SANDBOX
  try { process.env.DEEP_IMAGING_STRONG_SANDBOX = '1'; assert.equal(sandboxCapabilities().customCode, false) }
  finally { if (old === undefined) delete process.env.DEEP_IMAGING_STRONG_SANDBOX; else process.env.DEEP_IMAGING_STRONG_SANDBOX = old }
})
