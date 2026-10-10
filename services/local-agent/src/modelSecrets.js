// Server-side model credentials. The API never returns plaintext keys; the
// ciphertext and its instance key stay in the Agent data volume, not Web storage.
import fs from 'node:fs'
import path from 'node:path'
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'

export class ModelSecretStore {
  constructor(root = null, { prefix = 'model-secrets' } = {}) {
    if (!/^[a-z][a-z0-9-]+$/.test(prefix)) throw new Error('Invalid encrypted store name')
    this.root = root
    this.prefix = prefix
    this.state = { shared: null, users: {} }
    this.key = randomBytes(32)
    if (!root) return
    fs.mkdirSync(root, { recursive: true })
    const keyPath = path.join(root, `${prefix}.key`)
    const dataPath = path.join(root, `${prefix}.json`)
    if (fs.existsSync(keyPath)) {
      this.key = fs.readFileSync(keyPath)
      if (this.key.length !== 32) throw new Error('模型配置加密密钥无效')
    } else {
      if (fs.existsSync(dataPath)) throw new Error('模型配置密钥缺失；已保留加密数据，不能自动覆盖')
      this.key = randomBytes(32)
      try { fs.writeFileSync(keyPath, this.key, { flag: 'wx', mode: 0o600 }) }
      catch (error) {
        if (error.code !== 'EEXIST') throw error
        this.key = fs.readFileSync(keyPath)
      }
    }
    if (fs.existsSync(dataPath)) {
      const envelope = JSON.parse(fs.readFileSync(dataPath, 'utf8'))
      const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(envelope.iv, 'base64url'))
      decipher.setAuthTag(Buffer.from(envelope.tag, 'base64url'))
      const plaintext = Buffer.concat([decipher.update(Buffer.from(envelope.data, 'base64url')), decipher.final()])
      this.state = JSON.parse(plaintext.toString('utf8'))
    }
  }
  persist() {
    if (!this.root) return
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', this.key, iv)
    const data = Buffer.concat([cipher.update(JSON.stringify(this.state), 'utf8'), cipher.final()])
    const envelope = {
      version: 1, iv: iv.toString('base64url'), tag: cipher.getAuthTag().toString('base64url'), data: data.toString('base64url')
    }
    const target = path.join(this.root, `${this.prefix}.json`)
    const temp = path.join(this.root, `.${this.prefix}.${process.pid}.tmp`)
    fs.writeFileSync(temp, JSON.stringify(envelope), { mode: 0o600 })
    fs.renameSync(temp, target)
  }
  getShared() { return this.state.shared ? { ...this.state.shared } : null }
  getUser(userId) { return this.state.users[userId] ? { ...this.state.users[userId] } : null }
  setShared(config) { this.state.shared = { ...config }; this.persist() }
  setUser(userId, config) { this.state.users[userId] = { ...config }; this.persist() }
  deleteShared() { this.state.shared = null; this.persist() }
  deleteUser(userId) { delete this.state.users[userId]; this.persist() }
}

export function modelConfigSummary(config) {
  return config
    ? { configured: !!config.apiKey, providerId: config.providerId, displayName: config.displayName, models: config.models, provider: config.provider, protocol: config.protocol, baseUrl: config.baseUrl, model: config.model }
    : { configured: false }
}
