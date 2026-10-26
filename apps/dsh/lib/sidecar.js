/**
 * SPARK SIGHT for DeepSeek Harness — local-agent sidecar manager.
 *
 * Owns the lifecycle of the bundled `@deep-imaging/local-agent` HTTP/WS
 * service: spawn it under the host's Node runtime, read the bound port and
 * boot token from its stdout, confirm readiness through `/health`, and kill
 * the whole process tree on shutdown.
 *
 * Zero runtime dependencies beyond Node built-ins. Works in both host
 * environments:
 *   - plain Node (`dsh web`)        -> process.execPath is node.
 *   - Electron desktop host         -> process.execPath is the Electron binary,
 *                                      which runs as Node with ELECTRON_RUN_AS_NODE=1.
 */

import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { dirname, join, delimiter } from 'node:path'
import { fileURLToPath } from 'node:url'
import http from 'node:http'
import { resolvePersistentDataDir } from './paths.js'

const HERE = dirname(fileURLToPath(import.meta.url))        // apps/dsh/lib
const PACKAGE_DIR = dirname(HERE)                           // apps/dsh
const REPO_ROOT = dirname(dirname(PACKAGE_DIR))             // deep_imaging

const START_TIMEOUT_MS = 20_000
const STOP_TIMEOUT_MS = 8_000

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** GET /health (no token required). Resolves with the parsed health body. */
function fetchHealth(port, timeoutMs = 2500) {
  return new Promise((resolve, reject) => {
    const req = http.get(
      { host: '127.0.0.1', port, path: '/health', timeout: timeoutMs },
      (res) => {
        let body = ''
        res.on('data', (chunk) => { body += chunk })
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`health HTTP ${res.statusCode}`))
            return
          }
          try { resolve(JSON.parse(body)) } catch (error) { reject(error) }
        })
      }
    )
    req.on('timeout', () => req.destroy(new Error('health timeout')))
    req.on('error', reject)
  })
}

export class SidecarManager {
  #child = null
  #startPromise = null
  /** Resolved once ready: { baseUrl, token, health }. */
  endpoint = null

  constructor({ config = {}, log = () => {} } = {}) {
    this.config = config
    this.log = log
  }

  /**
   * Locate the local-agent directory.
   * Order: explicit config.agentDir > bundled resources/agent > monorepo dev path.
   */
  resolveAgentDir() {
    const candidates = [
      this.config.agentDir,
      join(PACKAGE_DIR, 'resources', 'agent'),
      join(REPO_ROOT, 'services', 'local-agent'),
    ].filter(Boolean)
    for (const dir of candidates) {
      if (existsSync(join(dir, 'src', 'server.js'))) return dir
    }
    throw new Error(`local-agent not found; tried: ${candidates.join('  ;  ')}`)
  }

  /**
   * Locate the SPARK SIGHT web build that provides the Stage UI (optional).
   * Order: explicit config.webDir > bundled resources/web/dist > monorepo apps/web/dist.
   * Returns null (never throws) so the sidecar still runs without the web build.
   */
  resolveWebDistDir() {
    const candidates = [
      this.config.webDir,
      join(PACKAGE_DIR, 'resources', 'web', 'dist'),
      join(REPO_ROOT, 'apps', 'web', 'dist'),
    ].filter(Boolean)
    for (const dir of candidates) {
      if (existsSync(join(dir, 'index.html'))) return dir
    }
    return null
  }

  /** Build the Node invocation; under Electron, run the host binary as plain Node. */
  #buildInvocation(agentDir, webDistDir) {
    const serverEntry = join(agentDir, 'src', 'server.js')
    const env = { ...process.env }
    const bundledPython = join(PACKAGE_DIR, 'resources', 'runtime', 'python')
    if (process.platform === 'win32' && existsSync(join(bundledPython, 'python.exe'))) env.PATH = [bundledPython, env.PATH ?? ''].join(delimiter)
    const isElectron = Boolean(process.versions.electron)
    if (isElectron) env.ELECTRON_RUN_AS_NODE = '1'
    // M3：以本地单机模式运行 sidecar——禁用云同步/远程分享、关闭测试模式、
    // 打开文件态持久化；保留 MATLAB 等本机引擎发现结果（与 vscode 扩展一致）。
    env.LOCAL_ONLY_MODE = '1'
    env.LOCAL_AGENT_HOST = '127.0.0.1'
    env.LOCAL_AGENT_PORT = String(this.config.port || 0)
    delete env.LOCAL_AGENT_TOKEN
    env.LOCAL_AGENT_WEB_ONLY = '0'
    env.REMOTE_MODE = '0'
    env.TEST_WEB_MODE = '0'
    env.LOCAL_AGENT_PERSIST = '1'
    env.LOCAL_AGENT_CLOUD_URL = ''
    env.LOCAL_AGENT_CLOUD_TOKEN = ''
    // Fully local by default: accounts, sessions and plotting data stay on this
    // machine. Set config.cloudAccountUrl explicitly to opt into a cloud account.
    env.LOCAL_AGENT_CLOUD_ACCOUNT_URL = String(this.config.cloudAccountUrl || process.env.DEEP_IMAGING_ACCOUNT_URL || '')
    // A stable signing secret keeps the plugin's saved login valid across
    // sidecar/DSH restarts. It lives in the persistent data directory (0600).
    if (this.config.authSecret) env.LOCAL_AGENT_AUTH_SECRET = String(this.config.authSecret)
    // Port 0 / random token are the agent defaults; only override when configured.
    if (this.config.port) env.LOCAL_AGENT_PORT = String(this.config.port)
    env.LOCAL_AGENT_DATA_DIR = this.config.dataDir
      ? String(this.config.dataDir)
      : resolvePersistentDataDir(this.config, { agentDir, env })
    // Serve the SPARK SIGHT web app same-origin (the Stage UI) when a build is present.
    if (webDistDir) env.LOCAL_AGENT_WEB_DIST_DIR = webDistDir
    // Bootstrap admin credentials for the plugin scenario (optional).
    if (this.config.adminUsername) env.LOCAL_AGENT_ADMIN_USERNAME = String(this.config.adminUsername)
    if (this.config.adminPassword) env.LOCAL_AGENT_ADMIN_PASSWORD = String(this.config.adminPassword)
    return { command: process.execPath, args: [serverEntry], cwd: agentDir, env, isElectron }
  }

  /** Parse one local-agent stdout line into the boot accumulator. */
  static #parseBootLine(line, boot) {
    if (!line) return
    if (line.includes('local agent started')) boot.started = true
    let match = /\[local-agent\]\s+HTTP\s+https?:\/\/([^:/\s]+):(\d+)\/health/.exec(line)
    if (match) {
      boot.host = match[1]
      boot.port = Number(match[2])
    }
    match = /\[local-agent\]\s+TOKEN\s+(\S+)/.exec(line)
    if (match) boot.token = match[1]
  }

  /** Wait for the boot lines, then poll /health until it answers. */
  async #waitReady(boot, timeoutMs, webDistDir) {
    const deadline = Date.now() + timeoutMs
    while ((!boot.port || !boot.token) && Date.now() < deadline) {
      if (!this.#child) throw new Error('local-agent process disappeared before boot')
      await sleep(100)
    }
    if (!boot.port || !boot.token) {
      throw new Error('timed out waiting for local-agent port/token on stdout')
    }
    while (Date.now() < deadline) {
      try {
        const health = await fetchHealth(boot.port)
        if (health.status === 'ok') {
          this.endpoint = {
            baseUrl: `http://${boot.host}:${boot.port}`,
            token: boot.token,
            health,
            ...(webDistDir ? { webUrl: `http://${boot.host}:${boot.port}` } : null),
          }
          return
        }
      } catch {
        // not listening yet; retry
      }
      await sleep(200)
    }
    throw new Error(`timed out waiting for local-agent /health on port ${boot.port}`)
  }

  /** Start the sidecar once; repeated calls share the same promise. */
  start() {
    if (this.#startPromise) return this.#startPromise
    const pending = this.#start()
    this.#startPromise = pending
    // Allow a later request to retry after a failed boot instead of pinning
    // every login/tool call to the first rejection.
    pending.catch(() => {
      if (this.#startPromise === pending) this.#startPromise = null
    })
    return pending
  }

  async #start() {
    const agentDir = this.resolveAgentDir()
    const webDistDir = this.resolveWebDistDir()
    if (webDistDir) this.log(`web Stage build at ${webDistDir}`)
    const invocation = this.#buildInvocation(agentDir, webDistDir)
    const boot = { started: false, host: null, port: null, token: null }
    let stderrTail = ''

    await new Promise((resolve, reject) => {
      let child
      try {
        child = spawn(invocation.command, invocation.args, {
          cwd: invocation.cwd,
          env: invocation.env,
          windowsHide: true,
          stdio: ['ignore', 'pipe', 'pipe'],
        })
      } catch (error) {
        reject(error)
        return
      }
      this.#child = child
      this.log(`spawning local-agent (electron=${invocation.isElectron})`)

      child.stdout.setEncoding('utf8')
      child.stdout.on('data', (chunk) => {
        for (const line of chunk.split(/\r?\n/)) SidecarManager.#parseBootLine(line, boot)
      })
      child.stderr.setEncoding('utf8')
      child.stderr.on('data', (chunk) => {
        stderrTail = (stderrTail + chunk).slice(-4000)
      })
      child.once('error', reject)
      child.once('exit', (code) => {
        if (!this.endpoint) {
          this.#child = null
          reject(new Error(`local-agent exited early (code ${code}): ${stderrTail.trim()}`))
        }
      })

      this.#waitReady(boot, START_TIMEOUT_MS, webDistDir).then(resolve, reject)
    })

    this.log(`sidecar ready at ${this.endpoint.baseUrl}`)
    return this.endpoint
  }

  /** Kill the process tree and wait for exit (best effort, bounded). */
  async stop() {
    const child = this.#child
    this.#startPromise = null
    this.endpoint = null
    if (!child) return

    await new Promise((resolve) => {
      let settled = false
      const finish = () => {
        if (!settled) {
          settled = true
          clearTimeout(timer)
          resolve()
        }
      }
      const timer = setTimeout(finish, STOP_TIMEOUT_MS)
      child.once('exit', finish)

      if (process.platform === 'win32') {
        // /T kills the whole tree; /F forces (Windows has no real SIGTERM).
        const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
          windowsHide: true,
          stdio: 'ignore',
        })
        killer.once('error', () => { try { child.kill() } catch { /* noop */ } })
      } else {
        try {
          process.kill(-child.pid, 'SIGTERM') // negative pid = process group
        } catch {
          try { child.kill('SIGTERM') } catch { /* noop */ }
        }
      }
    })

    this.#child = null
    this.log('sidecar stopped')
  }
}
