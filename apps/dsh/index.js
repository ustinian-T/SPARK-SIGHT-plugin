/**
 * SPARK SIGHT for DeepSeek Harness — Host half.
 *
 * Integrates SPARK SIGHT into DSH instead of merely embedding a web page:
 *   - a persistent local login (token stays in the Host, never the browser);
 *   - same-origin routes for login, task upload, JSON relay and ZIP export;
 *   - model-callable `sparksight_*` tools plus prompt guidance, so DSH's own
 *     model turn and polling drive the plotting backend;
 *   - the optional same-origin Stage iframe (full workbench) for deep editing.
 *
 * Zero runtime dependencies beyond Node built-ins and the host's Connection
 * fetch registry (standard Web Request/Response — no Typert/decorators/build).
 */

import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SidecarManager } from './lib/sidecar.js'
import { AgentClient } from './lib/agent-client.js'
import { PluginAuth, readOrCreateAuthSecret } from './lib/auth.js'
import { createSparksightTools, registerSparksightPrompt } from './lib/tools.js'
import { resolvePersistentDataDir } from './lib/paths.js'
import { checkUpdate, downloadUpdate, ARTIFACT_NAME } from './lib/updater.js'

export const VERSION = '0.5.1'
const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url))
const MAX_UPLOAD_BYTES = 64 * 1024 * 1024

export const inject = ['connection', 'tools', 'systemPrompt']

function codedHostError(code, message) {
  return Object.assign(new Error(message), { code })
}

function jsonResponse(payload, status = 200) {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  })
}

function httpStatusFor(error) {
  if (error?.status && Number.isInteger(error.status)) return error.status
  switch (error?.code) {
    case 'AUTH_REQUIRED':
    case 'AUTH_FAILED':
    case 'SESSION_EXPIRED':
      return 401
    case 'AUTH_PENDING':
      return 409
    case 'PROXY_PATH_DENIED':
    case 'DATA_TYPE_UNSUPPORTED':
      return 400
    case 'TASK_NOT_FOUND':
    case 'PLAN_NOT_FOUND':
    case 'ARTIFACT_NOT_FOUND':
      return 404
    case 'AGENT_UNAVAILABLE':
      return 503
    default:
      return 400
  }
}

function errorResponse(error) {
  return jsonResponse({
    ok: false,
    error: { code: error?.code ?? 'SPARKSIGHT_REQUEST_FAILED', message: error?.message ?? '请求失败' },
  }, httpStatusFor(error))
}

async function readJson(request) {
  try {
    return await request.json()
  } catch {
    throw codedHostError('INVALID_JSON', '请求体不是有效 JSON')
  }
}

// Lazily import the sidecar's engine probe (same-repo, zero-dep), then cache.
let enginesModule = null
let cachedRuntimes = null
async function loadEngines(agentDir) {
  if (!enginesModule) {
    const href = pathToFileURL(join(agentDir, 'src', 'engines.js')).href
    enginesModule = await import(href)
  }
  return enginesModule
}

/** Map one probeEngines() record into the public RuntimeCapability shape. */
function toRuntimeCapability(probe, language) {
  const packages = {}
  if (probe && probe.dependencies) {
    for (const [name, value] of Object.entries(probe.dependencies)) packages[name] = value || false
  }
  return {
    id: `${language}-system`,
    language,
    source: 'system',
    executable: '', // 公开响应绝不暴露本机绝对路径
    version: probe?.version ?? null,
    packages,
    canRun: probe?.available === true,
    canInstall: false,
    sandboxLevel: 'generated-only',
    reason: probe?.note,
  }
}

async function discoverRuntimes(agentDir) {
  if (cachedRuntimes) return cachedRuntimes
  const engines = await loadEngines(agentDir)
  const probes = engines.probeEngines()
  cachedRuntimes = [
    toRuntimeCapability(probes.python, 'python'),
    toRuntimeCapability(probes.r, 'r'),
    toRuntimeCapability(probes.matlab, 'matlab'),
  ]
  return cachedRuntimes
}

/** Handle one embedded HostMessage; returns the result or throws a coded error. */
async function handleHostMessage(message, sidecar, agentDir, auth) {
  switch (message?.type) {
    case 'agent.config': {
      const endpoint = sidecar.endpoint
      if (!endpoint) throw codedHostError('AGENT_UNAVAILABLE', '本机 Agent 尚未就绪，请稍后重试')
      return { baseUrl: endpoint.baseUrl, token: endpoint.token, engine: 'python' }
    }
    case 'runtime.capabilities': {
      const runtimes = await discoverRuntimes(agentDir)
      return {
        host: 'browser', // DSH 非编辑器/Tauri 宿主；实际能力以下方布尔为准
        openDiff: false,
        readSelection: false,
        applyPatch: false,
        runMatlab: true,
        runtimeProtocol: 2,
        runtimes,
      }
    }
    case 'runtime.discover':
      return await discoverRuntimes(agentDir)
    case 'selection.read':
      return null
    case 'runtime.plan':
    case 'runtime.run':
    case 'runtime.events':
    case 'runtime.cancel':
    case 'runtime.openArtifact':
      throw codedHostError('RUNTIME_UNSUPPORTED', 'DSH 宿主暂不支持直接运行脚本；请在工作台通过新建任务完成绘图')
    case 'runtime.runMatlab':
      throw codedHostError('MATLAB_UNSUPPORTED', '请在工作台任务流程中使用 MATLAB（由本机 Agent 编排执行）')
    case 'diff.open':
    case 'patch.apply':
    case 'patch.applyHunks':
    case 'plans.compare':
    case 'text.insert':
    case 'diagnostic.reveal':
    case 'edit.undo':
    case 'handoff.write':
      throw codedHostError('HOST_UNSUPPORTED', '该能力依赖编辑器宿主，DSH 插件不提供')
    default:
      throw codedHostError('HOST_REQUEST_FAILED', `未知 host 消息类型: ${message?.type}`)
  }
}

export function apply(ctx, config = {}) {
  const log = (...args) => console.log('[sparksight-dsh]', ...args)
  const sidecar = new SidecarManager({ config, log })
  let agentDir
  try {
    agentDir = sidecar.resolveAgentDir()
  } catch (error) {
    log(`local-agent unavailable: ${error.message}`)
    agentDir = null
  }

  let dataDir = null
  let authSecret = null
  if (agentDir) {
    try {
      dataDir = resolvePersistentDataDir(config, { agentDir })
      authSecret = readOrCreateAuthSecret(dataDir)
      sidecar.config = { ...config, dataDir, authSecret }
    } catch (error) {
      log(`persistent data unavailable: ${error.message}`)
    }
  }

  const client = new AgentClient({ sidecar, log })
  const auth = new PluginAuth({ client, dataDir, log })

  if (config.autoStart !== false && agentDir) {
    sidecar
      .start()
      .then((endpoint) =>
        log(
          `sidecar ready ${endpoint.baseUrl} (protocol v${endpoint.health.protocol})` +
          (endpoint.webUrl ? '; web Stage hosted same-origin' : '')
        )
      )
      .catch((error) => log(`sidecar failed: ${error.message}`))
  }

  const jsonHeaders = {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
  }

  // ---- model-facing integration -----------------------------------------

  if (agentDir) {
    ctx.effect(() => createSparksightTools({ ctx, client, auth, log }), 'sparksight-dsh: model tools')
    ctx.effect(() => registerSparksightPrompt(ctx), 'sparksight-dsh: plotting prompt')
  }

  // ---- lifecycle ---------------------------------------------------------

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/sparksight/updates', methods: ['GET'], requestBody: 'buffered',
    fetch: async () => {
      try { return new Response(JSON.stringify({ currentVersion: VERSION, release: await checkUpdate(VERSION), verification: 'trusted-https-sha256', signedArtifacts: false }), { headers: jsonHeaders }) }
      catch (error) { return new Response(JSON.stringify({ error: error.message }), { status: 502, headers: jsonHeaders }) }
    },
  }), 'sparksight-dsh: check updates')
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/sparksight/update-package', methods: ['GET'], requestBody: 'buffered',
    fetch: async () => {
      try {
        const { bytes } = await downloadUpdate(VERSION)
        return new Response(new Uint8Array(bytes), { headers: { ...jsonHeaders, 'content-type': 'application/gzip', 'content-disposition': `attachment; filename="${ARTIFACT_NAME}"` } })
      } catch (error) { return new Response(JSON.stringify({ error: error.message }), { status: 502, headers: jsonHeaders }) }
    },
  }), 'sparksight-dsh: verified upgrade download')

  // ---- bootstrap / auth --------------------------------------------------

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/sparksight/bootstrap',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      let ready = Boolean(sidecar.endpoint)
      if (!ready && agentDir && config.autoStart !== false) {
        try { await sidecar.start(); ready = true } catch { /* offline */ }
      }
      const status = await auth.status({ validate: ready })
      return jsonResponse({
        ok: true,
        version: VERSION,
        name: 'SPARK SIGHT',
        ready,
        webStage: Boolean(sidecar.endpoint?.webUrl),
        loginRequired: true,
        ...status,
        engines: ['python', 'r', 'matlab'],
        features: {
          tools: agentDir !== null,
          view: true,
          toggle: true,
          export: true,
        },
      })
    },
  }), 'sparksight-dsh: bootstrap')

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/sparksight/auth/status',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      try { return jsonResponse({ ok: true, ...(await auth.status()) }) } catch (error) { return errorResponse(error) }
    },
  }), 'sparksight-dsh: auth status')

  for (const [route, handler] of [
    ['login', (body) => auth.login(body)],
    ['register', (body) => auth.register(body)],
    ['anonymous', () => auth.anonymous()],
    ['local-admin', () => auth.localAdmin()],
  ]) {
    ctx.effect(() => ctx.connection.fetch.register({
      path: `/api/sparksight/auth/${route}`,
      methods: ['POST'],
      requestBody: 'buffered',
      fetch: async (request) => {
        try {
          const body = route === 'anonymous' || route === 'local-admin' ? {} : await readJson(request)
          const user = await handler(body)
          return jsonResponse({ ok: true, ...user })
        } catch (error) {
          return errorResponse(error)
        }
      },
    }), `sparksight-dsh: auth ${route}`)
  }

  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/sparksight/auth/logout',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async () => {
      try { return jsonResponse({ ok: true, ...(await auth.logout()) }) } catch (error) { return errorResponse(error) }
    },
  }), 'sparksight-dsh: auth logout')

  // ---- sidecar relay -----------------------------------------------------

  // JSON relay: the browser never sees the local-agent token or its port.
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/sparksight/api',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const body = await readJson(request)
        const token = auth.ensure()
        const result = await client.proxy({
          method: body.method ?? 'GET',
          path: body.path,
          body: body.body,
          token,
          signal: request.signal,
        })
        return jsonResponse({ ok: true, result })
      } catch (error) {
        return errorResponse(error)
      }
    },
  }), 'sparksight-dsh: api relay')

  // Multipart upload relay: create a plotting task from the native Plot view.
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/sparksight/tasks',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const token = auth.ensure()
        const form = await request.formData()
        const file = form.get('file')
        if (!file || typeof file === 'string') throw codedHostError('MISSING_FILE', '请选择 CSV 数据文件')
        if (file.size > MAX_UPLOAD_BYTES) throw codedHostError('DATA_TOO_LARGE', '数据文件超过 64MB 上限')
        const bytes = new Uint8Array(await file.arrayBuffer())
        const created = await client.createTask({
          bytes,
          fileName: file.name || 'upload.csv',
          prompt: String(form.get('prompt') ?? ''),
          engine: String(form.get('engine') ?? 'python'),
          clarify: String(form.get('clarify') ?? 'true') !== 'false',
          clarifyAnswers: parseJsonField(form.get('clarifyAnswers')),
          projectId: form.get('projectId') ? String(form.get('projectId')) : undefined,
          fields: collectTaskFields(form),
          token,
          signal: request.signal,
        })
        const snapshot = await client.task(created.taskId, token, { signal: request.signal }).catch(() => null)
        return jsonResponse({ ok: true, taskId: created.taskId, state: created.state ?? snapshot?.state, snapshot })
      } catch (error) {
        return errorResponse(error)
      }
    },
  }), 'sparksight-dsh: task upload relay')

  // ZIP export download relay.
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/sparksight/export',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async (request) => {
      try {
        const url = new URL(request.url)
        const taskId = String(url.searchParams.get('taskId') ?? '')
        if (!/^[A-Za-z0-9_-]{1,128}$/.test(taskId)) throw codedHostError('TASK_ID_REQUIRED', '缺少有效 taskId')
        const token = auth.ensure()
        url.searchParams.delete('taskId')
        const query = url.searchParams.toString()
        const result = await client.proxyDownload({
          path: `/api/tasks/${taskId}/export${query ? `?${query}` : ''}`,
          token,
          signal: request.signal,
        })
        const disposition = result.disposition || `attachment; filename="${taskId}.zip"`
        return new Response(result.bytes, {
          status: 200,
          headers: {
            'content-type': result.contentType || 'application/zip',
            'content-disposition': disposition,
            'cache-control': 'no-store',
          },
        })
      } catch (error) {
        return errorResponse(error)
      }
    },
  }), 'sparksight-dsh: export download')

  // GET stage: discovery route for the iframe Stage webUrl (never the token).
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/sparksight/stage',
    methods: ['GET'],
    requestBody: 'buffered',
    fetch: async () => {
      const endpoint = sidecar.endpoint ?? await sidecar.start().catch(() => null)
      const webUrl = endpoint?.webUrl
      if (!webUrl) return new Response(JSON.stringify({ ready: false }), { status: 503, headers: jsonHeaders })
      return new Response(JSON.stringify({ ready: true, webUrl, authenticated: Boolean(auth.token) }), { status: 200, headers: jsonHeaders })
    },
  }), 'sparksight-dsh: stage route')

  // POST host: relay endpoint for the iframe's embedded HostBridge.
  ctx.effect(() => ctx.connection.fetch.register({
    path: '/api/sparksight/host',
    methods: ['POST'],
    requestBody: 'buffered',
    fetch: async (request) => {
      let message
      try {
        message = await request.json()
      } catch {
        return new Response(
          JSON.stringify({ version: 2, id: '', ok: false, error: { code: 'HOST_MESSAGE_INVALID', message: 'invalid JSON body' } }),
          { status: 400, headers: jsonHeaders }
        )
      }
      const id = typeof message?.id === 'string' ? message.id : ''
      try {
        const result = await handleHostMessage(message, sidecar, agentDir, auth)
        return new Response(JSON.stringify({ version: 2, id, ok: true, result }), { status: 200, headers: jsonHeaders })
      } catch (error) {
        const body = {
          version: 2,
          id,
          ok: false,
          error: { code: error?.code ?? 'HOST_REQUEST_FAILED', message: error?.message ?? 'host request failed' },
        }
        return new Response(JSON.stringify(body), { status: 200, headers: jsonHeaders })
      }
    },
  }), 'sparksight-dsh: host relay route')

  // Stop the sidecar when the plugin or the Harness host is torn down.
  ctx.effect(() => () => {
    sidecar.stop().catch(() => { /* already gone */ })
  }, 'sparksight-dsh: sidecar')
}

function parseJsonField(value) {
  if (typeof value !== 'string' || !value.trim()) return undefined
  try { return JSON.parse(value) } catch { return undefined }
}

function collectTaskFields(form) {
  const fields = {}
  for (const name of ['dataNature', 'dataDisclosure']) {
    const value = form.get(name)
    if (typeof value === 'string' && value) fields[name] = value
  }
  return fields
}
