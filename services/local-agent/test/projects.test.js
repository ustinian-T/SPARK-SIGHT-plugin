import test, { after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { execFile } from 'node:child_process'
import { ProjectStore, PROJECT_FORMAT_VERSION } from '../src/projects.js'
import { ProjectStore as FileProjectStore, DEFAULT_PROJECT_ID } from '../src/projectStore.js'
import { startTestServer, postJson, multipart, waitForSnapshot } from './helpers.js'

const h = await startTestServer()
after(async () => h.close())

// ---- 阶段 1：文件态项目制（FileProjectStore）持久化测试服务 ----
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..')
const migrateScript = path.join(REPO_ROOT, 'scripts', 'migrate-to-projects.mjs')
const execFileAsync = promisify(execFile)

const persistDir = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-imaging-fileproj-'))
const ph = await startTestServer(1, { dataDir: persistDir, persist: true })
after(async () => ph.close())

const fp = ph.agent.fileProjectStore
const AUTH = { authorization: `Bearer ${ph.token}`, 'content-type': 'application/json' }

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'deep-imaging-project-'))
}

test('recovers an interrupted default-project atomic write without deleting existing files', () => {
  const root = tempRoot()
  const store = new FileProjectStore(root)
  const dir = store.projectDir(DEFAULT_PROJECT_ID)
  fs.mkdirSync(path.join(dir, 'tasks'), { recursive: true })
  const pending = path.join(dir, 'project.json.12345.tmp')
  fs.writeFileSync(pending, JSON.stringify({ projectId: DEFAULT_PROJECT_ID, name: '未分类任务', taskIds: [], status: 'active' }))
  const restored = store.recoverInterruptedCreate(DEFAULT_PROJECT_ID)
  assert.equal(restored.projectId, DEFAULT_PROJECT_ID)
  assert.equal(store.get(DEFAULT_PROJECT_ID).name, '未分类任务')
  assert.equal(fs.existsSync(pending), true, '保留原子写临时文件供人工审计')
  fs.rmSync(root, { recursive: true, force: true })
})


test('creates and reopens a versioned .deep-imaging project without storing credentials', () => {
  const root = tempRoot()
  const store = new ProjectStore()
  const project = store.create(root, {
    name: 'Research plots',
    settings: { interpreters: { python: 'python' }, model: { provider: 'ark', model: 'doubao-seed-2.0-lite' } }
  })
  assert.equal(project.formatVersion, PROJECT_FORMAT_VERSION)
  assert.equal(project.name, 'Research plots')
  assert.ok(fs.existsSync(path.join(root, '.deep-imaging', 'project.json')))
  assert.ok(fs.existsSync(path.join(root, '.deep-imaging', 'history')))
  assert.doesNotMatch(fs.readFileSync(path.join(root, '.deep-imaging', 'project.json'), 'utf8'), /apiKey|secret|token/i)
  store.close(root)
  assert.equal(store.open(root).projectId, project.projectId)
  store.close(root)
})

test('exclusive lock rejects a second writer and becomes available after close', () => {
  const root = tempRoot()
  const first = new ProjectStore()
  const second = new ProjectStore()
  first.create(root, { name: 'Locked' })
  assert.throws(() => second.open(root), (error) => error.code === 'PROJECT_LOCKED')
  first.close(root)
  assert.doesNotThrow(() => second.open(root))
  second.close(root)
})

test('updates only supported interpreter/model settings and appends project history', () => {
  const root = tempRoot()
  const store = new ProjectStore()
  store.create(root, { name: 'Settings' })
  const updated = store.updateSettings(root, {
    interpreters: { python: 'C:/Python/python.exe', matlab: 'D:/MATLAB/bin/matlab.exe' },
    model: { provider: 'ark', model: 'doubao-seed-2.0-lite', protocol: 'responses' }
  })
  assert.equal(updated.settings.interpreters.matlab, 'D:/MATLAB/bin/matlab.exe')
  assert.equal(updated.settings.model.protocol, 'responses')
  assert.ok(fs.readdirSync(path.join(root, '.deep-imaging', 'history')).length >= 2)
  assert.throws(() => store.updateSettings(root, { apiKey: 'must-not-persist' }), (error) => error.code === 'PROJECT_SETTINGS_INVALID')
  store.close(root)
})

test('project HTTP API creates, updates, closes, and reopens the same project', async () => {
  const root = tempRoot()
  const created = await postJson(h, '/api/projects/create', { root, name: 'API project' })
  assert.equal(created.res.status, 201)
  const projectId = created.json.project.projectId
  const updated = await postJson(h, '/api/projects/settings', { root, settings: { interpreters: { matlab: 'D:/MATLAB/bin/matlab.exe' }, model: { provider: 'ark' } } })
  assert.equal(updated.res.status, 200)
  assert.equal(updated.json.project.settings.interpreters.matlab, 'D:/MATLAB/bin/matlab.exe')
  assert.equal((await postJson(h, '/api/projects/close', { root })).json.closed, true)
  const opened = await postJson(h, '/api/projects/open', { root })
  assert.equal(opened.json.project.projectId, projectId)
  await postJson(h, '/api/projects/close', { root })
})

// ============ 阶段 1：文件态项目制（FileProjectStore） ============

test('文件态项目创建：目录骨架与 A.2 字段完整', () => {
  const project = fp.create({ name: '绘图项目', description: '单元测试', owner: 'tester', tenantId: 'local' })
  const dir = fp.projectDir(project.projectId)
  assert.ok(fs.existsSync(path.join(dir, 'project.json')))
  assert.ok(fs.existsSync(path.join(dir, 'preferences.json')))
  assert.ok(fs.existsSync(path.join(dir, 'audit.jsonl')))
  assert.ok(fs.existsSync(path.join(dir, 'grants.jsonl')))
  assert.ok(fs.existsSync(path.join(dir, 'tasks')))
  const onDisk = JSON.parse(fs.readFileSync(path.join(dir, 'project.json'), 'utf8'))
  assert.equal(onDisk.status, 'active')
  assert.equal(onDisk.owner, 'tester')
  assert.ok(Array.isArray(onDisk.taskIds))
  assert.ok(project.projectId.startsWith('proj_'))
})

test('项目内创建任务：taskIds 命中且物理落盘到项目任务目录', async () => {
  const project = fp.create({ name: '项目-任务联动', owner: 'local-user', tenantId: 'local' })
  const csv = 'group,week,value\nA,1,10\nA,2,12\nB,1,9\nB,2,11\n'
  const { body, contentType } = multipart({ prompt: '对比趋势', engine: 'python' }, [{ field: 'file', fileName: 'd.csv', content: csv }])
  const res = await fetch(`${ph.base}/api/projects/${project.projectId}/tasks`, {
    method: 'POST',
    headers: { 'content-type': contentType, authorization: `Bearer ${ph.token}` },
    body
  })
  assert.equal(res.status, 201)
  const json = await res.json()
  const taskId = json.taskId
  assert.equal(json.projectId, project.projectId)
  // project.json 的 taskIds 已登记
  const reloaded = fp.get(project.projectId)
  assert.ok(reloaded.taskIds.includes(taskId))
  // 物理目录在项目内
  assert.ok(fs.existsSync(path.join(fp.taskDir(project.projectId, taskId), 'data.csv')))

  // 列表接口返回摘要
  const listRes = await fetch(`${ph.base}/api/projects/${project.projectId}/tasks`, { headers: AUTH })
  const listJson = await listRes.json()
  assert.equal(listRes.status, 200)
  const found = listJson.tasks.find((t) => t.taskId === taskId)
  assert.ok(found)
  assert.equal(found.taskIndex, 1)
  // 清理
  await fetch(`${ph.base}/api/projects/${project.projectId}/tasks/${taskId}`, { method: 'DELETE', headers: AUTH })
})

test('项目内任务取消：项目作用域 cancel 路由与兼容任务路由语义一致', async () => {
  const project = fp.create({ name: '项目取消', owner: 'local-user', tenantId: 'local' })
  const csv = 'x,y\n1,2\n3,4\n'
  const { body, contentType } = multipart({ prompt: '趋势图', engine: 'python' }, [{ field: 'file', fileName: 'cancel.csv', content: csv }])
  const created = await (await fetch(`${ph.base}/api/projects/${project.projectId}/tasks`, {
    method: 'POST', headers: { 'content-type': contentType, authorization: `Bearer ${ph.token}` }, body
  })).json()
  const cancelled = await fetch(`${ph.base}/api/projects/${project.projectId}/tasks/${created.taskId}/cancel`, { method: 'POST', headers: AUTH })
  assert.equal(cancelled.status, 200)
  const json = await cancelled.json()
  assert.equal(json.taskId, created.taskId)
  assert.ok(['CANCELLED', 'PRESENT', 'UNDERSTAND'].includes(json.state))
})

test('项目内任务：预览与 trace 走项目作用域并保留归属隔离', async () => {
  const project = fp.create({ name: '项目产物', owner: 'local-user', tenantId: 'local' })
  const csv = 'week,control,treatment\n1,10,12\n2,11,14\n3,13,16\n4,15,18\n'
  const { body, contentType } = multipart({ prompt: '比较两组随周次的变化趋势', engine: 'python' }, [{ field: 'file', fileName: 'preview.csv', content: csv }])
  const created = await (await fetch(`${ph.base}/api/projects/${project.projectId}/tasks`, {
    method: 'POST', headers: { 'content-type': contentType, authorization: `Bearer ${ph.token}` }, body
  })).json()
  const task = await waitForSnapshot(ph, created.taskId, (value) => value.state === 'PRESENT')
  const planId = task.plans.find((plan) => plan.executionStatus === 'verified')?.plan_id
  assert.ok(planId)

  const preview = await fetch(`${ph.base}/api/projects/${project.projectId}/tasks/${created.taskId}/preview?planId=${encodeURIComponent(planId)}`, { headers: AUTH })
  assert.equal(preview.status, 200)
  const previewJson = await preview.json()
  assert.equal(previewJson.planId, planId)
  assert.match(previewJson.svg, /<svg\s/)

  const trace = await fetch(`${ph.base}/api/projects/${project.projectId}/tasks/${created.taskId}/trace`, { headers: AUTH })
  assert.equal(trace.status, 200)
  assert.equal((await trace.json()).trace.taskId, created.taskId)
  await fetch(`${ph.base}/api/projects/${project.projectId}/tasks/${created.taskId}`, { method: 'DELETE', headers: AUTH })
})

test('跨项目访问：项目 A 的任务用项目 B 路径请求返回 403', async () => {
  const projA = fp.create({ name: '项目A', owner: 'local-user', tenantId: 'local' })
  const projB = fp.create({ name: '项目B', owner: 'local-user', tenantId: 'local' })
  const csv = 'x,y\n1,2\n3,4\n'
  const { body, contentType } = multipart({ prompt: 'p', engine: 'python' }, [{ field: 'file', fileName: 'a.csv', content: csv }])
  const created = await (await fetch(`${ph.base}/api/projects/${projA.projectId}/tasks`, {
    method: 'POST', headers: { 'content-type': contentType, authorization: `Bearer ${ph.token}` }, body
  })).json()
  // 项目 B 请求 A 的任务详情 → 403
  const res = await fetch(`${ph.base}/api/projects/${projB.projectId}/tasks/${created.taskId}`, { headers: AUTH })
  assert.equal(res.status, 403)
  const json = await res.json()
  assert.equal(json.error.details.code, 'cross-project-access-denied')
  // 清理
  await fetch(`${ph.base}/api/projects/${projA.projectId}/tasks/${created.taskId}`, { method: 'DELETE', headers: AUTH })
})

test('保存默认任务到协作项目后可通过该项目重新打开', async () => {
  const { body, contentType } = multipart({ prompt: 'saved task', engine: 'python' }, [{ field: 'file', fileName: 'saved.csv', content: 'x,y\n1,2\n3,4\n' }])
  const created = await (await fetch(`${ph.base}/api/tasks`, { method: 'POST', headers: { 'content-type': contentType, authorization: `Bearer ${ph.token}` }, body })).json()
  const projectResponse = await fetch(`${ph.base}/api/projects`, { method: 'POST', headers: AUTH, body: JSON.stringify({ name: '保存并重开' }) })
  assert.equal(projectResponse.status, 201)
  const { project } = await projectResponse.json()
  const attached = await fetch(`${ph.base}/api/projects/${project.projectId}/attachments`, { method: 'POST', headers: AUTH, body: JSON.stringify({ taskId: created.taskId }) })
  assert.equal(attached.status, 200)
  const reopened = await fetch(`${ph.base}/api/projects/${project.projectId}/tasks/${created.taskId}`, { headers: AUTH })
  assert.equal(reopened.status, 200)
  assert.equal((await reopened.json()).task.taskId, created.taskId)
  await fetch(`${ph.base}/api/tasks/${created.taskId}`, { method: 'DELETE', headers: AUTH })
})

test('删除项目：目录软删除到 .trash 且 status=deleted', () => {
  const project = fp.create({ name: '待删项目', owner: 'tester', tenantId: 'local' })
  const dir = fp.projectDir(project.projectId)
  assert.ok(fs.existsSync(dir))
  const deleted = fp.delete(project.projectId)
  assert.equal(deleted.status, 'deleted')
  assert.ok(!fs.existsSync(dir))
  assert.ok(fs.existsSync(path.join(persistDir, '.trash', project.projectId, 'project.json')))
})

test('项目偏好读写：合并写并回读', async () => {
  const project = fp.create({ name: '偏好项目', owner: 'local-user', tenantId: 'local' })
  const put = await fetch(`${ph.base}/api/projects/${project.projectId}/preferences`, {
    method: 'PUT', headers: AUTH, body: JSON.stringify({ palette: 'nature', darkMode: true })
  })
  assert.equal(put.status, 200)
  const merged = await fetch(`${ph.base}/api/projects/${project.projectId}/preferences`, { headers: AUTH })
  const mergedJson = await merged.json()
  assert.equal(mergedJson.preferences.palette, 'nature')
  assert.equal(mergedJson.preferences.darkMode, true)
  // 二次 PUT 浅合并
  await fetch(`${ph.base}/api/projects/${project.projectId}/preferences`, {
    method: 'PUT', headers: AUTH, body: JSON.stringify({ darkMode: false })
  })
  const again = await (await fetch(`${ph.base}/api/projects/${project.projectId}/preferences`, { headers: AUTH })).json()
  assert.equal(again.preferences.darkMode, false)
  assert.equal(again.preferences.palette, 'nature')
})

test('审计追加：写入后按 limit 返回时间线', async () => {
  const project = fp.create({ name: '审计项目', owner: 'local-user', tenantId: 'local' })
  fp.appendAudit(project.projectId, { action: 'task.created', taskId: 'task_x' })
  fp.appendAudit(project.projectId, { action: 'preferences.updated' })
  const res = await fetch(`${ph.base}/api/projects/${project.projectId}/audit?limit=10`, { headers: AUTH })
  assert.equal(res.status, 200)
  const json = await res.json()
  assert.equal(json.records.length, 2)
  // 最新在前
  assert.equal(json.records[0].action, 'preferences.updated')
})

test('归档/恢复：POST archive 切换 status', async () => {
  const project = fp.create({ name: '归档项目', owner: 'local-user', tenantId: 'local' })
  const archived = await fetch(`${ph.base}/api/projects/${project.projectId}/archive`, {
    method: 'POST', headers: AUTH, body: JSON.stringify({ archived: true })
  })
  assert.equal(archived.status, 200)
  assert.equal((await archived.json()).status, 'archived')
  const restored = await fetch(`${ph.base}/api/projects/${project.projectId}/archive`, {
    method: 'POST', headers: AUTH, body: JSON.stringify({ archived: false })
  })
  assert.equal((await restored.json()).status, 'active')
})

test('兼容层：POST /api/tasks 归入 proj_default 并带 deprecation 头', async () => {
  const csv = 'a,b\n1,2\n3,4\n'
  const { body, contentType } = multipart({ prompt: 'legacy', engine: 'python' }, [{ field: 'file', fileName: 'legacy.csv', content: csv }])
  const res = await fetch(`${ph.base}/api/tasks`, {
    method: 'POST', headers: { 'content-type': contentType, authorization: `Bearer ${ph.token}` }, body
  })
  assert.equal(res.status, 201)
  assert.match(res.headers.get('x-deprecation-warning'), /\/api\/projects\/:projectId\/tasks/)
  const json = await res.json()
  assert.equal(json.projectId, 'proj_default')
  // proj_default 的 taskIds 已登记该任务
  const def = fp.get('proj_default')
  assert.ok(def.taskIds.includes(json.taskId))
  // 旧 GET /api/tasks/:id 仍可用且带 deprecation 头
  const oldGet = await fetch(`${ph.base}/api/tasks/${json.taskId}`, { headers: AUTH })
  assert.equal(oldGet.status, 200)
  assert.ok(oldGet.headers.get('x-deprecation-warning'))
  await fetch(`${ph.base}/api/tasks/${json.taskId}`, { method: 'DELETE', headers: AUTH })
})

test('迁移脚本 dry-run：打印计划且不移动文件', async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'deep-imaging-migrate-'))
  const flat = path.join(tmp, 'tasks')
  fs.mkdirSync(path.join(flat, 'task_old1'), { recursive: true })
  fs.writeFileSync(path.join(flat, 'task_old1', 'meta.json'), JSON.stringify({ createdAt: 1000, engine: 'python' }))
  fs.writeFileSync(path.join(flat, 'task_old1', 'data.csv'), 'a,b\n1,2\n')
  fs.writeFileSync(path.join(flat, 'task_old1', 'events.jsonl'), '')
  const { stdout } = await execFileAsync(process.execPath, [migrateScript, `--data-dir=${tmp}`, '--dry-run'])
  assert.match(stdout, /发现 1 个旧任务/)
  assert.match(stdout, /task_old1/)
  assert.match(stdout, /dry-run/)
  // dry-run 不建项目目录、不移动
  assert.ok(!fs.existsSync(path.join(tmp, 'projects', 'proj_default', 'tasks', 'task_old1')))
  assert.ok(fs.existsSync(path.join(flat, 'task_old1')))
})

