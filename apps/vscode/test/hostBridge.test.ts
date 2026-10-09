import { describe, expect, it, vi } from 'vitest'
import { createHost } from '../src/hostBridge'
import { applySelectedHunks, hashText, type VscodeFacade } from '../src/patchReview'

function facade(options: { trusted: boolean; dirty?: boolean; text?: string }): VscodeFacade {
  const text = options.text ?? 'old text'
  return {
    isTrusted: options.trusted,
    isUriAllowed: () => true,
    openDocument: vi.fn(async () => ({ text, isDirty: options.dirty ?? false })),
    openDiff: vi.fn(async () => undefined),
    applyText: vi.fn(async () => undefined),
    readSelection: vi.fn(async () => ({ uri: 'file:///workspace/data.csv', text: 'selected' })),
    createTemporaryDocument: vi.fn(async (name: string) => `untitled:/deep-imaging/${name}`),
    insertText: vi.fn(async () => undefined),
    revealLocation: vi.fn(async () => undefined),
    undo: vi.fn(async () => undefined),
    writeHandoff: vi.fn(async () => 'file:///workspace/.deep-imaging/handoff.json')
  }
}

const patch = { uri: 'file:///workspace/plot.py', baseHash: hashText('old text'), proposedText: 'new text' }

describe('VSCode host safety boundary', () => {
  it('refuses reads and patch application in an untrusted workspace', async () => {
    const host = createHost(facade({ trusted: false }))
    await expect(host.readSelection()).rejects.toMatchObject({ code: 'WORKSPACE_UNTRUSTED' })
    await expect(host.applyPatch(patch)).rejects.toMatchObject({ code: 'WORKSPACE_UNTRUSTED' })
  })

  it('opens a review diff when the target editor is dirty', async () => {
    const api = facade({ trusted: true, dirty: true })
    const host = createHost(api)
    await expect(host.applyPatch(patch)).resolves.toEqual({ applied: false, reviewOpened: true })
    expect(api.openDiff).toHaveBeenCalledOnce()
    expect(api.applyText).not.toHaveBeenCalled()
  })

  it('opens review instead of overwriting when the base hash is stale', async () => {
    const api = facade({ trusted: true, text: 'changed externally' })
    await expect(createHost(api).applyPatch(patch)).resolves.toEqual({ applied: false, reviewOpened: true })
    expect(api.applyText).not.toHaveBeenCalled()
  })

  it('applies only an explicitly requested clean workspace file', async () => {
    const api = facade({ trusted: true })
    await expect(createHost(api).applyPatch(patch)).resolves.toEqual({ applied: true, reviewOpened: false })
    expect(api.applyText).toHaveBeenCalledWith(patch.uri, patch.proposedText)
  })

  it('creates three temporary plan files and supports targeted insertion/navigation/undo/handoff', async () => {
    const api = facade({ trusted: true })
    const host = createHost(api)
    const comparison = await host.comparePlans([
      { name: 'a.py', source: 'a' }, { name: 'b.py', source: 'b' }, { name: 'c.py', source: 'c' }
    ])
    expect(comparison).toHaveLength(3)
    await host.insertAt({ uri: 'file:///workspace/plot.py', text: 'generated', line: 4, character: 2 })
    await host.revealDiagnostic({ uri: 'file:///workspace/plot.py', line: 9, character: 3 })
    await host.undo()
    await host.writeHandoff({ taskId: 'task-1', revisionId: 'rev-2', direction: 'desktop' })
    expect(api.insertText).toHaveBeenCalledWith('file:///workspace/plot.py', 'generated', 4, 2)
    expect(api.revealLocation).toHaveBeenCalledWith('file:///workspace/plot.py', 9, 3)
    expect(api.undo).toHaveBeenCalledOnce()
    expect(api.writeHandoff).toHaveBeenCalledOnce()
  })

  it('applies only accepted hunks against an unchanged clean base', async () => {
    const api = facade({ trusted: true, text: 'alpha beta gamma' })
    const result = await applySelectedHunks(api, {
      uri: 'file:///workspace/plot.py',
      baseHash: hashText('alpha beta gamma'),
      hunks: [
        { start: 0, end: 5, replacement: 'ALPHA', accepted: true },
        { start: 11, end: 16, replacement: 'GAMMA', accepted: false }
      ]
    })
    expect(result).toEqual({ applied: true, accepted: 1, rejected: 1 })
    expect(api.applyText).toHaveBeenCalledWith('file:///workspace/plot.py', 'ALPHA beta gamma')
  })
})
