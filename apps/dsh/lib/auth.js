/**
 * SPARK SIGHT for DeepSeek Harness — persistent local login.
 *
 * The desktop/web client never receives the local-agent identity token.
 * A successful login stores the signed token in the plugin data directory
 * (0600); every later browser request and model tool call reuses it.
 *
 * The sidecar is started with a stable LOCAL_AGENT_AUTH_SECRET stored next to
 * the token, so sessions survive DSH/sidecar restarts. Secrets never enter
 * the plugin package or a browser response.
 */

import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { AGENT_ERROR_CODES, codedError } from './agent-client.js'

const AUTH_FILE = 'dsh-auth.json'
const SECRET_FILE = 'dsh-auth-secret'

function safeMkdir(dir) {
  try {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 })
    return true
  } catch {
    return false
  }
}

export function readOrCreateAuthSecret(dataDir) {
  if (!dataDir) return randomBytes(32).toString('hex')
  try {
    if (!safeMkdir(dataDir)) return randomBytes(32).toString('hex')
    const target = path.join(dataDir, SECRET_FILE)
    try {
      const existing = fs.readFileSync(target, 'utf8').trim()
      if (existing.length >= 32) return existing
    } catch { /* create below */ }
    const secret = randomBytes(32).toString('hex')
    const temp = `${target}.${process.pid}.tmp`
    fs.writeFileSync(temp, secret, { mode: 0o600 })
    fs.renameSync(temp, target)
    return secret
  } catch {
    return randomBytes(32).toString('hex')
  }
}

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

function publicState(user) {
  if (!user) return { authenticated: false, user: null }
  return {
    authenticated: true,
    user: {
      userId: user.userId,
      username: user.username ?? '',
      displayName: user.displayName ?? user.username ?? '本机用户',
      role: user.role ?? 'user',
      kind: user.kind ?? 'account',
      status: user.status ?? 'active',
      expiresAt: user.expiresAt ?? null,
      modelAccess: user.modelAccess ?? null,
      modelSource: user.modelSource ?? null,
    },
  }
}

export class PluginAuth {
  #state = { authenticated: false, user: null, token: null }
  #ready = false

  constructor({ client, dataDir, log = () => {} } = {}) {
    this.client = client
    this.dataDir = dataDir
    this.log = log
    this.file = dataDir ? path.join(dataDir, AUTH_FILE) : null
    this.#load()
  }

  #load() {
    if (!this.file) return
    const stored = readJson(this.file)
    if (!stored?.token || typeof stored.token !== 'string') return
    this.#state = {
      authenticated: true,
      token: stored.token,
      user: stored.user ?? null,
    }
  }

  #persist() {
    if (!this.file || !this.dataDir) return
    try {
      safeMkdir(this.dataDir)
      const temp = `${this.file}.${process.pid}.tmp`
      fs.writeFileSync(temp, JSON.stringify({
        token: this.#state.token,
        user: this.#state.user,
        savedAt: Date.now(),
      }, null, 2), { mode: 0o600 })
      fs.renameSync(temp, this.file)
    } catch (error) {
      this.log(`could not persist login: ${error.message}`)
    }
  }

  #clear() {
    this.#state = { authenticated: false, user: null, token: null }
    if (!this.file) return
    try { fs.rmSync(this.file, { force: true }) } catch { /* already gone */ }
  }

  get token() {
    return this.#state.token
  }

  get user() {
    return this.#state.user
  }

  /** Accept a login response from /api/auth/login, /register or /anonymous. */
  #accept(result, source) {
    if (!result?.token || !result?.user) {
      throw codedError(AGENT_ERROR_CODES.authFailed, '登录响应缺少会话令牌')
    }
    this.#state = {
      authenticated: true,
      token: String(result.token),
      user: result.user,
    }
    this.#persist()
    this.log(`signed in via ${source}`)
    return { ...publicState(result.user), authMode: result.authMode ?? 'local' }
  }

  /**
   * Validate the stored token with the sidecar.
   * Offline keeps the cached user visible but reports ready:false.
   */
  async status({ validate = true } = {}) {
    if (!this.#state.token) {
      this.#ready = true
      return { ...publicState(null), ready: this.#ready, offline: false }
    }
    if (!validate) {
      return { ...publicState(this.#state.user), ready: this.#ready, offline: false }
    }
    try {
      const result = await this.client.me(this.#state.token, { timeoutMs: 8_000 })
      const user = result?.user ?? this.#state.user
      this.#state.user = user
      this.#persist()
      this.#ready = true
      return { ...publicState(user), ready: true, offline: false }
    } catch (error) {
      if ([401, 403].includes(error?.status) || error?.code === AGENT_ERROR_CODES.authRequired) {
        this.#clear()
        this.#ready = true
        return { ...publicState(null), ready: true, offline: false, expired: true }
      }
      this.#ready = false
      return { ...publicState(this.#state.user), ready: false, offline: true, error: error?.message }
    }
  }

  async login({ username, password, expectedRole } = {}) {
    const result = await this.client.login({ username, password, expectedRole }, { timeoutMs: 20_000 })
    return this.#accept(result, 'login')
  }

  async register({ username, password, displayName } = {}) {
    const result = await this.client.register({ username, password, displayName }, { timeoutMs: 20_000 })
    if (!result?.token) {
      if (result?.pendingApproval) throw codedError('AUTH_PENDING', '账号已创建，正在等待管理员审核')
      throw codedError(AGENT_ERROR_CODES.authFailed, '注册成功但未返回会话令牌，请直接登录')
    }
    return this.#accept(result, 'register')
  }

  async anonymous() {
    const result = await this.client.anonymous({ timeoutMs: 15_000 })
    return this.#accept(result, 'anonymous')
  }

  /** One-click access to the local bootstrap administrator. */
  async localAdmin() {
    const credentials = this.readBootstrapCredentials()
    if (!credentials) {
      throw codedError('AUTH_BOOTSTRAP_MISSING', '未找到本机初始管理员凭据，请使用账户密码登录或注册新账户')
    }
    try {
      return await this.login({ username: credentials.username, password: credentials.password, expectedRole: 'admin' })
    } catch (error) {
      if (error?.code === 'AUTH_FAILED' || error?.status === 401) {
        throw codedError('AUTH_BOOTSTRAP_STALE', '本机初始管理员密码已修改，请手动输入账户密码')
      }
      throw error
    }
  }

  readBootstrapCredentials() {
    if (!this.dataDir) return null
    const candidates = [
      path.join(this.dataDir, 'admin-bootstrap.local'),
      path.join(this.dataDir, '.data', 'admin-bootstrap.local'),
    ]
    for (const file of candidates) {
      const value = readJson(file)
      if (value?.username && value?.password) return { username: String(value.username), password: String(value.password) }
    }
    return null
  }

  async logout() {
    const token = this.#state.token
    this.#clear()
    if (token) {
      try { await this.client.logout(token, { timeoutMs: 8_000 }) } catch { /* local logout must succeed offline */ }
    }
    return { authenticated: false, user: null, ready: true }
  }

  /** Throw AUTH_REQUIRED when a model tool is called before login. */
  ensure() {
    if (!this.#state.token) {
      throw codedError(AGENT_ERROR_CODES.authRequired, 'SPARK SIGHT 尚未登录：请点击模型选择器旁的“绘图”开关完成登录后重试')
    }
    return this.#state.token
  }
}
