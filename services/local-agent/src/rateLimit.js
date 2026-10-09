function coded(code, message, retryAfterMs) {
  return Object.assign(new Error(message), { code, retryAfterMs })
}

export class RateLimiter {
  constructor({ windowMs = 60_000, maxRequests = 120, maxConcurrentTasks = 4, now = () => Date.now() } = {}) {
    this.windowMs = windowMs
    this.maxRequests = maxRequests
    this.maxConcurrentTasks = maxConcurrentTasks
    this.now = now
    this.windows = new Map()
    this.running = new Map()
  }

  consume(tenantId) {
    const now = this.now()
    let state = this.windows.get(tenantId)
    if (!state || now - state.startedAt >= this.windowMs) state = { startedAt: now, count: 0 }
    if (state.count >= this.maxRequests) throw coded('RATE_LIMITED', '请求频率超出租户限制', Math.max(0, state.startedAt + this.windowMs - now))
    state.count += 1
    this.windows.set(tenantId, state)
    return { remaining: this.maxRequests - state.count, resetAt: state.startedAt + this.windowMs }
  }

  beginTask(tenantId) {
    const count = this.running.get(tenantId) ?? 0
    if (count >= this.maxConcurrentTasks) throw coded('QUOTA_EXCEEDED', '并发任务数超出租户配额')
    this.running.set(tenantId, count + 1)
  }

  endTask(tenantId) {
    const count = this.running.get(tenantId) ?? 0
    if (count <= 1) this.running.delete(tenantId)
    else this.running.set(tenantId, count - 1)
  }
}
