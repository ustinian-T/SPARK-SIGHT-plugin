# Deep Imaging for VSCode

This extension hosts the shared `apps/web` UI in a nonce-protected webview and speaks host protocol v2. It sends only the active explicit selection or an explicitly requested file.

The Windows x64 package bundles Node, Python plotting dependencies and the licensed
Noto CJK font. Generated charts work without installing Python or Chinese fonts.
Data, chat records and API settings remain in local extension storage. R and
strong isolation for custom scripts require a separately configured local runtime;
the Agent reports availability instead of pretending those tools are installed.

Safety rules:

- Untrusted workspaces cannot read selections, open workspace diffs, or apply patches.
- Resources outside the current workspace are rejected.
- Dirty editors and stale base hashes always open a review diff; they are never overwritten silently.
- The local Agent token remains in extension/webview memory and is not placed in the page URL.

Run `npm install`, `npm test`, and `npm run build` in this directory. Build `apps/web` before opening the webview.

## Commands and review flow

The command palette exposes Agent start/stop, generation, repair, preview, three-plan comparison, export, preferences, reviewed insertion, undo, Desktop handoff, and local MATLAB execution. CSV comparison uses temporary files; applying code always targets an explicit editor location. Patch review supports per-hunk accept/reject, stale-hash and dirty-file protection, one-step restoration, and source-error navigation to the reported file/line.

MATLAB execution is a local host action using the user's licensed installation. The extension does not ship MATLAB, upload its license, or execute MATLAB in the Web client.

## Shared workspace and licensing

Inspector, evidence and preferences are fixed left navigation entries and open in the main workspace. The shared UI no longer has a right sidebar. Long pages and the activity rail remain scrollable in narrow/short webviews. A published VSIX must be rebuilt to include changes after its release commit. Current usage and attribution terms are in the root LICENSE and docs/licensing.md; independently licensed components keep their original rights.
