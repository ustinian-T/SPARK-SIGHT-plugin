// 项目仓库（文件态）：Project 是任务的物理与逻辑容器，任务必须归属于且仅归属于一个 Project。
// 目录布局（见设计文档 A.5）：
//   .data/projects/<projectId>/
//     project.json     项目唯一事实源（字段见 A.2）
//     preferences.json 项目级偏好（独立文件，避免频繁改偏好动 project.json，见 C.2）
//     audit.jsonl      追加写审计日志（跨任务授权、审批决策、设置变更）
//     grants.jsonl     跨任务授权令牌
//     tasks/<taskId>/  项目内任务（数据/事件/产物完全嵌套）
// 所有 JSON 写入均为原子写（<file>.<pid>.tmp + rename）。
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { assertSafeSegment } from './safe.js'
import { ApiError, ERR } from './errors.js'

// 默认项目 ID（旧扁平任务迁移目的地，见 H.1 / 附录）
export const DEFAULT_PROJECT_ID = 'proj_default'

// 生成项目主键：proj_<时间戳36>_<uuid8>
export function newProjectId() {
  return `proj_${Date.now().toString(36)}_${randomUUID().replace(/-/g, '').slice(0, 8)}`
}

// 原子写 JSON：先写同目录临时文件，再 rename 覆盖（rename 在同分区下为原子操作）
function writeJsonAtomic(target, value) {
  const temp = `${target}.${process.pid}.tmp`
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(temp, target)
}

// 读取 JSON，文件不存在时返回 null
function readJsonIfExists(file) {
  if (!fs.existsSync(file)) return null
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch (e) {
    process.stderr.write(`[projectStore] ${path.basename(file)} 损坏，按空处理：${e.message}\n`)
    return null
  }
}

export class ProjectStore {
  /**
   * @param {string} root .data 目录的绝对路径
   */
  constructor(root) {
    if (!root) throw new ApiError(500, ERR.INTERNAL, 'ProjectStore 需要 .data 根目录')
    this.root = path.resolve(root)
    this.projectsRoot = path.join(this.root, 'projects')
    this.trashRoot = path.join(this.root, '.trash')
    fs.mkdirSync(this.projectsRoot, { recursive: true })
  }

  newProjectId() {
    return newProjectId()
  }

  projectDir(projectId) {
    assertSafeSegment(projectId, '项目 ID')
    return path.join(this.projectsRoot, projectId)
  }

  taskDir(projectId, taskId) {
    assertSafeSegment(projectId, '项目 ID')
    assertSafeSegment(taskId, '任务 ID')
    return path.join(this.projectDir(projectId), 'tasks', taskId)
  }

  // 构造一份符合 A.2 的空项目骨架
  #skeleton({ projectId, name, description, sourceFolder, owner, tenantId }) {
    const now = Date.now()
    return {
      projectId,
      name: name || '未命名项目',
      description: description ?? '',
      createdAt: now,
      updatedAt: now,
      owner: owner ?? 'local-user',
      tenantId: tenantId ?? 'local',
      visibility: 'private',
      status: 'active',
      settings: { interpreters: {}, model: {} },
      preferences: {},
      taskIds: [],
      chartUsage: {},
      collaboration: { comments: [], locks: [], shares: [], syncState: {} },
      sourceFolder: sourceFolder ?? null
    }
  }

  /**
   * 创建项目：建目录 + project.json + preferences.json + audit.jsonl + grants.jsonl + tasks/
   */
  create({ name, description = '', sourceFolder = null, owner = 'local-user', tenantId = 'local', projectId } = {}) {
    const pid = projectId || this.newProjectId()
    assertSafeSegment(pid, '项目 ID')
    const dir = this.projectDir(pid)
    if (fs.existsSync(dir)) throw new ApiError(409, ERR.PROJECT_NOT_FOUND, `项目已存在：${pid}`)
    fs.mkdirSync(path.join(dir, 'tasks'), { recursive: true })
    const project = this.#skeleton({ projectId: pid, name, description, sourceFolder, owner, tenantId })
    writeJsonAtomic(path.join(dir, 'project.json'), project)
    writeJsonAtomic(path.join(dir, 'preferences.json'), {})
    fs.writeFileSync(path.join(dir, 'audit.jsonl'), '', 'utf8')
    fs.writeFileSync(path.join(dir, 'grants.jsonl'), '', 'utf8')
    return project
  }

  /** 读取 project.json；不存在或已软删除时抛 404 */
  get(projectId) {
    const file = path.join(this.projectDir(projectId), 'project.json')
    const project = readJsonIfExists(file)
    if (!project) throw new ApiError(404, ERR.PROJECT_NOT_FOUND, `项目不存在：${projectId}`)
    return project
  }

  /** 只读读取（不抛错），找不到返回 null */
  tryGet(projectId) {
    try {
      return this.get(projectId)
    } catch {
      return null
    }
  }

  /** 恢复创建时断电/进程退出留下的原子写临时文件；绝不覆盖已有事实源。 */
  recoverInterruptedCreate(projectId) {
    const dir = this.projectDir(projectId)
    const target = path.join(dir, 'project.json')
    if (!fs.existsSync(dir) || fs.existsSync(target)) return this.tryGet(projectId)
    const candidates = fs.readdirSync(dir)
      .filter((name) => /^project\.json\.\d+\.tmp$/.test(name))
      .map((name) => ({ path: path.join(dir, name), mtime: fs.statSync(path.join(dir, name)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime)
    for (const candidate of candidates) {
      const project = readJsonIfExists(candidate.path)
      if (project?.projectId !== projectId || !Array.isArray(project.taskIds)) continue
      try { fs.copyFileSync(candidate.path, target, fs.constants.COPYFILE_EXCL) }
      catch (error) { if (error.code !== 'EEXIST') throw error }
      return this.tryGet(projectId)
    }
    return null
  }

  /** 列出 active 项目（可按 owner/tenantId 过滤），按 updatedAt 降序 */
  list(owner, tenantId) {
    if (!fs.existsSync(this.projectsRoot)) return []
    const out = []
    for (const entry of fs.readdirSync(this.projectsRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const project = readJsonIfExists(path.join(this.projectsRoot, entry.name, 'project.json'))
      if (!project) continue
      if (project.status === 'deleted') continue
      if (owner && project.owner !== owner) continue
      if (tenantId && project.tenantId !== tenantId) continue
      out.push(project)
    }
    out.sort((a, b) => (b.updatedAt ?? 0) - (a.updatedAt ?? 0))
    return out
  }

  /** 更新 name/description/preferences/settings，并刷新 updatedAt */
  update(projectId, patch = {}) {
    const project = this.get(projectId)
    if (project.status === 'deleted') throw new ApiError(409, ERR.BAD_REQUEST, '项目已删除，不可更新')
    if (typeof patch.name === 'string') project.name = patch.name.slice(0, 120)
    if (typeof patch.description === 'string') project.description = patch.description.slice(0, 2000)
    if (patch.preferences && typeof patch.preferences === 'object') {
      project.preferences = { ...project.preferences, ...patch.preferences }
    }
    if (patch.settings && typeof patch.settings === 'object') {
      project.settings = { ...project.settings, ...patch.settings }
    }
    if (patch.sourceFolder !== undefined) project.sourceFolder = patch.sourceFolder
    project.updatedAt = Date.now()
    writeJsonAtomic(path.join(this.projectDir(projectId), 'project.json'), project)
    return project
  }

  /** 软删除：目录移到 .trash/<projectId>/，并标记 status=deleted */
  delete(projectId) {
    const project = this.get(projectId)
    const dir = this.projectDir(projectId)
    fs.mkdirSync(this.trashRoot, { recursive: true })
    const trashTarget = path.join(this.trashRoot, projectId)
    if (fs.existsSync(trashTarget)) fs.rmSync(trashTarget, { recursive: true, force: true })
    fs.renameSync(dir, trashTarget)
    // 在回收站内补写状态标记，便于后续恢复/TTL 清理
    project.status = 'deleted'
    project.updatedAt = Date.now()
    writeJsonAtomic(path.join(trashTarget, 'project.json'), project)
    return project
  }

  /** 归档/恢复：status=archived（只读）或 active */
  archive(projectId, archived = true) {
    const project = this.get(projectId)
    project.status = archived ? 'archived' : 'active'
    project.updatedAt = Date.now()
    writeJsonAtomic(path.join(this.projectDir(projectId), 'project.json'), project)
    return project
  }

  /** 项目内追加任务 ID（去重），刷新 updatedAt */
  addTask(projectId, taskId) {
    assertSafeSegment(taskId, '任务 ID')
    const project = this.get(projectId)
    if (!project.taskIds.includes(taskId)) project.taskIds.push(taskId)
    project.updatedAt = Date.now()
    writeJsonAtomic(path.join(this.projectDir(projectId), 'project.json'), project)
    return project
  }

  /** 项目内移除任务 ID */
  removeTask(projectId, taskId) {
    const project = this.tryGet(projectId)
    if (!project) return null
    const before = project.taskIds.length
    project.taskIds = project.taskIds.filter((id) => id !== taskId)
    if (project.taskIds.length !== before) {
      project.updatedAt = Date.now()
      writeJsonAtomic(path.join(this.projectDir(projectId), 'project.json'), project)
    }
    return project
  }

  hasTask(projectId, taskId) {
    const project = this.tryGet(projectId)
    return !!project && project.taskIds.includes(taskId)
  }

  /** 追加审计记录到 audit.jsonl（每行一条 JSON） */
  appendAudit(projectId, record) {
    this.get(projectId) // 校验项目存在
    const file = path.join(this.projectDir(projectId), 'audit.jsonl')
    fs.appendFileSync(file, JSON.stringify({ ts: Date.now(), ...record }) + '\n', 'utf8')
  }

  /** 读取审计时间线（最新在前），可选 limit */
  readAudit(projectId, limit = 100) {
    this.get(projectId)
    const file = path.join(this.projectDir(projectId), 'audit.jsonl')
    if (!fs.existsSync(file)) return []
    const lines = fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean)
    const records = lines.map((line) => JSON.parse(line))
    return records.slice(-limit).reverse()
  }

  getGrants(projectId) {
    this.get(projectId)
    const file = path.join(this.projectDir(projectId), 'grants.jsonl')
    if (!fs.existsSync(file)) return []
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line))
  }

  appendGrant(projectId, grant) {
    this.get(projectId)
    const file = path.join(this.projectDir(projectId), 'grants.jsonl')
    fs.appendFileSync(file, JSON.stringify({ grantedAt: Date.now(), ...grant }) + '\n', 'utf8')
  }

  // 原子重写 grants.jsonl：用于 once 令牌 consumed / 吊销等状态迁移
  #rewriteGrants(projectId, grants) {
    const file = path.join(this.projectDir(projectId), 'grants.jsonl')
    const text = grants.map((g) => JSON.stringify(g)).join('\n') + (grants.length ? '\n' : '')
    const temp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(temp, text, 'utf8')
    fs.renameSync(temp, file)
  }

  /** 将 once 令牌标记为 consumed（用完即焚） */
  consumeGrant(projectId, grantId) {
    const grants = this.getGrants(projectId)
    let found = false
    const next = grants.map((g) => {
      if (g.grantId === grantId) {
        found = true
        return { ...g, status: 'consumed', consumedAt: Date.now() }
      }
      return g
    })
    if (!found) throw new ApiError(404, ERR.NOT_FOUND, `授权令牌不存在：${grantId}`)
    this.#rewriteGrants(projectId, next)
    return next.find((g) => g.grantId === grantId)
  }

  /** 吊销令牌（active → revoked） */
  revokeGrant(projectId, grantId) {
    const grants = this.getGrants(projectId)
    let found = false
    const next = grants.map((g) => {
      if (g.grantId === grantId) {
        found = true
        return { ...g, status: 'revoked', revokedAt: Date.now() }
      }
      return g
    })
    if (!found) throw new ApiError(404, ERR.NOT_FOUND, `授权令牌不存在：${grantId}`)
    this.#rewriteGrants(projectId, next)
    return next.find((g) => g.grantId === grantId)
  }

  /**
   * 校验跨任务取数授权：存在、未过期、未消费/吊销、任务与字段在白名单内。
   * 任一不满足抛 403/404；通过则返回 grant 记录。
   */
  validateGrant(projectId, grantId, fromTaskId, toTaskId, field) {
    const grant = this.getGrants(projectId).find((g) => g.grantId === grantId)
    if (!grant) throw new ApiError(404, ERR.NOT_FOUND, `授权令牌不存在：${grantId}`)
    if (grant.status === 'consumed') throw new ApiError(403, ERR.FORBIDDEN, '授权令牌已被消费（once 令牌一次性）', { code: 'grant-consumed' })
    if (grant.status === 'revoked') throw new ApiError(403, ERR.FORBIDDEN, '授权令牌已被吊销', { code: 'grant-revoked' })
    if (grant.expiresAt && grant.expiresAt < Date.now()) throw new ApiError(403, ERR.FORBIDDEN, '授权令牌已过期', { code: 'grant-expired' })
    if (grant.fromTaskId !== fromTaskId) throw new ApiError(403, ERR.FORBIDDEN, '授权令牌与发起任务不匹配', { code: 'grant-task-mismatch' })
    if (grant.toTaskId !== toTaskId) throw new ApiError(403, ERR.FORBIDDEN, '授权令牌与目标任务不匹配', { code: 'grant-task-mismatch' })
    if (!Array.isArray(grant.fields) || !grant.fields.includes(field)) {
      throw new ApiError(403, ERR.FORBIDDEN, `字段「${field}」不在授权白名单内`, { code: 'field-not-authorized' })
    }
    return grant
  }

  /** 读取图表类型使用直方图（project.json.chartUsage） */
  getChartUsage(projectId) {
    const project = this.get(projectId)
    return project.chartUsage ?? {}
  }

  /** 记录一次图表类型使用：chartUsage[chartType]++，原子写 */
  recordChartUsage(projectId, chartType) {
    if (!chartType || typeof chartType !== 'string') return
    const project = this.get(projectId)
    project.chartUsage = project.chartUsage ?? {}
    project.chartUsage[chartType] = (project.chartUsage[chartType] ?? 0) + 1
    project.updatedAt = Date.now()
    writeJsonAtomic(path.join(this.projectDir(projectId), 'project.json'), project)
    return project.chartUsage
  }

  getPreferences(projectId) {
    this.get(projectId)
    const file = path.join(this.projectDir(projectId), 'preferences.json')
    return readJsonIfExists(file) ?? {}
  }

  /** 合并写 preferences.json（与项目内已有偏好浅合并） */
  setPreferences(projectId, prefs = {}) {
    this.get(projectId)
    const file = path.join(this.projectDir(projectId), 'preferences.json')
    const current = readJsonIfExists(file) ?? {}
    const next = { ...current, ...prefs }
    writeJsonAtomic(file, next)
    // 同步刷新 project.preferences 镜像，便于列表/详情读取
    const project = this.get(projectId)
    project.preferences = next
    project.updatedAt = Date.now()
    writeJsonAtomic(path.join(this.projectDir(projectId), 'project.json'), project)
    return next
  }

  /**
   * 桥接：为已存在于协作层（platformProjectStore）的项目 ID 在新模型中建目录骨架。
   * 阶段 1 共存用——HTTP POST /api/projects 仍由协作层建项目，这里补建任务容器目录。
   */
  attachExisting(projectId, { name, description = '', sourceFolder = null, owner = 'local-user', tenantId = 'local' } = {}) {
    assertSafeSegment(projectId, '项目 ID')
    const dir = this.projectDir(projectId)
    if (fs.existsSync(path.join(dir, 'project.json'))) return this.get(projectId)
    fs.mkdirSync(path.join(dir, 'tasks'), { recursive: true })
    const project = this.#skeleton({ projectId, name, description, sourceFolder, owner, tenantId })
    writeJsonAtomic(path.join(dir, 'project.json'), project)
    writeJsonAtomic(path.join(dir, 'preferences.json'), {})
    fs.writeFileSync(path.join(dir, 'audit.jsonl'), '', 'utf8')
    fs.writeFileSync(path.join(dir, 'grants.jsonl'), '', 'utf8')
    return project
  }
}
