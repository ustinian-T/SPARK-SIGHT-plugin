// 安全测试（收尾轮）：
//  - 上传文件名路径穿越（../、..\、绝对路径、盘符）不得逃逸工作目录；
//  - planId 越权（../）在 preview/export/select 上被拒；
//  - 空文件 400、超限文件 413；
//  - CSV 表头/单元格中的指令文本（引号逃逸、公式注入、系统命令）只能作为数据，不能作为代码执行；
//  - 对外响应不泄露绝对路径、令牌或敏感环境变量。
import { test, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from '../src/server.js'
import { TOKEN, FAST_PROBE, multipart, waitForSnapshot, getSnapshot, postJson, openEvents } from './helpers.js'
import { generateCode } from '../src/codegen.js'
import { staticSafetyScan } from '../src/sandbox.js'
import { safeCsvName, redactText, assertSafeSegment } from '../src/safe.js'
import { parseMultipart } from '../src/multipart.js'
import { FileStorage } from '../src/storage.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const SAMPLE = fs.readFileSync(path.join(here, 'fixtures', 'nitrogen_response_demo.csv'))

const keepAlive = setTimeout(() => {}, 120000)
after(() => clearTimeout(keepAlive))

async function startServer(opts = {}) {
  const agent = createServer({ host: '127.0.0.1', port: 0, token: TOKEN, stepDelayMs: 1, persist: false, probeEngines: FAST_PROBE, ...opts })
  const { host, port } = await agent.start()
  return { agent, base: `http://${host}:${port}`, port, token: TOKEN }
}

async function upload(base, { fileName, content, prompt = '比较处理组趋势，生成论文用图', engine = 'python' }, rawHeaders) {
  const { body, contentType } = multipart(
    { prompt, engine },
    [{ field: 'file', fileName: fileName ?? 'demo.csv', content: Buffer.isBuffer(content) ? content : Buffer.from(content ?? '', 'utf-8') }]
  )
  const res = await fetch(`${base}/api/tasks`, {
    method: 'POST',
    headers: { 'content-type': contentType, authorization: `Bearer ${TOKEN}`, 'x-agent-protocol': '1' },
    body
  })
  return { res, json: await res.json() }
}

test('安全：文件名路径穿越/盘符/UNC 被收敛为单层安全文件名，不写出目录', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-agent-sec-traversal-'))
  const server = await startServer({ persist: true, dataDir })
  try {
    for (const evil of ['../../../../Windows/Temp/evil.csv', '..\\..\\..\\evil.csv', 'E:\\Windows\\evil.csv', '/etc/passwd']) {
      const { res, json } = await upload(server.base, { fileName: evil, content: SAMPLE })
      assert.equal(res.status, 201, `${evil} 应被安全收敛而非拒绝合法数据`)
      const snap = await waitForSnapshot(server, json.taskId, (t) => ['PRESENT', 'FAILED'].includes(t.state))
      assert.equal(snap.state, 'PRESENT', `${evil} 任务应正常完成`)
      assert.ok(!/[\\/]/.test(snap.title) && !snap.title.includes('..'), `标题不得含路径成分：${snap.title}`)
      assert.ok(/^[\w.\-\u4e00-\u9fff]+\.csv$/.test(snap.title), `标题应为安全单层文件名：${snap.title}`)
      // 数据目录内不得出现逃逸文件
      assert.ok(!fs.existsSync(path.join(dataDir, 'evil.csv')))
      assert.ok(!fs.existsSync(path.join(dataDir, '..', 'evil.csv')))
      // 任务目录内只有固定 data.csv
      const taskDir = path.join(dataDir, 'tasks', json.taskId)
      assert.ok(fs.existsSync(path.join(taskDir, 'data.csv')))
    }
  } finally {
    await server.agent.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
  }
})

test('安全：safeCsvName 单元覆盖（空名、隐藏文件、超长名、非白名单字符）', () => {
  assert.equal(safeCsvName('../../x.csv'), 'x.csv')
  assert.equal(safeCsvName('..\\..\\x.csv'), 'x.csv')
  assert.equal(safeCsvName(''), 'upload.csv')
  assert.equal(safeCsvName(null), 'upload.csv')
  assert.equal(safeCsvName('.bashrc'), 'bashrc.csv')
  // a/b\c:d*.csv：先按目录取 basename 得 c:d*.csv，盘符样式 c: 被剥离 → d_.csv
  assert.equal(safeCsvName('a/b\\c:d*.csv'), 'd_.csv')
  assert.ok(safeCsvName('x.txt').endsWith('.csv'))
  assert.ok([...safeCsvName('a'.repeat(200) + '.csv')].length <= 90)
  assert.equal(safeCsvName('实验数据.csv'), '实验数据.csv')
  assert.equal(safeCsvName('CON.csv'), '_CON.csv')
  assert.equal(safeCsvName('plot&whoami.csv'), 'plot_whoami.csv')
  assert.throws(() => assertSafeSegment('../x', '测试'))
  assert.throws(() => assertSafeSegment('a/b', '测试'))
  assert.throws(() => assertSafeSegment('a\\b', '测试'))
  assert.doesNotThrow(() => assertSafeSegment('plan_clarity', '测试'))
})

test('安全：multipart 拒绝重复 disposition 头注入', () => {
  const boundary = 'security-boundary'
  const body = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="safe.csv"\r\n` +
    `Content-Disposition: form-data; name="synthetic"\r\n\r\na,b\n1,2\r\n--${boundary}--\r\n`
  )
  assert.throws(() => parseMultipart(body, boundary), (error) => error?.code === 'INVALID_MULTIPART_HEADER')
})

test('安全：产物 realpath containment 拒绝指向任务目录外的 junction', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'local-agent-sec-realpath-'))
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'local-agent-sec-outside-'))
  try {
    const storage = new FileStorage(root)
    storage.initTask('task_safe', {}, Buffer.from('a,b\n1,2'))
    const runs = path.join(storage.taskDir('task_safe'), 'runs', 'plan_safe')
    fs.mkdirSync(runs, { recursive: true })
    fs.writeFileSync(path.join(outside, 'leak.svg'), '<svg/>')
    fs.symlinkSync(outside, path.join(runs, 'attempt-1'), 'junction')
    assert.throws(() => storage.readArtifact('task_safe', 'plan_safe', 'leak.svg'), (error) => error?.code === 'PATH_OUTSIDE_TASK')
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
    fs.rmSync(outside, { recursive: true, force: true })
  }
})

test('安全：planId 路径穿越在 select/preview/export 上被拒，不读取目录外文件', async () => {
  const server = await startServer()
  try {
    const { json } = await upload(server.base, { content: SAMPLE })
    const task = await waitForSnapshot(server, json.taskId, (t) => t.state === 'PRESENT')
    assert.equal(task.plans.length, 3)
    const evil = '..%2f..%2f..%2fWindows%2fwin.ini'
    const sel = await postJson(server, `/api/tasks/${json.taskId}/select`, { planId: '../../../etc/passwd' })
    assert.equal(sel.res.status, 404)
    assert.equal(sel.json.error.code, 'PLAN_NOT_FOUND')
    const preview = await fetch(`${server.base}/api/tasks/${json.taskId}/preview?planId=${evil}`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    assert.equal(preview.status, 404)
    const previewJson = await preview.json()
    assert.equal(previewJson.error.code, 'PLAN_NOT_FOUND')
    const exp = await fetch(`${server.base}/api/tasks/${json.taskId}/export?planId=${evil}`, {
      headers: { authorization: `Bearer ${TOKEN}` }
    })
    assert.equal(exp.status, 404)
  } finally {
    await server.agent.close()
  }
})

test('安全：空文件 → 400 EMPTY_FILE；超限文件 → 413 PAYLOAD_TOO_LARGE', async () => {
  const server = await startServer({ maxBytes: 1024 })
  try {
    const empty = await upload(server.base, { fileName: 'empty.csv', content: Buffer.alloc(0) })
    assert.equal(empty.res.status, 400)
    assert.equal(empty.json.error.code, 'EMPTY_FILE')
    const big = Buffer.concat([Buffer.from('a,b,c\n'), Buffer.alloc(4096, Buffer.from('1,2,3\n'))])
    const tooLarge = await upload(server.base, { fileName: 'big.csv', content: big })
    assert.equal(tooLarge.res.status, 413)
    assert.equal(tooLarge.json.error.code, 'PAYLOAD_TOO_LARGE')
  } finally {
    await server.agent.close()
  }
})

test('安全：代码生成对引号/反斜杠/换行做字面量转义，注入载荷无法逃逸字符串', () => {
  const maliciousX = 'a");raise RuntimeError("PWNED");#'
  const c = {
    fileName: 'x";raise RuntimeError("PWNED");#.csv',
    x: maliciousX,
    measures: ['control', 'treatment_a'],
    yLabel: 'y\\";\nraise RuntimeError("PWNED")',
    title: 't"); raise RuntimeError("PWNED");#',
    dpi: 100
  }
  const gens = generateCode('clarity', c)
  for (const code of [gens.python, gens.r]) {
    // 危险载荷若作为代码执行必然包含未转义形态；不允许出现“双引号闭合后直接接语句”
    assert.ok(!/raise RuntimeError\("PWNED"\);#/.test(code), '注入代码不应以可执行形态出现')
    assert.ok(!/(?<!\\)"\);raise/.test(code), '不得存在未转义双引号导致的字符串逃逸')
  }
  // MATLAB 为单引号字符向量：单引号双写转义（下方精确断言），双引号在其中只是普通字符
  // Python 模板中 x_col 必须是转义后的单一字符串字面量（String.raw 保留反斜杠）
  const py = generateCode('clarity', c).python
  assert.ok(py.includes(String.raw`x_col = "a\");raise RuntimeError(\"PWNED\");#"`), 'Python 列名必须整体转义在字符串字面量内')
  const r = generateCode('clarity', c).r
  assert.ok(r.includes(String.raw`idvar = "a\");raise RuntimeError(\"PWNED\");#"`), 'R 列名必须整体转义')
  const m = generateCode('clarity', c).matlab
  assert.ok(m.includes(String.raw`x = T.('a");raise RuntimeError("PWNED");#');`), 'MATLAB 列名必须在单引号字符向量内安全转义')
  // 静态扫描对显式危险调用仍保持拦截能力（安全限制不放宽）
  const dangerous = 'import os\nos.system("calc.exe")\n'
  assert.ok(staticSafetyScan(dangerous, 'python').length > 0)
})

test('安全：CSV 单元格/表头中的指令文本只作为数据，任务真实渲染成功且不执行指令', async () => {
  // 表头含引号逃逸 + 单元格含公式注入/命令文本；数值列仍可统计绘图
  // 表头按 RFC4180 双写引号，承载引号逃逸载荷；单元格为公式注入/命令文本（单引号，不含裸双引号）
  const csv = [
    'week,"x"");raise RuntimeError(""PWNED"");#",control,control_sd',
    '1,=cmd|\'/c calc\'!A1,12.0,0.5',
    '2,import os; os.system(\'calc.exe\'),13.4,0.7',
    '3,@SUM(1+1)+cmd /c,14.8,0.8',
    '4,正常文本,15.2,0.6',
    '5,end,16.0,0.5'
  ].join('\n')
  const server = await startServer()
  try {
    const { json } = await upload(server.base, { fileName: 'instruction_cells.csv', content: csv })
    const task = await waitForSnapshot(server, json.taskId, (t) => ['PRESENT', 'FAILED'].includes(t.state))
    // 引号被转义、指令文本仅为数据：三套方案必须真实执行验证通过
    assert.equal(task.state, 'PRESENT', `任务应完成，实际：${task.state} ${task.error?.code ?? ''}`)
    for (const p of task.plans) assert.equal(p.executionStatus, 'verified', `${p.plan_id} 应验证通过`)
    // 任何执行日志/错误中都不应出现 PWNED 未捕获异常
    const flat = JSON.stringify(task)
    assert.ok(!flat.includes('Traceback'), '不应有脚本异常')
  } finally {
    await server.agent.close()
  }
})

test('安全：响应与日志不泄露令牌、绝对路径或密钥环境变量', async () => {
  process.env.LOCAL_AGENT_TOKEN = TOKEN
  process.env.LOCAL_AGENT_LLM_API_KEY = 'sk-secret-abcdef-123456'
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-agent-sec-leak-'))
  const server = await startServer({ persist: true, dataDir })
  try {
    const { json } = await upload(server.base, { content: SAMPLE })
    await waitForSnapshot(server, json.taskId, (t) => t.state === 'PRESENT')
    const { json: snap } = await getSnapshot(server, json.taskId)
    const traceRes = await fetch(`${server.base}/api/tasks/${json.taskId}/trace`, { headers: { authorization: `Bearer ${TOKEN}` } })
    const traceJson = await traceRes.json()
    const capsRes = await fetch(`${server.base}/api/capabilities`, { headers: { authorization: `Bearer ${TOKEN}` } })
    const caps = await capsRes.json()
    const notFound = await getSnapshot(server, 'task_does_not_exist')
    const blob = JSON.stringify({ snap, trace: traceJson, caps, err: notFound.json })
    assert.ok(!blob.includes(TOKEN), '响应中不得出现启动令牌')
    assert.ok(!blob.includes('sk-secret-abcdef-123456'), '响应中不得出现 LLM 密钥')
    assert.ok(!blob.includes(dataDir), '响应中不得出现数据目录绝对路径')
    assert.ok(!blob.includes(os.homedir()), '响应中不得出现用户主目录绝对路径')
    // trace 不含工作目录字段
    // JSON.stringify 会把真实 Windows 路径中的反斜杠编码为 \\；避免把源码里的 `else:\n` 误判为 E 盘路径。
    const pathLeak = /workdir|cwd|[a-z]:\\\\(?:Users|[^"\\]+\\\\)/i.exec(blob)
    const leakContext = pathLeak ? blob.slice(Math.max(0, pathLeak.index - 60), pathLeak.index + 120) : ''
    assert.equal(pathLeak, null, `响应含工作目录标记：${pathLeak?.[0] ?? ''}；上下文：${leakContext}`)
  } finally {
    await server.agent.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
    delete process.env.LOCAL_AGENT_LLM_API_KEY
  }
})

test('安全：redactText 脱敏绝对路径与密钥值', () => {
  const out = redactText(`File "${path.join(os.tmpdir(), 'x', 'plot.py')}", line 1\n token=${TOKEN}`, { roots: [] })
  assert.ok(!out.includes(os.tmpdir()))
  assert.ok(!out.includes(TOKEN))
})

// ---- 阶段 E 追加：会话票据过期/复用失败 + 浏览器存储不读 API Key ----
import { IdentityStore } from '../src/platform.js'

test('安全：IdentityStore 会话票据过期、签名篡改、过期后复用均被拒绝', () => {
  const store = new IdentityStore({ root: null, secret: 'unit-test-secret-at-least-16-chars' })
  const now = Date.now()
  // 1) 合法票据：可验证（anonymous 类不要求已注册用户）
  const good = store.sign({ sub: 'anon_1', kind: 'anonymous', name: '甲', exp: now + 3600_000 })
  const goodPayload = store.verify(good)
  assert.ok(goodPayload && goodPayload.userId === 'anon_1', '合法票据应通过验证')

  // 2) 已过期票据：复用必须失败（exp < now）
  const expired = store.sign({ sub: 'anon_1', kind: 'anonymous', name: '甲', exp: now - 1000 })
  assert.equal(store.verify(expired), null, '过期票据必须拒绝，不得复用')

  // 3) 签名篡改：把合法 token 的签名翻转一个字符，验签必须失败
  const forged = store.sign({ sub: 'anon_2', kind: 'anonymous', name: '乙', exp: now + 3600_000 })
  const [bodyPart, sigPart] = forged.split('.', 2)
  const flip = sigPart[0] === 'A' ? 'B' : 'A'
  const tampered = `${bodyPart}.${flip}${sigPart.slice(1)}`
  // 用另一个 secret 签出的 token 在本 store 上必然验签失败
  const otherStore = new IdentityStore({ root: null, secret: 'another-secret-at-least-16-characters' })
  const cross = otherStore.sign({ sub: 'anon_2', kind: 'anonymous', name: '乙', exp: now + 3600_000 })
  assert.equal(store.verify(cross), null, '跨 secret 票据必须拒绝')

  // 4) 无签名/格式损坏
  assert.equal(store.verify('not-a-token'), null, '无点号的垃圾票据必须拒绝')
  assert.equal(store.verify(''), null, '空票据必须拒绝')
  assert.equal(store.verify(tampered), null, '篡改签名的票据必须拒绝')
})

test('安全：WS 握手后用过期票据认证应被 1008 关闭（不静默放行）', async () => {
  const server = await startServer()
  try {
    const { json } = await upload(server.base, { content: SAMPLE })
    const task = await waitForSnapshot(server, json.taskId, (t) => ['PRESENT', 'FAILED'].includes(t.state))
    // 构造一个已过期的匿名票据
    const expired = server.agent.identityStore.sign({
      sub: 'anon_expired',
      kind: 'anonymous',
      name: '已过期匿名用户',
      exp: Date.now() - 5000
    })
    const h = { base: server.base, port: server.port, token: TOKEN }
    const conn = openEvents(h, json.taskId, { token: expired })
    let closed = false
    conn.ws.addEventListener('close', () => { closed = true })
    await Promise.race([
      conn.opened.then(() => { throw new Error('过期票据不应通过 WS 认证') }),
      new Promise((resolve) => {
        conn.ws.addEventListener('close', resolve)
        setTimeout(resolve, 3000)
      })
    ])
    assert.ok(closed, '过期票据应触发 WS 关闭（1008 策略性关闭）')
  } finally {
    await server.agent.close()
  }
})

test('安全：网页模式（TEST_WEB_MODE=1）下本地设置接口被 403 拒绝，浏览器读不到 API Key', async () => {
  // 浏览器端 localStorage/sessionStorage 不持久化 API Key（apps/web/src/client/modelSettings.ts 已实现）；
  // Node 侧对应保证：web 模式下 /api/local/settings（唯一持久化 apiKey 的端点）对网页客户端 403。
  const prev = process.env.TEST_WEB_MODE
  process.env.TEST_WEB_MODE = '1'
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'local-agent-sec-webmode-'))
  const server = await startServer({ persist: true, dataDir })
  try {
    const res = await fetch(`${server.base}/api/local/settings`, { headers: { authorization: `Bearer ${TOKEN}` } })
    assert.equal(res.status, 403, '网页模式下 /api/local/settings 必须 403，浏览器 JS 无法读取本地 apiKey')
  } finally {
    await server.agent.close()
    fs.rmSync(dataDir, { recursive: true, force: true })
    if (prev === undefined) delete process.env.TEST_WEB_MODE
    else process.env.TEST_WEB_MODE = prev
  }
})
