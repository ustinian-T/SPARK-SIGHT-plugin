import fs from 'node:fs'
import path from 'node:path'
import { mergeUserProfile, normalizeUserProfile } from './userProfile.js'
import { ApiError, ERR } from './errors.js'

export class UserProfileStore {
  constructor(root = null) {
    this.file = root ? path.join(root, 'user-plot-profiles.json') : null
    this.values = this.file && fs.existsSync(this.file) ? JSON.parse(fs.readFileSync(this.file, 'utf8')) : {}
  }
  get(userId) {
    const value = Object.hasOwn(this.values, userId) ? this.values[userId] : null
    return value ? { ...value, profile: normalizeUserProfile(value.profile) } : { profile: {}, revision: 0, updatedAt: null }
  }
  put(userId, body) {
    if (!body || !body.profile || typeof body.profile !== 'object' || Array.isArray(body.profile)) throw new ApiError(400, ERR.BAD_REQUEST, '请提供绘图偏好对象')
    const current = this.get(userId)
    if (body.expectedRevision !== undefined && body.expectedRevision !== current.revision) throw new ApiError(409, ERR.SYNC_CONFLICT, '偏好已在其他端更新，请重新加载后保存')
    const next = { profile: mergeUserProfile(current.profile, body.profile), revision: current.revision + 1, updatedAt: Date.now() }
    Object.defineProperty(this.values, userId, { value: next, writable: true, enumerable: true, configurable: true })
    if (this.file) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true })
      const tmp = `${this.file}.${process.pid}.tmp`
      fs.writeFileSync(tmp, JSON.stringify(this.values), { mode: 0o600 })
      fs.renameSync(tmp, this.file)
    }
    return next
  }
}
