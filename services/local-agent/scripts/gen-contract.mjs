// 抓取真实任务的快照与事件（含 select/feedback/complete 全流程），生成：
//   contract/fixtures.ts  —— 用 apps/web 的 TypeScript 类型做结构校验（tsc --noEmit）
//   contract/fixtures.json —— 供 test/contract.test.js 做跨端枚举/字段/事件名契约断言
import { createServer } from '../src/server.js'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.resolve(here, '..')
const contractDir = path.join(root, 'contract')
fs.mkdirSync(contractDir, { recursive: true })

function multipart(fields, file) {
  const boundary = '----contract-boundary'
  const parts = []
  for (const [k, v] of Object.entries(fields)) {
    parts.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${k}"\r\n\r\n${v}\r\n`))
  }
  parts.push(
    Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="${file.name}"\r\nContent-Type: text/csv\r\n\r\n`)
  )
  parts.push(file.buffer, Buffer.from(`\r\n--${boundary}--\r\n`))
  return { body: Buffer.concat(parts), contentType: `multipart/form-data; boundary=${boundary}` }
}

// 契约只校验结构与语义字段；大体积 SVG/Base64 已由 smoke 校验真实性，不重复写入 Git。
function compactFixture(value) {
  const bulky = new Set(['svg', 'dataBase64', 'pdfBase64', 'pngBase64'])
  return JSON.parse(JSON.stringify(value, (key, item) => {
    if (bulky.has(key) && typeof item === 'string' && item.length > 4096) {
      return `<omitted:${key}:${item.length}>`
    }
    return item
  }))
}

const agent = createServer({ host: '127.0.0.1', port: 0, token: 'contract-token', stepDelayMs: 1, persist: false })
const { port } = await agent.start()
const base = `http://127.0.0.1:${port}`
const auth = { authorization: 'Bearer contract-token' }
const post = async (p, body) => fetch(`${base}${p}`, { method: 'POST', headers: { ...auth, 'content-type': 'application/json' }, body: JSON.stringify(body) })
const postJson = async (p, body) => {
  const response = await post(p, body)
  const json = await response.json()
  if (!response.ok) throw new Error(`${p} failed: ${response.status} ${JSON.stringify(json)}`)
  return json
}

try {
  const csv = fs.readFileSync(path.join(root, 'examples', 'nitrogen_response_demo.csv'))
  const mp = multipart(
    { prompt: '比较三个处理组随观测周的变化趋势，生成论文用图', engine: 'python' },
    { name: 'nitrogen_response_demo.csv', buffer: csv }
  )
  const created = await (
    await fetch(`${base}/api/tasks`, { method: 'POST', headers: { ...auth, 'content-type': mp.contentType }, body: mp.body })
  ).json()

  // 失败任务快照（UNKNOWN_FIELD）
  const mp2 = multipart(
    { prompt: '请对不存在的字段 revenue 绘制趋势折线图', engine: 'python' },
    { name: 'nitrogen_response_demo.csv', buffer: csv }
  )
  const failed = await (
    await fetch(`${base}/api/tasks`, { method: 'POST', headers: { ...auth, 'content-type': mp2.contentType }, body: mp2.body })
  ).json()

  const events = []
  const ws = new WebSocket(`ws://127.0.0.1:${port}/api/tasks/${created.taskId}/events`)
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve)
    ws.addEventListener('error', reject)
  })
  // 后端 WS 握手后须在 5 秒内发送 {type:'auth', token}（query token 不再被认可，否则返回认证超时）
  ws.send(JSON.stringify({ type: 'auth', token: 'contract-token' }))
  ws.addEventListener('message', (e) => events.push(JSON.parse(e.data)))

  const waitSnapshot = async (id, pred, label, timeout = 30000) => {
    const deadline = Date.now() + timeout
    while (Date.now() < deadline) {
      const t = await (await fetch(`${base}/api/tasks/${id}`, { headers: auth })).json()
      if (pred(t)) return t
      await new Promise((r) => setTimeout(r, 40))
    }
    throw new Error(`等待 ${label} 超时`)
  }

  await waitSnapshot(created.taskId, (t) => t.state === 'PRESENT', '首轮 PRESENT')
  const initialSnapshot = await (await fetch(`${base}/api/tasks/${created.taskId}`, { headers: auth })).json()
  const clarity = initialSnapshot.plans.find((plan) => plan.plan_id === 'plan_clarity')
  const patchPreview = await postJson(`/api/tasks/${created.taskId}/patches/preview`, {
    planId: clarity.plan_id,
    parentVersion: initialSnapshot.currentRevision,
    targetKind: 'figure',
    targetId: 'figure',
    path: 'title',
    before: clarity.spec.figure.title,
    after: '契约补丁标题'
  })
  const patchApplied = await postJson(`/api/tasks/${created.taskId}/patches/apply`, { token: patchPreview.preview.token })
  await waitSnapshot(
    created.taskId,
    (t) => t.state === 'PRESENT' && t.currentRevision === patchApplied.revision.version,
    'patch 后 PRESENT'
  )

  // 全局偏好开关必须可暂停并恢复；最终快照作为 Web/Native 契约。
  await postJson('/api/preferences/pause', { paused: true })
  await postJson('/api/preferences/pause', { paused: false })
  const preferenceSnapshot = await (await fetch(`${base}/api/preferences`, { headers: auth })).json()

  // SELECT：ITERATE，三方案保留
  const selectRes = await post(`/api/tasks/${created.taskId}/select`, { planId: 'plan_density' })
  if (selectRes.status !== 200) throw new Error(`select failed: ${selectRes.status}`)
  // FEEDBACK：新 PlotRevision
  const fbRes = await post(`/api/tasks/${created.taskId}/feedback`, { feedback: '改成黑白印刷友好的期刊图' })
  if (fbRes.status !== 202) throw new Error(`feedback failed: ${fbRes.status}`)
  const successSnapshot = await waitSnapshot(
    created.taskId,
    (t) => t.state === 'PRESENT' && (t.planVersions?.some((v) => v.reason === 'feedback') ?? false),
    'feedback 后 PRESENT'
  )
  // COMPLETE：用户确认冻结
  await post(`/api/tasks/${created.taskId}/complete`, {})
  const completeSnapshot = await waitSnapshot(created.taskId, (t) => t.state === 'COMPLETE', 'COMPLETE')

  const failedSnapshot = await waitSnapshot(failed.taskId, (t) => t.state === 'FAILED', '失败任务 FAILED')
  ws.close()

  // 单独生成取消任务，保留服务端重放事件，证明 CANCELLED 是单一、不可逆终态。
  const cancelMp = multipart(
    { prompt: '生成可取消的论文趋势图', engine: 'python' },
    { name: 'nitrogen_response_demo.csv', buffer: csv }
  )
  const cancellable = await (
    await fetch(`${base}/api/tasks`, { method: 'POST', headers: { ...auth, 'content-type': cancelMp.contentType }, body: cancelMp.body })
  ).json()
  await postJson(`/api/tasks/${cancellable.taskId}/cancel`, {})
  const cancelledSnapshot = await waitSnapshot(cancellable.taskId, (t) => t.state === 'CANCELLED', 'CANCELLED')
  const cancelledEvents = []
  const cancelledWs = new WebSocket(`ws://127.0.0.1:${port}/api/tasks/${cancellable.taskId}/events`)
  cancelledWs.addEventListener('message', (event) => cancelledEvents.push(JSON.parse(event.data)))
  await new Promise((resolve, reject) => {
    cancelledWs.addEventListener('open', resolve)
    cancelledWs.addEventListener('error', reject)
  })
  cancelledWs.send(JSON.stringify({ type: 'auth', token: 'contract-token' }))
  await new Promise((resolve) => {
    const timer = setTimeout(resolve, 100)
    cancelledWs.addEventListener('message', (event) => {
      const parsed = JSON.parse(event.data)
      if (parsed.type === 'done' && parsed.state === 'CANCELLED') {
        clearTimeout(timer)
        setTimeout(resolve, 10)
      }
    })
  })
  cancelledWs.close()

  const jsonPayload = compactFixture({
    generatedAt: new Date().toISOString(),
    successSnapshot,
    completeSnapshot,
    failedSnapshot,
    cancelledSnapshot,
    preferenceSnapshot,
    eventStream: events,
    cancelledEvents
  })
  fs.writeFileSync(path.join(contractDir, 'fixtures.json'), JSON.stringify(jsonPayload, null, 2), 'utf-8')

  const compactSuccess = jsonPayload.successSnapshot
  const compactComplete = jsonPayload.completeSnapshot
  const compactFailed = jsonPayload.failedSnapshot
  const compactCancelled = jsonPayload.cancelledSnapshot
  const compactPreferences = jsonPayload.preferenceSnapshot
  const compactEvents = jsonPayload.eventStream
  const compactCancelledEvents = jsonPayload.cancelledEvents

  const out = `// 本文件由 scripts/gen-contract.mjs 依据真实服务响应自动生成，请勿手改。
// 目的：用 apps/web 的 TypeScript 类型对后端真实载荷做结构校验（tsc --noEmit）。
import type { AgentTask, PreferenceSnapshot, TaskEvent } from '../../../apps/web/src/types/index'

export const successSnapshot: AgentTask = ${JSON.stringify(compactSuccess, null, 2)}

export const completeSnapshot: AgentTask = ${JSON.stringify(compactComplete, null, 2)}

export const failedSnapshot: AgentTask = ${JSON.stringify(compactFailed, null, 2)}

export const cancelledSnapshot: AgentTask = ${JSON.stringify(compactCancelled, null, 2)}

export const preferenceSnapshot: PreferenceSnapshot = ${JSON.stringify(compactPreferences, null, 2)}

export const eventStream: TaskEvent[] = ${JSON.stringify(compactEvents, null, 2)}

export const cancelledEvents: TaskEvent[] = ${JSON.stringify(compactCancelledEvents, null, 2)}

// 编译期断言：快照与事件必须可赋值给前端契约类型
export const _assertions: Array<AgentTask | TaskEvent> = [
  successSnapshot,
  completeSnapshot,
  failedSnapshot,
  cancelledSnapshot,
  ...eventStream,
  ...cancelledEvents
]
`
  fs.writeFileSync(path.join(contractDir, 'fixtures.ts'), out, 'utf-8')
  console.log(
    `[contract] fixtures 生成：success/complete/failed/cancelled 快照 + ${events.length + cancelledEvents.length} 事件；planVersions=${successSnapshot.planVersions.length}`
  )
} finally {
  agent.close()
}
