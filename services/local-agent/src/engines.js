// 引擎适配层 · probe()：真实检测本机解释器与依赖可用性（DESK-003 / 架构 9.2）。
// 检测不到时如实返回 available:false，编排层据此诚实降级，绝不伪造执行结果。
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { probeWslSandbox } from './wslSandbox.js'
export const pythonCommand = process.platform === 'win32' ? 'python' : 'python3'

function run(cmd, args, { timeout = 4000 } = {}) {
  try {
    const r = spawnSync(cmd, args, { timeout, encoding: 'utf-8', shell: false })
    if (r.error || r.status !== 0) return { ok: false, output: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() }
    return { ok: true, output: `${r.stdout ?? ''}${r.stderr ?? ''}`.trim() }
  } catch {
    return { ok: false, output: '' }
  }
}

function firstLine(s) {
  return s.split(/\r?\n/).map((x) => x.trim()).find(Boolean) ?? ''
}

export function probePython() {
  const worker = probeWslSandbox()
  if (worker?.available && worker.python?.available) return { ...worker.python, note: 'Python 绘图依赖就绪（WSL 独立沙箱）' }
  const v = run(pythonCommand, ['--version'])
  if (!v.ok) return { engine: 'python', available: false, version: null, note: '未检测到 python 解释器' }
  const deps = {}
  for (const pkg of ['pandas', 'matplotlib', 'numpy', 'seaborn']) {
    const r = run(pythonCommand, ['-c', `import ${pkg}; print(${pkg}.__version__)`], { timeout: 8000 })
    deps[pkg] = r.ok ? firstLine(r.output) : false
  }
  return {
    engine: 'python',
    available: true,
    version: firstLine(v.output),
    dependencies: deps,
    note: deps.matplotlib && deps.pandas ? 'pandas + matplotlib 就绪，可执行渲染' : '解释器存在但绘图依赖不完整，代码可生成而执行将降级'
  }
}

export function probeR() {
  const v = run('Rscript', ['--version'])
  if (!v.ok) {
    const worker = probeWslSandbox()
    if (worker?.available && worker.r?.available) return { ...worker.r, note: 'R / ggplot2 就绪（WSL 独立沙箱）' }
    return { engine: 'r', available: false, version: null, note: '未检测到 Rscript 或可用的 WSL R 沙箱' }
  }
  const dependencies = {}
  for (const pkg of ['ggplot2', 'tidyr', 'dplyr', 'svglite', 'patchwork']) {
    const result = run('Rscript', ['-e', `cat(as.character(packageVersion("${pkg}")))`])
    dependencies[pkg] = result.ok ? firstLine(result.output) : false
  }
  const ready = Object.values(dependencies).every(Boolean)
  return {
    engine: 'r',
    available: ready,
    version: firstLine(v.output),
    dependencies,
    note: ready ? 'R 绘图与 SVG 导出依赖就绪' : `R 存在但缺少 ${Object.keys(dependencies).filter((key) => !dependencies[key]).join('、')}`
  }
}

export function probeMatlab() {
  // MATLAB 启动慢，仅探测可执行文件是否存在，不宣称许可证状态（合规模型：不打包商业运行时）
  const finder = process.platform === 'win32' ? ['where', ['matlab']] : ['which', ['matlab']]
  const r = run(finder[0], finder[1])
  if (!r.ok) {
    return {
      engine: 'matlab',
      available: false,
      version: null,
      license: 'unknown',
      note: '未检测到 matlab；仅生成代码并标注未执行，产品不打包 MATLAB 运行时'
    }
  }
  return {
    engine: 'matlab',
    available: true,
    license: 'user_owned_required',
    note: '检测到 MATLAB 可执行文件；执行仍取决于用户合法许可证'
  }
}

export function probeEngines() {
  return {
    python: probePython(),
    r: probeR(),
    matlab: probeMatlab(),
    probedAt: new Date().toISOString()
  }
}
