#!/usr/bin/env node
// 迁移脚本：把旧扁平任务目录 .data/tasks/<taskId>/ 迁移到项目制布局
//   .data/projects/proj_default/tasks/<taskId>/
// 用法：
//   node scripts/migrate-to-projects.mjs --dry-run     # 只打印计划，不动盘
//   node scripts/migrate-to-projects.mjs                # 执行迁移（先备份）
//   node scripts/migrate-to-projects.mjs --rollback     # 从最近一次备份回滚
// 幂等：已位于项目目录下的任务自动跳过；迁移后旧 .data/tasks/ 保留为空目录。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
// 默认数据目录：仓库根 → services/local-agent/.data；可用 --data-dir 覆盖
const REPO_ROOT = path.resolve(__dirname, '..')
const DEFAULT_DATA_DIR = path.join(REPO_ROOT, 'services', 'local-agent', '.data')
const DEFAULT_PROJECT_ID = 'proj_default'

function parseArgs(argv) {
  const args = { dryRun: false, rollback: false, dataDir: DEFAULT_DATA_DIR }
  for (const a of argv) {
    if (a === '--dry-run') args.dryRun = true
    else if (a === '--rollback') args.rollback = true
    else if (a.startsWith('--data-dir=')) args.dataDir = path.resolve(a.slice('--data-dir='.length))
  }
  return args
}

function readMeta(taskDir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(taskDir, 'meta.json'), 'utf8'))
  } catch {
    return { createdAt: 0 }
  }
}

function projectFile(projectDir) {
  return path.join(projectDir, 'project.json')
}

function readProject(projectDir) {
  try { return JSON.parse(fs.readFileSync(projectFile(projectDir), 'utf8')) }
  catch { return null }
}

function writeProjectAtomic(projectDir, project) {
  fs.mkdirSync(projectDir, { recursive: true })
  const tmp = path.join(projectDir, `project.json.${process.pid}.tmp`)
  fs.writeFileSync(tmp, JSON.stringify(project, null, 2), 'utf8')
  fs.renameSync(tmp, projectFile(projectDir))
}

function ensureDefaultProject(projectsRoot, dryRun) {
  const dir = path.join(projectsRoot, DEFAULT_PROJECT_ID)
  if (fs.existsSync(projectFile(dir))) return dir
  if (!dryRun) {
    fs.mkdirSync(path.join(dir, 'tasks'), { recursive: true })
    const now = Date.now()
    writeProjectAtomic(dir, {
      projectId: DEFAULT_PROJECT_ID,
      name: '未分类任务',
      description: '由迁移脚本自动创建，承接旧扁平布局中的任务',
      createdAt: now,
      updatedAt: now,
      owner: 'local-user',
      tenantId: 'local',
      visibility: 'private',
      status: 'active',
      settings: { interpreters: {}, model: {} },
      preferences: {},
      taskIds: [],
      chartUsage: {},
      collaboration: { comments: [], locks: [], shares: [], syncState: {} },
      sourceFolder: null
    })
    fs.writeFileSync(path.join(dir, 'preferences.json'), '{}', 'utf8')
    fs.writeFileSync(path.join(dir, 'audit.jsonl'), '', 'utf8')
    fs.writeFileSync(path.join(dir, 'grants.jsonl'), '', 'utf8')
  }
  return dir
}

function listFlatTasks(dataDir) {
  const flatRoot = path.join(dataDir, 'tasks')
  if (!fs.existsSync(flatRoot)) return []
  const out = []
  for (const entry of fs.readdirSync(flatRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const taskDir = path.join(flatRoot, entry.name)
    // 幂等：必须有 meta.json 才算有效任务目录
    if (!fs.existsSync(path.join(taskDir, 'meta.json'))) continue
    out.push({ taskId: entry.name, taskDir, createdAt: readMeta(taskDir).createdAt ?? 0 })
  }
  out.sort((a, b) => a.createdAt - b.createdAt)
  return out
}

function backupData(dataDir) {
  const ts = new Date().toISOString().replace(/[:.]/g, '-')
  const backupRoot = path.join(path.dirname(dataDir), `${path.basename(dataDir)}.backup.${ts}`)
  fs.cpSync(dataDir, backupRoot, { recursive: true })
  return backupRoot
}

function latestBackup(dataDir) {
  const parent = path.dirname(dataDir)
  const base = path.basename(dataDir)
  const backups = fs.readdirSync(parent, { withFileTypes: true })
    .filter((e) => e.isDirectory() && e.name.startsWith(`${base}.backup.`))
    .map((e) => e.name)
    .sort()
  return backups.length ? path.join(parent, backups.at(-1)) : null
}

function main() {
  const args = parseArgs(process.argv.slice(2))
  const dataDir = path.resolve(args.dataDir)
  const projectsRoot = path.join(dataDir, 'projects')

  if (args.rollback) {
    const backup = latestBackup(dataDir)
    if (!backup) {
      console.error('[migrate] 未找到任何备份，无法回滚。')
      process.exit(1)
    }
    console.log(`[migrate] 回滚：用 ${backup} 覆盖 ${dataDir}`)
    if (!args.dryRun) {
      fs.rmSync(dataDir, { recursive: true, force: true })
      fs.cpSync(backup, dataDir, { recursive: true })
    }
    console.log('[migrate] 回滚完成。')
    return
  }

  if (!fs.existsSync(dataDir)) {
    console.log(`[migrate] 数据目录不存在，无需迁移：${dataDir}`)
    return
  }

  const tasks = listFlatTasks(dataDir)
  if (tasks.length === 0) {
    console.log(`[migrate] 旧扁平目录 ${dataDir}/tasks 为空（或无有效任务），无需迁移。`)
    return
  }

  console.log(`[migrate] 发现 ${tasks.length} 个旧任务，目标项目 ${DEFAULT_PROJECT_ID}`)
  const projectDir = ensureDefaultProject(projectsRoot, args.dryRun)
  const targetTasksRoot = path.join(projectDir, 'tasks')

  for (const t of tasks) {
    const target = path.join(targetTasksRoot, t.taskId)
    if (fs.existsSync(target)) {
      console.log(`  跳过（已在项目目录下）：${t.taskId}`)
      continue
    }
    console.log(`  ${t.dryRun ? '[计划]' : '[迁移]'} ${t.taskDir} -> ${target}`)
  }

  if (args.dryRun) {
    console.log('[migrate] --dry-run 结束：未移动任何文件、未写 project.json。')
    return
  }

  // 正式执行：先备份
  const backupRoot = backupData(dataDir)
  console.log(`[migrate] 已备份 .data -> ${backupRoot}`)

  fs.mkdirSync(targetTasksRoot, { recursive: true })
  const project = readProject(projectDir) || { taskIds: [] }
  project.taskIds = Array.isArray(project.taskIds) ? project.taskIds : []

  for (const t of tasks) {
    const target = path.join(targetTasksRoot, t.taskId)
    if (fs.existsSync(target)) continue // 幂等
    fs.renameSync(t.taskDir, target)
    if (!project.taskIds.includes(t.taskId)) project.taskIds.push(t.taskId)
  }
  project.taskIds.sort((a, b) => {
    // 按原 createdAt 排序：迁移时已按 createdAt 排序 push，这里读 meta 兜底
    const ma = readMeta(path.join(targetTasksRoot, a)).createdAt ?? 0
    const mb = readMeta(path.join(targetTasksRoot, b)).createdAt ?? 0
    return ma - mb
  })
  project.updatedAt = Date.now()
  writeProjectAtomic(projectDir, project)

  // 旧目录保留为空（若空）
  const flatRoot = path.join(dataDir, 'tasks')
  const leftover = fs.existsSync(flatRoot) ? fs.readdirSync(flatRoot).filter((n) => n !== '') : []
  console.log(`[migrate] 完成：${tasks.length} 个任务已迁入 ${DEFAULT_PROJECT_ID}，project.taskIds=${project.taskIds.length}`)
  if (leftover.length) console.log(`[migrate] 提示：旧目录仍残留 ${leftover.length} 个条目：${leftover.join(', ')}`)
}

main()
