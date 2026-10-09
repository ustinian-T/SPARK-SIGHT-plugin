// 测试公共辅助：在随机端口启动内存态服务、构造 multipart、轮询快照、收集 WS 事件。
import { createServer } from '../src/server.js'
import { probeEngines as realProbeEngines } from '../src/engines.js'

// 本机可能存在解释器冷启动/字体缓存重建/CPU 争用（含其他进程并行跑 Python）：
// 测试环境放宽沙箱超时与快照轮询上限，避免把环境抖动误判为功能失败。
process.env.LOCAL_AGENT_SANDBOX_TIMEOUT_MS ??= '120000'

export const TOKEN = 'test-token'

// 快速探测桩：R/MATLAB 固定不可用；Python 必须反映本机真实依赖（尤其 pandas），
// 否则编排器“缺 pandas 前置降级”会被桩里谎报的 pandas 版本误导，产生可预见的 REPAIR 循环。
// 真实探测仅在模块加载时执行一次，桩在每个测试文件内仍保持快速。
const REAL_ENGINES = realProbeEngines()
export const FAST_PROBE = () => ({
  python: REAL_ENGINES.python,
  r: { engine: 'r', available: false, version: null, note: 'test stub: Rscript 不可用' },
  matlab: { engine: 'matlab', available: false, version: null, license: 'unknown', note: 'test stub' },
  probedAt: new Date().toISOString()
})

export async function startTestServer(stepDelayMs = 1, opts = {}) {
  const agent = createServer({
    host: '127.0.0.1',
    port: 0,
    token: TOKEN,
    stepDelayMs,
    persist: false,
    probeEngines: opts.probeEngines ?? FAST_PROBE,
    ...opts
  })
  const { host, port } = await agent.start()
  const base = `http://${host}:${port}`
  return {
    agent,
    base,
    port,
    token: TOKEN,
    close: () => agent.close()
  }
}

/** 构造 multipart/form-data 请求体 */
export function multipart(fields = {}, files = []) {
  const boundary = '----local-agent-test-boundary-7f3a91'
  const chunks = []
  for (const [name, value] of Object.entries(fields)) {
    chunks.push(Buffer.from(`--${boundary}\r\nContent-Disposition: form-data; name="${name}"\r\n\r\n${value}\r\n`))
  }
  for (const f of files) {
    const buf = Buffer.isBuffer(f.content) ? f.content : Buffer.from(f.content, 'utf-8')
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${f.field ?? 'file'}"; filename="${f.fileName ?? 'upload.csv'}"\r\nContent-Type: ${f.contentType ?? 'text/csv'}\r\n\r\n`
      )
    )
    chunks.push(buf)
    chunks.push(Buffer.from('\r\n'))
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` }
}

export async function createTask(h, { csv, fileName = 'demo.csv', prompt = '比较三个处理组随观测周的变化趋势，生成论文用图', engine = 'python', fieldName = 'file' } = {}) {
  const content = Buffer.isBuffer(csv) ? csv : Buffer.from(csv, 'utf-8')
  const { body, contentType } = multipart(
    { prompt, engine },
    [{ field: fieldName, fileName, content }]
  )
  const res = await fetch(`${h.base}/api/tasks`, {
    method: 'POST',
    headers: {
      'content-type': contentType,
      authorization: `Bearer ${h.token}`,
      'x-agent-protocol': '1'
    },
    body
  })
  const json = await res.json()
  return { res, json }
}

export async function getSnapshot(h, taskId) {
  const res = await fetch(`${h.base}/api/tasks/${taskId}`, {
    headers: { authorization: `Bearer ${h.token}` }
  })
  return { res, json: await res.json() }
}

export async function waitForSnapshot(h, taskId, predicate, { timeout = 120000, interval = 30 } = {}) {
  const deadline = Date.now() + timeout
  let last
  while (Date.now() < deadline) {
    const { json } = await getSnapshot(h, taskId)
    last = json
    if (predicate(json)) return json
    await new Promise((r) => setTimeout(r, interval))
  }
  throw new Error(`等待快照条件超时，最后状态：${JSON.stringify({ state: last?.state, error: last?.error })}`)
}

const TERMINAL_OR_SETTLED = new Set(['PRESENT', 'FAILED', 'COMPLETE', 'NEED_INPUT'])

export async function waitSettled(h, taskId) {
  return waitForSnapshot(h, taskId, (t) => TERMINAL_OR_SETTLED.has(t.state))
}

export async function postJson(h, pathName, body, method = 'POST') {
  const res = await fetch(`${h.base}${pathName}`, {
    method,
    headers: { 'content-type': 'application/json', authorization: `Bearer ${h.token}` },
    body: body === undefined ? undefined : JSON.stringify(body)
  })
  const text = await res.text()
  return { res, json: text ? JSON.parse(text) : null, body: text }
}

export async function getRaw(h, pathName) {
  const res = await fetch(`${h.base}${pathName}`, { headers: { authorization: `Bearer ${h.token}` } })
  const buf = Buffer.from(await res.arrayBuffer())
  return { res, buf }
}

/** 打开事件 WebSocket 并收集消息（P0-6: 握手后通过消息认证） */
export function openEvents(h, taskId, { token = h.token } = {}) {
  const ws = new WebSocket(`ws://127.0.0.1:${h.port}/api/tasks/${taskId}/events`)
  const events = []
  let resolveDone
  const done = new Promise((resolve) => (resolveDone = resolve))
  let resolveOpened
  const opened = new Promise((resolve) => (resolveOpened = resolve))
  let authenticated = false
  
  ws.addEventListener('open', () => {
    ws.send(JSON.stringify({ type: 'auth', token }))
  })
  
  ws.addEventListener('message', (ev) => {
    const data = JSON.parse(ev.data)
    if (data.type === 'authenticated') {
      authenticated = true
      resolveOpened()
      return
    }
    events.push(data)
    if (data.type === 'done' || data.type === 'error') resolveDone(data)
  })
  
  return {
    ws,
    events,
    done,
    opened,
    close: () => ws.close()
  }
}


