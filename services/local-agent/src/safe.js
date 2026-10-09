// 安全工具：所有来自请求的路径片段（上传文件名、taskId、planId、产物文件名）在进入
// fs 路径拼接前必须经过白名单校验，杜绝路径穿越（../、绝对路径、盘符、UNC、反斜杠变体）。

import os from 'node:os'
import { ApiError } from './errors.js'

// 任务/方案/产物等路径片段：字母数字与有限安全符号；禁止分隔符、点号穿越与空名
const SAFE_SEGMENT = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/

export function assertSafeSegment(seg, label = '路径片段') {
  if (typeof seg !== 'string' || !SAFE_SEGMENT.test(seg) || seg.includes('..')) {
    throw new ApiError(400, 'BAD_REQUEST', `非法${label}（仅允许字母、数字、点、下划线、连字符，且不能包含路径分隔符或 ..）`)
  }
  return seg
}

/**
 * 将上传文件名收敛为工作目录内安全的单层文件名（同时用于落盘、沙箱与代码生成）：
 * 1) 同时按 / 与 \\ 取 basename，剥离盘符与 UNC 前缀；
 * 2) 白名单保留字母数字、点、下划线、连字符与 CJK；
 * 3) 空/全非法 → upload.csv；长度收敛；强制 .csv 扩展名。
 */
export function safeCsvName(raw) {
  const fallback = 'upload.csv'
  if (typeof raw !== 'string' || !raw) return fallback
  // 剥离任何目录成分（含 Windows 盘符 C: 与 UNC \\host\share）
  let name = raw
    .replace(/\\/g, '/')
    .split('/')
    .pop()
    .replace(/^[A-Za-z]:/, '')
  name = name.normalize('NFKC')
  // 白名单：拉丁字母数字、常见安全符号与 CJK 统一表意文字
  name = name.replace(/[^A-Za-z0-9._\-\u4e00-\u9fff]/g, '_')
  name = name.replace(/\.{2,}/g, '.').replace(/^_+/, '').replace(/_+/g, '_')
  if (!name || name === '.' || name === '..') return fallback
  // 去起始点（防止隐藏文件/类 .. 变体），主体长度收敛
  name = name.replace(/^\.+/, '')
  if (!name) return fallback
  let stem = name.replace(/\.csv$/i, '').slice(0, 80) || 'upload'
  // Windows 设备名即使带扩展名也会映射到设备，必须改写为普通文件名。
  if (/^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])$/i.test(stem)) stem = `_${stem}`
  return `${stem}.csv`
}

// ---- 输出脱敏：错误响应、事件日志、trace 中不得出现绝对路径、敏感环境变量值 ----

const SECRET_ENV = /(token|secret|api[_-]?key|password|passwd|authorization|credential|cookie)/i

/**
 * 文本脱敏：
 * 1) 将 roots 中的绝对路径（含正反斜杠变体）替换为 <workspace> 类占位符；
 * 2) 将进程环境中疑似密钥/令牌的变量值替换为 <redacted>；
 * 3) 兜底替换 Windows 临时目录与用户主目录前缀。
 */
export function redactText(input, { roots = [], label = 'sandbox' } = {}) {
  if (input == null) return input
  let out = String(input)
  const allRoots = [...roots, os.tmpdir(), os.homedir(), process.cwd()].filter(Boolean)
  const uniq = [...new Set(allRoots.map((r) => String(r).replace(/[\\/]+$/, '')))]
    .filter((r) => r.length >= 3)
    .sort((a, b) => b.length - a.length)
  const replaceAll = (text, find, rep) => (find ? text.split(find).join(rep) : text)
  for (const root of uniq) {
    const rep = root === process.cwd().replace(/[\\/]+$/, '') ? `<${label}>` : '<workspace>'
    // 同时覆盖正/反斜杠两种写法
    out = replaceAll(out, root, rep)
    out = replaceAll(out, root.replace(/\\/g, '/'), rep)
    out = replaceAll(out, root.replace(/\//g, '\\'), rep)
  }
  for (const [k, v] of Object.entries(process.env)) {
    if (SECRET_ENV.test(k) && typeof v === 'string' && v.length >= 6) {
      out = replaceAll(out, v, '<redacted>')
    }
  }
  return out
}
