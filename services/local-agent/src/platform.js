// Identity, project persistence, cloud synchronization and read-only sharing.
// All stores are dependency-free and can persist atomically under FileStorage.
import fs from 'node:fs'
import path from 'node:path'
import { createHash, createHmac, pbkdf2Sync, randomBytes, randomUUID, timingSafeEqual } from 'node:crypto'
import { ApiError, ERR } from './errors.js'
import { assertSafeSegment } from './safe.js'

const now = () => Date.now()
const uid = (prefix) => `${prefix}_${Date.now().toString(36)}_${randomUUID().replace(/-/g, '').slice(0, 10)}`
const clone = (value) => structuredClone(value)
const hash = (value) => createHash('sha256').update(String(value)).digest('hex')

function atomicJson(root, name, value) {
  if (!root) return
  fs.mkdirSync(root, { recursive: true })
  const target = path.join(root, name)
  const temp = path.join(root, `.${name}.${process.pid}.tmp`)
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(temp, target)
}

function readJson(root, name, fallback) {
  if (!root) return clone(fallback)
  try { return JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')) } catch { return clone(fallback) }
}

function b64(value) { return Buffer.from(JSON.stringify(value)).toString('base64url') }

// 账户名字符集：1—32 位，仅字母/数字/点/下划线/连字符（天然排除中文），首字符为字母或数字；
// 长度下限（普通注册 6 位）由 validateUsername 的 minimumLength 单独控制。
export const USERNAME_PATTERN = /^[a-z0-9][a-z0-9_.-]{0,31}$/
export function validateUsername(raw, { minimumLength = 6 } = {}) {
  const normalized = String(raw ?? '').trim().toLowerCase()
  if (!normalized) return { ok: false, reason: '请输入账户名' }
  if (/[\u4e00-\u9fff\u3400-\u4dbf]/.test(normalized)) return { ok: false, reason: '账户名不得包含中文' }
  if (normalized.length < minimumLength) return { ok: false, reason: `账户名不得少于 ${minimumLength} 位` }
  if (!USERNAME_PATTERN.test(normalized)) return { ok: false, reason: '账户名仅支持字母、数字、点、下划线或连字符' }
  return { ok: true, normalized }
}

export class IdentityStore {
  constructor({ root = null, secret = randomBytes(32).toString('hex') } = {}) {
    this.root = root
    this.secret = secret
    this.state = readJson(root, 'accounts.json', { users: [] })
    // 旧数据迁移：补齐角色/状态/令牌版本字段（缺省视为已激活的普通用户）
    for (const user of this.state.users) {
      if (user.role === undefined) user.role = 'user'
      if (user.status === undefined) user.status = 'active'
      if (user.tokenVersion === undefined) user.tokenVersion = 1
      if (user.phone === undefined) user.phone = ''
      if (!user.modelAccess) user.modelAccess = { allowOwn: false, allowShared: false }
      if (!user.modelSource) user.modelSource = 'none'
      if (!Array.isArray(user.sessions)) user.sessions = []
    }
  }
  persist() { atomicJson(this.root, 'accounts.json', this.state) }
  sign(payload) {
    const encoded = b64(payload)
    const signature = createHmac('sha256', this.secret).update(encoded).digest('base64url')
    return `${encoded}.${signature}`
  }
  verify(token) {
    if (!token || !token.includes('.')) return null
    const [encoded, signature] = token.split('.', 2)
    const expected = createHmac('sha256', this.secret).update(encoded).digest()
    let supplied
    try { supplied = Buffer.from(signature, 'base64url') } catch { return null }
    if (expected.length !== supplied.length || !timingSafeEqual(expected, supplied)) return null
    let payload
    try { payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) } catch { return null }
    if (!payload?.sub || payload.exp < now()) return null
    if (payload.kind === 'account') {
      const user = this.state.users.find((item) => item.userId === payload.sub)
      if (!user || user.disabled || user.status !== 'active') return null
      if ((user.tokenVersion ?? 1) !== (payload.tv ?? 1)) return null
      if (payload.sid && !user.sessions?.some((session) => session.id === payload.sid && !session.loggedOutAt)) return null
      return { userId: payload.sub, kind: payload.kind, displayName: payload.name, role: user.role, expiresAt: payload.exp, sessionId: payload.sid ?? null }
    }
    return { userId: payload.sub, kind: payload.kind, displayName: payload.name, role: payload.role, expiresAt: payload.exp }
  }
  anonymous() {
    const userId = uid('anon')
    const expiresAt = now() + 24 * 60 * 60 * 1000
    return { user: { userId, kind: 'anonymous', displayName: '匿名用户', expiresAt }, token: this.sign({ sub: userId, kind: 'anonymous', name: '匿名用户', exp: expiresAt }) }
  }
  publicUser(user) {
    const expiresAt = user.expiresAt ?? now() + 7 * 24 * 60 * 60 * 1000
    return {
      userId: user.userId, username: user.username, displayName: user.displayName, phone: user.phone ?? '',
      role: user.role ?? 'user', status: user.status ?? 'active', kind: 'account', expiresAt,
      createdAt: user.createdAt ?? null, approvedAt: user.approvedAt ?? null,
      lastLoginAt: user.lastLoginAt ?? null, lastLogoutAt: user.lastLogoutAt ?? null,
      modelAccess: { allowOwn: user.modelAccess?.allowOwn === true, allowShared: user.modelAccess?.allowShared === true },
      modelSource: user.modelSource ?? 'none'
    }
  }
  isUsernameAvailable(raw) {
    const check = validateUsername(raw)
    if (!check.ok) return { available: false, reason: check.reason }
    if (this.state.users.some((user) => user.username === check.normalized)) return { available: false, reason: '该账户名已被注册' }
    return { available: true }
  }
  #hashPassword(password, salt) {
    return pbkdf2Sync(String(password), salt, 210_000, 32, 'sha256').toString('base64url')
  }
  // bootstrap 用于系统引导的内置管理员（如默认名 admin），豁免 6 位下限但不豁免字符集约束
  register({ username, password, displayName, phone, role = 'user', status = 'active', bootstrap = false, adminProvisioned = false, protected: isProtected = false, agreementAccepted = false, agreementVersion = '', modelAccess = { allowOwn: false, allowShared: false } }) {
    const check = bootstrap ? validateUsername(username, { minimumLength: 1 }) : validateUsername(username)
    if (!check.ok) throw new ApiError(400, ERR.AUTH_INVALID, check.reason)
    const normalized = check.normalized
    if (String(password ?? '').length < 10) throw new ApiError(400, ERR.AUTH_INVALID, '密码至少 10 个字符')
    if (typeof modelAccess?.allowOwn !== 'boolean' || typeof modelAccess?.allowShared !== 'boolean') throw new ApiError(400, ERR.BAD_REQUEST, '模型权限须为布尔值')
    // 协议同意是注册的强制前提（bootstrap 引导管理员除外）：未同意一律拒绝，杜绝绕过前端直接调 API 注册。
    if (!bootstrap && !adminProvisioned && agreementAccepted !== true) {
      throw new ApiError(400, ERR.AUTH_INVALID, '请先阅读并同意《用户协议与隐私政策》')
    }
    if (this.state.users.some((user) => user.username === normalized)) throw new ApiError(409, ERR.AUTH_CONFLICT, '该账户名已被注册')
    const normalizedPhone = String(phone ?? '').trim()
    if (normalizedPhone && !/^1[3-9]\d{9}$/.test(normalizedPhone)) throw new ApiError(400, ERR.AUTH_INVALID, '手机号格式不正确')
    const salt = randomBytes(16).toString('base64url')
    const user = {
      userId: uid('user'), username: normalized, displayName: String(displayName ?? normalized).trim().slice(0, 80) || normalized,
      phone: normalizedPhone, salt, passwordHash: this.#hashPassword(password, salt),
      role, status, tokenVersion: 1, createdAt: now(), approvedAt: status === 'active' ? now() : null, disabled: false,
      // 受保护的内置管理员（bootstrap）不可删除、不可禁用、不可降级。
      protected: isProtected === true,
      // 留存同意证据：协议版本与同意时间，用于合规审计（不冗余保存协议正文）。
      agreementVersion: adminProvisioned || bootstrap ? '' : String(agreementVersion ?? '').slice(0, 24), agreedAt: adminProvisioned || bootstrap ? null : now(),
      modelAccess: role === 'admin' ? { allowOwn: false, allowShared: false } : { allowOwn: modelAccess.allowOwn, allowShared: modelAccess.allowShared }, modelSource: 'none', sessions: [], lastLoginAt: null, lastLogoutAt: null
    }
    this.state.users.push(user)
    this.persist()
    return { user: this.publicUser(user), token: status === 'active' ? this.issue(user).token : null }
  }
  login({ username, password, expectedRole }) {
    const normalized = String(username ?? '').trim().toLowerCase()
    const user = this.state.users.find((item) => item.username === normalized && !item.disabled)
    if (!user) throw new ApiError(401, ERR.AUTH_FAILED, '账户名或密码错误')
    const actual = pbkdf2Sync(String(password ?? ''), user.salt, 210_000, 32, 'sha256')
    const expected = Buffer.from(user.passwordHash, 'base64url')
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new ApiError(401, ERR.AUTH_FAILED, '账户名或密码错误')
    if (user.status === 'pending') throw new ApiError(403, 'AUTH_PENDING', '账号正在等待管理员审核，审核通过后即可登录')
    if (user.status === 'rejected') throw new ApiError(403, 'AUTH_REJECTED', '您的注册申请未通过，请联系管理员')
    if (expectedRole === 'admin' && user.role !== 'admin') throw new ApiError(403, 'AUTH_ROLE_MISMATCH', '该账号不是管理员账号，请使用用户登录')
    return this.issue(user)
  }
  issue(user) {
    const expiresAt = now() + 7 * 24 * 60 * 60 * 1000
    const sessionId = randomUUID()
    user.sessions = (user.sessions ?? []).filter((session) => session.expiresAt > now()).slice(-19)
    user.sessions.push({ id: sessionId, expiresAt, loggedOutAt: null })
    user.lastLoginAt = now()
    this.persist()
    const publicUser = { ...this.publicUser(user), expiresAt }
    return { user: publicUser, token: this.sign({ sub: user.userId, kind: 'account', name: user.displayName, role: user.role ?? 'user', tv: user.tokenVersion ?? 1, exp: expiresAt, sid: sessionId }) }
  }
  logout(token) {
    const identity = this.verify(token)
    if (!identity || identity.kind !== 'account') throw new ApiError(401, ERR.UNAUTHORIZED, '会话无效')
    const user = this.findUser(identity.userId)
    const timestamp = now()
    if (identity.sessionId) {
      const session = user.sessions?.find((item) => item.id === identity.sessionId)
      if (session) session.loggedOutAt = timestamp
    } else {
      user.tokenVersion = (user.tokenVersion ?? 1) + 1
    }
    user.lastLogoutAt = timestamp
    this.persist()
    return { loggedOutAt: timestamp }
  }
  findUser(userId) {
    return this.state.users.find((item) => item.userId === userId) ?? null
  }
  listUsers() {
    return this.state.users.map((user) => this.publicUser(user)).sort((a, b) => (a.createdAt ?? 0) - (b.createdAt ?? 0))
  }
  approveUser(userId) {
    const user = this.findUser(userId)
    if (!user) throw new ApiError(404, ERR.NOT_FOUND, '用户不存在')
    if (user.status === 'active') return this.publicUser(user)
    user.status = 'active'
    user.approvedAt = now()
    this.persist()
    return this.publicUser(user)
  }
  removeUser(userId) {
    const index = this.state.users.findIndex((item) => item.userId === userId)
    if (index < 0) throw new ApiError(404, ERR.NOT_FOUND, '用户不存在')
    if (this.state.users[index].protected || this.state.users[index].role === 'admin') {
      throw new ApiError(400, ERR.BAD_REQUEST, '管理员账号受系统保护，不可删除')
    }
    const [user] = this.state.users.splice(index, 1)
    this.persist()
    return this.publicUser(user)
  }
  updateUser(userId, patch = {}) {
    const user = this.findUser(userId)
    if (!user) throw new ApiError(404, ERR.NOT_FOUND, '用户不存在')
    if (patch.displayName !== undefined) user.displayName = String(patch.displayName).trim().slice(0, 80) || user.displayName
    if (patch.phone !== undefined) {
      const normalizedPhone = String(patch.phone).trim()
      if (normalizedPhone && !/^1[3-9]\d{9}$/.test(normalizedPhone)) throw new ApiError(400, ERR.AUTH_INVALID, '手机号格式不正确')
      user.phone = normalizedPhone
    }
    if (patch.disabled !== undefined && user.role !== 'admin' && !user.protected) user.disabled = patch.disabled === true
    if (patch.modelAccess !== undefined) {
      if (user.role === 'admin') throw new ApiError(400, ERR.BAD_REQUEST, '管理员无需用户模型授权')
      if (!patch.modelAccess || typeof patch.modelAccess !== 'object' ||
          typeof patch.modelAccess.allowOwn !== 'boolean' || typeof patch.modelAccess.allowShared !== 'boolean') {
        throw new ApiError(400, ERR.BAD_REQUEST, '模型权限须明确指定是否允许自填及使用统一配置')
      }
      user.modelAccess = { allowOwn: patch.modelAccess.allowOwn, allowShared: patch.modelAccess.allowShared }
      if ((user.modelSource === 'own' && !user.modelAccess.allowOwn) ||
          (user.modelSource === 'shared' && !user.modelAccess.allowShared)) user.modelSource = 'none'
    }
    if (patch.password !== undefined) {
      if (String(patch.password).length < 10) throw new ApiError(400, ERR.AUTH_INVALID, '密码至少 10 个字符')
      user.salt = randomBytes(16).toString('base64url')
      user.passwordHash = this.#hashPassword(patch.password, user.salt)
      // 令牌版本 +1：使该用户所有已签发会话立即失效
      user.tokenVersion = (user.tokenVersion ?? 1) + 1
    }
    this.persist()
    return this.publicUser(user)
  }
  setModelSource(userId, source) {
    const user = this.findUser(userId)
    if (!user) throw new ApiError(404, ERR.NOT_FOUND, '用户不存在')
    if (!['none', 'own', 'shared'].includes(source)) throw new ApiError(400, ERR.BAD_REQUEST, '无效的模型来源')
    if (source === 'own' && user.role !== 'admin' && !user.modelAccess?.allowOwn) throw new ApiError(403, ERR.FORBIDDEN, '未获自填 API 授权')
    if (source === 'shared' && user.role !== 'admin' && !user.modelAccess?.allowShared) throw new ApiError(403, ERR.FORBIDDEN, '未获统一 API 授权')
    user.modelSource = source
    this.persist()
    return source
  }
  clearModelSource(source) {
    let changed = false
    for (const user of this.state.users) {
      if (user.modelSource !== source) continue
      user.modelSource = 'none'
      changed = true
    }
    if (changed) this.persist()
  }
}

function role(project, userId) {
  if (project.ownerId === userId) return 'owner'
  return project.collaborators?.find((item) => item.userId === userId)?.role ?? null
}

export class ProjectStore {
  constructor({ root = null, cloudAdapter = null } = {}) {
    this.root = root
    this.cloudAdapter = cloudAdapter
    this.state = readJson(root, 'projects.json', { projects: [], shares: [] })
  }
  persist() { atomicJson(this.root, 'projects.json', this.state) }
  list(userId) { return this.state.projects.filter((project) => role(project, userId)).map((project) => this.public(project)) }
  public(project) { return clone(project) }
  get(projectId, userId, required = 'viewer') {
    const project = this.state.projects.find((item) => item.projectId === projectId)
    if (!project) throw new ApiError(404, ERR.PROJECT_NOT_FOUND, `项目不存在：${projectId}`)
    const actual = role(project, userId)
    if (!actual || (required !== 'viewer' && !['owner', 'editor'].includes(actual))) throw new ApiError(403, ERR.FORBIDDEN, '没有访问该项目的权限')
    return project
  }
  create(userId, input = {}) {
    const project = {
      projectId: uid('project'), ownerId: userId, name: String(input.name ?? '未命名项目').slice(0, 120),
      description: String(input.description ?? '').slice(0, 2000), protocolVersion: 1,
      createdAt: now(), updatedAt: now(), version: 1, taskIds: [], bundleIds: [],
      lockedSteps: {}, preferences: {}, collaborators: [], cloud: { status: 'local_only', remoteRevision: null, lastSyncedAt: null },
      dirty: true
    }
    this.state.projects.push(project); this.persist(); return this.public(project)
  }
  update(projectId, userId, patch = {}) {
    const project = this.get(projectId, userId, 'editor')
    for (const key of ['name', 'description', 'preferences']) if (patch[key] !== undefined) project[key] = clone(patch[key])
    project.updatedAt = now(); project.version++; project.dirty = true; this.persist(); return this.public(project)
  }
  attach(projectId, userId, { taskId, bundleId }) {
    const project = this.get(projectId, userId, 'editor')
    if (taskId && !project.taskIds.includes(taskId)) project.taskIds.push(taskId)
    if (bundleId && !project.bundleIds.includes(bundleId)) project.bundleIds.push(bundleId)
    project.updatedAt = now(); project.version++; project.dirty = true; this.persist(); return this.public(project)
  }
  setLocks(projectId, userId, locks) {
    const project = this.get(projectId, userId, 'editor')
    const allowed = new Set(['filter', 'columns', 'types', 'missing', 'aggregate', 'normalize', 'join', 'unit_conversion'])
    const next = {}
    for (const [key, value] of Object.entries(locks ?? {})) {
      if (!allowed.has(key)) throw new ApiError(400, ERR.LOCK_INVALID, `不支持锁定的数据处理步骤：${key}`)
      if (value === true || (value && typeof value === 'object')) next[key] = value === true ? { locked: true, at: now(), by: userId } : { ...clone(value), locked: true, at: now(), by: userId }
    }
    project.lockedSteps = next; project.updatedAt = now(); project.version++; project.dirty = true; this.persist(); return clone(next)
  }
  async sync(projectId, userId, { direction = 'bidirectional', conflictPolicy = 'fail' } = {}) {
    const project = this.get(projectId, userId, 'editor')
    if (!this.cloudAdapter) throw new ApiError(503, ERR.CLOUD_NOT_CONFIGURED, '未配置云同步适配器')
    const remote = await this.cloudAdapter.get(projectId)
    const conflict = remote && project.dirty && project.cloud.remoteRevision && remote.revision !== project.cloud.remoteRevision
    if (conflict && conflictPolicy === 'fail') throw new ApiError(409, ERR.SYNC_CONFLICT, '本地与云端均有新版本，需要选择 local / remote / merge', { localVersion: project.version, remoteRevision: remote.revision })
    if ((direction === 'pull' || direction === 'bidirectional') && remote && (conflictPolicy === 'remote' || (!project.dirty && remote.revision !== project.cloud.remoteRevision))) {
      const ownerId = project.ownerId
      Object.assign(project, clone(remote.project), { ownerId, projectId })
    } else if (conflict && conflictPolicy === 'merge') {
      project.taskIds = [...new Set([...(remote.project.taskIds ?? []), ...project.taskIds])]
      project.bundleIds = [...new Set([...(remote.project.bundleIds ?? []), ...project.bundleIds])]
      project.preferences = { ...(remote.project.preferences ?? {}), ...project.preferences }
      project.lockedSteps = { ...(remote.project.lockedSteps ?? {}), ...project.lockedSteps }
      project.version = Math.max(project.version, remote.project.version ?? 0) + 1
    }
    if (direction === 'push' || direction === 'bidirectional') {
      const pushed = await this.cloudAdapter.put(projectId, this.public(project), remote?.revision ?? null)
      project.cloud.remoteRevision = pushed.revision
    } else if (remote) project.cloud.remoteRevision = remote.revision
    project.cloud.status = 'synced'; project.cloud.lastSyncedAt = now(); project.dirty = false; project.updatedAt = now(); this.persist()
    return this.public(project)
  }
  createShare(projectId, userId, { expiresInMs = 7 * 24 * 60 * 60 * 1000, includeCode = true } = {}) {
    const project = this.get(projectId, userId, 'editor')
    const token = randomBytes(24).toString('base64url')
    const share = { shareId: uid('share'), projectId, tokenHash: hash(token), createdBy: userId, createdAt: now(), expiresAt: now() + Math.max(60_000, Math.min(expiresInMs, 90 * 24 * 60 * 60 * 1000)), includeCode: includeCode === true, revokedAt: null }
    this.state.shares.push(share); this.persist()
    return { ...clone(share), token, urlPath: `/share/${token}` }
  }
  revokeShare(projectId, shareId, userId) {
    this.get(projectId, userId, 'editor')
    const share = this.state.shares.find((item) => item.shareId === shareId && item.projectId === projectId)
    if (!share) throw new ApiError(404, ERR.SHARE_NOT_FOUND, '分享链接不存在')
    share.revokedAt = now(); this.persist(); return clone(share)
  }
  resolveShare(token) {
    const share = this.state.shares.find((item) => item.tokenHash === hash(token))
    if (!share || share.revokedAt || share.expiresAt < now()) throw new ApiError(404, ERR.SHARE_NOT_FOUND, '只读分享链接不存在、已撤销或已过期')
    const project = this.state.projects.find((item) => item.projectId === share.projectId)
    if (!project) throw new ApiError(404, ERR.PROJECT_NOT_FOUND, '分享项目已删除')
    return { share: { shareId: share.shareId, expiresAt: share.expiresAt, includeCode: share.includeCode }, project: this.public(project), readOnly: true }
  }
}

export class FileCloudAdapter {
  constructor(root) { this.root = path.resolve(root); fs.mkdirSync(this.root, { recursive: true }) }
  file(projectId) { assertSafeSegment(projectId, '项目 ID'); return path.join(this.root, `${projectId}.json`) }
  async get(projectId) { try { return JSON.parse(fs.readFileSync(this.file(projectId), 'utf8')) } catch { return null } }
  async put(projectId, project) {
    const revision = hash(`${project.version}:${project.updatedAt}:${JSON.stringify(project.taskIds)}`).slice(0, 24)
    atomicJson(this.root, `${projectId}.json`, { revision, project })
    return { revision }
  }
}

export class HttpCloudAdapter {
  constructor(baseUrl, token) { this.baseUrl = String(baseUrl).replace(/\/$/, ''); this.token = token }
  headers(extra = {}) { return { ...extra, ...(this.token ? { authorization: `Bearer ${this.token}` } : {}) } }
  async get(projectId) {
    const response = await fetch(`${this.baseUrl}/projects/${encodeURIComponent(projectId)}`, { headers: this.headers() })
    if (response.status === 404) return null
    if (!response.ok) throw new ApiError(502, ERR.CLOUD_SYNC_FAILED, `云端读取失败：HTTP ${response.status}`)
    return { revision: response.headers.get('etag')?.replace(/"/g, '') ?? null, project: await response.json() }
  }
  async put(projectId, project, revision) {
    const response = await fetch(`${this.baseUrl}/projects/${encodeURIComponent(projectId)}`, {
      method: 'PUT', headers: this.headers({ 'content-type': 'application/json', ...(revision ? { 'if-match': `"${revision}"` } : {}) }), body: JSON.stringify(project)
    })
    if (response.status === 409 || response.status === 412) throw new ApiError(409, ERR.SYNC_CONFLICT, '云端项目版本已变化')
    if (!response.ok) throw new ApiError(502, ERR.CLOUD_SYNC_FAILED, `云端写入失败：HTTP ${response.status}`)
    return { revision: response.headers.get('etag')?.replace(/"/g, '') ?? (await response.json().catch(() => ({}))).revision }
  }
}

export function createCloudAdapter(options = {}) {
  if (options.cloudAdapter) return options.cloudAdapter
  const fileRoot = options.cloudDir ?? process.env.LOCAL_AGENT_CLOUD_DIR
  if (fileRoot) return new FileCloudAdapter(fileRoot)
  const baseUrl = options.cloudUrl ?? process.env.LOCAL_AGENT_CLOUD_URL
  if (baseUrl) return new HttpCloudAdapter(baseUrl, options.cloudToken ?? process.env.LOCAL_AGENT_CLOUD_TOKEN)
  return null
}
