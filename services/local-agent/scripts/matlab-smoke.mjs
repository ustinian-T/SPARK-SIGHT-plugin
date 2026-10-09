import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { generateCode, expectedArtifacts } from '../src/codegen.js'

const executable = process.env.DEEP_IMAGING_MATLAB || 'matlab'
const workdir = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-imaging-matlab-'))
const fileName = 'matlab_smoke.csv'
const strategy = 'clarity'
fs.writeFileSync(path.join(workdir, fileName), 'dose,response_a,response_b\n1,2,3\n2,4,4\n3,7,6\n', 'utf8')
const source = generateCode(strategy, {
  fileName,
  x: 'dose',
  measures: ['response_a', 'response_b'],
  title: 'Deep Imaging MATLAB smoke',
  yLabel: 'response'
}).matlab
const script = path.join(workdir, 'deep_imaging_matlab_smoke.m')
fs.writeFileSync(script, source, 'utf8')
const escaped = script.replaceAll('\\', '/').replaceAll("'", "''")
const result = spawnSync(executable, ['-batch', `run('${escaped}')`], { cwd: workdir, encoding: 'utf8', timeout: 120_000, windowsHide: true })
if (result.error) throw result.error
if (result.status !== 0) throw new Error(`MATLAB exited ${result.status}: ${`${result.stdout ?? ''}${result.stderr ?? ''}`.slice(-2000)}`)
const artifacts = expectedArtifacts(strategy, 'matlab')
for (const artifact of artifacts) {
  const target = path.join(workdir, artifact)
  if (!fs.existsSync(target) || fs.statSync(target).size < 100) throw new Error(`MATLAB artifact missing or empty: ${artifact}`)
}
process.stdout.write(`${JSON.stringify({ ok: true, engine: 'matlab', artifacts: artifacts.map((name) => ({ name, bytes: fs.statSync(path.join(workdir, name)).size })), workdir })}\n`)
