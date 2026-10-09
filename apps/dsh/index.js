/**
 * SPARK SIGHT for DeepSeek Harness — Host half.
 *
 * M3: owns the local-agent sidecar lifecycle and exposes two same-origin
 * routes for the Client half:
 *   - GET  /api/sparksight/stage -> sidecar webUrl (boots the iframe Stage)
 *   - POST /api/sparksight/host  -> handles an embedded HostMessage, giving
 *        the iframe its agent baseUrl/token and local runtime capabilities.
 * The iframe's injected bootstrap bridges window.__DEEP_IMAGING_HOST__ over
 * postMessage to the parent, which relays each call to the POST route here.
 *
 * Zero runtime dependencies beyond Node built-ins and the host's Connection
 * fetch registry (standard Web Request/Response — no Typert/decorators/build).
 */

import { join, dirname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { SidecarManager } from './lib/sidecar.js'
import { checkUpdate, downloadUpdate, ARTIFACT_NAME } from './lib/updater.js'

export const VERSION = '0.4.0'
const PACKAGE_DIR = dirname(fileURLToPath(import.meta.url))

export const inject = ['connection']

function codedHostError(code, message) {
  return Object.assign(new Error(message), { code })
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
async function handleHostMessage(message, sidecar, agentDir) {
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
  const agentDir = sidecar.resolveAgentDir()

  if (config.autoStart !== false) {
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

  // GET stage: discovery route for the iframe Stage webUrl (never the token).
  ctx.effect(
    () =>
      ctx.connection.fetch.register({
        path: '/api/sparksight/stage',
        methods: ['GET'],
        requestBody: 'buffered',
        fetch: async () => {
          const webUrl = sidecar.endpoint?.webUrl
          if (!webUrl) return new Response(JSON.stringify({ ready: false }), { status: 503, headers: jsonHeaders })
          return new Response(JSON.stringify({ ready: true, webUrl }), { status: 200, headers: jsonHeaders })
        },
      }),
    'sparksight-dsh: stage route'
  )

  // POST host: relay endpoint for the iframe's embedded HostBridge.
  ctx.effect(
    () =>
      ctx.connection.fetch.register({
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
            const result = await handleHostMessage(message, sidecar, agentDir)
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
      }),
    'sparksight-dsh: host relay route'
  )

  // Stop the sidecar when the plugin or the Harness host is torn down.
  ctx.effect(
    () => () => {
      sidecar.stop().catch(() => { /* already gone */ })
    },
    'sparksight-dsh: sidecar'
  )
}
