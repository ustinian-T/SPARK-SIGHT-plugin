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
    const session = { uploadId, tenantId, fileName: safeCsvName(fileName), totalBytes: size, receivedBytes: 0, complete: false, filePath }
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

  #public(session) {
    return { uploadId: session.uploadId, fileName: session.fileName, totalBytes: session.totalBytes, receivedBytes: session.receivedBytes, complete: session.complete }
  }
}
