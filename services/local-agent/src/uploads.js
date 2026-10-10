import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { safeCsvName } from './safe.js'

function coded(code, message) {
  return Object.assign(new Error(message), { code })
}

function tenantKey(value) {
  return createHash('sha256').update(String(value)).digest('hex').slice(0, 24)
}

export class UploadStore {
  constructor(root, { maxBytes = 50 * 1024 * 1024 } = {}) {
    this.root = path.resolve(root)
    this.maxBytes = maxBytes
    this.sessions = new Map()
    fs.mkdirSync(this.root, { recursive: true })
    // Sessions are in-memory: files from a previous process cannot be resumed.
    for (const folder of fs.readdirSync(this.root, { withFileTypes: true })) {
      if (!folder.isDirectory() || !/^[a-f0-9]{24}$/.test(folder.name)) continue
      const dir = path.join(this.root, folder.name)
      for (const name of fs.readdirSync(dir)) {
        if (/^upload_[a-f0-9]{32}\.part$/.test(name)) fs.rmSync(path.join(dir, name), { force: true })
      }
    }
  }

  create(tenantId, { fileName, totalBytes }) {
    const size = Number(totalBytes)
    if (!Number.isSafeInteger(size) || size <= 0) throw coded('UPLOAD_INVALID', 'totalBytes 必须是正整数')
    if (size > this.maxBytes) throw coded('UPLOAD_TOO_LARGE', '上传文件超出租户配额')
    const uploadId = `upload_${randomUUID().replaceAll('-', '')}`
    const folder = path.join(this.root, tenantKey(tenantId))
    fs.mkdirSync(folder, { recursive: true })
    const filePath = path.join(folder, `${uploadId}.part`)
    fs.writeFileSync(filePath, Buffer.alloc(0), { flag: 'wx' })
    this.cleanup()
    const session = { uploadId, tenantId, fileName: safeCsvName(fileName), totalBytes: size, receivedBytes: 0, complete: false, filePath, updatedAt: Date.now() }
    this.sessions.set(uploadId, session)
    return this.#public(session)
  }

  #get(tenantId, uploadId) {
    const session = this.sessions.get(uploadId)
    if (!session || session.tenantId !== tenantId) throw coded('UPLOAD_NOT_FOUND', '上传会话不存在')
    return session
  }

  append(tenantId, uploadId, { offset, chunk }) {
    const session = this.#get(tenantId, uploadId)
    if (session.complete) throw coded('UPLOAD_COMPLETE', '上传已完成')
    if (Number(offset) !== session.receivedBytes) throw coded('UPLOAD_OFFSET_MISMATCH', `期望偏移 ${session.receivedBytes}`)
    const bytes = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk ?? '')
    if (session.receivedBytes + bytes.length > session.totalBytes) throw coded('UPLOAD_TOO_LARGE', '分块超出声明的文件大小')
    fs.appendFileSync(session.filePath, bytes)
    session.receivedBytes += bytes.length
    session.updatedAt = Date.now()
    session.complete = session.receivedBytes === session.totalBytes
    return this.#public(session)
  }

  status(tenantId, uploadId) {
    return this.#public(this.#get(tenantId, uploadId))
  }

  consume(tenantId, uploadId) {
    const session = this.#get(tenantId, uploadId)
    if (!session.complete) throw coded('UPLOAD_INCOMPLETE', '上传尚未完成')
    return session.filePath
  }

  remove(tenantId, uploadId) {
    const session = this.#get(tenantId, uploadId)
    fs.rmSync(session.filePath, { force: true })
    this.sessions.delete(uploadId)
    return { deleted: true, uploadId }
  }

  cleanup(now = Date.now()) {
    for (const session of this.sessions.values()) {
      if (now - session.updatedAt > 6 * 60 * 60 * 1000) this.remove(session.tenantId, session.uploadId)
    }
  }

  #public(session) {
    return { uploadId: session.uploadId, fileName: session.fileName, totalBytes: session.totalBytes, receivedBytes: session.receivedBytes, complete: session.complete }
  }
}
