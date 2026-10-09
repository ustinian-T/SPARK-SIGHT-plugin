import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto'

function coded(code, message) {
  return Object.assign(new Error(message), { code })
}

function encode(value) {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url')
}

function decode(value) {
  return JSON.parse(Buffer.from(value, 'base64url').toString('utf8'))
}

export class AuthManager {
  constructor({ secret = randomBytes(32).toString('hex'), now = () => Date.now(), sessionTtlMs = 8 * 60 * 60 * 1000 } = {}) {
    if (String(secret).length < 16) throw new Error('auth signing secret must contain at least 16 characters')
    this.secret = String(secret)
    this.now = now
    this.sessionTtlMs = sessionTtlMs
  }

  #sign(value) {
    return createHmac('sha256', this.secret).update(value).digest('base64url')
  }

  #token(payload) {
    const body = encode(payload)
    return `${body}.${this.#sign(body)}`
  }

  #verify(token, invalidCode) {
    const [body, signature, extra] = String(token ?? '').split('.')
    if (!body || !signature || extra) throw coded(invalidCode, '签名令牌格式无效')
    const expected = Buffer.from(this.#sign(body))
    const received = Buffer.from(signature)
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) throw coded(invalidCode, '签名令牌验证失败')
    try { return decode(body) } catch { throw coded(invalidCode, '签名令牌载荷无效') }
  }

  createSession({ tenantId, subject, scopes = ['tasks:read', 'tasks:write'] }) {
    if (!tenantId || !subject) throw coded('SESSION_INVALID', 'tenantId 和 subject 不能为空')
    const issuedAt = this.now()
    const expiresAt = issuedAt + this.sessionTtlMs
    const token = this.#token({ kind: 'session', tenantId, subject, scopes, issuedAt, expiresAt, nonce: randomBytes(8).toString('hex') })
    return { token, tenantId, subject, scopes, expiresAt }
  }

  authenticate(header) {
    const token = String(header ?? '').startsWith('Bearer ') ? String(header).slice(7) : String(header ?? '')
    const payload = this.#verify(token, 'SESSION_INVALID')
    if (payload.kind !== 'session') throw coded('SESSION_INVALID', '令牌类型无效')
    if (this.now() >= payload.expiresAt) throw coded('SESSION_EXPIRED', '会话已过期')
    return payload
  }

  signDownload({ tenantId, taskId, planId, ttlMs = 5 * 60 * 1000 }) {
    const expiresAt = this.now() + Math.max(1, Math.min(ttlMs, 15 * 60 * 1000))
    const payload = { kind: 'download', tenantId, taskId, planId, expiresAt }
    return { ...payload, signature: this.#sign(encode(payload)) }
  }

  verifyDownload(input) {
    const payload = { kind: 'download', tenantId: input.tenantId, taskId: input.taskId, planId: input.planId, expiresAt: Number(input.expiresAt) }
    const expected = Buffer.from(this.#sign(encode(payload)))
    const received = Buffer.from(String(input.signature ?? ''))
    if (expected.length !== received.length || !timingSafeEqual(expected, received)) throw coded('SIGNED_URL_INVALID', '下载签名无效')
    if (this.now() > payload.expiresAt) throw coded('SIGNED_URL_EXPIRED', '下载链接已过期')
    return payload
  }
}
