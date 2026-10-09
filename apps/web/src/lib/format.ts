// 通用格式化与小工具
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

export function fmtMs(ms?: number): string {
  if (ms === undefined) return '—'
  if (ms < 1000) return `${Math.round(ms)} ms`
  return `${(ms / 1000).toFixed(2)} s`
}

export function fmtNum(n: number | undefined, digits = 2): string {
  if (n === undefined || Number.isNaN(n)) return '—'
  if (Math.abs(n) >= 1000) return n.toLocaleString('zh-CN', { maximumFractionDigits: digits })
  return n.toFixed(digits)
}

export function pct(rate: number): string {
  return `${(rate * 100).toFixed(1)}%`
}

export function shortHash(h: string, head = 10): string {
  return h.length <= head + 4 ? h : `${h.slice(0, head)}…${h.slice(-4)}`
}

export function cx(...parts: (string | false | null | undefined)[]): string {
  return parts.filter(Boolean).join(' ')
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function uid(prefix: string): string {
  return `${prefix}_${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-4)}`
}
