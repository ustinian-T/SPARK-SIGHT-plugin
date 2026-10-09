// 邀请码存储：一次性使用，注册时预留（reservedBy），审核通过即消费删除；拒绝/手动删除即释放。
// 文件态持久化（invites.json），与 accounts.json 同目录，原子写入。
import fs from 'node:fs'
import path from 'node:path'
import { randomBytes } from 'node:crypto'
import { ApiError, ERR } from './errors.js'
import { assertSafeSegment } from './safe.js'

const now = () => Date.now()
const clone = (value) => structuredClone(value)

// 邀请码规则：10—64 位，仅字母/数字/下划线/连字符（不含易混淆的空白）。
export const INVITE_CODE_PATTERN = /^[A-Za-z0-9_-]{10,64}$/

function atomicJson(root, name, value) {
  fs.mkdirSync(root, { recursive: true })
  const target = path.join(root, name)
  const temp = path.join(root, `.${name}.${process.pid}.tmp`)
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(temp, target)
}

function readJson(root, name, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(root, name), 'utf8')) } catch { return clone(fallback) }
}

export class InviteStore {
  constructor({ root = null } = {}) {
    this.root = root
    this.state = readJson(root, 'invites.json', { invites: [] })
  }
  persist() {
    if (!this.root) return
    atomicJson(this.root, 'invites.json', this.state)
  }
  list() {
    return clone(this.state.invites).sort((a, b) => (b.createdAt ?? 0) - (a.createdAt ?? 0))
  }
  find(code) {
    return this.state.invites.find((item) => item.code === code) ?? null
  }
  assertFormat(code) {
    if (!INVITE_CODE_PATTERN.test(String(code ?? ''))) {
      throw new ApiError(400, ERR.AUTH_INVALID, '邀请码需为 10—64 位字母、数字、下划线或连字符')
    }
  }
  assertAvailable(code) {
    this.assertFormat(code)
    const invite = this.find(String(code))
    if (!invite) throw new ApiError(404, 'INVITE_NOT_FOUND', '邀请码不存在或已失效')
    if (invite.reservedBy) throw new ApiError(409, 'INVITE_RESERVED', '邀请码已被其他注册预留，请更换邀请码')
    return invite
  }
  create({ code, createdBy }) {
    const normalized = String(code ?? '').trim()
    if (normalized) {
      this.assertFormat(normalized)
      if (this.find(normalized)) throw new ApiError(409, ERR.AUTH_CONFLICT, '邀请码已存在，请更换')
    }
    const invite = {
      code: normalized || randomBytes(12).toString('base64url').replace(/[-_]/g, () => randomBytes(1).toString('hex')).slice(0, 16),
      createdBy: createdBy ?? null,
      reservedBy: null,
      reservedAt: null,
      createdAt: now()
    }
    if (!INVITE_CODE_PATTERN.test(invite.code)) invite.code = randomBytes(16).toString('hex')
    this.state.invites.push(invite)
    this.persist()
    return clone(invite)
  }
  reserve(code, userId) {
    const invite = this.assertAvailable(code)
    invite.reservedBy = userId
    invite.reservedAt = now()
    this.persist()
    return clone(invite)
  }
  release(code, userId) {
    const invite = this.find(String(code))
    if (invite && invite.reservedBy === userId) {
      invite.reservedBy = null
      invite.reservedAt = null
      this.persist()
    }
  }
  releaseByUser(userId) {
    for (const invite of this.state.invites) {
      if (invite.reservedBy === userId) {
        invite.reservedBy = null
        invite.reservedAt = null
      }
    }
    this.persist()
  }
  // 消费：一次性使用后立即失效并自动删除
  consume(code) {
    const normalized = String(code)
    const index = this.state.invites.findIndex((item) => item.code === normalized)
    if (index < 0) throw new ApiError(404, 'INVITE_NOT_FOUND', '邀请码不存在或已失效')
    const [invite] = this.state.invites.splice(index, 1)
    this.persist()
    return clone(invite)
  }
  findByReservation(userId) {
    return this.state.invites.find((item) => item.reservedBy === userId) ?? null
  }
  remove(code) {
    const index = this.state.invites.findIndex((item) => item.code === String(code))
    if (index < 0) throw new ApiError(404, 'INVITE_NOT_FOUND', '邀请码不存在')
    const [invite] = this.state.invites.splice(index, 1)
    this.persist()
    return clone(invite)
  }
  safeCode(code) {
    assertSafeSegment(String(code), '邀请码')
    return String(code)
  }
}
