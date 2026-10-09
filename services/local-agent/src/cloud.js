// 用户云存储：项目上云（目录镜像到云端区）+ 每租户 300 MB 配额 + 未上云数据 7 天保留清扫。
// - 云端区位于 <dataDir>/cloud/<tenantId>/<projectId>/，是项目数据目录的完整镜像（数据/代码/产物）。
// - 配额按镜像字节数累计（manifest.json 持久化），超出配额拒绝上云。
// - 保留清扫：未上云（cloudEnabled!==true）且超过保留期的项目移入 .trash；上云项目不受影响。
import fs from 'node:fs'
import path from 'node:path'
import { ApiError, ERR } from './errors.js'
import { assertSafeSegment } from './safe.js'

const now = () => Date.now()
const clone = (value) => structuredClone(value)
const DAY_MS = 24 * 60 * 60 * 1000

export const DEFAULT_CLOUD_QUOTA_BYTES = 300 * 1024 * 1024 // 300 MB / 用户
export const DEFAULT_RETENTION_DAYS = 7

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return structuredClone(fallback) }
}

function atomicJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const temp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(temp, JSON.stringify(value, null, 2), 'utf8')
  fs.renameSync(temp, file)
}

export function dirSize(root) {
  let total = 0
  const walk = (dir) => {
    let entries
    try { entries = fs.readdirSync(dir, { withFileTypes: true }) } catch { return }
    for (const entry of entries) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) walk(full)
      else {
        try { total += fs.statSync(full).size } catch { /* 文件消失不计入 */ }
      }
    }
  }
  walk(root)
  return total
}

export class TenantCloudStore {
  constructor({ root, quotaBytes = DEFAULT_CLOUD_QUOTA_BYTES } = {}) {
    this.root = root ? path.resolve(root) : null
    this.quotaBytes = quotaBytes
    if (this.root) fs.mkdirSync(this.root, { recursive: true })
  }
  tenantFile(tenantId) {
    assertSafeSegment(tenantId, '租户 ID')
    return path.join(this.root, tenantId, 'manifest.json')
  }
  manifest(tenantId) {
    if (!this.root) return { projects: {} }
    return readJson(this.tenantFile(tenantId), { projects: {} })
  }
  saveManifest(tenantId, manifest) {
    if (!this.root) return
    atomicJson(this.tenantFile(tenantId), manifest)
  }
  projectCloudDir(tenantId, projectId) {
    assertSafeSegment(tenantId, '租户 ID')
    assertSafeSegment(projectId, '项目 ID')
    return path.join(this.root, tenantId, projectId)
  }
  usage(tenantId) {
    const manifest = this.manifest(tenantId)
    let usedBytes = 0
    for (const entry of Object.values(manifest.projects ?? {})) usedBytes += entry.bytes ?? 0
    return { usedBytes, quotaBytes: this.quotaBytes }
  }
  assertQuota(tenantId, extraBytes = 0) {
    const { usedBytes, quotaBytes } = this.usage(tenantId)
    if (usedBytes + extraBytes > quotaBytes) {
      throw new ApiError(413, 'CLOUD_QUOTA_EXCEEDED', `云存储配额不足：已用 ${fmtBytes(usedBytes)} / 上限 ${fmtBytes(quotaBytes)}`, { usedBytes, quotaBytes })
    }
  }
  // 上云：将项目数据目录镜像到云端区，返回用量（projectId 目录已存在时先清理旧镜像）
  archive(tenantId, projectId, projectDir) {
    if (!this.root) throw new ApiError(503, 'CLOUD_NOT_CONFIGURED', '云存储未启用（persist=0 或未配置云端区）')
    assertSafeSegment(tenantId, '租户 ID')
    assertSafeSegment(projectId, '项目 ID')
    if (!fs.existsSync(projectDir)) throw new ApiError(404, ERR.PROJECT_NOT_FOUND, `项目数据不存在：${projectId}`)
    const target = this.projectCloudDir(tenantId, projectId)
    const staged = `${target}.staging-${process.pid}`
    fs.rmSync(staged, { recursive: true, force: true })
    const manifest = this.manifest(tenantId)
    manifest.projects ??= {}
    const previousBytes = manifest.projects[projectId]?.bytes ?? 0
    this.assertQuota(tenantId, dirSize(projectDir) - previousBytes)
    let bytes
    try {
      fs.cpSync(projectDir, staged, { recursive: true })
      bytes = dirSize(staged)
      this.assertQuota(tenantId, bytes - previousBytes)
    } catch (error) {
      fs.rmSync(staged, { recursive: true, force: true })
      throw error
    }
    fs.rmSync(target, { recursive: true, force: true })
    fs.renameSync(staged, target)
    manifest.projects[projectId] = { bytes, syncedAt: now() }
    this.saveManifest(tenantId, manifest)
    return { bytes, usage: this.usage(tenantId) }
  }
  removeProject(tenantId, projectId) {
    if (!this.root) return
    const manifest = this.manifest(tenantId)
    if (manifest.projects?.[projectId]) {
      delete manifest.projects[projectId]
      this.saveManifest(tenantId, manifest)
    }
    fs.rmSync(this.projectCloudDir(tenantId, projectId), { recursive: true, force: true })
  }
  removeTenant(tenantId) {
    if (!this.root) return
    assertSafeSegment(tenantId, '租户 ID')
    fs.rmSync(path.join(this.root, tenantId), { recursive: true, force: true })
  }
  listProjects(tenantId) {
    return Object.entries(this.manifest(tenantId).projects ?? {}).map(([projectId, entry]) => ({ projectId, ...entry }))
  }
}

export function fmtBytes(bytes) {
  const value = Number(bytes) || 0
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(2)} GB`
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`
  if (value >= 1024) return `${(value / 1024).toFixed(1)} KB`
  return `${value} B`
}

// 数据保留清扫：未上云项目超过保留期后整体清除（软删除至 .trash + 移除协作层记录）。
// 本机用户（ownerId==='local-user'）的项目不受清扫影响（桌面端无云端概念）。
export function sweepRetention({ platformProjectStore, fileProjectStore, cloudStore, retentionDays = DEFAULT_RETENTION_DAYS, now: at = now, onSwept } = {}) {
  const deadlineMs = retentionDays * DAY_MS
  const swept = []
  for (const project of [...platformProjectStore.state.projects]) {
    if (project.cloudEnabled === true) continue
    if (project.ownerId === 'local-user') continue
    const lastActive = Math.max(project.updatedAt ?? 0, project.createdAt ?? 0)
    if (lastActive && at() - lastActive <= deadlineMs) continue
    try { fileProjectStore?.delete(project.projectId) } catch { /* 目录可能已不存在 */ }
    try { cloudStore?.removeProject(project.ownerId, project.projectId) } catch { /* 云端未启用 */ }
    platformProjectStore.state.projects = platformProjectStore.state.projects.filter((item) => item.projectId !== project.projectId)
    swept.push({ projectId: project.projectId, ownerId: project.ownerId, lastActive })
    onSwept?.(project)
  }
  if (swept.length) platformProjectStore.persist()
  return swept
}

export function startRetentionScheduler({ platformProjectStore, fileProjectStore, cloudStore, retentionDays, intervalMs = 6 * 60 * 60 * 1000, onSwept } = {}) {
  if (!retentionDays || retentionDays <= 0) return { stop() { /* 未启用 */ }, sweep: () => [] }
  const run = () => {
    try {
      return sweepRetention({ platformProjectStore, fileProjectStore, cloudStore, retentionDays, onSwept })
    } catch { return [] }
  }
  run()
  const timer = setInterval(run, intervalMs)
  timer.unref?.()
  return { stop: () => clearInterval(timer), sweep: run }
}

export function resolveRetentionDays({ remoteEnabled } = {}) {
  const raw = process.env.LOCAL_AGENT_RETENTION_DAYS
  if (raw !== undefined && raw !== '') {
    const value = Number(raw)
    if (Number.isFinite(value) && value >= 0) return value
  }
  return remoteEnabled ? DEFAULT_RETENTION_DAYS : 0
}

export const cloudUsageView = (usage) => ({ ...clone(usage), usedText: fmtBytes(usage.usedBytes), quotaText: fmtBytes(usage.quotaBytes) })
