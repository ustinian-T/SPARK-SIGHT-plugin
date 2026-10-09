// 端到端冒烟脚本：启动本地服务 → 上传 examples 中的 CSV → WebSocket 收集事件
// → 校验八状态顺序、沙箱真实执行、证据绑定、补丁修订、偏好开关、预览/导出/trace → 输出能力探测。
// 运行：npm run smoke
import { createServer } from '../src/server.js'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

function multipart(fields, file) {
  const boundary = '----smoke-boundary'
  const parts = []
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`))
  }
  parts.push(
    Buffer.from(
      `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: text/csv\r\n\r\n`
    )
  )
  parts.push(file.buffer, Buffer.from(`\r\n--${boundary}--\r\n`))
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` }
}

// 冒烟使用内存态（persist:false），避免反复写入 .data
process.env.LOCAL_AGENT_APPROVAL_MODE = 'auto'
const agent = createServer({ host: '127.0.0.1', port: 0, token: 'smoke-token', stepDelayMs: 20, persist: false })
const { port } = await agent.start()
const base = `http://127.0.0.1:${port}`
const auth = { authorization: 'Bearer smoke-token' }
const postJson = async (pathName, body) => {
  const response = await fetch(`${base}${pathName}`, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify(body)
  })
  const json = await response.json()
  if (!response.ok) throw new Error(`${pathName} → ${response.status}: ${JSON.stringify(json)}`)
  return json
}

try {
  // 1. 健康检查
  const health = await (await fetch(`${base}/health`)).json()
  console.log('[health]', health.status, 'protocol v' + health.protocol, 'version', health.version)

  // 2. 创建任务
  const csv = fs.readFileSync(path.join(root, 'examples', 'nitrogen_response_demo.csv'))
  const mp = multipart(
    { prompt: '比较三个处理组随观测周的变化趋势，生成论文用图', engine: 'python' },
    { name: 'nitrogen_response_demo.csv', buffer: csv }
  )
  const created = await (
    await fetch(`${base}/api/tasks`, { method: 'POST', headers: { ...auth, 'content-type': mp.contentType }, body: mp.body })
  ).json()
  console.log('[create]', created.taskId, created.state)

  // 3. WebSocket 收集事件
  const events = []
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/tasks/${created.taskId}/events`)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', reject)
  })
  const done = new Promise((resolve) => ws.addEventListener('message', (e) => {
    const ev = JSON.parse(e.data)
    events.push(ev)
    if (ev.type === 'done' || ev.type === 'error') resolve(ev)
  }))
  ws.send(JSON.stringify({ type: 'auth', token: 'smoke-token' }))
  const last = await done
  ws.close()

  const states = events.filter((e) => e.type === 'state_delta').map((e) => e.state)
  console.log('[states]', states.join(' → '))
  console.log('[last]  ', last.type, '-', (last.message ?? last.code ?? '').slice(0, 120))

  // 4. 快照核对
  const task = await (await fetch(`${base}/api/tasks/${created.taskId}`, { headers: auth })).json()
  console.log('[dataset]', `${task.dataset.rows} 行 × ${task.dataset.cols} 列`, '指纹', task.dataset.fingerprint.slice(0, 16) + '…')
  console.log('[evidence]', task.evidence.length, '条；', task.evidence.map((e) => e.evidence_id).join(', '))
  const shared = new Set(task.plans.map((p) => JSON.stringify(p.evidenceIds)))
  console.log('[plans]', task.plans.length, '套；evidenceIds 集合数 =', shared.size, '（应为 1）；执行状态 =', task.plans.map((p) => p.executionStatus).join(', '))
  for (const p of task.plans) {
    const art = task.planArtifacts[p.plan_id]
    console.log('   -', p.plan_id, p.name, '| 差异维度', p.diffDimensions.length, '| 总分', p.score.total, '| PNG', art.png ? `${art.png.width}x${art.png.height}` : 'NA')
  }
  const failedSteps = task.steps.filter((s) => s.status === 'failed' || s.status === 'skipped').map((s) => s.step_id)
  console.log('[steps]  failed/skipped =', failedSteps.length ? failedSteps.join(', ') : '无')
  console.log('[verify]', task.verification.passed ? '三项独立验证全部通过' : '存在未通过项')
  console.log('[exec]  ', task.execution.status, '| 自动修复', task.retries, '次 | SVG', task.execution.artifactSvg?.length ?? 0, '字节')

  // 5. 对真实任务应用单字段补丁，仅重新执行受影响方案。
  const clarity = task.plans.find((plan) => plan.plan_id === 'plan_clarity')
  const patchPreview = await postJson(`/api/tasks/${created.taskId}/patches/preview`, {
    planId: clarity.plan_id,
    parentVersion: task.currentRevision,
    targetKind: 'figure',
    targetId: 'figure',
    path: 'title',
    before: clarity.spec.figure.title,
    after: 'Smoke 补丁标题'
  })
  const patchApplied = await postJson(`/api/tasks/${created.taskId}/patches/apply`, { token: patchPreview.preview.token })
  const patchedTask = await (await fetch(`${base}/api/tasks/${created.taskId}`, { headers: auth })).json()
  console.log('[patch] ', `v${task.currentRevision} → v${patchApplied.revision.version}`, patchedTask.plans.find((p) => p.plan_id === 'plan_clarity').spec.figure.title)

  // 6. 偏好学习可以全局暂停并恢复。
  await postJson('/api/preferences/pause', { paused: true })
  await postJson('/api/preferences/pause', { paused: false })
  const preferences = await (await fetch(`${base}/api/preferences`, { headers: auth })).json()
  console.log('[prefs] ', preferences.paused ? '已暂停' : '已恢复', preferences.events.length, '条')

  // 7. 预览 / 导出 / trace
  const preview = await (await fetch(`${base}/api/tasks/${created.taskId}/preview?planId=plan_density`, { headers: auth })).json()
  console.log('[preview]', preview.planId, `${preview.width}x${preview.height}`, 'SVG', preview.svg.length, '字节')

  const zipRes = await fetch(`${base}/api/tasks/${created.taskId}/export?planId=plan_clarity`, { headers: auth })
  const zipBuf = Buffer.from(await zipRes.arrayBuffer())
  const names = []
  let q = 0
  while (zipBuf.readUInt32LE(q) === 0x04034b50) {
    const nameLen = zipBuf.readUInt16LE(q + 26)
    const extraLen = zipBuf.readUInt16LE(q + 28)
    const compSize = zipBuf.readUInt32LE(q + 18)
    names.push(zipBuf.toString('utf-8', q + 30, q + 30 + nameLen))
    q = q + 30 + nameLen + extraLen + compSize
  }
  console.log('[export] zip', zipBuf.length, '字节，含', names.length, '个文件：', names.join(', '))

  const trace = await (await fetch(`${base}/api/tasks/${created.taskId}/trace`, { headers: auth })).json()
  console.log('[trace] ', trace.trace.states.length, '个状态节点，', trace.trace.eventCount, '个事件，错误签名', trace.trace.errors.length, '条')

  // 8. 错误响应
  const bad = await fetch(`${base}/api/tasks/nope`, { headers: auth })
  console.log('[errors]', '未知任务 →', bad.status, (await bad.json()).error.code)

  // 9. 能力探测（真实检测本机解释器）
  const caps = await (await fetch(`${base}/api/capabilities`, { headers: auth })).json()
  for (const [k, v] of Object.entries(caps.runtimes)) {
    if (k === 'probedAt') continue
    console.log('[engine]', k.padEnd(6), v.available ? `available (${v.version ?? v.license ?? ''})` : `unavailable - ${v.note}`)
  }

  // 断言
  const statePath = states.join('→')
  const validStatePath = /^INGEST→UNDERSTAND→PLAN→ANALYZE→DESIGN→EXECUTE(?:→REPAIR→EXECUTE)*→VERIFY→PRESENT$/
  if (!validStatePath.test(statePath)) throw new Error(`状态顺序不符：${statePath}`)
  if (shared.size !== 1) throw new Error('三方案未共享同一证据集合')
  if (task.evidence.length < 8) throw new Error('证据数量异常')
  if (!task.verification.passed) throw new Error('独立验证未全部通过')
  if (!task.plans.every((p) => p.executionStatus === 'verified')) throw new Error('存在未验证通过的方案')
  if (patchedTask.currentRevision !== patchApplied.revision.version) throw new Error('补丁修订未成为当前版本')
  if (patchedTask.plans.find((p) => p.plan_id === 'plan_clarity')?.spec?.figure?.title !== 'Smoke 补丁标题') throw new Error('补丁未落到目标字段')
  if (!trace.trace.revisions.some((revision) => revision.reason === 'patch')) throw new Error('trace 缺少 patch 修订')
  if (preferences.paused) throw new Error('偏好学习未从暂停恢复')
  if (!preview.svg.includes('<svg')) throw new Error('预览 SVG 异常')
  if (!names.includes('plot.py') || !names.includes('artifacts/plan_clarity.svg')) throw new Error('导出 zip 条目缺失')
  console.log('\nSMOKE OK')
  await sleep(10)
  process.exit(0)
} catch (e) {
  console.error('SMOKE FAILED', e)
  process.exit(1)
} finally {
  agent.close()
}
