// 本地持久化（架构 6.3：本地 SQLite + 对象存储的零依赖文件态实现）。
// 布局（阶段 1 起，项目制物理隔离，见设计文档 A.5）：
//   .data/projects/<projectId>/tasks/<taskId>/
//       data.csv         原始上传字节
//       meta.json        创建参数
//       events.jsonl     结构化事件追加日志（快照由重放得到）
//       runs/<planId>/attempt-N/  每次执行的代码与产物（修复证据链）
//   兼容旧扁平布局：
//   .data/tasks/<taskId>/...
// 进程重启后扫描两处目录、重放事件即可恢复任务；可用 LOCAL_AGENT_DATA_DIR 改位置，LOCAL_AGENT_PERSIST=0 关闭。
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { assertSafeSegment } from './safe.js'
import { ApiError, ERR } from './errors.js'

export function assertContainedRealPath(root, candidate) {
  const rootReal = fs.realpathSync(root)
  const candidateReal = fs.realpathSync(candidate)
  const relative = path.relative(rootReal, candidateReal)
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    throw new ApiError(400, ERR.PATH_OUTSIDE_TASK, '路径超出任务目录')
  }
  return candidateReal
}

export class FileStorage {
  constructor(root) {
    this.root = root ?? path.join(process.cwd(), '.data')
    // 根目录必须是绝对路径，避免相对路径与任务片段拼接时越出预期数据区
    this.root = path.resolve(this.root)
    fs.mkdirSync(path.join(this.root, 'tasks'), { recursive: true })
    fs.mkdirSync(path.join(this.root, 'projects'), { recursive: true })
    // taskId -> projectId 索引：登记过项目归属的任务落盘在项目目录下；
    // 未登记的任务落在旧扁平 .data/tasks/。restore() 时会扫描两处重建该索引。
    this.taskLocations = new Map()
  }

  /** 项目内任务目录：.data/projects/<projectId>/tasks/<taskId> */
  projectTaskDir(projectId, taskId) {
    assertSafeSegment(projectId, '项目 ID')
    assertSafeSegment(taskId, '任务 ID')
    return path.join(this.root, 'projects', projectId, 'tasks', taskId)
  }

  /**
   * 解析项目任务目录下的相对片段为真实路径，并校验其确在任务目录之内（防目录穿越）。
   * 所有跨层文件访问必须经此入口，禁止自行拼接路径。
   */
  resolveTaskPath(projectId, taskId, ...segments) {
    const base = this.projectTaskDir(projectId, taskId)
    const candidate = path.join(base, ...segments)
    return assertContainedRealPath(base, candidate)
  }

  /**
   * 任务目录（兼容旧扁平布局）。
   * @deprecated 新代码应显式传入 projectId；无 projectId 时按已登记归属回退到扁平目录。
   */
  taskDir(taskId, projectId) {
    assertSafeSegment(taskId, '任务 ID')
    return this._dirFor(taskId, projectId)
  }

  // 内部统一解析任务目录：显式 projectId 优先；否则查登记索引；否则旧扁平目录
  _dirFor(taskId, projectId) {
    if (projectId) {
      assertSafeSegment(projectId, '项目 ID')
      return path.join(this.root, 'projects', projectId, 'tasks', taskId)
    }
    const located = this.taskLocations.get(taskId)
    if (located) return path.join(this.root, 'projects', located.projectId, 'tasks', taskId)
    return path.join(this.root, 'tasks', taskId)
  }

  initTask(taskId, meta, csvBuffer, projectId) {
    if (projectId) {
      assertSafeSegment(projectId, '项目 ID')
      this.taskLocations.set(taskId, { projectId })
    }
    const dir = this._dirFor(taskId, projectId)
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2), 'utf-8')
    fs.writeFileSync(path.join(dir, 'data.csv'), csvBuffer)
    fs.writeFileSync(path.join(dir, 'events.jsonl'), '', 'utf-8')
  }

  replaceDataset(taskId, metaPatch, csvBuffer, projectId) {
    const dir = this._dirFor(taskId, projectId ?? this.taskLocations.get(taskId)?.projectId)
    const metaFile = path.join(dir, 'meta.json')
    const current = fs.existsSync(metaFile) ? JSON.parse(fs.readFileSync(metaFile, 'utf-8')) : {}
    const tempData = path.join(dir, `.data-${process.pid}.tmp`)
    const tempMeta = path.join(dir, `.meta-${process.pid}.tmp`)
    fs.writeFileSync(tempData, csvBuffer)
    fs.writeFileSync(tempMeta, JSON.stringify({ ...current, ...metaPatch }, null, 2), 'utf-8')
    fs.renameSync(tempData, path.join(dir, 'data.csv'))
    fs.renameSync(tempMeta, metaFile)
  }

  appendEvent(taskId, event) {
    const file = path.join(this._dirFor(taskId), 'events.jsonl')
    fs.appendFileSync(file, JSON.stringify(event) + '\n', 'utf-8')
  }

  runDir(taskId, planId, attempt) {
    assertSafeSegment(planId, '方案 ID')
    if (!Number.isInteger(attempt) || attempt < 1) throw new Error('非法执行轮次目录')
    const dir = path.join(this._dirFor(taskId), 'runs', planId, `attempt-${attempt}`)
    fs.mkdirSync(dir, { recursive: true })
    return dir
  }

  listRunArtifacts(taskId, planId) {
    assertSafeSegment(planId, '方案 ID')
    const runs = path.join(this._dirFor(taskId), 'runs', planId)
    if (!fs.existsSync(runs)) return { dir: null, attempts: [] }
    const attempts = fs
      .readdirSync(runs)
      .filter((d) => d.startsWith('attempt-'))
      .sort()
    return { dir: runs, attempts }
  }

  readArtifact(taskId, planId, fileName) {
    assertSafeSegment(planId, '方案 ID')
    assertSafeSegment(fileName, '产物文件名')
    const { attempts } = this.listRunArtifacts(taskId, planId)
    for (let i = attempts.length - 1; i >= 0; i--) {
      const fp = path.join(this._dirFor(taskId), 'runs', planId, attempts[i], fileName)
      // 归一化后必须仍位于任务目录内（防御符号链接/异常分隔符导致的越权读取）
      const taskRoot = this._dirFor(taskId)
      const inside = path.resolve(fp).startsWith(path.resolve(taskRoot) + path.sep)
      if (!inside) continue
      if (fs.existsSync(fp)) return assertContainedRealPath(taskRoot, fp)
    }
    return null
  }

  deleteTask(taskId, projectId) {
    const dir = this._dirFor(taskId, projectId ?? this.taskLocations.get(taskId)?.projectId)
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true })
    this.taskLocations.delete(taskId)
  }

  loadPreferences() {
    const file = path.join(this.root, 'preferences.json')
    if (!fs.existsSync(file)) return { paused: false, events: [] }
    try {
      const value = JSON.parse(fs.readFileSync(file, 'utf-8'))
      return { paused: value.paused === true, events: Array.isArray(value.events) ? value.events : [] }
    } catch (e) {
      process.stderr.write(`[storage] preferences.json 损坏，使用空偏好：${e.message}\n`)
      return { paused: false, events: [] }
    }
  }

  savePreferences(state) {
    const file = path.join(this.root, 'preferences.json')
    const temp = path.join(this.root, `.preferences-${process.pid}.tmp`)
    fs.writeFileSync(temp, JSON.stringify(state, null, 2), 'utf-8')
    fs.renameSync(temp, file)
  }

  // 读取单个任务目录的持久化记录（meta/events/bytes/artifacts）
  #readTaskRecord(taskDir, taskId, projectId) {
    const meta = JSON.parse(fs.readFileSync(path.join(taskDir, 'meta.json'), 'utf-8'))
    const events = fs
      .readFileSync(path.join(taskDir, 'events.jsonl'), 'utf-8')
      .split(/\r?\n/)
      .filter(Boolean)
      .map((line) => JSON.parse(line))
    const csvPath = path.join(taskDir, 'data.csv')
    const bytes = fs.existsSync(csvPath) ? fs.readFileSync(csvPath) : Buffer.alloc(0)
    const runsRoot = path.join(taskDir, 'runs')
    const artifacts = {}
    if (fs.existsSync(runsRoot)) {
      for (const planId of fs.readdirSync(runsRoot)) {
        const { attempts } = this.listRunArtifacts(taskId, planId)
        artifacts[planId] = attempts
      }
    }
    return { taskId, projectId: projectId ?? null, meta, events, bytes, artifacts }
  }

  /** 扫描并加载全部任务（事件日志 + 元数据 + 原始字节 + 产物索引）：
   *  同时覆盖旧扁平 .data/tasks/ 与项目目录 .data/projects/<pid>/tasks/<tid>/ */
  loadAll() {
    const out = []
    // 1) 旧扁平目录
    const tasksRoot = path.join(this.root, 'tasks')
    if (fs.existsSync(tasksRoot)) {
      for (const taskId of fs.readdirSync(tasksRoot)) {
        const dir = path.join(tasksRoot, taskId)
        if (!fs.statSync(dir).isDirectory()) continue
        try {
          out.push(this.#readTaskRecord(dir, taskId))
        } catch (e) {
          process.stderr.write(`[storage] 跳过损坏任务 ${taskId}: ${e.message}\n`)
        }
      }
    }
    // 2) 项目目录
    const projectsRoot = path.join(this.root, 'projects')
    if (fs.existsSync(projectsRoot)) {
      for (const projectId of fs.readdirSync(projectsRoot)) {
        const projectTasks = path.join(projectsRoot, projectId, 'tasks')
        if (!fs.existsSync(projectTasks)) continue
        for (const taskId of fs.readdirSync(projectTasks)) {
          const dir = path.join(projectTasks, taskId)
          if (!fs.statSync(dir).isDirectory()) continue
          try {
            this.taskLocations.set(taskId, { projectId })
            out.push(this.#readTaskRecord(dir, taskId, projectId))
          } catch (e) {
            process.stderr.write(`[storage] 跳过损坏任务 ${taskId}: ${e.message}\n`)
          }
        }
      }
    }
    return out
  }
}

export function tempDataDir(prefix = 'local-agent-test-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix))
}
