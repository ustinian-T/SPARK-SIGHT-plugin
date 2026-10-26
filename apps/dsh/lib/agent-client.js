/**
 * SPARK SIGHT for DeepSeek Harness — local-agent HTTP client.
 *
 * The host half talks to the bundled local-agent sidecar on loopback. Every
 * user-facing call carries the signed identity token obtained through the
 * plugin's login route; the token never reaches the browser.
 *
 * Zero runtime dependencies beyond Node's global fetch/FormData/Blob.
 */

const DEFAULT_TIMEOUT_MS = 30_000
const TASK_TIMEOUT_CAP_MS = 120_000

export function codedError(code, message, extra = {}) {
  return Object.assign(new Error(message), { code, ...extra })
}

export const AGENT_ERROR_CODES = Object.freeze({
  unavailable: 'AGENT_UNAVAILABLE',
  authRequired: 'AUTH_REQUIRED',
  authFailed: 'AUTH_FAILED',
  notFound: 'TASK_NOT_FOUND',
  timeout: 'AGENT_TIMEOUT',
  badGateway: 'AGENT_BAD_GATEWAY',
})

/** Routes the browser may reach through the host relay. Never a wildcard. */
const PROXY_RULES = [
  { method: 'GET', pattern: /^\/api\/auth\/me$/ },
  { method: 'GET', pattern: /^\/api\/projects(?:\?.*)?$/ },
  { method: 'GET', pattern: /^\/api\/projects\/[A-Za-z0-9_-]+$/ },
  { method: 'GET', pattern: /^\/api\/tasks\/[A-Za-z0-9_-]+$/ },
  { method: 'GET', pattern: /^\/api\/tasks\/[A-Za-z0-9_-]+\/preview(?:\?.*)?$/ },
  { method: 'GET', pattern: /^\/api\/tasks\/[A-Za-z0-9_-]+\/trace(?:\?.*)?$/ },
  { method: 'GET', pattern: /^\/api\/capabilities$/ },
  { method: 'GET', pattern: /^\/api\/style-presets$/ },
  { method: 'GET', pattern: /^\/api\/preferences(?:\?.*)?$/ },
  { method: 'GET', pattern: /^\/api\/preferences\/colors$/ },
  { method: 'GET', pattern: /^\/api\/me\/model-config$/ },
  { method: 'GET', pattern: /^\/api\/local\/settings$/ },
  { method: 'GET', pattern: /^\/api\/local\/ui$/ },
  { method: 'GET', pattern: /^\/api\/user-profile$/ },
  { method: 'PUT', pattern: /^\/api\/local\/ui$/ },
  { method: 'PUT', pattern: /^\/api\/user-profile$/ },
  { method: 'POST', pattern: /^\/api\/tasks\/[A-Za-z0-9_-]+\/(answer|select|feedback|replan|complete|preferences|cancel|retry)$/ },
  { method: 'POST', pattern: /^\/api\/me\/model-catalog$/ },
  { method: 'POST', pattern: /^\/api\/local\/model-catalog$/ },
]

export function isProxyAllowed(method, pathname) {
  const upper = String(method ?? 'GET').toUpperCase()
  return PROXY_RULES.some((rule) => rule.method === upper && rule.pattern.test(String(pathname ?? '')))
}

/** Only loopback URLs are ever called by this client. */
function assertLoopback(url) {
  let parsed
  try {
    parsed = new URL(url)
  } catch {
    throw codedError(AGENT_ERROR_CODES.unavailable, '本机绘图服务地址无效')
  }
  if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname)) {
    throw codedError(AGENT_ERROR_CODES.unavailable, '拒绝访问非本机绘图服务地址')
  }
  return parsed
}

function timeoutSignal(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(Math.max(1, timeoutMs))
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

export class AgentClient {
  constructor({ sidecar, log = () => {} } = {}) {
    this.sidecar = sidecar
    this.log = log
  }

  /** Start (or reuse) the sidecar and return its loopback endpoint. */
  async endpoint() {
    if (!this.sidecar) throw codedError(AGENT_ERROR_CODES.unavailable, '本机绘图服务未配置')
    let endpoint
    try {
      endpoint = await this.sidecar.start()
    } catch (error) {
      throw codedError(AGENT_ERROR_CODES.unavailable, `本机绘图服务启动失败：${error?.message ?? error}`)
    }
    assertLoopback(endpoint.baseUrl)
    return endpoint
  }

  async #fetch(pathname, { method = 'GET', token, body, headers = {}, signal, timeoutMs = DEFAULT_TIMEOUT_MS } = {}) {
    const endpoint = await this.endpoint()
    const target = new URL(pathname, `${endpoint.baseUrl}/`)
    assertLoopback(target.href)
    const requestHeaders = { 'x-agent-protocol': String(endpoint.health?.protocol ?? 1), ...headers }
    if (token) requestHeaders.authorization = `Bearer ${token}`
    if (body !== undefined && !(body instanceof FormData) && !requestHeaders['content-type']) {
      requestHeaders['content-type'] = 'application/json; charset=utf-8'
    }
    let response
    try {
      response = await fetch(target, {
        method,
        headers: requestHeaders,
        body: body === undefined ? undefined : body instanceof FormData ? body : JSON.stringify(body),
        redirect: 'error',
        signal: timeoutSignal(signal, timeoutMs),
      })
    } catch (error) {
      if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
        throw codedError(AGENT_ERROR_CODES.timeout, '本机绘图服务响应超时，请稍后重试')
      }
      throw codedError(AGENT_ERROR_CODES.unavailable, `无法连接本机绘图服务：${error?.message ?? error}`)
    }
    return { response, endpoint }
  }

  async json(pathname, options = {}) {
    const { response } = await this.#fetch(pathname, options)
    const text = await response.text()
    let parsed = null
    if (text) {
      try {
        parsed = JSON.parse(text)
      } catch {
        parsed = null
      }
    }
    if (!response.ok) {
      const code = parsed?.error?.code ?? parsed?.code ?? (response.status === 401 ? AGENT_ERROR_CODES.authRequired : AGENT_ERROR_CODES.badGateway)
      const message = parsed?.error?.message ?? parsed?.message ?? `本机绘图服务返回 HTTP ${response.status}`
      throw codedError(code, message, { status: response.status, body: parsed })
    }
    if (parsed === null) throw codedError(AGENT_ERROR_CODES.badGateway, '本机绘图服务返回了无效的 JSON')
    return parsed
  }

  async bytes(pathname, options = {}) {
    const { response } = await this.#fetch(pathname, { ...options, timeoutMs: options.timeoutMs ?? 60_000 })
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      let message = `本机绘图服务返回 HTTP ${response.status}`
      try {
        const parsed = JSON.parse(text)
        message = parsed?.error?.message ?? message
      } catch { /* binary or plain error body */ }
      throw codedError(response.status === 401 ? AGENT_ERROR_CODES.authRequired : AGENT_ERROR_CODES.badGateway, message, { status: response.status })
    }
    return {
      bytes: new Uint8Array(await response.arrayBuffer()),
      contentType: response.headers.get('content-type') ?? 'application/octet-stream',
      disposition: response.headers.get('content-disposition') ?? '',
    }
  }

  // ---- auth -------------------------------------------------------------

  login({ username, password, expectedRole } = {}, options = {}) {
    const body = { username: String(username ?? '').trim(), password: String(password ?? '') }
    if (expectedRole === 'admin') body.expectedRole = 'admin'
    return this.json('/api/auth/login', { ...options, method: 'POST', body })
  }

  register(input = {}, options = {}) {
    return this.json('/api/auth/register', {
      ...options,
      method: 'POST',
      body: {
        username: String(input.username ?? '').trim(),
        password: String(input.password ?? ''),
        displayName: String(input.displayName ?? '').trim() || undefined,
        agreementAccepted: true,
        agreementVersion: 'dsh-plugin-1',
      },
    })
  }

  anonymous(options = {}) {
    return this.json('/api/auth/anonymous', { ...options, method: 'POST', body: {} })
  }

  me(token, options = {}) {
    return this.json('/api/auth/me', { ...options, token })
  }

  logout(token, options = {}) {
    return this.json('/api/auth/logout', { ...options, method: 'POST', token, body: {} })
  }

  // ---- tasks ------------------------------------------------------------

  async createTask({ bytes, fileName, prompt, engine = 'python', clarify = true, clarifyAnswers, projectId, fields, token, signal, timeoutMs = 60_000 } = {}) {
    if (!bytes?.length) throw codedError('DATA_EMPTY', '数据文件为空')
    const form = new FormData()
    form.append('file', new Blob([bytes], { type: 'text/csv' }), String(fileName || 'upload.csv'))
    form.append('prompt', String(prompt ?? ''))
    form.append('engine', String(engine || 'python'))
    form.append('clarify', clarify ? 'true' : 'false')
    if (clarifyAnswers) form.append('clarifyAnswers', JSON.stringify(clarifyAnswers))
    if (projectId) form.append('projectId', String(projectId))
    if (fields && typeof fields === 'object') {
      for (const [name, value] of Object.entries(fields)) {
        if (value === undefined || value === null || value === '') continue
        form.append(String(name), typeof value === 'string' ? value : JSON.stringify(value))
      }
    }
    const result = await this.json('/api/tasks', { method: 'POST', body: form, token, signal, timeoutMs })
    return result
  }

  task(taskId, token, options = {}) {
    return this.json(`/api/tasks/${encodeURIComponent(taskId)}`, { ...options, token })
  }

  answer(taskId, answer, token, options = {}) {
    return this.json(`/api/tasks/${encodeURIComponent(taskId)}/answer`, { ...options, method: 'POST', token, body: { answer: String(answer ?? '') } })
  }

  select(taskId, planId, token, options = {}) {
    return this.json(`/api/tasks/${encodeURIComponent(taskId)}/select`, { ...options, method: 'POST', token, body: { planId: String(planId ?? '') } })
  }

  feedback(taskId, feedback, { planId, kind = 'manual_edit' } = {}, token, options = {}) {
    return this.json(`/api/tasks/${encodeURIComponent(taskId)}/feedback`, {
      ...options,
      method: 'POST',
      token,
      body: { feedback: String(feedback ?? ''), planId, kind },
    })
  }

  complete(taskId, token, options = {}) {
    return this.json(`/api/tasks/${encodeURIComponent(taskId)}/complete`, { ...options, method: 'POST', token, body: {} })
  }

  preview(taskId, { planId, engine } = {}, token, options = {}) {
    const query = new URLSearchParams()
    if (planId) query.set('planId', planId)
    if (engine) query.set('engine', engine)
    const suffix = query.size > 0 ? `?${query}` : ''
    return this.json(`/api/tasks/${encodeURIComponent(taskId)}/preview${suffix}`, { ...options, token, timeoutMs: options.timeoutMs ?? 60_000 })
  }

  exportTask(taskId, { planId, formats = 'svg,png,pdf', dpi = 300, transparent = false, includeCode = true, includeData = true, includeEvidence = true, includeArtifacts = true } = {}, token, options = {}) {
    const query = new URLSearchParams({
      formats: String(formats),
      dpi: String(dpi),
      transparent: transparent ? 'true' : 'false',
      includeCode: includeCode ? 'true' : 'false',
      includeData: includeData ? 'true' : 'false',
      includeEvidence: includeEvidence ? 'true' : 'false',
      includeArtifacts: includeArtifacts ? 'true' : 'false',
    })
    if (planId) query.set('planId', planId)
    return this.bytes(`/api/tasks/${encodeURIComponent(taskId)}/export?${query}`, { ...options, token, timeoutMs: options.timeoutMs ?? 120_000 })
  }

  /** Poll until plans/questions/terminal state or timeout. */
  async waitTask(taskId, token, { timeoutMs = 20_000, intervalMs = 1200, signal, stop } = {}) {
    const deadline = Date.now() + Math.max(1_000, Math.min(Number(timeoutMs) || 20_000, TASK_TIMEOUT_CAP_MS))
    let snapshot = null
    for (;;) {
      snapshot = await this.task(taskId, token, { signal, timeoutMs: 15_000 })
      if (typeof stop === 'function' ? stop(snapshot) : defaultStop(snapshot)) return { snapshot, timedOut: false }
      if (Date.now() >= deadline) return { snapshot, timedOut: true }
      await sleep(intervalMs, signal)
    }
  }

  // ---- browser relay ----------------------------------------------------

  async proxy({ method = 'GET', path, body, token, signal } = {}) {
    if (!isProxyAllowed(method, path)) {
      throw codedError('PROXY_PATH_DENIED', '该本机绘图服务路径不在白名单内')
    }
    if (method === 'GET') return this.json(path, { token, signal })
    return this.json(path, { method, body: body ?? {}, token, signal })
  }

  async proxyDownload({ path, token, signal } = {}) {
    if (!/^\/api\/tasks\/[A-Za-z0-9_-]+\/export(?:\?.*)?$/.test(String(path ?? ''))) {
      throw codedError('PROXY_PATH_DENIED', '仅允许下载任务导出包')
    }
    return this.bytes(path, { token, signal, timeoutMs: 120_000 })
  }
}

export function defaultStop(snapshot) {
  const state = String(snapshot?.state ?? '')
  return Boolean(snapshot?.pendingQuestion) || (Array.isArray(snapshot?.plans) && snapshot.plans.length > 0) || ['FAILED', 'CANCELLED', 'COMPLETE'].includes(state)
}

export function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(codedError('ABORTED', '操作已取消'))
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, Math.max(0, ms))
    const onAbort = () => {
      clearTimeout(timer)
      reject(codedError('ABORTED', '操作已取消'))
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}
