// Cloud identities/explicit plotting traits only. Task, CSV, chat and model keys
// are intentionally absent from this allowlisted account-service transport.
import { createHash, randomBytes } from 'node:crypto'
import { ModelSecretStore } from './modelSecrets.js'
import { ApiError, ERR } from './errors.js'
import { normalizeUserProfile, USER_PROFILE_FIELDS } from './userProfile.js'

const digest = value => createHash('sha256').update(value).digest('hex')
function publicUser(value) {
  if (!value || !/^[A-Za-z0-9_-]{1,128}$/.test(value.userId ?? '') || value.status && value.status !== 'active' || value.disabled) {
    throw new ApiError(401, ERR.AUTH_FAILED, '云端账号无效或未启用')
  }
  return {
    userId: value.userId, username: String(value.username ?? ''), displayName: String(value.displayName ?? value.username ?? ''),
    role: value.role === 'admin' ? 'admin' : 'user', kind: 'account', status: 'active',
    expiresAt: Math.min(Number(value.expiresAt) || Date.now() + 7 * 86400000, Date.now() + 7 * 86400000)
  }
}

export class CloudAccountClient {
  constructor({ baseUrl, root = null, fetchImpl = fetch }) {
    const url = new URL(baseUrl)
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('云端账号服务必须是 HTTPS origin')
    }
    this.origin = url.origin
    this.fetch = fetchImpl
    this.vault = new ModelSecretStore(root, { prefix: 'cloud-account-sessions' })
  }
  async request(endpoint, { method = 'GET', body, bearer } = {}) {
    if (!['/api/auth/login', '/api/auth/me', '/api/auth/logout', '/api/user-profile'].includes(endpoint)) throw new Error('Account route is not allowlisted')
    let response
    try {
      response = await this.fetch(this.origin + endpoint, {
        method, redirect: 'error', signal: AbortSignal.timeout(15000),
        headers: { 'x-agent-protocol': '1', ...(body ? { 'content-type': 'application/json' } : {}), ...(bearer ? { authorization: 'Bearer ' + bearer } : {}) },
        body: body ? JSON.stringify(body) : undefined
      })
    } catch { throw new ApiError(503, 'CLOUD_ACCOUNT_UNAVAILABLE', '云端账号服务暂不可达，请检查网络后重试；已有本地任务不会上传') }
    const text = await response.text()
    if (text.length > 512000) throw new ApiError(502, 'CLOUD_ACCOUNT_INVALID', '云端账号响应无效')
    let result
    try { result = JSON.parse(text) } catch { throw new ApiError(502, 'CLOUD_ACCOUNT_INVALID', '云端账号响应无效') }
    if (!response.ok) throw new ApiError(response.status, result.error?.code ?? ERR.AUTH_FAILED, result.error?.message ?? '云端账号请求失败')
    return result
  }
  async login(input) {
    const result = await this.request('/api/auth/login', { method: 'POST', body: {
      username: String(input.username ?? '').trim(), password: String(input.password ?? ''), ...(input.expectedRole === 'admin' ? { expectedRole: 'admin' } : {})
    } })
    const user = publicUser(result.user)
    if (typeof result.token !== 'string' || !result.token) throw new ApiError(502, 'CLOUD_ACCOUNT_INVALID', '云端未返回有效会话')
    const localToken = randomBytes(32).toString('base64url')
    const session = { origin: this.origin, user, cloudToken: result.token, localToken, createdAt: Date.now() }
    this.vault.setUser(digest(localToken), session)
    return { token: localToken, user, authMode: 'cloud', cloudAccountOrigin: this.origin }
  }
  session(token) {
    if (typeof token !== 'string' || !token) return null
    const session = this.vault.getUser(digest(token))
    return session?.origin === this.origin && session.user?.expiresAt > Date.now() ? session : null
  }
  verify(token) {
    const session = this.session(token)
    return session ? { ...session.user, cloudSessionKey: digest(token) } : null
  }
  resume() {
    const session = Object.values(this.vault.state.users).filter(item => item.origin === this.origin && item.user?.expiresAt > Date.now()).sort((a, b) => b.createdAt - a.createdAt)[0]
    return session ? { user: session.user, token: session.localToken, authMode: 'cloud', cloudAccountOrigin: this.origin } : null
  }
  async me(token) {
    const session = this.session(token)
    if (!session) throw new ApiError(401, ERR.UNAUTHORIZED, '本地云账号会话已失效')
    try {
      const result = await this.request('/api/auth/me', { bearer: session.cloudToken })
      const user = publicUser(result.user)
      if (user.userId !== session.user.userId) throw new ApiError(401, ERR.AUTH_FAILED, '账号身份不一致，请重新登录')
      session.user = user; this.vault.setUser(digest(token), session)
      return { user }
    } catch (error) {
      if ([401, 403].includes(error.status)) this.vault.deleteUser(digest(token))
      if (error.status === 503) return { user: session.user, offline: true }
      throw error
    }
  }
  async logout(token) {
    const session = this.session(token)
    this.vault.deleteUser(digest(token))
    if (session) { try { await this.request('/api/auth/logout', { method: 'POST', bearer: session.cloudToken }) } catch { /* Local logout must work offline. */ } }
    return { ok: true }
  }
  async profileForIdentity(identity, { method = 'GET', body } = {}) {
    const session = identity.cloudSessionKey ? this.vault.getUser(identity.cloudSessionKey) : Object.values(this.vault.state.users).filter(item => item.origin === this.origin && item.user?.userId === identity.userId && item.user.expiresAt > Date.now()).sort((a, b) => b.createdAt - a.createdAt)[0]
    if (!session || session.user.expiresAt <= Date.now()) throw new ApiError(401, ERR.UNAUTHORIZED, '请重新登录云账号')
    try {
      if (method === 'PUT') {
        const profile = normalizeUserProfile(body?.profile)
        for (const key of Object.keys(USER_PROFILE_FIELDS)) if (body?.profile?.[key] === null || body?.profile?.[key] === '') profile[key] = null
        body = { profile, ...(Number.isSafeInteger(body?.expectedRevision) && body.expectedRevision >= 0 ? { expectedRevision: body.expectedRevision } : {}) }
      }
      const result = await this.request('/api/user-profile', { method, body, bearer: session.cloudToken })
      session.profileCache = result
      this.vault.setUser(digest(session.localToken), session)
      return result
    } catch (error) {
      if ([401, 403].includes(error.status)) this.vault.deleteUser(digest(session.localToken))
      if (method === 'GET' && error.status === 503 && session.profileCache) return { ...session.profileCache, offline: true }
      throw error
    }
  }
}
