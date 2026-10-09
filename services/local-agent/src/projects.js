import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

export const PROJECT_FORMAT_VERSION = 1

function projectError(code, message) {
  return Object.assign(new Error(message), { code })
}

function pathsFor(root) {
  const resolved = path.resolve(root)
  const metadata = path.join(resolved, '.deep-imaging')
  return {
    root: resolved,
    metadata,
    manifest: path.join(metadata, 'project.json'),
    lock: path.join(metadata, 'write.lock'),
    history: path.join(metadata, 'history')
  }
}

function validateSettings(settings = {}) {
  const keys = Object.keys(settings)
  if (keys.some((key) => !['interpreters', 'model'].includes(key))) {
    throw projectError('PROJECT_SETTINGS_INVALID', '项目只允许保存解释器路径和非敏感模型配置；密钥必须使用操作系统凭据库')
  }
  const interpreters = settings.interpreters ?? {}
  if (!interpreters || typeof interpreters !== 'object' || Array.isArray(interpreters)) throw projectError('PROJECT_SETTINGS_INVALID', 'interpreters 必须是对象')
  const allowedEngines = ['python', 'r', 'matlab']
  if (Object.keys(interpreters).some((key) => !allowedEngines.includes(key) || typeof interpreters[key] !== 'string')) {
    throw projectError('PROJECT_SETTINGS_INVALID', '解释器配置只支持 python/r/matlab 字符串路径')
  }
  const model = settings.model ?? {}
  if (!model || typeof model !== 'object' || Array.isArray(model)) throw projectError('PROJECT_SETTINGS_INVALID', 'model 必须是对象')
  const allowedModel = ['provider', 'model', 'protocol', 'baseUrl']
  if (Object.entries(model).some(([key, value]) => !allowedModel.includes(key) || typeof value !== 'string')) {
    throw projectError('PROJECT_SETTINGS_INVALID', '模型配置包含不支持的字段')
  }
  return { interpreters: { ...interpreters }, model: { ...model } }
}

function writeJsonAtomic(file, value) {
  const temporary = `${file}.${process.pid}.${randomUUID()}.tmp`
  fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' })
  fs.renameSync(temporary, file)
}

function snapshotProject(paths, project, action) {
  fs.mkdirSync(paths.history, { recursive: true })
  const stamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
  writeJsonAtomic(path.join(paths.history, `${stamp}-${action}-${randomUUID().slice(0, 8)}.json`), project)
}

export class ProjectStore {
  constructor() {
    this.locks = new Map()
  }

  create(root, input = {}) {
    const paths = pathsFor(root)
    if (fs.existsSync(paths.manifest)) throw projectError('PROJECT_EXISTS', '目标已是 Deep Imaging 项目')
    fs.mkdirSync(paths.metadata, { recursive: true })
    fs.mkdirSync(paths.history, { recursive: true })
    const project = {
      format: 'deep-imaging-project',
      formatVersion: PROJECT_FORMAT_VERSION,
      projectId: randomUUID(),
      name: String(input.name ?? path.basename(paths.root)),
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      settings: validateSettings(input.settings)
    }
    writeJsonAtomic(paths.manifest, project)
    snapshotProject(paths, project, 'create')
    this.#lock(paths)
    return project
  }

  open(root) {
    const paths = pathsFor(root)
    if (!fs.existsSync(paths.manifest)) throw projectError('PROJECT_NOT_FOUND', '未找到 .deep-imaging/project.json')
    const project = JSON.parse(fs.readFileSync(paths.manifest, 'utf8'))
    if (project.format !== 'deep-imaging-project' || project.formatVersion !== PROJECT_FORMAT_VERSION) {
      throw projectError('PROJECT_FORMAT_UNSUPPORTED', `不支持的项目格式版本：${project.formatVersion ?? 'unknown'}`)
    }
    this.#lock(paths)
    return project
  }

  updateSettings(root, settings) {
    const paths = pathsFor(root)
    if (!this.locks.has(paths.root)) throw projectError('PROJECT_NOT_OPEN', '项目未以可写模式打开')
    const project = JSON.parse(fs.readFileSync(paths.manifest, 'utf8'))
    project.settings = validateSettings(settings)
    project.updatedAt = new Date().toISOString()
    writeJsonAtomic(paths.manifest, project)
    snapshotProject(paths, project, 'settings')
    return project
  }

  close(root) {
    const paths = pathsFor(root)
    const lockId = this.locks.get(paths.root)
    if (!lockId) return false
    try {
      const current = JSON.parse(fs.readFileSync(paths.lock, 'utf8'))
      if (current.lockId === lockId) fs.unlinkSync(paths.lock)
    } catch {}
    this.locks.delete(paths.root)
    return true
  }

  closeAll() {
    for (const root of [...this.locks.keys()]) this.close(root)
  }

  #lock(paths) {
    if (this.locks.has(paths.root)) return
    const lockId = randomUUID()
    try {
      fs.writeFileSync(paths.lock, `${JSON.stringify({ lockId, pid: process.pid, createdAt: new Date().toISOString() })}\n`, { encoding: 'utf8', flag: 'wx' })
    } catch (error) {
      if (error?.code === 'EEXIST') throw projectError('PROJECT_LOCKED', '项目已被另一进程以可写模式打开')
      throw error
    }
    this.locks.set(paths.root, lockId)
  }
}
