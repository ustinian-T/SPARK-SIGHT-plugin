# SPARK SIGHT for DeepSeek Harness

> 灵感视界 SPARK SIGHT — DeepSeek Harness 内的科研绘图插件。

An independent, third-party plugin that brings SPARK SIGHT research-plotting
capabilities into [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness).
**This is an independent plugin; it is not provided, endorsed, or certified by
DeepSeek.**

## Status

Developer milestone **M3 — local backend connected**. The plugin installs into
a Harness profile (primary target: the `desktop` profile used by the official
desktop app) and places an "open workbench" button in the conversation input
toolbar (the `conversation.input.left` slot). Clicking it opens a full-screen
Stage whose iframe embeds the full SPARK SIGHT web app, served same-origin by
the bundled `@deep-imaging/local-agent` sidecar. The sidecar injects a
postMessage host bridge into that page, so the embedded app runs in **local
mode** and talks directly to the sidecar's complete plotting backend — login →
open data → plan → preview → export end to end, with no remote server. The
agent is managed as a sidecar (boot token, `/health` readiness, process-tree
teardown) under plain Node or Electron's `ELECTRON_RUN_AS_NODE`. Later
milestones add model-callable tools, direct script execution, and publishing.

## Install

The plugin renders in the Harness Web UI, which the official desktop app also
uses: the desktop shell launches the `desktop` profile through the same Web
application and loads its URL in Electron. Install the plugin into the profile
you actually use.

For the **desktop app** (SPARK SIGHT's primary target):

```sh
dsh plugin --profile desktop add sparksight-dsh
```

For the browser-based Web UI:

```sh
dsh plugin --profile web add sparksight-dsh
```

During development, replace the package name with the local path, e.g.
`dsh plugin --profile desktop add ./apps/dsh`. Restart Harness (or quit and
reopen the desktop app) after installing.

> **Why `platform` stays `web` for the desktop app too.** `dsh.client.platform`
> identifies the rendering surface — the shared Web UI — and the loader only
> accepts `web` (there is no separate desktop client platform). Whether the UI
> appears in a browser or in Electron is selected by the **profile**
> (`web` vs `desktop`), not by that field.

## Development

The plugin needs no build step: the Host (`index.js`) and Client (`client.js`)
artifacts are committed directly and load as-is.

- Host half runs in the Node-capable Harness process; it keeps zero runtime
  dependencies beyond Node built-ins and the host's Connection fetch registry.
- Client half is registered through the browser Module Loader; React and
  react-dom are provided by the Harness module table.

## Stage architecture

The Stage embeds the exact web application shipped as the SPARK SIGHT
web/desktop product — there is no second UI:

1. The Host starts the local-agent sidecar (M1) with `LOCAL_AGENT_WEB_DIST_DIR`
   pointing at the web build (`resources/web/dist`, else `apps/web/dist`); the
   agent serves that SPA same-origin (static assets need no token).
2. The Host registers a same-origin route `GET /api/sparksight/stage` via the
   Connection fetch registry (standard Web Request/Response). It returns only
   the sidecar `webUrl` (never the boot token) and answers 503 while booting.
3. When the sidecar serves the SPA's `index.html`, it injects an inline
   bootstrap (right after `<head>`) that — only while framed — installs
   `window.__DEEP_IMAGING_HOST__` over `window.parent.postMessage`.
4. The Client button fetches the stage route, then opens an overlay with
   `<iframe src="<webUrl>/#/app">`. The overlay relays each bridge message to a
   same-origin `POST /api/sparksight/host` route and posts the response back to
   the iframe using its exact origin.
5. Inside the iframe the bridge puts the app in **local mode**: `agent.config`
   supplies the sidecar baseUrl and boot token, after which all plotting calls
   (projects, tasks, WebSocket events, preview, export) go directly to the
   sidecar. `runtime.discover` reports the machine's real Python/R/MATLAB
   engines (via the sidecar's probe); editor-only and direct-script-run calls
   are honestly reported unsupported in this milestone.

The iframe is cross-origin to the Harness page (a different loopback port).
Child→parent requests carry no token and use `'*'` target; parent→child
responses (which include the boot token) always use the iframe's exact origin.
The sidecar runs in local-only mode (`LOCAL_ONLY_MODE=1`, `REMOTE_MODE=0`), so
no data leaves the machine and MATLAB engine discovery stays available.

## Configuration

The plugin row's `config` accepts these optional fields:

| Field | Type | Default | Purpose |
|---|---|---|---|
| `autoStart` | boolean | `true` | Launch the sidecar when the plugin mounts |
| `agentDir` | string | auto | Explicit local-agent directory; otherwise `resources/agent`, then the monorepo dev path |
| `port` | number | `0` (random) | Fixed sidecar port via `LOCAL_AGENT_PORT` |
| `dataDir` | string | agent default | Persistence directory via `LOCAL_AGENT_DATA_DIR` |
| `webDir` | string | auto | Web build served same-origin; else `resources/web/dist`, then `apps/web/dist` |
| `adminUsername` | string | `admin` | Bootstrap admin name via `LOCAL_AGENT_ADMIN_USERNAME` |
| `adminPassword` | string | random | Bootstrap admin password via `LOCAL_AGENT_ADMIN_PASSWORD`; otherwise generated and shown once in the agent log |

The agent binds `127.0.0.1` only and generates a random boot token on every
start, which the Host reads from stdout. API calls use
`Authorization: Bearer <token>` and the WebSocket authenticates after the
handshake; the token never goes in the URL.

## Layout

```
apps/dsh/
├── package.json          # dsh.bundle.patch + dsh.client manifest
├── cordis.patch.yml      # inserts the plugin row into the profile composition
├── index.js              # Host half (sidecar + stage + host-bridge relay routes)
├── lib/
│   └── sidecar.js         # local-agent process manager
├── client.js             # Client half (Module Loader factory + slot)
├── locale/               # en.json / zh.json display metadata
├── icon.svg              # original plugin icon
├── LICENSE               # MIT (adapter code)
└── THIRD_PARTY_NOTICES.md
```

## License

The plugin adapter code in this directory is licensed under the
[MIT License](LICENSE) — a genuine OSI-approved open source license. You may use,
modify, and redistribute it, including commercially.

The bundled resources it loads at runtime (the shared local Agent from
`services/local-agent/` and the SPARK SIGHT web application from `apps/web/`)
are **not** MIT: they are governed by the repository root
[LICENSE](../../LICENSE), the Deep Imaging Noncommercial Attribution License 1.0.
That is a source-available license with a noncommercial restriction and is **not**
an OSI-approved open source license. Commercial use of those components requires
prior written authorization.

The bundled Noto Sans CJK SC font remains under the SIL Open Font License 1.1 and
is not affected by either of the above.

See [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) for upstream attributions and
[docs/licensing.md](../../docs/licensing.md) for the full scope map.
"DeepSeek" is a trademark of DeepSeek and is used only to describe the host
platform. This is an independent third-party plugin and is not provided,
endorsed, certified, or sponsored by DeepSeek.
