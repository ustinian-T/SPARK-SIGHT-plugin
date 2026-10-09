import { spawnSync } from 'node:child_process'
import { isolationAvailable, isolatedCommand } from './isolatedRunner.js'
import { probeR, probePython } from './engines.js'
process.env.DEEP_IMAGING_SANDBOX = 'bubblewrap'
const mode = process.argv[2]
if (mode === 'probe') {
  const python = probePython()
  console.log(JSON.stringify({ available: isolationAvailable() && !!python.dependencies?.matplotlib, python, r: probeR() }))
} else if (mode === 'run') {
  const payload = JSON.parse(Buffer.from(process.argv[3], 'base64').toString('utf8'))
  const command = isolatedCommand(payload)
  const result = spawnSync(command.cmd, command.args, { cwd: payload.workdir, timeout: payload.timeoutMs, maxBuffer: 4 * 1024 * 1024, encoding: 'utf8', shell: false })
  process.stdout.write(result.stdout || '')
  process.stderr.write(result.stderr || result.error?.message || '')
  process.exitCode = result.status ?? 1
} else {
  throw new Error('Unknown isolated worker command')
}
