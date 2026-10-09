// 每个方案独立工作目录，静态扫描、执行超时和产物回收。
// 用户编辑代码需要经探测的 bubblewrap 命名空间（Windows 经 WSL worker）。
// 无强隔离环境时只允许运行受限的生成代码，并明确上报缺少的 OS 边界。
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { SCRIPT_NAME } from './codegen.js'
import { safeCsvName, redactText } from './safe.js'
import { isolationAvailable, isolatedCommand } from './isolatedRunner.js'
import { pythonCommand } from './engines.js'
import { wslCommand, wslPath } from './wslSandbox.js'

export function sandboxCapabilities() {
  const strong = isolationAvailable()
  return {
    profile: strong ? (process.platform === 'win32' ? 'wsl-bubblewrap-per-execution' : 'bubblewrap-per-execution') : 'local-generated-only',
    generatedCode: true,
    customCode: strong,
    enforced: ['static-import-call-policy', 'sanitized-environment', 'isolated-working-directory', 'wall-timeout', 'process-tree-termination', 'artifact-size-quota'],
    notEnforced: strong ? ['aggregate-memory-cgroup', 'cpu-bandwidth-quota'] : ['os-network-namespace', 'hard-memory-limit', 'hard-cpu-quota', 'hard-process-count-limit'],
    note: strong ? '每次执行创建独立网络、进程和文件系统命名空间，并限制地址空间、CPU 时间与文件大小' : '本机弱沙箱只允许 Agent 生成代码；用户自定义代码必须配置强沙箱'
  }
}

export function assertExecutionAllowed({ sourceKind = 'generated' } = {}) {
  const capabilities = sandboxCapabilities()
  if (sourceKind === 'custom' && !capabilities.customCode) {
    throw Object.assign(new Error('当前运行时无法强制 OS 级隔离，拒绝执行用户自定义代码'), { code: 'STRONG_SANDBOX_REQUIRED' })
  }
  return capabilities
}

// 沙箱子进程只继承解释器运行所必需的环境变量；显式剔除令牌、密钥、代理凭据等，
// 防止生成代码（即使被注入）通过环境读取到 LOCAL_AGENT_TOKEN / LLM_API_KEY 等敏感信息。
const ENV_DENY = /(token|secret|api[_-]?key|password|passwd|authorization|credential|cookie|local_agent|llm_)/i
const ENV_ALLOW = new Set([
  // 跨平台运行时
  'PATH', 'PATHEXT', 'SYSTEMDRIVE', 'SYSTEMROOT', 'WINDIR', 'TEMP', 'TMP', 'HOME', 'LANG', 'LC_ALL',
  'LIBRARY_PATH', 'LD_LIBRARY_PATH', 'DYLD_LIBRARY_PATH', 'R_HOME', 'R_LIBS_USER',
  // Python
  'PYTHONHOME', 'PYTHONPATH', 'PYTHONIOENCODING', 'PYTHONUTF8', 'PYTHONUNBUFFERED', 'MPLBACKEND', 'MPLCONFIGDIR',
  // R
  'R_DEFAULT_PACKAGES', 'R_LANGS'
])

function scrubbedEnv(extra) {
  const out = { ...extra }
  for (const [k, v] of Object.entries(process.env)) {
    if (ENV_ALLOW.has(k) && !ENV_DENY.test(k)) out[k] = v
  }
  // PATH 类变量即使名字未命中白名单也按值传递（Windows 下解释器依赖 DLL 查找）
  for (const k of ['PATH', 'Path', 'path']) {
    if (process.env[k] !== undefined) out[k] = process.env[k]
  }
  return out
}

const PY_ALLOWED = new Set(['numpy', 'pandas', 'matplotlib', 'csv', 'math', 'statistics', 'datetime', 're', 'json', 'textwrap'])
const PY_FORBID_CALL = /\b(__import__|eval|exec|compile)\s*\(|\b(os\.system|subprocess\.(run|Popen|call)|socket\.|urllib\.|requests\.|shutil\.rmtree)\b/
const R_FORBID = /\b(system2?|shell|download\.file|url\(|httr|curl|processx|reticulate|unlink|file\.remove)\s*\(/i
const M_FORBID = /(^|\n)\s*(!|system\s*\(|urlwrite\s*\(|webread\s*\(|websave\s*\(|delete\s*\(|eval\s*\(|evalin\s*\()/i

function scanPython(code) {
  const violations = []
  const imports = new Set()
  for (const line of code.split(/\r?\n/)) {
    const t = line.trim()
    if (t.startsWith('#')) continue
    let m
    const reFrom = /^\s*from\s+([\w.]+)\s+import\b/g
    while ((m = reFrom.exec(line))) imports.add(m[1])
    const reImport = /^\s*import\s+([\w.]+)(?:\s+as\s+\w+)?/g
    while ((m = reImport.exec(line))) imports.add(m[1].split('.')[0])
  }
  for (const name of imports) {
    // Matplotlib 的三维投影是标准绘图组件；仅精确放行该模块，
    // 不因根包 mpl_toolkits 而开放其余工具包。
    if (!PY_ALLOWED.has(name.split('.')[0]) && name !== 'mpl_toolkits.mplot3d') violations.push(`Python 导入不在白名单：${name}`)
  }
  if (PY_FORBID_CALL.test(code)) violations.push('Python 代码包含被禁止的动态执行/网络/进程调用')
  return violations
}

function scanR(code) {
  const violations = []
  const allowedPkgs = new Set(['ggplot2', 'dplyr', 'tidyr', 'readr', 'patchwork', 'scales'])
  let m
  const reLib = /(?:library|require)\s*\(\s*([A-Za-z0-9.]+)/g
  while ((m = reLib.exec(code))) {
    if (!allowedPkgs.has(m[1])) violations.push(`R 包不在白名单：${m[1]}`)
  }
  if (R_FORBID.test(code)) violations.push('R 代码包含被禁止的系统/网络调用')
  return violations
}

function scanMatlab(code) {
  return M_FORBID.test(code) ? ['MATLAB 代码包含被禁止的系统/网络/动态求值调用'] : []
}

export function staticSafetyScan(code, engine) {
  if (engine === 'python') return scanPython(code)
  if (engine === 'r') return scanR(code)
  return scanMatlab(code)
}

function runProcess(cmd, args, { cwd, env, timeoutMs, signal, onSpawn }) {
  return new Promise((resolve) => {
    // 输出直接写普通文件句柄，既不创建可能残留的 pipe，也不经过 cmd.exe。
    // Windows 上配合 windowsHide 可避免每次绘图都弹出/闪烁前台终端窗口。
    const tag = `.sandbox-${process.pid}-${Date.now()}`
    const stdoutName = `${tag}.stdout.log`
    const stderrName = `${tag}.stderr.log`
    const isWin = process.platform === 'win32'
    let stdoutFd
    let stderrFd
    try {
      stdoutFd = fs.openSync(path.join(cwd, stdoutName), 'w')
      stderrFd = fs.openSync(path.join(cwd, stderrName), 'w')
    } catch (e) {
      if (stdoutFd !== undefined) try { fs.closeSync(stdoutFd) } catch {}
      if (stderrFd !== undefined) try { fs.closeSync(stderrFd) } catch {}
      return resolve({ exitCode: -1, stdout: '', stderr: String(e?.message ?? e), timedOut: false, spawnError: 'log_open_failed' })
    }

    const readOutputs = () => {
      let stdout = ''
      let stderr = ''
      try {
        stdout = fs.readFileSync(path.join(cwd, stdoutName), 'utf-8')
      } catch {
        /* ignore */
      }
      try {
        stderr = fs.readFileSync(path.join(cwd, stderrName), 'utf-8')
      } catch {
        /* ignore */
      }
      for (const name of [stdoutName, stderrName]) {
        try {
          fs.unlinkSync(path.join(cwd, name))
        } catch {
          /* ignore */
        }
      }
      return { stdout, stderr }
    }

    let timedOut = false
    let cancelled = false
    let settled = false
    let child
    let abortFallback
    const killTree = (onKilled) => {
      try {
        if (!child?.pid) return
        if (isWin) {
          // Some packaged shells expose a malformed/minimal PATH. Resolve the
          // Windows utility explicitly and handle spawn failures so aborting a
          // task can never surface an unhandled ChildProcess "error" event.
          const taskkill = path.join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows', 'System32', 'taskkill.exe')
          const killer = spawn(taskkill, ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true })
          killer.on('error', () => {
            try { child.kill('SIGKILL') } catch { /* ignore */ }
            onKilled?.()
          })
          killer.on('close', () => onKilled?.())
          killer.unref()
        } else {
          process.kill(-child.pid, 'SIGKILL')
        }
      } catch {
        /* ignore */
      }
    }
    const onAbort = () => {
      if (settled) return
      cancelled = true
      killTree(() => finish(-1))
      // A referenced fallback guarantees the cancellation promise resolves
      // even when Windows never emits close for an already-orphaned process.
      abortFallback = setTimeout(() => finish(-1), 2000)
    }
    const finish = (exitCode, error) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(abortFallback)
      signal?.removeEventListener('abort', onAbort)
      try { fs.closeSync(stdoutFd) } catch {}
      try { fs.closeSync(stderrFd) } catch {}
      const { stdout, stderr } = readOutputs()
      resolve({ exitCode, stdout, stderr: stderr || (error ? String(error.message ?? error) : ''), timedOut, cancelled, spawnError: error?.code })
    }
    const timer = setTimeout(() => {
      timedOut = true
      killTree()
    }, timeoutMs)
    if (signal?.aborted) {
      cancelled = true
      return finish(-1)
    }
    try {
      child = spawn(cmd, args, {
        cwd,
        env,
        stdio: ['ignore', stdoutFd, stderrFd],
        shell: false,
        windowsHide: true,
        // POSIX 需要独立进程组以便 kill(-pid)；Windows 用 taskkill /T 杀进程树，
        // 不 detach 可避免系统默认终端把控制台进程提升到前台窗口。
        detached: !isWin
      })
    } catch (e) {
      return finish(-1, Object.assign(e, { code: e?.code || 'spawn_failed' }))
    }
    onSpawn?.(child.pid)
    // detached children must not keep the Agent/test process alive after the
    // cancellation result has already been settled by taskkill/fallback.
    child.unref()
    signal?.addEventListener('abort', onAbort, { once: true })
    if (signal?.aborted) onAbort()
    child.on('error', (e) => {
      finish(-1, Object.assign(e, { code: e.code || 'spawn_error' }))
    })
    child.on('close', (code) => {
      finish(code ?? -1)
    })
  })
}

function readPngDimensions(buf) {
  // PNG IHDR：8 字节签名 + 4 长度 + 4 类型，随后 width/height 各 4 字节大端
  if (buf.length < 24 || buf.toString('ascii', 12, 16) !== 'IHDR') return null
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) }
}

/**
 * 在沙箱中执行单个方案。
 * @param {object} p
 * @param {string} p.workdir 已创建的空工作目录
 * @param {string} p.engine python|r|matlab
 * @param {string} p.code 该引擎源码
 * @param {Buffer} p.csvBuffer 原始 CSV 字节
 * @param {string} p.csvName 工作目录内数据文件名
 * @param {string[]} p.expected 必须回收的产物文件名
 * @param {number} [p.timeoutMs]
 */
async function runInSandboxInner(p) {
  // 默认 30s（R/MATLAB 在调用处另设下限）；可用 LOCAL_AGENT_SANDBOX_TIMEOUT_MS 放宽，
  // 以便在解释器冷启动/本机高负载（如字体缓存重建、CPU 争用）环境下避免误判超时。
  const envTimeout = Number.parseInt(process.env.LOCAL_AGENT_SANDBOX_TIMEOUT_MS ?? '', 10)
  const defaultTimeout = Number.isFinite(envTimeout) && envTimeout > 0 ? envTimeout : 30000
  const { workdir, engine, code, csvBuffer, csvName: rawCsvName = 'data.csv', expected, timeoutMs = defaultTimeout, signal, onSpawn } = p
  assertExecutionAllowed({ sourceKind: p.sourceKind ?? 'generated' })
  if (signal?.aborted) return { status: 'cancelled', engine, cancelled: true, artifacts: [], missingArtifacts: [] }
  // 沙箱是安全边界：数据文件名再做一次白名单收敛，杜绝调用方绕过导致的路径穿越
  const csvName = safeCsvName(rawCsvName)
  fs.mkdirSync(workdir, { recursive: true })
  fs.writeFileSync(path.join(workdir, csvName), csvBuffer)
  fs.writeFileSync(path.join(workdir, SCRIPT_NAME[engine]), code, 'utf-8')
  // Public, licensed fonts travel with every client bundle, not the host OS.
  const fontDir = path.join(workdir, '.deep-imaging-fonts')
  fs.cpSync(fileURLToPath(new URL('./fonts/', import.meta.url)), fontDir, { recursive: true })

  const safetyViolations = staticSafetyScan(code, engine)
  if (safetyViolations.length) {
    return { status: 'error', engine, exitCode: -1, stdout: '', stderr: '', timedOut: false, safetyViolations, artifacts: [], workdir }
  }

  const mplConfig = path.join(os.tmpdir(), 'local-agent-mpl')
  fs.mkdirSync(mplConfig, { recursive: true })
  const env = scrubbedEnv({
    MPLBACKEND: 'Agg',
    MPLCONFIGDIR: mplConfig,
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    FONTCONFIG_FILE: path.join(fontDir, 'fonts.conf'),
    R_DEFAULT_PACKAGES: 'base,utils,stats,graphics,grDevices,ggplot2'
  })

  let result
  if (process.platform === 'win32' && isolationAvailable() && ['python', 'r'].includes(engine)) {
    const command = wslCommand('run', { engine, script: SCRIPT_NAME[engine], workdir: wslPath(path.resolve(workdir)), timeoutMs: Math.max(timeoutMs, engine === 'r' ? 60000 : timeoutMs) })
    result = await runProcess(command.cmd, command.args, { cwd: workdir, env, timeoutMs: Math.max(timeoutMs, 60000) + 5000, signal, onSpawn })
  } else if (isolationAvailable() && ['python', 'r'].includes(engine)) {
    const command = isolatedCommand({ engine, script: SCRIPT_NAME[engine], workdir: path.resolve(workdir) })
    result = await runProcess(command.cmd, command.args, { cwd: workdir, env, timeoutMs: Math.max(timeoutMs, engine === 'r' ? 60000 : timeoutMs), signal, onSpawn })
  } else if (engine === 'python') {
    result = await runProcess(pythonCommand, [SCRIPT_NAME.python], { cwd: workdir, env, timeoutMs, signal, onSpawn })
  } else if (engine === 'r') {
    result = await runProcess('Rscript', [SCRIPT_NAME.r], { cwd: workdir, env, timeoutMs: Math.max(timeoutMs, 60000), signal, onSpawn })
  } else {
    result = await runProcess('matlab', ['-batch', `run('${SCRIPT_NAME.matlab}')`], {
      cwd: workdir,
      env,
      timeoutMs: Math.max(timeoutMs, 120000),
      signal,
      onSpawn
    })
  }

  if (result.cancelled) {
    return { status: 'cancelled', engine, exitCode: result.exitCode, stdout: '', stderr: '', timedOut: false, cancelled: true, artifacts: [], missingArtifacts: [], workdir }
  }

  // 回收产物
  const artifacts = []
  const missingArtifacts = []
  for (const name of expected) {
    const fp = path.join(workdir, name)
    if (!fs.existsSync(fp) || fs.statSync(fp).size === 0) {
      missingArtifacts.push(name)
      continue
    }
    const maxArtifactBytes = Number(p.maxArtifactBytes ?? process.env.LOCAL_AGENT_MAX_ARTIFACT_BYTES ?? 20 * 1024 * 1024)
    const bytes = fs.statSync(fp).size
    if (bytes > maxArtifactBytes) {
      missingArtifacts.push(`${name}:quota_exceeded`)
      continue
    }
    const item = { name, bytes }
    if (name.endsWith('.svg')) item.svg = fs.readFileSync(fp, 'utf-8')
    if (name.endsWith('.png')) {
      const buf = fs.readFileSync(fp)
      item.png = { ...(readPngDimensions(buf) ?? { width: 0, height: 0 }), dataBase64: buf.toString('base64') }
    }
    artifacts.push(item)
  }

  const success = result.exitCode === 0 && missingArtifacts.length === 0
  // 对外输出（事件/快照/trace/错误响应）一律脱敏：不泄露工作目录绝对路径与环境中的密钥
  const redact = (s) => redactText(s, { roots: [workdir, mplConfig], label: 'sandbox' })
  return {
    status: success ? 'success' : 'error',
    engine,
    exitCode: result.exitCode,
    stdout: redact(result.stdout),
    stderr: redact(result.stderr),
    timedOut: result.timedOut,
    spawnError: result.spawnError ? redact(String(result.spawnError)) : result.spawnError,
    safetyViolations: [],
    artifacts,
    missingArtifacts: success ? [] : missingArtifacts,
    workdir
  }
}

// 进程内执行队列：本机实测并发 matplotlib 进程会在共享 MPLCONFIGDIR 字体缓存锁上长时间串行
// （单任务 1.5s，争用时可达数十秒甚至饿死），且桌面单机 Agent 不需要并行渲染。
// 同一进程内的沙箱执行一律排队，保证耗时可预测；不影响多任务的 HTTP/WS 并发处理。
let sandboxChain = Promise.resolve()
export function runInSandbox(p) {
  const run = () => p.signal?.aborted ? Promise.resolve({ status: 'cancelled', engine: p.engine, cancelled: true, artifacts: [], missingArtifacts: [] }) : runInSandboxInner(p)
  const result = sandboxChain.then(run, run)
  // 失败不中断后续任务
  sandboxChain = result.then(
    () => undefined,
    () => undefined
  )
  return result
}

/**
 * 创建独立的串行沙箱执行器（每个 Agent/服务器一个队列）。
 * 多服务器同进程运行（如测试）时，一个服务器上残留的长任务不会阻塞另一个服务器。
 */
export function createSandboxRunner() {
  let chain = Promise.resolve()
  return (p) => {
    const run = () => p.signal?.aborted ? Promise.resolve({ status: 'cancelled', engine: p.engine, cancelled: true, artifacts: [], missingArtifacts: [] }) : runInSandboxInner(p)
    const result = chain.then(run, run)
    chain = result.then(
      () => undefined,
      () => undefined
    )
    return result
  }
}
