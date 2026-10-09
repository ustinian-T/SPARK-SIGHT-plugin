// 错误归一化与自动修复（算法说明书 11.1 / 架构表 9-3、9-4）。
// 七类签名：FIELD / SYNTAX / DEPENDENCY / ENGINE / RENDER / RESOURCE / SAFETY。
// 修复预算默认 3 次（初次执行之外）；SAFETY 不自动修复；每次修复返回新的代码/引擎/dpi，不允许“只重试”。
import { generateCode, generateFallbackCode } from './codegen.js'
import { ERROR_SIGNATURE } from './errors.js'

export const MAX_REPAIRS = 3

/** Bounded deterministic layout repair for Python/Matplotlib render findings. */
export function repairVisualLayout(code, attempt = 1) {
  const source = String(code ?? '')
  if (!source || !/matplotlib|pyplot|savefig/i.test(source)) return null
  const top = Math.max(0.78, 0.90 - attempt * 0.04)
  let repaired = source.replace(/\.tight_layout\(\s*\)/g, `.tight_layout(rect=[0.04, 0.06, 0.96, ${top.toFixed(2)}])`)
  repaired = repaired.replace(/bbox_inches\s*=\s*(['"])tight\1(?!\s*,\s*pad_inches)/g, "bbox_inches='tight', pad_inches=0.18")
  if (repaired === source) {
    const marker = 'import matplotlib.pyplot as plt'
    if (!source.includes(marker)) return null
    repaired = source.replace(marker, `${marker}\nplt.rcParams.update({'savefig.bbox': 'tight', 'savefig.pad_inches': 0.18, 'figure.constrained_layout.use': True})`)
  }
  return repaired === source ? null : repaired
}

/**
 * 从执行结果归类错误签名
 * @param {{exitCode:number,stderr:string,stdout:string,timedOut:boolean,spawnError?:string,missingArtifacts?:string[],safetyViolations?:string[]}} r
 */
export function classifyError(r) {
  const log = `${r.stdout ?? ''}\n${r.stderr ?? ''}\n${r.spawnError ?? ''}`
  if (r.safetyViolations?.length) {
    return { category: ERROR_SIGNATURE.SAFETY, signature: 'safety.scan_failed', hint: `静态安全扫描拦截：${r.safetyViolations.join('；')}`, repairable: false }
  }
  if (r.timedOut) {
    return { category: ERROR_SIGNATURE.RESOURCE, signature: 'resource.timeout', hint: '执行超时，降低 dpi/采样后重试', repairable: true }
  }
  if (/spawn (.*)ENOENT|command not found|不是内部或外部命令|ENOENT/.test(log) && /python|rscript|matlab/i.test(log)) {
    return { category: ERROR_SIGNATURE.ENGINE, signature: 'engine.not_found', hint: '解释器不可用，切换至 Python 引擎', repairable: true }
  }
  if (/License Manager Error|License checkout|licen[sc]e/i.test(log)) {
    return { category: ERROR_SIGNATURE.ENGINE, signature: 'engine.license', hint: 'MATLAB 许可证不可用，切换至 Python 引擎', repairable: true }
  }
  if (/MemoryError|std::bad_alloc|OutOfMemory|Killed|cannot allocate memory/i.test(log)) {
    return { category: ERROR_SIGNATURE.RESOURCE, signature: 'resource.memory', hint: '内存不足，降低 dpi 后重试', repairable: true }
  }
  if (/ModuleNotFoundError|No module named|there is no package called|Error in library|could not find package|ImportError/i.test(log)) {
    return { category: ERROR_SIGNATURE.DEPENDENCY, signature: 'dependency.missing', hint: '依赖缺失：Python 改用标准库 csv + matplotlib 内置模板；R/MATLAB 切换 Python', repairable: true }
  }
  if (/KeyError:\s*['"](.+)['"]|Column ['"](.+)['"] (not found|does not exist)|object '.*?' not found|undefined columns selected/i.test(log)) {
    const m = /KeyError:\s*['"]([^'"]+)['"]/.exec(log) || /Column ['"]([^'"]+)['"]/.exec(log)
    return { category: ERROR_SIGNATURE.FIELD, signature: 'field.missing', hint: `字段映射错误：${m?.[1] ?? '未知列'}，按真实列名重新生成`, repairable: true, field: m?.[1] }
  }
  if (/SyntaxError|IndentationError|unexpected symbol|unexpected token|parse error|Error: attempt to/i.test(log)) {
    return { category: ERROR_SIGNATURE.SYNTAX, signature: 'syntax.template', hint: '语法错误：从确定性模板重新生成', repairable: true }
  }
  if (r.missingArtifacts?.length || /savefig|exportgraphics|ggsave|cannot open|No such file|Permission denied/i.test(log)) {
    return { category: ERROR_SIGNATURE.RENDER, signature: 'render.output', hint: '渲染/保存失败：强制 Agg 后端与显式 savefig 后重试', repairable: true }
  }
  return { category: ERROR_SIGNATURE.SYNTAX, signature: 'unknown.nonzero_exit', hint: '未归类的非零退出：从确定性模板重新生成', repairable: true }
}

/**
 * 依据错误类别产出修复后的执行规格（禁止原样重试）。
 * @param {object} classified classifyError 输出
 * @param {object} ctx {strategy, input, engine, attempt, columns}
 * @returns {{engine:string, code:string, dpi:number, note:string}|null} null 表示不可自动修复
 */
export function repair(classified, ctx) {
  const { strategy, input, engine, attempt } = ctx
  const base = { engine, dpi: input.dpi ?? 160 }
  switch (classified.category) {
    case ERROR_SIGNATURE.SAFETY:
      return null
    case ERROR_SIGNATURE.ENGINE:
      if (engine === 'python') return null
      return {
        ...base, engine: 'python',
        code: generateCode(strategy, input).python,
        note: `修复#${attempt}（ENGINE）：${engine} 不可用，切换 Python 重新执行`
      }
    case ERROR_SIGNATURE.DEPENDENCY:
      if (engine !== 'python') {
        return {
          ...base, engine: 'python',
          code: generateCode(strategy, input).python,
          note: `修复#${attempt}（DEPENDENCY）：切换 Python 引擎规避缺失依赖`
        }
      }
      return {
        ...base, engine: 'python',
        code: generateFallbackCode(strategy, { ...input, dpi: 120 }),
        note: `修复#${attempt}（DEPENDENCY）：切换标准库 csv + matplotlib 内置模板`
      }
    case ERROR_SIGNATURE.RESOURCE: {
      const dpi = Math.max(80, (input.dpi ?? 160) - 60)
      return {
        ...base,
        code: engine === 'python' ? generateCode(strategy, { ...input, dpi }).python : generateCode(strategy, input)[engine],
        dpi,
        note: `修复#${attempt}（RESOURCE）：dpi 降至 ${dpi} 以减少内存/超时风险`
      }
    }
    case ERROR_SIGNATURE.RENDER:
    case ERROR_SIGNATURE.SYNTAX:
    case ERROR_SIGNATURE.FIELD:
    default:
      // FIELD：input.measures/x 来自真实列名，重生成即完成映射修正
      return {
        ...base,
        code: generateCode(strategy, input)[engine],
        note: `修复#${attempt}（${classified.category}）：按确定性模板与真实字段重新生成代码`
      }
  }
}
