import { afterAll, describe, expect, it, vi } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { RuntimeRunner } from '../src/runtimeRunner'

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-imaging-runtime-test-'))
afterAll(() => fs.rmSync(root, { recursive: true, force: true }))

describe('VS Code local run pipeline', () => {
  it('runs a real Node script and opens its actual artifact', async () => {
    const scriptPath = path.join(root, 'plot.js')
    fs.writeFileSync(scriptPath, "require('node:fs').writeFileSync('chart.svg', '<svg xmlns=\"http://www.w3.org/2000/svg\"></svg>'); console.log('rendered')\n")
    const opened = vi.fn(async (_file: string) => {})
    const runner = new RuntimeRunner({ workspaceRoot: root, isTrusted: () => true, openArtifactPath: opened })
    const plan = await runner.plan({ runtimeId: 'node', scriptPath, workDir: root, args: [], envWhitelist: [], expectedArtifacts: ['chart.svg'] })
    const { runId } = await runner.run({ planId: plan.planId })
    let result = await runner.events(runId)
    for (let i = 0; i < 60 && result.status === 'running'; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 100))
      result = await runner.events(runId)
    }
    expect(result.status).toBe('completed')
    expect(result.events.some((event) => event.type === 'stdout' && String(event.data).includes('rendered'))).toBe(true)
    expect(result.dataHash).toMatch(/^[0-9a-f]{64}$/)
    await runner.openArtifact({ runId, artifactPath: 'chart.svg' })
    expect(opened).toHaveBeenCalledWith(path.join(root, 'chart.svg'))
  }, 30_000)
})
