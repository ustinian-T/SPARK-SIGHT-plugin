import { createHash } from 'node:crypto'

export interface HostPatchRequest {
  uri: string
  baseHash: string
  proposedText: string
  label?: string
}

export interface HostPatchResult {
  applied: boolean
  reviewOpened: boolean
}

export interface HostSelection {
  uri: string
  text: string
  languageId?: string
  startLine?: number
  endLine?: number
}

export interface VscodeFacade {
  readonly isTrusted: boolean
  isUriAllowed(uri: string): boolean
  openDocument(uri: string): Promise<{ text: string; isDirty: boolean }>
  openDiff(uri: string, proposedText: string, title?: string): Promise<void>
  applyText(uri: string, proposedText: string): Promise<void>
  readSelection(): Promise<HostSelection | null>
  createTemporaryDocument(name: string, content: string): Promise<string>
  insertText(uri: string, text: string, line: number, character: number): Promise<void>
  revealLocation(uri: string, line: number, character: number): Promise<void>
  undo(): Promise<void>
  writeHandoff(payload: unknown): Promise<string>
}

export interface HostHunkRequest {
  uri: string
  baseHash: string
  hunks: { start: number; end: number; replacement: string; accepted: boolean }[]
}

export function codedError(code: string, message: string): Error & { code: string } {
  return Object.assign(new Error(message), { code })
}

export function hashText(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

export async function applyPatchWithReview(vscode: VscodeFacade, request: HostPatchRequest): Promise<HostPatchResult> {
  if (!vscode.isTrusted) throw codedError('WORKSPACE_UNTRUSTED', 'Workspace trust is required')
  if (!vscode.isUriAllowed(request.uri)) throw codedError('RESOURCE_NOT_ALLOWED', 'Requested resource is outside the trusted workspace')
  const document = await vscode.openDocument(request.uri)
  if (document.isDirty || hashText(document.text) !== request.baseHash) {
    await vscode.openDiff(request.uri, request.proposedText, request.label)
    return { applied: false, reviewOpened: true }
  }
  await vscode.applyText(request.uri, request.proposedText)
  return { applied: true, reviewOpened: false }
}

export async function applySelectedHunks(vscode: VscodeFacade, request: HostHunkRequest): Promise<{ applied: boolean; accepted: number; rejected: number }> {
  if (!vscode.isTrusted) throw codedError('WORKSPACE_UNTRUSTED', 'Workspace trust is required')
  if (!vscode.isUriAllowed(request.uri)) throw codedError('RESOURCE_NOT_ALLOWED', 'Requested resource is outside the trusted workspace')
  const document = await vscode.openDocument(request.uri)
  if (document.isDirty || hashText(document.text) !== request.baseHash) throw codedError('PATCH_BASE_STALE', 'Document changed; reopen review before applying hunks')
  const accepted = request.hunks.filter((hunk) => hunk.accepted)
  for (const hunk of request.hunks) {
    if (!Number.isInteger(hunk.start) || !Number.isInteger(hunk.end) || hunk.start < 0 || hunk.end < hunk.start || hunk.end > document.text.length) {
      throw codedError('PATCH_HUNK_INVALID', 'Patch hunk is outside the document')
    }
  }
  const ordered = [...accepted].sort((a, b) => b.start - a.start)
  if (ordered.some((hunk, index) => index > 0 && hunk.end > ordered[index - 1].start)) throw codedError('PATCH_HUNK_OVERLAP', 'Accepted hunks overlap')
  let next = document.text
  for (const hunk of ordered) next = `${next.slice(0, hunk.start)}${hunk.replacement}${next.slice(hunk.end)}`
  if (accepted.length) await vscode.applyText(request.uri, next)
  return { applied: accepted.length > 0, accepted: accepted.length, rejected: request.hunks.length - accepted.length }
}
