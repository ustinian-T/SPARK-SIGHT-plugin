import { spawn, type ChildProcess } from 'node:child_process'
import { createHash, randomUUID } from 'node:crypto'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { codedError } from './patchReview'

// ==========================================================================
// v2 通用多语言运行时协议类型（与 apps/web/src/host/types.ts 严格对齐）
// ==========================================================================

export type RuntimeLanguage = 'python' | 'r' | 'matlab' | 'julia' | 'node'
export type RuntimeSource = 'bundled' | 'system' | 'vscode-extension' | 'remote'
export type SandboxLevel = 'generated-only' | 'strong' | 'host-trusted'

export interface RuntimeCapability {
  id: string
  language: RuntimeLanguage
  source: RuntimeSource
  executable: string
  version: string | null
  packages: Record<string, string | false>
  canRun: boolean
  canInstall: boolean
  sandboxLevel: SandboxLevel
  reason?: string
}

export interface RuntimePlanRequest {
  runtimeId: string
  scriptPath: string
  workDir: string
  args: string[]
  envWhitelist: string[]
  expectedArtifacts: string[]
}

export interface RuntimePlan {
  planId: string
  runtimeId: string
  language: RuntimeLanguage
  command: string[]
  workDir: string
  envAllowed: Record<string, string>
  expectedArtifacts: string[]
  sourceHash: string
  reviewNotes: string[]
}

export type RuntimeRunRequest = { planId: string } | { plan: RuntimePlan }

export interface RuntimeRunResponse {
  runId: string
}

export type RuntimeEventType = 'stdout' | 'stderr' | 'diagnostic' | 'phase' | 'resource' | 'artifact'

export interface RuntimeEvent {
  type: RuntimeEventType
  timestamp: number
  data: unknown
}

export type RuntimeRunStatus = 'pending' | 'running' | 'completed' | 'failed' | 'cancelled'

export interface RuntimeEventsResponse {
  runId: string
  status: RuntimeRunStatus
  events: RuntimeEvent[]
  exitCode: number | null
  runtimeFingerprint?: string
  sourceHash?: string
  dataHash?: string
  dependencySnapshot?: Record<string, string | false>
}

export interface RuntimeCancelResponse {
  runId: string
  cancelled: boolean
}

export interface RuntimeOpenArtifactRequest {
  runId: string
  artifactPath: string
}

export interface RuntimeOpenArtifactResponse {
  opened: boolean
  path: string
}

export interface LegacyMatlabRunInput {
  scriptPath: string
  projectRoot?: string
  executable?: string
  timeoutSeconds?: number
}

export interface RuntimeRunnerDeps {
  /** 工作区根目录（所有路径 containment 的基准） */
  workspaceRoot: string
  /** 用户配置的 MATLAB 可执行文件路径 */
  matlabPath?: string
  /** 工作区是否已信任（vscode.workspace.isTrusted） */
  isTrusted: () => boolean
  /** 用 VS Code 打开一个本地产物文件 */
  openArtifactPath: (absPath: string) => Promise<void>
  /** 可选日志回调（接入 Diagnostics 输出通道） */
  onLog?: (line: string) => void
}

// ==========================================================================
// 内部辅助
// ==========================================================================

interface ProbeResult {
  ok: boolean
  stdout: string
  stderr: string
  code: number | null
  error?: string
}

/** 短超时探测一个可执行文件：版本命令 / 包探测，绝不使用 shell。 */
function probe(file: string, args: string[], timeoutMs = 10_000): Promise<ProbeResult> {
  return new Promise((resolve) => {
    let child: ChildProcess
    try {
      child = spawn(file, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] })
    } catch (error) {
      resolve({ ok: false, stdout: '', stderr: '', code: null, error: (error as Error).message })
      return
    }
    let out = ''
    let err = ''
    const timer = setTimeout(() => {
      try { child.kill() } catch { /* already gone */ }
      resolve({ ok: false, stdout: out, stderr: err, code: null, error: 'timeout' })
    }, timeoutMs)
    const append = (bucket: 'out' | 'err', chunk: Buffer) => {
      const text = chunk.toString('utf8')
      if (bucket === 'out') { out += text; if (out.length > 16_000) out = out.slice(-8_000) }
      else { err += text; if (err.length > 16_000) err = err.slice(-8_000) }
    }
    child.stdout?.on('data', (chunk: Buffer) => append('out', chunk))
    child.stderr?.on('data', (chunk: Buffer) => append('err', chunk))
    child.once('error', (error) => { clearTimeout(timer); resolve({ ok: false, stdout: out, stderr: err, code: null, error: (error as Error).message }) })
    child.once('exit', (code) => { clearTimeout(timer); resolve({ ok: code === 0, stdout: out, stderr: err, code }) })
  })
}

/**
 * 路径 containment：resolved 必须等于 root 或位于 root 之下。
 * 使用 root + path.sep 前缀判定，避免 "C:\ws" 误吞 "C:\ws-evil"。
 */
function resolveInside(root: string, target: string, errorCode = 'RUNTIME_PATH_UNSAFE'): string {
  const abs = path.resolve(root, target)
  if (abs === root || abs.startsWith(root + path.sep)) return abs
  throw codedError(errorCode, `path escapes the trusted workspace: ${target}`)
}

function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex')
}

function firstVersionNumber(text: string): string | null {
  const match = /(\d+\.\d+(?:\.\d+)*)/.exec(text)
  return match ? match[1] : null
}

/** 子进程允许继承的最小系统环境变量（保证解释器能加载 DLL / 临时目录），其余一律走白名单。 */
const BASELINE_ENV_KEYS = new Set([
  'PATH', 'Path', 'SystemRoot', 'TEMP', 'TMP', 'HOME', 'USERPROFILE', 'LANG', 'LC_ALL', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE'
])

// ==========================================================================
// RuntimeRunner
// ==========================================================================

interface RunRecord {
  plan: RuntimePlan
  child?: ChildProcess
  status: RuntimeRunStatus
  events: RuntimeEvent[]
  exitCode: number | null
  fingerprint: string
  dependencySnapshot: Record<string, string | false>
  cancelledByUser: boolean
}

export class RuntimeRunner {
  private readonly deps: RuntimeRunnerDeps
  private capabilities = new Map<string, RuntimeCapability>()
  private plans = new Map<string, RuntimePlan>()
  private runs = new Map<string, RunRecord>()
  private discoveredAt = 0

  constructor(deps: RuntimeRunnerDeps) {
    this.deps = deps
  }

  private log(line: string): void {
    this.deps.onLog?.(`[runtime] ${line}`)
  }

  // ------------------------------------------------------------------
  // discover：真实探测本机 Python / R / MATLAB / Node
  // ------------------------------------------------------------------

  /** 枚举本机运行时；结果缓存 5 分钟，避免每次 discover 都冷启动 MATLAB。 */
  async discover(force = false): Promise<RuntimeCapability[]> {
    if (!force && this.discoveredAt > 0 && Date.now() - this.discoveredAt < 5 * 60_000 && this.capabilities.size > 0) {
      return [...this.capabilities.values()]
    }
    const detected = await Promise.all([
      this.discoverPython(),
      this.discoverR(),
      this.discoverMatlab(),
      this.discoverNode()
    ])
    this.capabilities = new Map(detected.map((cap) => [cap.id, cap]))
    this.discoveredAt = Date.now()
    for (const cap of detected) {
      this.log(`discover ${cap.language}: canRun=${cap.canRun} version=${cap.version ?? 'n/a'}${cap.reason ? ` reason=${cap.reason}` : ''}`)
    }
    return detected
  }

  private unavailable(id: string, language: RuntimeLanguage, executable: string, reason: string): RuntimeCapability {
    return { id, language, source: 'system', executable, version: null, packages: {}, canRun: false, canInstall: false, sandboxLevel: 'host-trusted', reason }
  }

  private async discoverPython(): Promise<RuntimeCapability> {
    let executable = ''
    let version: string | null = null
    for (const candidate of ['python', 'python3']) {
      const r = await probe(candidate, ['--version'], 8_000)
      if (!r.error) { executable = candidate; version = firstVersionNumber(`${r.stdout} ${r.stderr}`); break }
    }
    if (!executable) {
      return this.unavailable('python', 'python', '', '未找到 python 可执行文件（PATH 中无 python / python3）')
    }
    const pkg = await probe(executable, ['-c', "import importlib.metadata as m\nfor p in ('matplotlib','numpy'):\n    try: print(p+'='+m.version(p))\n    except Exception: print(p+'=MISSING')"], 15_000)
    const packages: Record<string, string | false> = {}
    for (const line of (pkg.stdout || '').split(/\r?\n/)) {
      const m = /^([\w.-]+)=(.+)$/.exec(line.trim())
      if (m && m[2] !== 'MISSING') packages[m[1]] = m[2]
    }
    return {
      id: 'python', language: 'python', source: 'system', executable, version,
      packages, canRun: true, canInstall: false, sandboxLevel: 'host-trusted',
      reason: Object.keys(packages).length === 0 ? '未探测到 matplotlib / numpy，绘图脚本可能无法运行' : '宿主不代为 pip install 新包'
    }
  }

  private async discoverR(): Promise<RuntimeCapability> {
    const versionProbe = await probe('Rscript', ['-e', 'cat(R.version.string)'], 10_000)
    if (versionProbe.error) {
      return this.unavailable('r', 'r', 'Rscript', '未找到 Rscript 可执行文件（PATH 中无 Rscript）')
    }
    const version = firstVersionNumber(versionProbe.stdout)
    const pkg = await probe('Rscript', ['-e', "for(p in c('ggplot2')){if(requireNamespace(p,quietly=TRUE)) cat(p,'=',as.character(packageVersion(p)),'\\n',sep='') else cat(p,'=MISSING\\n',sep='')}"], 15_000)
    const packages: Record<string, string | false> = { base: version ?? false }
    for (const line of (pkg.stdout || '').split(/\r?\n/)) {
      const m = /^([\w.-]+)=(.+)$/.exec(line.trim())
      if (m && m[2] !== 'MISSING') packages[m[1]] = m[2]
    }
    return {
      id: 'r', language: 'r', source: 'system', executable: 'Rscript', version,
      packages, canRun: true, canInstall: false, sandboxLevel: 'host-trusted',
      reason: packages.ggplot2 ? '宿主不代为 install.packages' : '未探测到 ggplot2，绘图脚本可能无法运行'
    }
  }

  private async discoverMatlab(): Promise<RuntimeCapability> {
    const executable = this.deps.matlabPath || 'matlab'
    // MATLAB 冷启动较慢：仅做一次最小 `-batch` 自检
    const r = await probe(executable, ['-batch', "disp('__DEEP_IMAGING_OK__')"], 45_000)
    if (r.error === 'ENOENT' || (r.error && /ENOENT|spawn.*E/i.test(r.error))) {
      return this.unavailable('matlab', 'matlab', executable, '未找到 matlab 可执行文件，请在 deepImaging.matlabPath 中配置')
    }
    if (r.error === 'timeout') {
      return this.unavailable('matlab', 'matlab', executable, 'MATLAB 探测超时：解释器存在但本次启动未完成，暂不可调度')
    }
    return {
      id: 'matlab', language: 'matlab', source: 'system', executable, version: null,
      packages: {}, canRun: true, canInstall: false, sandboxLevel: 'host-trusted',
      reason: 'MATLAB 版本号不在启动时探测（-batch 无轻量 version 输出）'
    }
  }

  private async discoverNode(): Promise<RuntimeCapability> {
    const r = await probe('node', ['--version'], 8_000)
    if (r.error) {
      return this.unavailable('node', 'node', '', '未找到 node 可执行文件（PATH 中无 node）')
    }
    return {
      id: 'node', language: 'node', source: 'system', executable: 'node',
      version: firstVersionNumber(r.stdout) ?? null,
      packages: {}, canRun: true, canInstall: false, sandboxLevel: 'host-trusted',
      reason: '宿主不代为 npm install 新包'
    }
  }

  // ------------------------------------------------------------------
  // plan：安全审查后产出可执行 argv
  // ------------------------------------------------------------------

  private requireTrusted(): void {
    if (!this.deps.isTrusted()) throw codedError('WORKSPACE_UNTRUSTED', '运行脚本要求工作区已受信任（Workspace Trust）')
  }

  async plan(request: RuntimePlanRequest): Promise<RuntimePlan> {
    this.requireTrusted()
    if (!request || typeof request.runtimeId !== 'string' || typeof request.scriptPath !== 'string' || typeof request.workDir !== 'string') {
      throw codedError('RUNTIME_PLAN_REJECTED', 'plan 请求必须包含 runtimeId / scriptPath / workDir')
    }
    if (!Array.isArray(request.args) || !request.args.every((a) => typeof a === 'string')) {
      throw codedError('RUNTIME_PLAN_REJECTED', 'args 必须为字符串数组；禁止 shell 拼接')
    }
    if (!Array.isArray(request.envWhitelist) || !request.envWhitelist.every((k) => typeof k === 'string')) {
      throw codedError('RUNTIME_PLAN_REJECTED', 'envWhitelist 必须为字符串数组')
    }

    // Preparing one script must not wait for unrelated runtimes (MATLAB can
    // take 45 seconds to start). Probe only the requested runtime here.
    let runtime = this.capabilities.get(request.runtimeId)
    if (!runtime) {
      const probes: Record<string, () => Promise<RuntimeCapability>> = {
        python: () => this.discoverPython(), r: () => this.discoverR(),
        matlab: () => this.discoverMatlab(), node: () => this.discoverNode()
      }
      if (probes[request.runtimeId]) {
        runtime = await probes[request.runtimeId]()
        this.capabilities.set(request.runtimeId, runtime)
      }
    }
    if (!runtime) throw codedError('RUNTIME_NOT_FOUND', `未知 runtimeId: ${request.runtimeId}`)
    if (!runtime.canRun) throw codedError('RUNTIME_UNAVAILABLE', runtime.reason ?? `runtime ${request.runtimeId} 当前不可运行`)

    const workspaceRoot = path.resolve(this.deps.workspaceRoot)
    if (!workspaceRoot || workspaceRoot === path.parse(workspaceRoot).root) {
      throw codedError('RUNTIME_PATH_UNSAFE', '未打开受信任的工作区根目录')
    }
    const workDir = resolveInside(workspaceRoot, request.workDir)
    if (!fs.existsSync(workDir) || !fs.statSync(workDir).isDirectory()) {
      throw codedError('RUNTIME_PATH_UNSAFE', `workDir 不存在或不是目录: ${request.workDir}`)
    }
    const scriptAbs = resolveInside(workDir, request.scriptPath)
    if (!fs.existsSync(scriptAbs) || !fs.statSync(scriptAbs).isFile()) {
      throw codedError('RUNTIME_PLAN_REJECTED', `脚本不存在: ${request.scriptPath}`)
    }

    // 环境变量：仅白名单键 + 最小系统基线，杜绝密钥泄漏进子进程
    const envAllowed: Record<string, string> = {}
    for (const key of request.envWhitelist) {
      const value = process.env[key]
      if (typeof value === 'string') envAllowed[key] = value
    }

    const command = this.buildArgv(runtime, scriptAbs, request.args)
    const sourceHash = sha256(fs.readFileSync(scriptAbs))
    const planId = randomUUID()
    const plan: RuntimePlan = {
      planId,
      runtimeId: runtime.id,
      language: runtime.language,
      command,
      workDir,
      envAllowed,
      expectedArtifacts: Array.isArray(request.expectedArtifacts) ? request.expectedArtifacts.filter((a) => typeof a === 'string') : [],
      sourceHash,
      reviewNotes: [
        `通过 execve 风格 spawn 执行（无 shell）：共 ${command.length} 个 argv 元素`,
        `cwd=${workDir}`,
        `环境变量透传白名单：[${Object.keys(envAllowed).join(', ') || '(空)'}]，另附最小系统基线（PATH/TEMP/SystemRoot 等）`,
        `脚本已 containment 校验并读取，sourceHash=${sourceHash.slice(0, 12)}…`
      ]
    }
    if (runtime.language === 'matlab') plan.reviewNotes.push('MATLAB 通过 -batch run() 执行，用户 args 不会转发给脚本')
    this.plans.set(planId, plan)
    this.log(`plan ${planId} runtime=${runtime.id} script=${scriptAbs}`)
    return plan
  }

  /** 按语言生成 argv：解释器 + 脚本 + 用户参数，绝不拼 shell 字符串。 */
  private buildArgv(runtime: RuntimeCapability, scriptAbs: string, args: string[]): string[] {
    switch (runtime.language) {
      case 'python':
      case 'node':
      case 'r':
        return [runtime.executable, scriptAbs, ...args]
      case 'matlab': {
        // MATLAB -batch 直接 run 脚本路径；路径中的单引号加倍转义（MATLAB 字符串语法）
        const escaped = scriptAbs.replace(/'/g, "''")
        return [runtime.executable, '-batch', `run('${escaped}')`]
      }
      default:
        throw codedError('RUNTIME_NOT_FOUND', `不支持的语言: ${runtime.language}`)
    }
  }

  // ------------------------------------------------------------------
  // run：spawn + args 数组，实时事件缓冲
  // ------------------------------------------------------------------

  async run(request: RuntimeRunRequest): Promise<RuntimeRunResponse> {
    this.requireTrusted()
    // 安全约束：只接受本宿主 runtime.plan() 签发的 planId；
    // 内联 plan 对象不被信任（command 可被跨端篡改），必须先经 plan() 审查。
    if (!('planId' in request) || typeof request.planId !== 'string' || !request.planId) {
      throw codedError('RUNTIME_PLAN_REJECTED', 'run 必须引用 runtime.plan 返回的 planId，不接受内联 plan')
    }
    const plan = this.plans.get(request.planId)
    if (!plan) throw codedError('RUNTIME_NOT_FOUND', '未知 planId，请先调用 runtime.plan')

    const runId = randomUUID()
    const runtime = this.capabilities.get(plan.runtimeId)
    const fingerprint = sha256(`${plan.language}|${runtime?.version ?? 'n/a'}|${plan.command[0]}`)

    const record: RunRecord = {
      plan,
      status: 'pending',
      events: [],
      exitCode: null,
      fingerprint,
      dependencySnapshot: runtime?.packages ?? {},
      cancelledByUser: false
    }
    this.runs.set(runId, record)
    const push = (type: RuntimeEventType, data: unknown) => record.events.push({ type, timestamp: Date.now(), data })

    // 环境白名单：最小系统基线 + 请求方白名单，禁止整包继承 process.env
    const env: NodeJS.ProcessEnv = {}
    for (const key of Object.keys(process.env)) {
      if (BASELINE_ENV_KEYS.has(key)) env[key] = process.env[key]
    }
    Object.assign(env, plan.envAllowed)

    let child: ChildProcess
    try {
      child = spawn(plan.command[0], plan.command.slice(1), {
        cwd: plan.workDir,
        env: env as NodeJS.ProcessEnv,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe']
      })
    } catch (error) {
      record.status = 'failed'
      record.exitCode = null
      push('phase', { phase: 'error', message: (error as Error).message })
      throw codedError('RUNTIME_EXECUTION_FAILED', `无法启动进程: ${(error as Error).message}`)
    }
    record.child = child
    record.status = 'running'
    push('phase', { phase: 'start', pid: child.pid ?? null, command: plan.command })
    this.log(`run ${runId} pid=${child.pid} argv=${plan.command.join(' ')}`)

    child.stdout?.on('data', (chunk: Buffer) => push('stdout', chunk.toString('utf8')))
    child.stderr?.on('data', (chunk: Buffer) => push('stderr', chunk.toString('utf8')))
    child.once('error', (error) => {
      push('phase', { phase: 'error', message: (error as Error).message })
      this.finishRun(record, record.cancelledByUser ? 'cancelled' : 'failed', null)
    })
    child.once('exit', (code) => {
      const status = record.cancelledByUser ? 'cancelled' : code === 0 ? 'completed' : 'failed'
      push('phase', { phase: 'exit', code })
      this.finishRun(record, status, code)
    })

    return { runId }
  }

  /** 终态只产生一次。 */
  private finishRun(record: RunRecord, status: RuntimeRunStatus, exitCode: number | null): void {
    if (record.status === 'completed' || record.status === 'failed' || record.status === 'cancelled') return
    record.status = status
    record.exitCode = exitCode
    this.log(`run finished status=${status} code=${exitCode}`)
  }

  // ------------------------------------------------------------------
  // events / cancel / openArtifact
  // ------------------------------------------------------------------

  async events(runId: string): Promise<RuntimeEventsResponse> {
    if (typeof runId !== 'string' || !runId) throw codedError('RUNTIME_NOT_FOUND', 'runId 不能为空')
    const record = this.runs.get(runId)
    if (!record) throw codedError('RUNTIME_NOT_FOUND', `未知 runId: ${runId}`)

    // 产物哈希：对 expectedArtifacts 中已存在的文件做增量校验
    let dataHash: string | undefined
    const expected = record.plan.expectedArtifacts ?? []
    if (expected.length) {
      const hash = createHash('sha256')
      let any = false
      for (const rel of expected) {
        try {
          const abs = resolveInside(record.plan.workDir, rel)
          if (fs.existsSync(abs) && fs.statSync(abs).isFile()) {
            hash.update(fs.readFileSync(abs))
            any = true
          }
        } catch { /* 未生成或越界：跳过 */ }
      }
      if (any) dataHash = hash.digest('hex')
    }

    return {
      runId,
      status: record.status,
      events: record.events,
      exitCode: record.exitCode,
      runtimeFingerprint: record.fingerprint,
      sourceHash: record.plan.sourceHash,
      dataHash,
      dependencySnapshot: record.dependencySnapshot
    }
  }

  async cancel(runId: string): Promise<RuntimeCancelResponse> {
    if (typeof runId !== 'string' || !runId) throw codedError('RUNTIME_NOT_RUNNING', 'runId 不能为空')
    const record = this.runs.get(runId)
    if (!record) throw codedError('RUNTIME_NOT_RUNNING', `未知 runId: ${runId}`)
    if (record.status !== 'running' && record.status !== 'pending') {
      return { runId, cancelled: false }
    }
    record.cancelledByUser = true
    const pid = record.child?.pid
    if (pid !== undefined) {
      if (process.platform === 'win32') {
        await new Promise<void>((resolve) => {
          const killer = spawn('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
          killer.once('exit', () => resolve())
          killer.once('error', () => { try { record.child?.kill() } catch { /* noop */ }; resolve() })
        })
      } else {
        try { process.kill(-pid, 'SIGTERM') } catch { try { record.child?.kill('SIGTERM') } catch { /* noop */ } }
      }
    }
    this.log(`cancel ${runId}`)
    return { runId, cancelled: true }
  }

  async openArtifact(request: RuntimeOpenArtifactRequest): Promise<RuntimeOpenArtifactResponse> {
    this.requireTrusted()
    if (!request || typeof request.runId !== 'string' || typeof request.artifactPath !== 'string') {
      throw codedError('ARTIFACT_PATH_UNSAFE', 'openArtifact 必须提供 runId 与 artifactPath')
    }
    const record = this.runs.get(request.runId)
    if (!record) throw codedError('RUNTIME_NOT_FOUND', `未知 runId: ${request.runId}`)

    let abs: string
    try {
      abs = resolveInside(record.plan.workDir, request.artifactPath, 'ARTIFACT_PATH_UNSAFE')
    } catch (error) {
      throw codedError('ARTIFACT_PATH_UNSAFE', (error as Error).message)
    }
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) {
      throw codedError('ARTIFACT_NOT_FOUND', `产物不存在: ${request.artifactPath}`)
    }
    const ext = path.extname(abs).toLowerCase().replace(/^\./, '')
    if (!['png', 'svg', 'pdf', 'html', 'htm', 'csv'].includes(ext)) {
      throw codedError('ARTIFACT_PATH_UNSAFE', `不支持打开的产物类型: ${ext || '(无扩展名)'}`)
    }
    await this.deps.openArtifactPath(abs)
    this.log(`openArtifact ${abs}`)
    return { opened: true, path: abs }
  }

  // ------------------------------------------------------------------
  // deprecated：runtime.runMatlab 兼容路径，内部走通用 plan/run 管线
  // ------------------------------------------------------------------

  async runMatlabLegacy(input: LegacyMatlabRunInput): Promise<{ ok: boolean; scriptPath: string; output: string }> {
    const scriptAbs = path.resolve(input.scriptPath)
    const workDir = input.projectRoot ? path.resolve(input.projectRoot) : path.dirname(scriptAbs)
    const plan = await this.plan({
      runtimeId: 'matlab',
      scriptPath: path.relative(workDir, scriptAbs),
      workDir,
      args: [],
      envWhitelist: [],
      expectedArtifacts: []
    })
    const { runId } = await this.run({ planId: plan.planId })
    const deadline = Date.now() + (input.timeoutSeconds ?? 120) * 1000
    for (;;) {
      const state = await this.events(runId)
      if (state.status === 'completed') {
        const output = state.events.filter((e) => e.type === 'stdout' || e.type === 'stderr').map((e) => String(e.data)).join('')
        return { ok: true, scriptPath: scriptAbs, output: output.slice(-4000) }
      }
      if (state.status === 'failed' || state.status === 'cancelled') {
        const output = state.events.filter((e) => e.type === 'stdout' || e.type === 'stderr').map((e) => String(e.data)).join('')
        throw codedError('RUNTIME_EXECUTION_FAILED', `MATLAB exited with code ${state.exitCode}: ${output.slice(-2000)}`)
      }
      if (Date.now() > deadline) {
        await this.cancel(runId).catch(() => undefined)
        throw codedError('RUNTIME_EXECUTION_FAILED', 'MATLAB execution timed out')
      }
      await new Promise((resolve) => setTimeout(resolve, 150))
    }
  }
}
