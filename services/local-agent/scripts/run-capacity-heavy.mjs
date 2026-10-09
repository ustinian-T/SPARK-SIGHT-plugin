import { spawnSync } from 'node:child_process'

const result = spawnSync(process.execPath, ['--test', 'test/capacity.test.js'], {
  cwd: process.cwd(),
  env: { ...process.env, DEEP_IMAGING_HEAVY: '1' },
  stdio: 'inherit'
})
process.exitCode = result.status ?? 1
