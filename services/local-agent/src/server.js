// 本地 Agent 服务主程序：版本化 HTTP + WebSocket（架构说明书第 11 章）。
// 零运行时依赖：node:http + 手写 multipart 解析 + 最小 RFC6455 WebSocket。
// 安全基线（ADR-06 / DESK-009）：仅绑 127.0.0.1、随机端口、每次启动令牌、协议版本协商。
import http from 'node:http'
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { createHash, randomBytes, randomUUID } from 'node:crypto'
import { URL, fileURLToPath } from 'node:url'
import { ingestFile } from './csv.js'
import { parseMultipart, readBody, MultipartError } from './multipart.js'
import { TaskStore } from './taskStore.js'
import { Orchestrator, ENGINE_KINDS } from './orchestrator.js'
import { attachWebSocket, acceptKey } from './ws.js'
import { probeEngines } from './engines.js'
import { createSandboxRunner, sandboxCapabilities } from './sandbox.js'
import { ApiError, ERR, jsonError } from './errors.js'
import { FileStorage } from './storage.js'
import { applyPreference, preferenceSummary, PreferenceStore } from './preferences.js'
import { buildExport } from './export.js'
import { buildTrace, buildTraceList } from './trace.js'
import { safeCsvName, assertSafeSegment } from './safe.js'
import { createDefaultFormatRegistry } from './formats.js'
import { BundleStore } from './bundles.js'
import { IdentityStore, ProjectStore as PlatformProjectStore, createCloudAdapter } from './platform.js'
import { InviteStore } from './invites.js'
import { TenantCloudStore, DEFAULT_CLOUD_QUOTA_BYTES, startRetentionScheduler, resolveRetentionDays, cloudUsageView, fmtBytes } from './cloud.js'
import { CollaborationStore, PluginRegistry, RemoteNodeRegistry, generateTwoVariants, mergeText3 } from './extensions.js'
import { STYLE_PRESETS } from './stylePresets.js'
import { ProjectStore as LocalProjectStore } from './projects.js'
import { ProjectStore as FileProjectStore, DEFAULT_PROJECT_ID } from './projectStore.js'
import { AuthManager } from './auth.js'
import { RateLimiter } from './rateLimit.js'
import { UploadStore } from './uploads.js'
import { validateModelSettings } from './modelSettings.js'
import { fetchModelCatalog } from './providerFetch.js'
import { providerConfig } from './llm.js'
import { ModelSecretStore, modelConfigSummary } from './modelSecrets.js'
import { CloudAccountClient } from './cloudAccounts.js'
import { UserProfileStore } from './userProfileStore.js'
import { analyzeFileGroup, mergeCsvBuffers } from './batchSplit.js'
import { MODES } from './approval.js'
import { calibrationReport } from './decision/metrics.js'

export const PROTOCOL_VERSION = 1
const DEFAULT_MAX_BYTES = 60 * 1024 * 1024 // NFR-P01：单 CSV ≤ 50MB，留 10MB 余量

export function createServer(options = {}) {
  const host = options.host ?? process.env.LOCAL_AGENT_HOST ?? '127.0.0.1'
  const requestedPort = options.port ?? Number(process.env.LOCAL_AGENT_PORT ?? 0)
  const token = options.token ?? process.env.LOCAL_AGENT_TOKEN ?? randomBytes(16).toString('hex')
  const stepDelayMs = options.stepDelayMs ?? Number(process.env.LOCAL_AGENT_STEP_DELAY ?? 40)
  const maxBytes = options.maxBytes ?? Number(process.env.LOCAL_AGENT_MAX_BYTES ?? DEFAULT_MAX_BYTES)
  const remoteConfig = options.remote ?? ((process.env.REMOTE_MODE ?? '0') === '1' ? {
    enabled: true,
    users: JSON.parse(process.env.REMOTE_USERS_JSON ?? '{}'),
    secret: process.env.REMOTE_AUTH_SECRET
  } : { enabled: false })
  const remoteEnabled = remoteConfig.enabled === true
  const testWeb = process.env.TEST_WEB_MODE === '1'
  const publicWeb = process.env.LOCAL_AGENT_WEB_ONLY === '1'
  // 公网 Web（REMOTE_MODE）或显式浏览器模式：API schema 仅允许 Python / R，拒绝 MATLAB。
  // 桌面端内置 Agent（默认本地启动）保留 MATLAB 等本机发现结果。
  const webOnlyEngines = remoteEnabled || testWeb || publicWeb
  const localSettingsPath = path.join(options.dataDir ?? process.env.LOCAL_AGENT_DATA_DIR ?? path.join(process.cwd(), '.data'), 'local-settings.json')
  const localUiPath = path.join(path.dirname(localSettingsPath), 'local-ui.json')
  const readLocalJson = (target) => fs.existsSync(target) ? JSON.parse(fs.readFileSync(target, 'utf8')) : {}
  const writeLocalJson = (target, value) => {
    fs.mkdirSync(path.dirname(target), { recursive: true })
    fs.writeFileSync(`${target}.tmp`, JSON.stringify(value), { mode: 0o600 })
    fs.renameSync(`${target}.tmp`, target)
  }

  // ---- 静态托管（可选）：LOCAL_AGENT_WEB_DIST_DIR 指向前端构建产物时，由本服务直接提供官网/应用 ----
  const webDistDir = options.webDistDir ?? process.env.LOCAL_AGENT_WEB_DIST_DIR ?? ''
  const STATIC_TYPES = {
    '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
    '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json; charset=utf-8',
    '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif',
    '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2', '.txt': 'text/plain; charset=utf-8', '.map': 'application/json'
  }

  // M3：注入到“被 iframe 托管的 index.html”的 host-bridge bootstrap。
  // 它以 window.parent.postMessage 作为 transport，在 iframe 内安装
  // window.__DEEP_IMAGING_HOST__，让前端进入本机（local）模式并直连本 sidecar。
  // 顶层直接加载（window.parent===window）时不安装，避免影响非嵌入场景。
  const HOST_BRIDGE_BOOTSTRAP = `
    (function () {
      if (window.parent === window) return;
      var pending = new Map();
      window.addEventListener('message', function (event) {
        var data = event.data;
        if (!data || typeof data.id !== 'string') return;
        var item = pending.get(data.id);
        if (!item) return;
        pending.delete(data.id);
        if (data.ok) item.resolve(data.result);
        else item.reject(Object.assign(new Error(data.error && data.error.message), { code: data.error && data.error.code }));
      });
      function request(type, payload) {
        return new Promise(function (resolve, reject) {
          var id = crypto.randomUUID();
          pending.set(id, { resolve: resolve, reject: reject });
          // 子->父请求不含令牌，targetOrigin 用 '*'; 父->子响应由父页以精确 iframe origin 回发。
          window.parent.postMessage({ version: 2, id: id, type: type, payload: payload || {} }, '*');
        });
      }
      window.__DEEP_IMAGING_HOST__ = {
        getAgentConfig: function () { return request('agent.config'); },
        openDiff: function (x) { return request('diff.open', x); },
        readSelection: function () { return request('selection.read'); },
        applyPatch: function (x) { return request('patch.apply', x); },
        getRuntimeCapabilities: function () { return request('runtime.capabilities'); },
        runMatlab: function (x) { return request('runtime.runMatlab', x); },
        discoverRuntimes: function () { return request('runtime.discover'); },
        planRuntime: function (x) { return request('runtime.plan', x); },
        runRuntime: function (x) { return request('runtime.run', x); },
        getRuntimeEvents: function (id) { return request('runtime.events', { runId: id }); },
        cancelRuntime: function (id) { return request('runtime.cancel', { runId: id }); },
        openArtifact: function (x) { return request('runtime.openArtifact', x); },
        receive: async function (x) { return x; }
      };
    })();
  `
  const injectHostBootstrap = (html) => {
    if (html.includes('__DEEP_IMAGING_HOST__')) return html // 幂等
    const tagged = `<head><script>${HOST_BRIDGE_BOOTSTRAP}</script>`
    if (html.includes('<head>')) return html.replace('<head>', tagged)
    return html
  }

  const serveStatic = (pathName, res) => {
    if (!webDistDir) return false
    try {
      const root = path.resolve(webDistDir)
      const relative = path.posix.normalize(decodeURIComponent(pathName === '/' ? '/index.html' : pathName))
      let file = path.resolve(root, `.${relative}`)
      if (file !== root && !file.startsWith(root + path.sep)) return false // 路径穿越防护
      if (!fs.existsSync(file) || fs.statSync(file).isDirectory()) {
        file = path.join(root, 'index.html') // SPA 回退
        if (!fs.existsSync(file)) return false
      }
      const ext = path.extname(file).toLowerCase()
      // 前端需能被宿主以 iframe 嵌入：DSH 桌面端父页为 dsh-app:、VS Code 为 vscode-webview:。
      // 全局默认的 X-Frame-Options:DENY 面向不被嵌套的 API/顶层文档；此处显式移除 XFO，
      // 改用 CSP frame-ancestors 白名单收紧（XFO 与 CSP 并存时，XFO 仍会单方面拦截）。
      res.removeHeader('X-Frame-Options')
      res.setHeader(
        'Content-Security-Policy',
        `default-src 'self'; script-src 'self' 'sha256-${createHash('sha256').update(HOST_BRIDGE_BOOTSTRAP).digest('base64')}'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; font-src 'self' data:; connect-src 'self' ws://127.0.0.1:* http://127.0.0.1:*; object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self' dsh-app: vscode-webview: https://*.vscode-webview.net`
      )
      let payload = fs.readFileSync(file)
      if (ext === '.html') payload = injectHostBootstrap(payload.toString('utf8'))
      res.writeHead(200, {
        'content-type': STATIC_TYPES[ext] ?? 'application/octet-stream',
        'cache-control': relative.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache'
      })
      res.end(payload)
      return true
    } catch { return false }
  }

  // 文件态持久化：默认开启（.data），LOCAL_AGENT_PERSIST=0 关闭，LOCAL_AGENT_DATA_DIR 改位置
  const persist = options.persist ?? (process.env.LOCAL_AGENT_PERSIST ?? '1') !== '0'
  const dataDir = options.dataDir ?? process.env.LOCAL_AGENT_DATA_DIR ?? path.join(process.cwd(), '.data')
  const storage = persist ? new FileStorage(dataDir) : null
  // 文件态项目仓库：任务的物理与逻辑容器（阶段 1 项目制）；persist 关闭时不可用
  const projectStore = storage ? new FileProjectStore(storage.root) : null
  // 启动时确保默认项目 proj_default 存在（无 projectId 的旧任务自动归入，见 H.1）
  if (projectStore && !projectStore.tryGet(DEFAULT_PROJECT_ID)) {
    const existingDir = projectStore.projectDir(DEFAULT_PROJECT_ID)
    if (fs.existsSync(existingDir)) {
      if (!projectStore.recoverInterruptedCreate(DEFAULT_PROJECT_ID)) {
        throw new Error(`默认项目目录存在但元数据缺失；已保留原始数据，请检查 ${existingDir}`)
      }
    } else {
      projectStore.create({ projectId: DEFAULT_PROJECT_ID, name: '未分类任务', owner: 'local-user', tenantId: 'local' })
    }
  }
  // 项目级事件总线：project_created / project_updated / task_created（供协作 WS 房间订阅广播）
  const projectBus = new EventEmitter()
  projectBus.setMaxListeners(0)
  const broadcastProjectEvent = (payload) => {
    try { projectBus.emit('project', payload) } catch { /* 广播不阻断主流程 */ }
  }
  const preferenceStore = new PreferenceStore(storage)
  const tenantPreferences = new Map()
  const preferencesFor = (tenantId = 'local') => {
    if (tenantId === 'local') return preferenceStore
    if (!tenantPreferences.has(tenantId)) {
      const target = path.join(path.dirname(localSettingsPath), `preferences-${Buffer.from(tenantId).toString('hex')}.json`)
      tenantPreferences.set(tenantId, new PreferenceStore({
        loadPreferences: () => fs.existsSync(target) ? readLocalJson(target) : { paused: false, events: [] },
        savePreferences: value => writeLocalJson(target, value)
      }))
    }
    return tenantPreferences.get(tenantId)
  }

  const formatRegistry = options.formatRegistry ?? createDefaultFormatRegistry()
  const bundleStore = options.bundleStore ?? new BundleStore()
  const identityStore = options.identityStore ?? new IdentityStore({ root: storage?.root ?? null, secret: options.authSecret ?? process.env.LOCAL_AGENT_AUTH_SECRET ?? token })
  const cloudAccountUrl = options.cloudAccountUrl ?? process.env.LOCAL_AGENT_CLOUD_ACCOUNT_URL
  const cloudAccounts = !webOnlyEngines && cloudAccountUrl ? new CloudAccountClient({ baseUrl: cloudAccountUrl, root: storage?.root ?? null, fetchImpl: options.cloudAccountFetch ?? fetch }) : null
  const userProfiles = new UserProfileStore(storage?.root ?? null)
  const modelSecrets = options.modelSecrets ?? new ModelSecretStore(storage?.root ?? null)
  const checkModelSettings = options.modelSettingsValidator ?? validateModelSettings
  const platformProjectStore = options.projectStore ?? new PlatformProjectStore({ root: storage?.root ?? null, cloudAdapter: createCloudAdapter(options) })
  const pluginRegistry = options.pluginRegistry ?? new PluginRegistry()
  for (const format of formatRegistry.list()) pluginRegistry.register('dataFormats', format)
  const collaborationStore = options.collaborationStore ?? new CollaborationStore()
  const remoteNodes = options.remoteNodes ?? new RemoteNodeRegistry({ fetchImpl: options.fetchImpl })
  const localProjectStore = options.localProjectStore ?? new LocalProjectStore()
  const authManager = new AuthManager({ secret: remoteConfig.secret || randomBytes(32).toString('hex'), sessionTtlMs: remoteConfig.sessionTtlMs })
  const rateLimiter = new RateLimiter(remoteConfig.rateLimit)
  const uploadStore = new UploadStore(path.join(dataDir, 'uploads'), { maxBytes })
  const uploadCleanupTimer = setInterval(() => uploadStore.cleanup(), 15 * 60 * 1000)
  uploadCleanupTimer.unref()

  const store = new TaskStore({ storage, projectStore })
  const restored = store.restore()

  // ---- 账户体系：邀请码与用户云存储 ----
  const inviteStore = options.inviteStore ?? new InviteStore({ root: storage?.root ?? null })
  const cloudStore = options.cloudStore ?? new TenantCloudStore({
    root: storage ? path.join(dataDir, 'cloud') : null,
    quotaBytes: Number(process.env.LOCAL_AGENT_CLOUD_QUOTA_BYTES) || DEFAULT_CLOUD_QUOTA_BYTES
  })

  // 初始管理员引导：绝不使用跨安装实例共享的默认密码。
  if (!identityStore.state.users.some((user) => user.role === 'admin')) {
    const adminUsername = String(process.env.LOCAL_AGENT_ADMIN_USERNAME ?? 'admin').trim().toLowerCase()
    const configuredPassword = process.env.LOCAL_AGENT_ADMIN_PASSWORD
    const adminPassword = configuredPassword ?? randomBytes(24).toString('base64url')
    try {
      identityStore.register({ username: adminUsername, password: adminPassword, displayName: '管理员', role: 'admin', status: 'active', bootstrap: true, protected: true })
      if (configuredPassword === undefined && storage?.root) {
        fs.writeFileSync(path.join(storage.root, 'admin-bootstrap.local'), JSON.stringify({ username: adminUsername, password: adminPassword }), { mode: 0o600, flag: 'wx' })
      }
      process.stdout.write('[auth] 初始管理员已创建；凭据不写入日志。请设置 LOCAL_AGENT_ADMIN_PASSWORD，或从受保护的数据目录读取 admin-bootstrap.local 后立即修改密码并删除该文件。\n')
    } catch (error) {
      process.stderr.write(`[auth] 初始管理员创建失败：${error.message}\n`)
    }
  }

  // ---- 数据保留：未上云项目超过保留期自动清除（公网模式默认 7 天；本机模式默认关闭） ----
  const retention = startRetentionScheduler({
    platformProjectStore,
    fileProjectStore: projectStore,
    cloudStore,
    retentionDays: resolveRetentionDays({ remoteEnabled }),
    onSwept: (project) => process.stdout.write(`[retention] 已清除超期未上云项目 ${project.projectId}（属主 ${project.ownerId}）\n`)
  })

  // ---- 阶段 3：批量拆分预览暂存（内存态，TTL 5 分钟）----
  // preview 端点接收多文件后暂存字节，confirm 凭 batchId 取回并批量建任务。
  const pendingBatches = new Map() // batchId -> { files: Map<fileName,{fileName,buffer}>, createdAt }
  const BATCH_TTL_MS = 5 * 60 * 1000
  const sweepPendingBatches = () => {
    const now = Date.now()
    for (const [id, entry] of pendingBatches) if (now - entry.createdAt > BATCH_TTL_MS) pendingBatches.delete(id)
  }

  // ---- 阶段 6：审批模式与待审批请求 ----
  let approvalMode = process.env.LOCAL_AGENT_APPROVAL_MODE === 'yolo' || process.env.LOCAL_AGENT_APPROVAL_MODE === 'auto'
    ? process.env.LOCAL_AGENT_APPROVAL_MODE
    : 'user'
  const pendingApprovals = new Map() // requestId -> { taskId, action, resolve }

  // ---- 阶段 4：plans_ready 事件自动记录图表类型使用直方图 ----
  // 图表类别归一化：从 plan.spec.panels[*].layers[*].kind 提取，映射到 7 大类
  const CHART_CATEGORY = (kind) => {
    if (!kind) return null
    const k = String(kind).toLowerCase()
    if (k.includes('heatmap')) return 'heatmap'
    if (k.includes('scatter')) return 'scatter'
    if (k.includes('box')) return 'box'
    if (k.includes('violin')) return 'box'
    if (k.includes('area')) return 'area'
    if (k.includes('pie')) return 'pie'
    if (k.includes('bar')) return 'bar'
    if (k.includes('line')) return 'line'
    return null
  }
  const recordChartUsageFromPlans = (task, plans) => {
    if (!projectStore || !task?.projectId || !Array.isArray(plans)) return
    for (const plan of plans) {
      const layers = plan?.spec?.panels?.flatMap?.((p) => p.layers ?? []) ?? []
      for (const layer of layers) {
        const cat = CHART_CATEGORY(layer?.kind)
        if (cat) {
          try { projectStore.recordChartUsage(task.projectId, cat) } catch { /* 记录失败不阻断任务 */ }
        }
      }
    }
  }
  // 包装中央事件入口：live 触发的 plans_ready 才记录（restore 重放走 applyEvent，不经此路径）
  const origEmit = store.emit.bind(store)
  store.emit = (task, event) => {
    origEmit(task, event)
    if (event?.type === 'plans_ready') {
      try { recordChartUsageFromPlans(task, event.plans) } catch { /* 静默 */ }
    }
  }
  // 每个服务器实例使用独立的沙箱串行队列：多实例（测试）互不阻塞
  // Tests and alternative deployments may inject an execution adapter (for
  // example a remote R/MATLAB node).  Keep the per-server queue as the safe
  // default, but do not silently discard an explicitly supplied adapter.
  const localSandbox = options.runSandbox ?? createSandboxRunner()
  const runSandbox = (request) => remoteNodes.execute(request, localSandbox)
  const orchestrator = new Orchestrator(store, { stepDelayMs, storage, preferenceStore, getPreferenceStore: task => preferencesFor(task.tenantId), modelFetch: options.modelFetch, probeEngines: options.probeEngines, runSandbox, getUserProfile: async (task) => cloudAccounts && task.tenantId !== 'local' ? (await cloudAccounts.profileForIdentity({ userId: task.tenantId })).profile : userProfiles.get(task.tenantId).profile })
  const backgroundOperations = new Set()
  const runBackground = (operation) => {
    const pending = Promise.resolve().then(operation)
    backgroundOperations.add(pending)
    void pending.catch(() => {}).finally(() => backgroundOperations.delete(pending))
    return pending
  }

  const sendJson = (res, status, obj, extraHeaders) => {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'x-agent-protocol': String(PROTOCOL_VERSION),
      'cache-control': 'no-store',
      ...(extraHeaders || {})
    })
    res.end(JSON.stringify(obj))
  }

  const DEPRECATED_TASK_API = { 'x-deprecation-warning': `use /api/projects/:projectId/tasks` }

  const authContext = (req) => {
    const auth = req.headers['authorization']
    const bearer = auth?.startsWith('Bearer ') ? auth.slice(7) : null
    const agentToken = req.headers['x-agent-token']
    if (bearer === token || agentToken === token) {
      const delegated = req.headers['x-user-token'] ? (identityStore.verify(String(req.headers['x-user-token'])) ?? cloudAccounts?.verify(String(req.headers['x-user-token']))) : null
      if (req.headers['x-user-token'] && !delegated) throw new ApiError(401, ERR.UNAUTHORIZED, '用户会话无效')
      return delegated ?? { userId: 'local-user', kind: 'local', displayName: '本机用户' }
    }
    return identityStore.verify(bearer) ?? cloudAccounts?.verify(bearer)
  }

  // 文件态项目属主守卫：加载项目并强制 owner 隔离，防止仅凭（可猜测的）项目 ID 越权访问。
  // 本机默认项目（owner=local-user）仅对本机 local 身份放行；其余项目仅属主可访问。
  const ownedFileProject = (projectId, identity) => {
    if (!projectStore) throw new ApiError(503, ERR.BAD_REQUEST, '项目存储未启用（persist=0）')
    const project = projectStore.tryGet(projectId)
    if (!project || project.status === 'deleted') throw new ApiError(404, ERR.PROJECT_NOT_FOUND, `项目不存在：${projectId}`)
    const me = identity?.userId
    if (project.owner !== me && !(project.owner === 'local-user' && identity?.kind === 'local')) {
      throw new ApiError(403, ERR.FORBIDDEN, '没有访问该项目的权限')
    }
    return project
  }

  const modelPermissions = (identity) => {
    const account = identity?.kind === 'account' ? identityStore.findUser(identity.userId) ?? identity : null
    return {
      allowOwn: account?.role === 'admin' || account?.modelAccess?.allowOwn === true,
      allowShared: account?.role === 'admin'
    }
  }
  const modelConfigForIdentity = (identity) => {
    // Desktop and VS Code keep their own local Agent/model settings.
    if (!remoteEnabled && !testWeb && !publicWeb) return localModelConfig(identity) ?? (identity?.kind === 'local' ? providerConfig() : { apiKey: '', baseUrl: '' })
    if (identity?.kind !== 'account') return { apiKey: '', baseUrl: '' }
    const account = identityStore.findUser(identity.userId)
    const permissions = modelPermissions(identity)
    if (account?.modelSource === 'own' && permissions.allowOwn) return modelSecrets.getUser(identity.userId) ?? { apiKey: '', baseUrl: '' }
    if (account?.modelSource === 'shared' && permissions.allowShared) return modelSecrets.getShared() ?? { apiKey: '', baseUrl: '' }
    return { apiKey: '', baseUrl: '' }
  }
  const modelView = (identity) => {
    const permissions = modelPermissions(identity)
    const account = identityStore.findUser(identity.userId)
    return {
      source: account?.modelSource ?? 'none', permissions,
      own: permissions.allowOwn ? modelConfigSummary(modelSecrets.getUser(identity.userId)) : { configured: false },
      shared: permissions.allowShared ? modelConfigSummary(modelSecrets.getShared()) : { configured: false }
    }
  }
  const requireModelAccount = (identity) => {
    if (identity?.kind !== 'account') throw new ApiError(403, ERR.FORBIDDEN, '请先登录账号')
  }
  // Per-account local vault. Plaintext legacy settings are migrated only to the
  // host identity; never transfer another person's key to a newly logged-in user.
  const localModels = new ModelSecretStore(path.dirname(localSettingsPath), { prefix: 'local-model-secrets' })
  const legacy = readLocalJson(localSettingsPath)
  if (legacy.model) {
    if (!localModels.getUser('local-user')) localModels.setUser('local-user', legacy.model)
    delete legacy.model
    writeLocalJson(localSettingsPath, legacy)
  }
  const localModelConfig = identity => localModels.getUser(identity.userId)
  const validatedSecretConfig = async (input, existing) => {
    if (!input || typeof input !== 'object') throw new ApiError(400, ERR.BAD_REQUEST, '模型配置无效')
    const apiKey = typeof input.apiKey === 'string' && input.apiKey.length ? input.apiKey : existing?.apiKey
    if (!apiKey) throw new ApiError(400, ERR.BAD_REQUEST, '请填写 API Key')
    try { return await checkModelSettings({ ...input, apiKey }) }
    catch { throw new ApiError(400, ERR.BAD_REQUEST, '模型配置无效，需 HTTPS 公网 API 地址、模型和密钥') }
  }

  const authenticate = (req) => {
    const auth = req.headers['authorization']
    const headerToken = auth?.startsWith('Bearer ') ? auth.slice(7) : req.headers['x-agent-token']
    if (headerToken === token) return { tenantId: 'local', subject: 'local-host', scopes: ['*'] }
    if (!remoteEnabled) return null
    return authManager.authenticate(auth)
  }

  const checkProtocol = (req) => {
    const v = req.headers['x-agent-protocol']
    return v === undefined || Number(String(v).split('.')[0]) === PROTOCOL_VERSION
  }

  const readJson = async (req) => {
    const body = await readBody(req, 1024 * 1024)
    if (!body.length) return {}
    return JSON.parse(body.toString('utf-8'))
  }

  const resolvePlan = (task, planId) => {
    const id = planId || task.selectedPlanId || task.plans.find((p) => p.executionStatus === 'verified')?.plan_id || task.plans[0]?.plan_id
    const plan = task.plans.find((p) => p.plan_id === id)
    if (!plan) throw new ApiError(404, ERR.PLAN_NOT_FOUND, `方案不存在：${planId ?? '(未指定)'}`, { availablePlans: task.plans.map((p) => p.plan_id) })
    return plan
  }


  // 升级后的 WebSocket 连接不受 http.Server.closeAllConnections() 管理，需单独跟踪关闭，
  // 否则服务关闭/测试结束后升级 socket 残留导致事件循环不退出。
  const wsConns = new Set()
  const upgradedSockets = new Set()
  const authAttempts = new Map()
  const limitAuth = (req, action, username = '') => {
    const timestamp = Date.now()
    for (const [key, entry] of authAttempts) if (timestamp >= entry.resetAt) authAttempts.delete(key)
    const key = `${req.socket.remoteAddress}:${action}:${String(username).trim().toLowerCase().slice(0, 64)}`
    let entry = authAttempts.get(key)
    if (!entry) {
      if (authAttempts.size >= 10000) throw new ApiError(429, 'RATE_LIMITED', '登录请求过多，请稍后重试')
      entry = { count: 0, resetAt: timestamp + 60000 }; authAttempts.set(key, entry)
    }
    if (++entry.count > (action === 'register' ? 10 : action === 'login-ip' ? 60 : 20)) throw new ApiError(429, 'RATE_LIMITED', '请求过于频繁，请一分钟后重试')
  }

  const server = http.createServer(async (req, res) => {
    try {
      const url = new URL(req.url, `http://${req.headers.host ?? '127.0.0.1'}`)
      const pathName = url.pathname
      const method = req.method

      // 安全基线响应头（静态与 API 统一）：防 MIME 嗅探、限制来源信息泄露、禁止页面被第三方嵌套
      // （点击劫持）。桌面端经 Tauri 协议顶层加载、插件 UI 由 VS Code webview 提供，均不受影响。
      res.setHeader('X-Content-Type-Options', 'nosniff')
      res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin')
      res.setHeader('X-Frame-Options', 'DENY')
      // 关闭与本服务无关的高风险浏览器能力；语音输入所需的麦克风、复制邀请码所需的剪贴板保持默认放行。
      res.setHeader('Permissions-Policy', 'camera=(), geolocation=(), usb=(), hid=(), payment=(), interest-cohort=()')

      // ---- CORS（开发态浏览器直连本机 5181 时使用）----
      // 安全约束：仅放行精确回环 Origin（127.0.0.1 / localhost，任意端口），禁止通配 *。
      // 经 Vite 代理（同源）时浏览器不发 Origin，此中间件不附加任何头，不影响既有链路。
      const LOOPBACK_ORIGIN = /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/
      // VS Code webview 是隔离源，插件 UI 直连本机 Agent 时也必须通过 CORS。
      const VSCODE_WEBVIEW_ORIGIN = /^(?:vscode-webview:\/\/[a-z0-9-]+|https:\/\/[a-z0-9-]+\.vscode-webview\.net)$/i
      const requestOrigin = typeof req.headers.origin === 'string' ? req.headers.origin : ''
      const originAllowed = LOOPBACK_ORIGIN.test(requestOrigin) || VSCODE_WEBVIEW_ORIGIN.test(requestOrigin)

      if (method === 'OPTIONS') {
        // 预检请求：直接 204，不进入鉴权与业务路由
        res.writeHead(204, {
          'Access-Control-Allow-Origin': originAllowed ? requestOrigin : 'null',
          'Access-Control-Allow-Methods': 'GET,POST,PUT,DELETE,OPTIONS',
          'Access-Control-Allow-Headers': 'authorization,content-type,x-agent-protocol',
          'Access-Control-Allow-Credentials': 'true',
          'Access-Control-Max-Age': '86400'
        })
        return res.end()
      }
      // 非预检：仅在回环 Origin 命中时回显具体 Origin（不使用 *），允许携带凭据
      if (originAllowed) {
        res.setHeader('Access-Control-Allow-Origin', requestOrigin)
        res.setHeader('Access-Control-Allow-Credentials', 'true')
      }

      // 健康检查不要求令牌（容器/桌面端存活探测）
      if (method === 'GET' && pathName === '/health') {
        return sendJson(res, 200, {
          status: 'ok',
          service: '@deep-imaging/local-agent',
          version: '0.3.0',
          protocol: PROTOCOL_VERSION,
          persist: !!storage,
          restoredTasks: restored,
          mode: remoteEnabled ? 'remote' : 'local',
          time: new Date().toISOString()
        })
      }

      // 静态资源（官网/应用前端构建产物，LOCAL_AGENT_WEB_DIST_DIR 启用）：不要求令牌
      if (method === 'GET' && webDistDir && !pathName.startsWith('/api') && pathName !== '/health' && serveStatic(pathName, res)) return

      // 登录入口与只读分享消费端点不要求既有令牌。
      if (method === 'POST' && pathName === '/api/auth/anonymous') {
        if (publicWeb) throw new ApiError(403, ERR.FORBIDDEN, '网页服务需要登录账号')
        return sendJson(res, 201, identityStore.anonymous())
      }
      if (method === 'GET' && pathName === '/api/auth/username-available') {
        return sendJson(res, 200, identityStore.isUsernameAvailable(url.searchParams.get('username')))
      }
      if (method === 'POST' && pathName === '/api/auth/register') {
        limitAuth(req, 'register')
        const body = await readJson(req)
        const inviteCode = String(body.inviteCode ?? '').trim()
        if (inviteCode) inviteStore.assertAvailable(inviteCode)
        // 审批制：公网多用户模式（REMOTE_MODE=1）或显式开启时，注册进入待审核状态，由管理员通过/驳回
        const requiresApproval = remoteEnabled || process.env.LOCAL_AGENT_REGISTRATION_APPROVAL === '1'
        const result = identityStore.register({
          username: body.username, password: body.password, displayName: body.displayName, phone: body.phone,
          agreementAccepted: body.agreementAccepted, agreementVersion: body.agreementVersion,
          role: 'user', status: requiresApproval ? 'pending' : 'active'
        })
        if (inviteCode) {
          if (requiresApproval) inviteStore.reserve(inviteCode, result.user.userId)
          else inviteStore.consume(inviteCode) // 免审核模式：注册即视为使用，一次性邀请码立即失效删除
        }
        if (!requiresApproval) return sendJson(res, 201, result)
        return sendJson(res, 202, { user: result.user, pendingApproval: true })
      }
      if (method === 'POST' && pathName === '/api/auth/login') {
        limitAuth(req, 'login-ip')
        const body = await readJson(req)
        limitAuth(req, 'login', body.username)
        return sendJson(res, 200, cloudAccounts ? await cloudAccounts.login(body) : identityStore.login(body))
      }
      if (method === 'GET' && pathName === '/api/auth/local-session') {
        if (req.headers.authorization !== `Bearer ${token}` || webOnlyEngines) throw new ApiError(401, ERR.UNAUTHORIZED, '需要本机启动令牌')
        return sendJson(res, 200, { session: cloudAccounts?.resume() ?? null })
      }
      const publicShare = /^\/api\/shares\/([A-Za-z0-9_-]+)$/.exec(pathName)
      if (publicShare && method === 'GET') {
        const shared = platformProjectStore.resolveShare(publicShare[1])
        const tasks = shared.project.taskIds.map((taskId) => store.get(taskId)).filter(Boolean).map((task) => {
          const snapshot = store.snapshot(task)
          if (!shared.share.includeCode) for (const plan of snapshot.plans ?? []) delete plan.code
          if (snapshot.dataset) delete snapshot.dataset.headRows
          return snapshot
        })
        return sendJson(res, 200, { ...shared, tasks })
      }

      // 远程模式会话换取：部署方注入租户 API key 映射，不进入项目文件。
      if (remoteEnabled && method === 'POST' && pathName === '/api/auth/session') {
        const apiKey = String(req.headers['x-api-key'] ?? '')
        const identity = remoteConfig.users?.[apiKey]
        if (!identity?.tenantId) throw new ApiError(401, ERR.UNAUTHORIZED, '远程 API key 无效')
        return sendJson(res, 201, authManager.createSession({ tenantId: identity.tenantId, subject: identity.subject ?? identity.tenantId, scopes: identity.scopes }))
      }

      // 授权下载 URL 本身携带短时 HMAC，无需再携带 Bearer 会话。
      if (remoteEnabled && method === 'GET' && pathName === '/api/downloads/export') {
        let signed
        try {
          signed = authManager.verifyDownload(Object.fromEntries(url.searchParams))
        } catch (error) {
          throw new ApiError(error?.code === 'SIGNED_URL_EXPIRED' ? 410 : 403, error?.code ?? 'SIGNED_URL_INVALID', error?.message ?? '下载签名无效')
        }
        const task = store.get(signed.taskId)
        if (!task || task.tenantId !== signed.tenantId) throw new ApiError(404, ERR.TASK_NOT_FOUND, '任务不存在')
        const plan = resolvePlan(task, signed.planId)
        const zip = buildExport(task, plan.plan_id, storage)
        res.writeHead(200, { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="${plan.plan_id}.zip"`, 'x-agent-protocol': String(PROTOCOL_VERSION) })
        return res.end(zip)
      }

      if (testWeb && method === 'GET' && pathName === '/api/test/config') {
        if (remoteEnabled || publicWeb) throw new ApiError(403, ERR.FORBIDDEN, '公网服务禁止暴露测试令牌')
        res.setHeader('Cache-Control', 'no-store')
        return sendJson(res, 200, { token })
      }
      let identity = authContext(req)
      let principal
      if (identity) {
        principal = { tenantId: identity.kind === 'local' ? 'local' : identity.userId, subject: identity.userId, scopes: ['*'] }
      } else {
        try {
          principal = authenticate(req)
        } catch (error) {
          throw new ApiError(401, error?.code ?? ERR.UNAUTHORIZED, error?.message ?? '会话无效')
        }
        if (principal) identity = { userId: principal.subject, kind: 'remote', displayName: principal.subject }
      }
      if (!identity || !principal) {
        return jsonError(res, new ApiError(401, ERR.UNAUTHORIZED, '缺少或无效的服务/用户令牌'), {
          protocolVersion: PROTOCOL_VERSION
        })
      }

      const preferenceStore = preferencesFor(principal.tenantId)
      const guardedTaskId = /^\/api\/tasks\/([A-Za-z0-9_-]+)(?:\/|$)/.exec(pathName)?.[1]
      if (guardedTaskId && principal.tenantId !== 'local') {
        const task = store.get(guardedTaskId)
        if (task && task.tenantId !== principal.tenantId) throw new ApiError(404, ERR.TASK_NOT_FOUND, '任务不存在')
      }
      if (pathName === '/api/auth/logout' && method === 'POST') {
        requireModelAccount(identity)
        const auth = String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')
        return sendJson(res, 200, identity.cloudSessionKey ? await cloudAccounts.logout(auth) : identityStore.logout(auth))
      }
      if (remoteEnabled && principal.tenantId !== 'local') {
        try { rateLimiter.consume(principal.tenantId) } catch (error) {
          throw new ApiError(error?.code === 'RATE_LIMITED' ? 429 : 403, error?.code ?? 'RATE_LIMITED', error?.message ?? '租户配额超限', { retryAfterMs: error?.retryAfterMs })
        }
      }
      if (!checkProtocol(req)) {
        return jsonError(
          res,
          new ApiError(409, ERR.PROTOCOL_MISMATCH, `协议版本不兼容，本服务要求 X-Agent-Protocol v${PROTOCOL_VERSION}`),
          { protocolVersion: PROTOCOL_VERSION }
        )
      }

      if (pathName === '/api/local/settings' || pathName === '/api/local/ui') {
        if (remoteEnabled || testWeb || publicWeb) throw new ApiError(403, ERR.BAD_REQUEST, '此接口仅供本地客户端使用')
        const target = pathName.endsWith('/settings') ? localSettingsPath : identity.kind === 'local' ? localUiPath : path.join(path.dirname(localUiPath), `ui-${Buffer.from(identity.userId).toString('hex')}.json`)
        if (method === 'GET') return sendJson(res, 200, target === localSettingsPath ? { model: modelConfigSummary(localModelConfig(identity)) } : readLocalJson(target))
        if (method === 'PUT') {
          const value = await readJson(req)
          if (target === localSettingsPath) {
            if (identity.kind !== 'local' && !modelPermissions(identity).allowOwn) throw new ApiError(403, ERR.FORBIDDEN, '未获自填 API 授权')
            if (value.clearKey === true) {
              localModels.deleteUser(identity.userId)
              return sendJson(res, 200, { model: { configured: false } })
            }
            const config = await validatedSecretConfig(value.model, localModelConfig(identity))
            localModels.setUser(identity.userId, config)
            return sendJson(res, 200, { model: modelConfigSummary(config) })
          }
          writeLocalJson(target, value)
          return sendJson(res, 200, { ok: true })
        }
      }

      if (process.env.LOCAL_ONLY_MODE === '1' && /^\/api\/projects\/[^/]+\/(sync|shares)/.test(pathName)) {
        throw new ApiError(403, ERR.BAD_REQUEST, '本地客户端不支持云同步或云分享')
      }
      if (method === 'GET' && pathName === '/api/auth/me') {
        if (identity.cloudSessionKey) return sendJson(res, 200, await cloudAccounts.me(String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '')))
        const profile = identity.kind === 'account' ? identityStore.findUser(identity.userId) : null
        return sendJson(res, 200, { user: profile ? identityStore.publicUser(profile) : identity })
      }

      if (pathName === '/api/user-profile' && (method === 'GET' || method === 'PUT')) {
        requireModelAccount(identity)
        const body = method === 'PUT' ? await readJson(req) : undefined
        return sendJson(res, 200, identity.cloudSessionKey ? await cloudAccounts.profileForIdentity(identity, { method, body }) : method === 'GET' ? userProfiles.get(identity.userId) : userProfiles.put(identity.userId, body))
      }

      // ---- 管理控制台：用户管理与邀请码管理（仅管理员账号可用） ----
      if (method === 'POST' && ['/api/me/model-catalog', '/api/local/model-catalog'].includes(pathName)) {
        const local = pathName.startsWith('/api/local/')
        if (local && webOnlyEngines) throw new ApiError(403, ERR.FORBIDDEN, '此接口仅供本机使用')
        if (!local || identity.kind !== 'local') {
          requireModelAccount(identity)
          if (!modelPermissions(identity).allowOwn) throw new ApiError(403, ERR.FORBIDDEN, '未获自填 API 授权')
        }
        const config = await validatedSecretConfig(await readJson(req), local ? localModelConfig(identity) : modelSecrets.getUser(identity.userId))
        try { return sendJson(res, 200, { models: await fetchModelCatalog(config) }) }
        catch { throw new ApiError(502, ERR.BAD_REQUEST, '无法获取模型目录，请手动添加模型 ID') }
      }
      const requireAdmin = () => {
        if (identity.kind !== 'account' || identity.role !== 'admin') throw new ApiError(403, ERR.FORBIDDEN, '需要管理员权限')
      }
      if (pathName === '/api/admin/model-config') {
        requireAdmin()
        if (method === 'GET') return sendJson(res, 200, modelConfigSummary(modelSecrets.getShared()))
        if (method === 'PUT') {
          const config = await validatedSecretConfig(await readJson(req), modelSecrets.getShared())
          modelSecrets.setShared(config)
          return sendJson(res, 200, modelConfigSummary(config))
        }
        if (method === 'DELETE') {
          modelSecrets.deleteShared()
          identityStore.clearModelSource('shared')
          return sendJson(res, 200, { configured: false })
        }
        throw new ApiError(405, ERR.METHOD_NOT_ALLOWED, `该资源不支持 ${method}`)
      }
      if (pathName === '/api/me/model-config') {
        requireModelAccount(identity)
        const permissions = modelPermissions(identity)
        if (method === 'GET') return sendJson(res, 200, modelView(identity))
        if (!permissions.allowOwn) throw new ApiError(403, ERR.FORBIDDEN, '未获自填 API 授权')
        if (method === 'PUT') {
          const config = await validatedSecretConfig(await readJson(req), modelSecrets.getUser(identity.userId))
          modelSecrets.setUser(identity.userId, config)
          identityStore.setModelSource(identity.userId, 'own')
          return sendJson(res, 200, modelView(identity))
        }
        if (method === 'DELETE') {
          modelSecrets.deleteUser(identity.userId)
          if (identityStore.findUser(identity.userId)?.modelSource === 'own') identityStore.setModelSource(identity.userId, 'none')
          return sendJson(res, 200, modelView(identity))
        }
        throw new ApiError(405, ERR.METHOD_NOT_ALLOWED, `该资源不支持 ${method}`)
      }
      if (pathName === '/api/me/model-source' && method === 'PUT') {
        requireModelAccount(identity)
        const source = String((await readJson(req)).source ?? '')
        if (source === 'own' && !modelSecrets.getUser(identity.userId)) throw new ApiError(409, ERR.BAD_REQUEST, '请先保存自己的 API 配置')
        if (source === 'shared' && !modelSecrets.getShared()) throw new ApiError(409, ERR.BAD_REQUEST, '管理员尚未保存统一 API 配置')
        identityStore.setModelSource(identity.userId, source)
        return sendJson(res, 200, modelView(identity))
      }
      if (pathName === '/api/admin/users' && method === 'GET') {
        requireAdmin()
        return sendJson(res, 200, { users: identityStore.listUsers() })
      }
      if (pathName === '/api/admin/users' && method === 'POST') {
        // 管理员直接创建用户（桌面端无注册界面，由管理员代建账号）
        requireAdmin()
        const body = await readJson(req)
        const result = identityStore.register({
          username: body.username, password: body.password, displayName: body.displayName, phone: body.phone,
          role: body.role === 'admin' ? 'admin' : 'user', status: 'active', adminProvisioned: true,
          modelAccess: body.modelAccess ?? { allowOwn: true, allowShared: false }
        })
        return sendJson(res, 201, result)
      }
      const adminUserMatch = /^\/api\/admin\/users\/([A-Za-z0-9_-]+)(?:\/(approve|reject))?$/.exec(pathName)
      if (adminUserMatch) {
        requireAdmin()
        const [, targetUserId, adminAction] = adminUserMatch
        if (adminAction === 'approve' && method === 'POST') {
          const user = identityStore.approveUser(targetUserId)
          const invite = inviteStore.findByReservation(targetUserId)
          if (invite) inviteStore.consume(invite.code) // 注册时预留的邀请码随审核通过一次性消费并自动删除
          return sendJson(res, 200, { user })
        }
        if (adminAction === 'reject' && method === 'POST') {
          const target = identityStore.findUser(targetUserId)
          if (!target) throw new ApiError(404, ERR.NOT_FOUND, '用户不存在')
          if (target.userId === identity.userId) throw new ApiError(400, ERR.BAD_REQUEST, '不能驳回当前登录的管理员账号')
          if (target.protected || target.role === 'admin') throw new ApiError(400, ERR.BAD_REQUEST, '管理员账号受系统保护，不可驳回')
          inviteStore.releaseByUser(targetUserId) // 驳回：释放邀请码预留，邀请码可再次使用
          const removed = identityStore.removeUser(targetUserId)
          modelSecrets.deleteUser(targetUserId)
          return sendJson(res, 200, { user: removed, rejected: true })
        }
        if (!adminAction && method === 'PUT') {
          const body = await readJson(req)
          const user = identityStore.updateUser(targetUserId, body)
          return sendJson(res, 200, { user })
        }
        if (!adminAction && method === 'DELETE') {
          if (targetUserId === identity.userId) throw new ApiError(400, ERR.BAD_REQUEST, '不能删除当前登录的管理员账号')
          const target = identityStore.findUser(targetUserId)
          if (!target) throw new ApiError(404, ERR.NOT_FOUND, '用户不存在')
          if (target.protected) throw new ApiError(400, ERR.BAD_REQUEST, '该内置管理员账号受系统保护，不可删除')
          if (target.role === 'admin') throw new ApiError(400, ERR.BAD_REQUEST, '不能删除管理员账号')
          // 数据隔离清理：删除该用户名下全部项目数据与云端镜像
          for (const project of platformProjectStore.state.projects.filter((item) => item.ownerId === targetUserId)) {
            try { projectStore?.delete(project.projectId) } catch { /* 目录可能已不存在 */ }
            try { cloudStore.removeProject(targetUserId, project.projectId) } catch { /* 云端未启用 */ }
          }
          platformProjectStore.state.projects = platformProjectStore.state.projects.filter((item) => item.ownerId !== targetUserId)
          platformProjectStore.persist()
          try { cloudStore.removeTenant(targetUserId) } catch { /* 云端未启用 */ }
          const removed = identityStore.removeUser(targetUserId)
          modelSecrets.deleteUser(targetUserId)
          return sendJson(res, 200, { user: removed, deleted: true })
        }
        throw new ApiError(405, ERR.METHOD_NOT_ALLOWED, `该管理资源不支持 ${method}`)
      }
      if (pathName === '/api/admin/invites' && method === 'GET') {
        requireAdmin()
        return sendJson(res, 200, { invites: inviteStore.list() })
      }
      if (pathName === '/api/admin/invites' && method === 'POST') {
        requireAdmin()
        const body = await readJson(req)
        const invite = inviteStore.create({ code: body.code, createdBy: identity.userId })
        return sendJson(res, 201, { invite })
      }
      const adminInviteMatch = /^\/api\/admin\/invites\/([A-Za-z0-9_-]+)$/.exec(pathName)
      if (adminInviteMatch && method === 'DELETE') {
        requireAdmin()
        return sendJson(res, 200, { invite: inviteStore.remove(inviteStore.safeCode(adminInviteMatch[1])) })
      }

      // ---- 云存储用量与项目上云 ----
      if (pathName === '/api/cloud/usage' && method === 'GET') {
        const usage = cloudStore.root ? cloudStore.usage(principal.tenantId) : { usedBytes: 0, quotaBytes: cloudStore.quotaBytes }
        return sendJson(res, 200, { usage: cloudUsageView(usage), projects: cloudStore.listProjects(principal.tenantId) })
      }
      const cloudMatch = /^\/api\/projects\/([A-Za-z0-9_-]+)\/cloud$/.exec(pathName)
      if (cloudMatch && method === 'POST') {
        const projectId = cloudMatch[1]
        const project = platformProjectStore.get(projectId, identity.userId, 'editor')
        if (!cloudStore.root || !projectStore) throw new ApiError(503, 'CLOUD_NOT_CONFIGURED', '云存储未启用，无法上云')
        const projectDir = projectStore.projectDir(projectId)
        if (!fs.existsSync(projectDir)) throw new ApiError(404, ERR.PROJECT_NOT_FOUND, `项目数据不存在：${projectId}`)
        const { usage } = cloudStore.archive(principal.tenantId, projectId, projectDir)
        project.cloudEnabled = true
        project.cloud = { ...project.cloud, status: 'synced', lastSyncedAt: Date.now() }
        if (platformProjectStore.cloudAdapter) {
          try {
            const pushed = await platformProjectStore.cloudAdapter.put(projectId, platformProjectStore.public(project), project.cloud.remoteRevision ?? null)
            project.cloud.remoteRevision = pushed.revision
          } catch { /* 元数据推送失败不阻断数据镜像 */ }
        }
        project.dirty = false
        platformProjectStore.persist()
        return sendJson(res, 200, { project: platformProjectStore.public(project), usage: cloudUsageView(usage) })
      }

      // ---- 项目保存/重新打开、处理步骤锁、云端同步和只读分享 ----
      // 阶段 1 桥接：POST/GET /api/projects 仍由协作层（platformProjectStore）承载以兼容既有
      // locks/sync/shares/comments；同时在文件态新模型中补建任务容器目录（同 ID）。
      if (pathName === '/api/projects' && method === 'GET') return sendJson(res, 200, { projects: platformProjectStore.list(identity.userId) })
      if (pathName === '/api/projects' && method === 'POST') {
        const body = await readJson(req)
        const project = platformProjectStore.create(identity.userId, body)
        if (projectStore) {
          projectStore.attachExisting(project.projectId, {
            name: project.name, description: project.description, owner: identity.userId, tenantId: 'local'
          })
          broadcastProjectEvent({ type: 'project_created', projectId: project.projectId, name: project.name })
        }
        return sendJson(res, 201, { project })
      }
      const projectMatch = /^\/api\/projects\/(?!(?:create|open|settings|close)(?:$|\/))([A-Za-z0-9_-]+)(?:\/(sync|locks|attachments|shares)(?:\/([A-Za-z0-9_-]+))?)?$/.exec(pathName)
      if (projectMatch) {
        const [, projectId, action, actionId] = projectMatch
        if (!action && method === 'GET') {
          const project = platformProjectStore.public(platformProjectStore.get(projectId, identity.userId))
          // 合并文件态新模型字段（status/preferences/taskIds 等），协作层字段保持原样
          const fileProject = projectStore?.tryGet(projectId)
          const merged = fileProject ? { ...fileProject, ...project, taskIds: fileProject.taskIds.length ? fileProject.taskIds : project.taskIds } : project
          return sendJson(res, 200, {
            project: merged,
            tasks: merged.taskIds.map((taskId) => store.get(taskId)).filter(Boolean).map((task) => store.snapshot(task)),
            bundles: project.bundleIds.map((bundleId) => bundleStore.get(bundleId)).filter(Boolean).map((bundle) => bundleStore.snapshot(bundle))
          })
        }
        if (!action && method === 'PUT') {
          const body = await readJson(req)
          const project = platformProjectStore.update(projectId, identity.userId, body)
          projectStore?.update(projectId, body)
          broadcastProjectEvent({ type: 'project_updated', projectId, changedKeys: Object.keys(body) })
          return sendJson(res, 200, { project })
        }
        if (!action && method === 'DELETE') {
          // 删除前强制属主校验：先确认调用方至少可见，再要求其为项目创建者，
          // 协作编辑者与其他用户一律拒绝，杜绝越权删除他人项目（IDOR）。
          const owned = platformProjectStore.get(projectId, identity.userId)
          if (owned.ownerId !== identity.userId) throw new ApiError(403, ERR.FORBIDDEN, '仅项目创建者可删除该项目')
          // 软删除：文件态目录移入 .trash；协作层记录不做物理删除
          if (!projectStore) throw new ApiError(503, ERR.BAD_REQUEST, '项目存储未启用（persist=0）')
          projectStore.delete(projectId)
          broadcastProjectEvent({ type: 'project_updated', projectId, changedKeys: ['status'] })
          return sendJson(res, 200, { ok: true, projectId, deleted: true })
        }
        if (action === 'attachments' && method === 'POST') {
          const data = await readJson(req)
          if (data.taskId && !store.get(String(data.taskId))) throw new ApiError(404, ERR.TASK_NOT_FOUND, `任务不存在：${data.taskId}`)
          if (data.bundleId && !bundleStore.get(String(data.bundleId))) throw new ApiError(404, ERR.NOT_FOUND, `数据包不存在：${data.bundleId}`)
          if (data.taskId) {
            const task = store.get(String(data.taskId))
            if (principal.tenantId !== 'local' && task.tenantId !== principal.tenantId) throw new ApiError(404, ERR.TASK_NOT_FOUND, '任务不存在')
            if (projectStore?.tryGet(task.projectId)) {
              try { platformProjectStore.get(task.projectId, identity.userId) }
              catch (error) {
                if (error.status !== 404) throw error
                ownedFileProject(task.projectId, identity)
              }
            }
          }
          const project = platformProjectStore.attach(projectId, identity.userId, { taskId: data.taskId && String(data.taskId), bundleId: data.bundleId && String(data.bundleId) })
          if (data.taskId && projectStore) projectStore.addTask(projectId, String(data.taskId))
          return sendJson(res, 200, { project })
        }
        if (action === 'locks' && method === 'GET') return sendJson(res, 200, { lockedSteps: platformProjectStore.get(projectId, identity.userId).lockedSteps })
        if (action === 'locks' && method === 'PUT') return sendJson(res, 200, { lockedSteps: platformProjectStore.setLocks(projectId, identity.userId, (await readJson(req)).locks) })
        if (action === 'sync' && method === 'POST') return sendJson(res, 200, { project: await platformProjectStore.sync(projectId, identity.userId, await readJson(req)) })
        if (action === 'shares' && !actionId && method === 'POST') return sendJson(res, 201, { share: platformProjectStore.createShare(projectId, identity.userId, await readJson(req)) })
        if (action === 'shares' && actionId && method === 'DELETE') return sendJson(res, 200, { share: platformProjectStore.revokeShare(projectId, actionId, identity.userId) })
        throw new ApiError(405, ERR.METHOD_NOT_ALLOWED, `该项目资源不支持 ${method}`)
      }

      // ---- 阶段 3：批量多文件拆分预览 / 确认（建任务）----
      // 必须在 projectTaskRoom 之前匹配，否则 /tasks/batch 会落入通用 tasks 子路由。
      const batchMatch = /^\/api\/projects\/([A-Za-z0-9_-]+)\/tasks\/batch(?:\/(confirm))?$/.exec(pathName)
      if (batchMatch && method === 'POST') {
        if (!projectStore) throw new ApiError(503, ERR.BAD_REQUEST, '项目存储未启用（persist=0）')
        const [, projectId, isConfirm] = batchMatch
        const project = ownedFileProject(projectId, identity)

        if (!isConfirm) {
          // 预览：接收 multipart 多文件 → analyzeFileGroup → 返回分组（不建任务）
          const ct = req.headers['content-type'] ?? ''
          if (!ct.includes('multipart/form-data')) throw new ApiError(415, ERR.UNSUPPORTED_MEDIA_TYPE, 'Content-Type 必须为 multipart/form-data')
          const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct)
          const body = await readBody(req, maxBytes, res)
          let parsed
          try {
            parsed = parseMultipart(body, (boundary?.[1] ?? boundary?.[2] ?? '').trim())
          } catch (e) {
            if (e instanceof MultipartError) throw new ApiError(400, ERR.BAD_REQUEST, `multipart 解析失败：${e.message}`)
            throw e
          }
          const fileList = parsed.files.map((f) => ({ fileName: safeCsvName(f.fileName || 'upload.csv'), bytes: f.buffer }))
          if (!fileList.length) throw new ApiError(400, ERR.MISSING_FILE, '缺少文件字段')
          const groups = analyzeFileGroup(fileList)
          // 暂存字节供 confirm 使用
          const batchId = `batch_${Date.now().toString(36)}_${randomUUID().replace(/-/g, '').slice(0, 8)}`
          sweepPendingBatches()
          pendingBatches.set(batchId, { files: new Map(fileList.map((f) => [f.fileName, f])), createdAt: Date.now() })
          return sendJson(res, 200, { projectId, batchId, groups })
        }

        // 确认：凭 batchId 取回文件，每组建一个任务
        const data = await readJson(req)
        const entry = pendingBatches.get(String(data.batchId ?? ''))
        if (!entry) throw new ApiError(400, ERR.BAD_REQUEST, '批量会话不存在或已过期，请重新上传预览')
        const groups = Array.isArray(data.groups) ? data.groups : []
        if (!groups.length) throw new ApiError(400, ERR.BAD_REQUEST, 'groups 不能为空')
        const engine = 'python'
        const createdTasks = []
        for (const group of groups) {
          const wanted = Array.isArray(group.files) ? group.files.map((f) => (typeof f === 'string' ? f : f.fileName)) : []
          const buffers = wanted.map((name) => entry.files.get(name)).filter(Boolean)
          if (!buffers.length) continue
          const merged = mergeCsvBuffers(buffers)
          const fileName = buffers[0].fileName
          const title = typeof group.title === 'string' && group.title.trim() ? group.title : fileName
          // 合并组尝试真实解析，失败则跳过该组但不阻断其余组
          let ingest
          try {
            ingest = ingestFile(fileName, merged)
          } catch (e) {
            process.stderr.write(`[batch] 组 ${group.groupId} 合并数据解析失败：${e.message}\n`)
            continue
          }
          const task = store.create({ title, engine, prompt: String(data.prompt ?? ''), fileName, bytes: merged, tenantId: principal.tenantId, projectId })
          task.dataset = ingest.profile
          void runBackground(async () => {
            try { await orchestrator.run(task, ingest, modelConfigForIdentity(identity)) } catch { /* 后台任务失败不阻断批量响应 */ }
          })
          broadcastProjectEvent({ type: 'task_created', projectId, taskId: task.taskId, title: task.title })
          createdTasks.push({ taskId: task.taskId, title: task.title, state: task.state })
        }
        pendingBatches.delete(String(data.batchId ?? ''))
        projectStore.appendAudit(projectId, { action: 'batch_tasks_created', count: createdTasks.length, by: identity.userId })
        return sendJson(res, 201, { projectId, tasks: createdTasks })
      }

      // ---- 阶段 5：跨任务取数授权 grants ----
      const grantsMatch = /^\/api\/projects\/([A-Za-z0-9_-]+)\/grants(?:\/([A-Za-z0-9_-]+))?$/.exec(pathName)
      if (grantsMatch) {
        if (!projectStore) throw new ApiError(503, ERR.BAD_REQUEST, '项目存储未启用（persist=0）')
        const [, projectId, grantId] = grantsMatch
        const project = ownedFileProject(projectId, identity)

        if (!grantId && method === 'GET') {
          const active = projectStore.getGrants(projectId).filter((g) => g.status === 'active')
          return sendJson(res, 200, { projectId, grants: active })
        }
        if (!grantId && method === 'POST') {
          const body = await readJson(req)
          const fromTaskId = String(body.fromTaskId ?? '')
          const toTaskId = String(body.toTaskId ?? '')
          const fields = Array.isArray(body.fields) ? body.fields.map(String) : []
          const scope = body.scope === 'project' ? 'project' : 'once'
          // 双向归属校验：from/to 任务必须都属于本项目（跨项目授权直接拒绝）
          if (!project.taskIds.includes(fromTaskId) || !project.taskIds.includes(toTaskId)) {
            throw new ApiError(403, ERR.FORBIDDEN, '跨项目授权被拒绝：fromTaskId/toTaskId 必须属于本项目', { code: 'cross-project-access-denied' })
          }
          if (!fields.length) throw new ApiError(400, ERR.BAD_REQUEST, 'fields 不能为空（字段白名单）')
          const grant = {
            grantId: `grant_${Date.now().toString(36)}_${randomUUID().replace(/-/g, '').slice(0, 8)}`,
            fromTaskId, toTaskId, fields, scope,
            status: 'active',
            expiresAt: Date.now() + 24 * 60 * 60 * 1000
          }
          projectStore.appendGrant(projectId, grant)
          projectStore.appendAudit(projectId, { action: 'grant_created', grantId: grant.grantId, fromTaskId, toTaskId, fields, scope, by: identity.userId })
          broadcastProjectEvent({ type: 'grant_requested', projectId, grantId: grant.grantId, fromTaskId, toTaskId })
          return sendJson(res, 201, { projectId, grant })
        }
        if (grantId && method === 'DELETE') {
          const revoked = projectStore.revokeGrant(projectId, grantId)
          projectStore.appendAudit(projectId, { action: 'grant_revoked', grantId, by: identity.userId })
          broadcastProjectEvent({ type: 'grant_resolved', projectId, grantId, approved: false })
          return sendJson(res, 200, { projectId, grantId, status: 'revoked' })
        }
        throw new ApiError(405, ERR.METHOD_NOT_ALLOWED, `该资源不支持 ${method}`)
      }

      // ---- 阶段 4：图表类型使用直方图 ----
      const chartUsageMatch = /^\/api\/projects\/([A-Za-z0-9_-]+)\/chart-usage$/.exec(pathName)
      if (chartUsageMatch && method === 'GET') {
        if (!projectStore) throw new ApiError(503, ERR.BAD_REQUEST, '项目存储未启用（persist=0）')
        const projectId = chartUsageMatch[1]
        const project = ownedFileProject(projectId, identity)
        return sendJson(res, 200, { projectId, chartUsage: projectStore.getChartUsage(projectId) })
      }

      // ---- 阶段 1：项目内任务 / 偏好 / 审计 / 归档（文件态新模型，G.2/G.3） ----
      // 与上面协作层 projectMatch 不冲突：子动作 tasks/preferences/audit/archive 不在其捕获组内。
      const projectTaskRoom = /^\/api\/projects\/([A-Za-z0-9_-]+)\/(tasks|preferences|audit|archive)(?:\/([A-Za-z0-9_-]+)(?:\/([A-Za-z0-9_-]+(?:\/[A-Za-z0-9_-]+)?))?)?$/.exec(pathName)
      if (projectTaskRoom) {
        if (!projectStore) throw new ApiError(503, ERR.BAD_REQUEST, '项目存储未启用（persist=0）')
        const [, projectId, sub, subId, action] = projectTaskRoom
        const project = ownedFileProject(projectId, identity)

        // 项目内任务（G.2）
        if (sub === 'tasks') {
          if (!subId && method === 'POST') {
            // 项目内创建任务（multipart）：复用与 POST /api/tasks 相同的解析/校验链路，仅指定 projectId
            const ct = req.headers['content-type'] ?? ''
            if (!ct.includes('multipart/form-data')) throw new ApiError(415, ERR.UNSUPPORTED_MEDIA_TYPE, 'Content-Type 必须为 multipart/form-data')
            const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct)
            const body = await readBody(req, maxBytes, res)
            let parsed
            try {
              parsed = parseMultipart(body, (boundary?.[1] ?? boundary?.[2] ?? '').trim())
            } catch (e) {
              if (e instanceof MultipartError) throw new ApiError(400, ERR.BAD_REQUEST, `multipart 解析失败：${e.message}`)
              throw e
            }
            const prompt = (parsed.fields.prompt ?? '').toString()
            const engine = (parsed.fields.engine ?? 'python').toString().trim()
            if (!ENGINE_KINDS.has(engine)) throw new ApiError(400, ERR.INVALID_ENGINE, `未知引擎「${engine}」`)
            if (webOnlyEngines && engine === 'matlab') throw new ApiError(400, ERR.INVALID_ENGINE, '网页端不支持 MATLAB')
            const file = parsed.files.find((f) => f.field === 'file') ?? parsed.files[0]
            if (!file) throw new ApiError(400, ERR.MISSING_FILE, '缺少 CSV 文件字段')
            const fileName = safeCsvName(file.fileName || 'upload.csv')
            const ingest = ingestFile(fileName, file.buffer)
            const title = (parsed.fields.title ?? fileName).toString()
            if (remoteEnabled && principal.tenantId !== 'local') {
              try { rateLimiter.beginTask(principal.tenantId) } catch (error) { throw new ApiError(429, error?.code ?? 'QUOTA_EXCEEDED', error?.message ?? '任务配额超限') }
            }
            const task = store.create({ title, engine, prompt, fileName, bytes: file.buffer, tenantId: principal.tenantId, projectId })
            task.dataset = ingest.profile
            task.clarify = ['true', '1'].includes(String(parsed.fields.clarify ?? '').trim())
            if (parsed.fields.clarifyAnswers) {
              try { task.clarifyAnswers = JSON.parse(parsed.fields.clarifyAnswers) } catch { /* ask interactively */ }
            }
            void runBackground(async () => {
              try { await orchestrator.run(task, ingest, modelConfigForIdentity(identity)) } finally { if (remoteEnabled && principal.tenantId !== 'local') rateLimiter.endTask(principal.tenantId) }
            })
            broadcastProjectEvent({ type: 'task_created', projectId, taskId: task.taskId, title: task.title })
            return sendJson(res, 201, { taskId: task.taskId, projectId, state: task.state, protocol: PROTOCOL_VERSION })
          }
          if (!subId && method === 'GET') {
            // 项目内任务摘要列表（taskIndex = taskIds 中的序号，从 1 起）
            const summaries = project.taskIds.map((taskId, i) => {
              const task = store.get(taskId)
              if (!task) return null
              return { taskId, projectId, taskIndex: i + 1, title: task.title, state: task.state, createdAt: task.createdAt }
            }).filter(Boolean)
            return sendJson(res, 200, { projectId, tasks: summaries })
          }
          if (subId && !action && method === 'GET') {
            // 归属校验：taskId 必须属于本项目，否则 403 cross-project-access-denied
            if (!project.taskIds.includes(subId)) throw new ApiError(403, ERR.FORBIDDEN, '跨项目访问被拒绝：该任务不属于此项目', { code: 'cross-project-access-denied' })
            const task = store.get(subId)
            if (!task) throw new ApiError(404, ERR.TASK_NOT_FOUND, `任务不存在：${subId}`)
            return sendJson(res, 200, { projectId, taskIndex: project.taskIds.indexOf(subId) + 1, task: store.snapshot(task) })
          }
          if (subId && action === 'cancel' && method === 'POST') {
            if (!project.taskIds.includes(subId)) throw new ApiError(403, ERR.FORBIDDEN, '跨项目访问被拒绝：该任务不属于此项目', { code: 'cross-project-access-denied' })
            const task = store.get(subId)
            if (!task) throw new ApiError(404, ERR.TASK_NOT_FOUND, `任务不存在：${subId}`)
            return sendJson(res, 200, { ok: true, projectId, taskId: task.taskId, ...orchestrator.cancel(task) })
          }
          // 项目作用域任务动作统一转交给同一任务处理器：先做项目归属校验，再复用所有
          // answer/select/feedback/preview/export/patch/source/data 等兼容路由语义，避免两套实现漂移。
          if (subId && action) {
            if (!project.taskIds.includes(subId)) throw new ApiError(403, ERR.FORBIDDEN, '跨项目访问被拒绝：该任务不属于此项目', { code: 'cross-project-access-denied' })
            const task = store.get(subId)
            if (!task) throw new ApiError(404, ERR.TASK_NOT_FOUND, `任务不存在：${subId}`)
            // 保留查询串（planId、导出选项等），POST body 尚未读取，递归进入同一请求处理器。
            req.url = `/api/tasks/${encodeURIComponent(subId)}/${action}${url.search}`
            return server.emit('request', req, res)
          }
          if (subId && !action && method === 'DELETE') {
            if (!project.taskIds.includes(subId)) throw new ApiError(403, ERR.FORBIDDEN, '跨项目访问被拒绝：该任务不属于此项目', { code: 'cross-project-access-denied' })
            store.delete(subId)
            return sendJson(res, 200, { ok: true, projectId, taskId: subId, deleted: true })
          }
          throw new ApiError(405, ERR.METHOD_NOT_ALLOWED, `该资源不支持 ${method}`)
        }

        // 项目偏好（G.3）：合并写；GET 同时返回图表类型使用直方图
        if (sub === 'preferences') {
          if (method === 'GET') return sendJson(res, 200, { projectId, preferences: projectStore.getPreferences(projectId), chartUsage: projectStore.getChartUsage(projectId) })
          if (method === 'PUT') {
            const prefs = await readJson(req)
            const next = projectStore.setPreferences(projectId, prefs)
            projectStore.appendAudit(projectId, { action: 'project_preferences_updated', keys: Object.keys(prefs ?? {}), by: identity.userId })
            broadcastProjectEvent({ type: 'project_updated', projectId, changedKeys: ['preferences'] })
            return sendJson(res, 200, { projectId, preferences: next, chartUsage: projectStore.getChartUsage(projectId) })
          }
          throw new ApiError(405, ERR.METHOD_NOT_ALLOWED, `该资源不支持 ${method}`)
        }

        // 项目审计时间线（G.3）
        if (sub === 'audit' && method === 'GET') {
          const limit = Math.min(500, Math.max(1, Number(url.searchParams.get('limit') ?? 100)))
          return sendJson(res, 200, { projectId, records: projectStore.readAudit(projectId, limit) })
        }

        // 归档/恢复（G.1）：POST /archive  body: { archived: true|false }
        if (sub === 'archive' && method === 'POST') {
          const data = await readJson(req).catch(() => ({}))
          const archived = data.archived !== false
          const updated = projectStore.archive(projectId, archived)
          broadcastProjectEvent({ type: 'project_updated', projectId, changedKeys: ['status'] })
          return sendJson(res, 200, { projectId, status: updated.status })
        }
        throw new ApiError(405, ERR.METHOD_NOT_ALLOWED, `该资源不支持 ${method}`)
      }

      // ---- 完整批注、显著性标记与协作快照 ----
      const commentMatch = /^\/api\/projects\/([A-Za-z0-9_-]+)\/comments(?:\/([A-Za-z0-9_-]+)\/resolve)?$/.exec(pathName)
      if (commentMatch) {
        const [, projectId, commentId] = commentMatch
        platformProjectStore.get(projectId, identity.userId, commentId || method === 'POST' ? 'editor' : 'viewer')
        if (!commentId && method === 'GET') return sendJson(res, 200, collaborationStore.snapshot(projectId))
        if (!commentId && method === 'POST') return sendJson(res, 201, { comment: collaborationStore.addComment(projectId, identity, await readJson(req)) })
        if (commentId && method === 'POST') return sendJson(res, 200, { comment: collaborationStore.resolve(projectId, commentId, identity.userId) })
        throw new ApiError(405, ERR.METHOD_NOT_ALLOWED, `该批注资源不支持 ${method}`)
      }

      // ---- 引擎能力探测 ----
      if (method === 'GET' && pathName === '/api/capabilities') {
        const runtimes = await orchestrator.capabilities()
        // 公网 Web 不暴露 MATLAB，能力清单与可选语言保持一致。
        if (webOnlyEngines && runtimes.matlab) delete runtimes.matlab
        return sendJson(res, 200, {
          protocol: PROTOCOL_VERSION,
          runtimes,
          dataFormats: formatRegistry.list(),
          sandbox: sandboxCapabilities(),
          remote: { enabled: remoteEnabled, resumableUploads: remoteEnabled, signedDownloads: remoteEnabled }
        })
      }

      // 离线/管理端推荐质量校准：只接受脱敏后的 id 排名，不接触原始数据或密钥。
      if (method === 'POST' && pathName === '/api/decision/calibration') {
        const data = await readJson(req)
        if (!Array.isArray(data.predictedRanking) || !Array.isArray(data.groundTruthRanking)) {
          throw new ApiError(400, 'INVALID_CALIBRATION_INPUT', 'predictedRanking 与 groundTruthRanking 必须是数组')
        }
        return sendJson(res, 200, { report: calibrationReport(data.predictedRanking, data.groundTruthRanking) })
      }

      // ---- 数据格式注册表 / DatasetBundle 推荐门槛 ----
      if (method === 'GET' && pathName === '/api/plugins') {
        return sendJson(res, 200, { protocol: PROTOCOL_VERSION, registries: pluginRegistry.list() })
      }
      const pluginMatch = /^\/api\/plugins\/([A-Za-z][A-Za-z0-9_-]*)$/.exec(pathName)
      if (pluginMatch && method === 'POST' && identity.kind !== 'local') requireAdmin()
      if (pluginMatch && method === 'POST') return sendJson(res, 201, { plugin: pluginRegistry.register(pluginMatch[1], await readJson(req)) })

      // ---- 远程 R / MATLAB 授权节点（凭据仅从命名环境变量读取） ----
      if (pathName.startsWith('/api/remote-nodes') && identity.kind !== 'local') requireAdmin()
      if (pathName === '/api/remote-nodes' && method === 'GET') return sendJson(res, 200, { nodes: remoteNodes.list() })
      if (pathName === '/api/remote-nodes' && method === 'POST') return sendJson(res, 201, { node: remoteNodes.register(await readJson(req)) })
      const remoteNodeMatch = /^\/api\/remote-nodes\/([A-Za-z0-9_-]+)\/check$/.exec(pathName)
      if (remoteNodeMatch && method === 'POST') return sendJson(res, 200, { node: await remoteNodes.check(remoteNodeMatch[1]) })
      if (method === 'GET' && pathName === '/api/bundles') {
        return sendJson(res, 200, { bundles: [...bundleStore.bundles.values()].map((bundle) => bundleStore.snapshot(bundle)) })
      }
      if (method === 'POST' && pathName === '/api/bundles') {
        const ct = req.headers['content-type'] ?? ''
        if (!ct.includes('multipart/form-data')) throw new ApiError(415, ERR.UNSUPPORTED_MEDIA_TYPE, 'Content-Type 必须为 multipart/form-data')
        const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct)
        const body = await readBody(req, Math.max(maxBytes, 260 * 1024 * 1024), res)
        let parsed
        try { parsed = parseMultipart(body, (boundary?.[1] ?? boundary?.[2] ?? '').trim()) } catch (e) {
          if (e instanceof MultipartError) throw new ApiError(400, ERR.BAD_REQUEST, `multipart 解析失败：${e.message}`)
          throw e
        }
        if (parsed.files.length < 1 || parsed.files.length > 5) throw new ApiError(400, ERR.BUNDLE_FILE_COUNT, '请上传 1—5 份 CSV、JSON 或 XLSX 文件')
        let selectedSheets = {}
        if (parsed.fields.selectedSheets) {
          try { selectedSheets = JSON.parse(parsed.fields.selectedSheets) } catch { throw new ApiError(400, ERR.BAD_REQUEST, 'selectedSheets 必须为 JSON 对象') }
        }
        const files = []
        const datasets = []
        parsed.files.forEach((file, fileIndex) => {
          const sourceFileId = `file_${fileIndex + 1}`
          const sourceFileName = path.basename(String(file.fileName || `upload-${fileIndex + 1}`).replace(/\\/g, '/'))
          const parsedFile = formatRegistry.parse(sourceFileName, file.buffer, { selectedSheets: selectedSheets[sourceFileName] })
          files.push({ sourceFileId, fileName: sourceFileName, format: parsedFile.plugin, buffer: file.buffer })
          parsedFile.datasets.forEach((dataset, datasetIndex) => datasets.push({
            ...dataset,
            datasetId: `ds_${fileIndex + 1}_${datasetIndex + 1}_${dataset.profile.fingerprint.slice(0, 8)}`,
            sourceFileId,
            sourceFileName
          }))
        })
        const bundle = bundleStore.create({ prompt: String(parsed.fields.prompt ?? ''), files, datasets })
        bundle.tenantId = principal.tenantId
        return sendJson(res, 201, bundleStore.snapshot(bundle))
      }
      const bundleMatch = /^\/api\/bundles\/([A-Za-z0-9_-]+)(?:\/(decisions))?$/.exec(pathName)
      if (bundleMatch) {
        const bundle = bundleStore.get(bundleMatch[1])
        if (!bundle) throw new ApiError(404, ERR.NOT_FOUND, `数据包不存在：${bundleMatch[1]}`)
        if (principal.tenantId !== 'local' && bundle.tenantId !== principal.tenantId) throw new ApiError(404, ERR.NOT_FOUND, '数据包不存在')
        if (!bundleMatch[2] && method === 'GET') return sendJson(res, 200, bundleStore.snapshot(bundle))
        if (bundleMatch[2] === 'decisions' && method === 'POST') {
          const data = await readJson(req).catch(() => ({}))
          const engine = String(data.engine ?? 'python')
          if (!ENGINE_KINDS.has(engine)) throw new ApiError(400, ERR.INVALID_ENGINE, `未知引擎：${engine}`)
          if (webOnlyEngines && engine === 'matlab') throw new ApiError(400, ERR.INVALID_ENGINE, '网页端不支持 MATLAB，请改用 Python / R')
          const result = await bundleStore.decide(bundle, data.decisions, async ({ recommendation, decision, csvBuffer }) => {
            const fileName = safeCsvName(`${bundle.bundleId}_${recommendation.recommendationId}.csv`)
            const ingest = ingestFile(fileName, csvBuffer)
            const task = store.create({ title: recommendation.objective, engine, prompt: bundle.prompt || recommendation.objective, fileName, bytes: csvBuffer, tenantId: principal.tenantId })
            task.dataset = ingest.profile
            task.bundleId = bundle.bundleId
            task.recommendationId = recommendation.recommendationId
            task.recommendationDecisionId = decision.decisionId
            preferenceStore.append({
              event_id: `pref_${Date.now().toString(36)}_${randomUUID().replace(/-/g, '').slice(0, 6)}`,
              kind: 'recommendation_accept', weight: 1, scope: 'project', confidence: 0.8,
              summary: `接受联合绘图推荐 ${recommendation.recommendationId}`,
              features: { chartType: recommendation.chartType, alignment: recommendation.alignment?.kind, datasets: recommendation.sources.map((item) => item.sheetName || item.fileName) },
              t: Date.now()
            })
            void orchestrator.run(task, ingest, modelConfigForIdentity(identity))
            return { branchId: `branch_${decision.decisionId}`, taskId: task.taskId, recommendationId: recommendation.recommendationId, state: task.state }
          })
          return sendJson(res, 202, { ok: true, bundleId: bundle.bundleId, ...result })
        }
        throw new ApiError(405, ERR.METHOD_NOT_ALLOWED, `该资源不支持 ${method}`)
      }
      if (method === 'GET' && pathName === '/api/style-presets') {
        return sendJson(res, 200, { presets: STYLE_PRESETS })
      }

      // ---- Trace 列表 ----
      if (method === 'GET' && pathName === '/api/traces') {
        return sendJson(res, 200, { protocol: PROTOCOL_VERSION, traces: buildTraceList(store, (task) => principal.tenantId === 'local' || task.tenantId === principal.tenantId) })
      }

      const uploadTaskMatch = /^\/api\/uploads\/([A-Za-z0-9_-]+)\/tasks$/.exec(pathName)
      if (remoteEnabled && uploadTaskMatch && method === 'POST') {
        let quotaHeld = false
        try {
          const data = await readJson(req).catch(() => ({}))
          const engine = String(data.engine ?? 'python')
          if (!ENGINE_KINDS.has(engine)) throw new ApiError(400, ERR.INVALID_ENGINE, '上传任务的 engine 无效')
          if (webOnlyEngines && engine === 'matlab') throw new ApiError(400, ERR.INVALID_ENGINE, '网页端不支持 MATLAB，请改用 Python / R')
          const upload = uploadStore.status(principal.tenantId, uploadTaskMatch[1])
          const bytes = fs.readFileSync(uploadStore.consume(principal.tenantId, uploadTaskMatch[1]))
          uploadStore.remove(principal.tenantId, uploadTaskMatch[1])
          const ingest = ingestFile(upload.fileName, bytes)
          rateLimiter.beginTask(principal.tenantId)
          quotaHeld = true
          const task = store.create({ title: upload.fileName, engine, prompt: String(data.prompt ?? ''), fileName: upload.fileName, bytes, tenantId: principal.tenantId })
          task.dataset = ingest.profile
          void runBackground(async () => {
            try { await orchestrator.run(task, ingest, modelConfigForIdentity(identity)) } finally { rateLimiter.endTask(principal.tenantId) }
          })
          return sendJson(res, 201, { taskId: task.taskId, state: task.state, protocol: PROTOCOL_VERSION, uploadId: upload.uploadId })
        } catch (error) {
          if (quotaHeld) rateLimiter.endTask(principal.tenantId)
          if (error instanceof ApiError) throw error
          const status = error?.code === 'UPLOAD_NOT_FOUND' ? 404 : error?.code === 'UPLOAD_INCOMPLETE' ? 409 : error?.code === 'QUOTA_EXCEEDED' ? 429 : 400
          throw new ApiError(status, error?.code ?? ERR.BAD_REQUEST, error?.message ?? '无法从断点上传创建任务')
        }
      }

      const uploadMatch = /^\/api\/uploads(?:\/([A-Za-z0-9_-]+))?$/.exec(pathName)
      if (remoteEnabled && uploadMatch) {
        try {
          if (!uploadMatch[1] && method === 'POST') return sendJson(res, 201, uploadStore.create(principal.tenantId, await readJson(req)))
          if (uploadMatch[1] && method === 'GET') return sendJson(res, 200, uploadStore.status(principal.tenantId, uploadMatch[1]))
          if (uploadMatch[1] && method === 'DELETE') return sendJson(res, 200, uploadStore.remove(principal.tenantId, uploadMatch[1]))
          if (uploadMatch[1] && method === 'PUT') {
            const chunk = await readBody(req, maxBytes, res)
            return sendJson(res, 200, uploadStore.append(principal.tenantId, uploadMatch[1], { offset: Number(req.headers['x-upload-offset']), chunk }))
          }
          throw new ApiError(405, ERR.METHOD_NOT_ALLOWED, '上传资源不支持该方法')
        } catch (error) {
          if (error instanceof ApiError) throw error
          const status = error?.code === 'UPLOAD_NOT_FOUND' ? 404 : error?.code === 'UPLOAD_OFFSET_MISMATCH' ? 409 : error?.code === 'UPLOAD_TOO_LARGE' ? 413 : 400
          throw new ApiError(status, error?.code ?? ERR.BAD_REQUEST, error?.message ?? '上传失败')
        }
      }

      // ---- 全局偏好学习控制（独立于任务生命周期持久化） ----
      // Preference history is scoped to the authenticated tenant.
      if (pathName === '/api/preferences' && method === 'GET') {
        return sendJson(res, 200, preferenceStore.snapshot())
      }

      // ---- 代码与界面三方合并：冲突逐项返回，不自动覆盖 ----
      if (pathName === '/api/merge' && method === 'POST') {
        const data = await readJson(req)
        if (![data.base, data.current, data.incoming].every((item) => typeof item === 'string')) throw new ApiError(400, ERR.MERGE_INVALID, 'base/current/incoming 必须是字符串')
        return sendJson(res, 200, mergeText3(data.base, data.current, data.incoming))
      }

      // ---- 基于已验证方案生成两个可审阅变体（不覆盖原方案、不自动执行） ----
      const variantMatch = /^\/api\/tasks\/([A-Za-z0-9_-]+)\/plans\/([A-Za-z0-9_-]+)\/variants$/.exec(pathName)
      if (variantMatch && method === 'POST') {
        const task = store.get(variantMatch[1])
        if (!task) throw new ApiError(404, ERR.TASK_NOT_FOUND, `任务不存在或已清理：${variantMatch[1]}`)
        return sendJson(res, 201, { parentPlanId: variantMatch[2], variants: generateTwoVariants(task, variantMatch[2], await readJson(req)) })
      }
      if (pathName === '/api/preferences/pause' && method === 'POST') {
        const data = await readJson(req).catch(() => ({}))
        if (typeof data.paused !== 'boolean') throw new ApiError(400, ERR.BAD_REQUEST, 'paused 必须为布尔值')
        return sendJson(res, 200, { ok: true, ...preferenceStore.setPaused(data.paused) })
      }
      if ((pathName === '/api/preferences' || pathName === '/api/preferences/clear') && method === 'DELETE') {
        return sendJson(res, 200, { ok: true, ...preferenceStore.clear() })
      }

      // ---- 配色学习画像查询与重置（仅配色事件；顺序必须在 /api/preferences/:id 撤销路由之前） ----
      if (pathName === '/api/preferences/colors' && method === 'GET') {
        return sendJson(res, 200, { ok: true, ...preferenceStore.colorProfile() })
      }
      if (pathName === '/api/preferences/colors' && method === 'DELETE') {
        return sendJson(res, 200, { ok: true, ...preferenceStore.clearColors() })
      }

      // ---- 本地项目：版本化清单 + 独占写锁（密钥不入项目文件） ----
      const localProjectActionMatch = /^\/api\/projects\/(create|open|settings|close)$/.exec(pathName)
      if (localProjectActionMatch) {
        if (identity.kind !== 'local') throw new ApiError(403, ERR.UNAUTHORIZED, '本地项目文件系统仅对 Desktop/VS Code 本机宿主开放')
        if (method !== 'POST') throw new ApiError(405, ERR.METHOD_NOT_ALLOWED, `该资源不支持 ${method}`)
        const data = await readJson(req).catch(() => ({}))
        if (!data.root || typeof data.root !== 'string') throw new ApiError(400, ERR.BAD_REQUEST, '缺少本地项目 root 路径')
        try {
          if (localProjectActionMatch[1] === 'create') return sendJson(res, 201, { ok: true, project: localProjectStore.create(data.root, data) })
          if (localProjectActionMatch[1] === 'open') return sendJson(res, 200, { ok: true, project: localProjectStore.open(data.root) })
          if (localProjectActionMatch[1] === 'settings') return sendJson(res, 200, { ok: true, project: localProjectStore.updateSettings(data.root, data.settings) })
          return sendJson(res, 200, { ok: true, closed: localProjectStore.close(data.root) })
        } catch (error) {
          const status = error?.code === 'PROJECT_LOCKED' || error?.code === 'PROJECT_EXISTS' ? 409 : error?.code === 'PROJECT_NOT_FOUND' ? 404 : 400
          throw new ApiError(status, error?.code ?? ERR.BAD_REQUEST, error?.message ?? '项目操作失败')
        }
      }
      const preferenceMatch = /^\/api\/preferences\/([A-Za-z0-9_-]+)$/.exec(pathName)
      if (preferenceMatch && method === 'DELETE') {
        return sendJson(res, 200, { ok: true, event: preferenceStore.revert(preferenceMatch[1]) })
      }

      // ---- 创建任务 ----
      if (method === 'POST' && pathName === '/api/tasks') {
        const ct = req.headers['content-type'] ?? ''
        if (!ct.includes('multipart/form-data')) {
          throw new ApiError(415, ERR.UNSUPPORTED_MEDIA_TYPE, 'Content-Type 必须为 multipart/form-data（CSV 文件 + prompt + engine）')
        }
        const boundary = /boundary=(?:"([^"]+)"|([^;]+))/i.exec(ct)
        const body = await readBody(req, maxBytes, res)
        let parsed
        try {
          parsed = parseMultipart(body, (boundary?.[1] ?? boundary?.[2] ?? '').trim())
        } catch (e) {
          if (e instanceof MultipartError) throw new ApiError(400, ERR.BAD_REQUEST, `multipart 解析失败：${e.message}`)
          throw e
        }
        const prompt = (parsed.fields.prompt ?? '').toString()
        let modelConfig
        if (remoteEnabled || testWeb || publicWeb) {
          if (parsed.fields.modelConfig) throw new ApiError(403, ERR.FORBIDDEN, '网页端模型配置必须由账号授权设置，不能随任务上传')
          modelConfig = modelConfigForIdentity(identity)
        } else if (parsed.fields.modelConfig) {
          if (identity.kind !== 'local' && !modelPermissions(identity).allowOwn) throw new ApiError(403, ERR.FORBIDDEN, '未获自填 API 授权')
          try { modelConfig = await validateModelSettings(JSON.parse(parsed.fields.modelConfig)) }
          catch { throw new ApiError(400, ERR.BAD_REQUEST, '模型配置无效，需 HTTPS 公网 API 地址、模型和接口类型') }
        } else {
          modelConfig = modelConfigForIdentity(identity)
        }
        const engine = (parsed.fields.engine ?? 'python').toString().trim()
        if (!ENGINE_KINDS.has(engine)) {
          throw new ApiError(400, ERR.INVALID_ENGINE, `未知引擎「${engine}」，可选：${webOnlyEngines ? 'python / r' : 'python / r / matlab'}`, {
            allowedEngines: webOnlyEngines ? ['python', 'r'] : [...ENGINE_KINDS]
          })
        }
        if (webOnlyEngines && engine === 'matlab') {
          throw new ApiError(400, ERR.INVALID_ENGINE, '网页端不支持 MATLAB，请改用 Python / R，或在桌面客户端使用本机授权 MATLAB', {
            allowedEngines: ['python', 'r']
          })
        }
        const file = parsed.files.find((f) => f.field === 'file') ?? parsed.files[0]
        if (!file) throw new ApiError(400, ERR.MISSING_FILE, '缺少 CSV 文件字段（multipart 字段名应为 file）')
        // 文件名是不可信输入：剥离路径/盘符/特殊字符后再用于落盘、沙箱执行与代码生成
        const fileName = safeCsvName(file.fileName || 'upload.csv')

        // 同步完成真实解析与体检：非法输入在创建时即得到稳定错误响应
        const ingest = ingestFile(fileName, file.buffer)

        if (remoteEnabled && principal.tenantId !== 'local') {
          try { rateLimiter.beginTask(principal.tenantId) } catch (error) { throw new ApiError(429, error?.code ?? 'QUOTA_EXCEEDED', error?.message ?? '任务配额超限') }
        }
        const task = store.create({ title: fileName, engine, prompt, fileName, bytes: file.buffer, tenantId: principal.tenantId })
        task.dataset = ingest.profile
        // 多轮需求澄清（绘图前 ≥3 轮轮询）：前端随建任务提交 clarify=true 启用交互轮询；
        // clarifyAnswers（JSON）预填已确认的轮次，剩余轮次继续询问。
        const clarifyFlag = String(parsed.fields.clarify ?? '').trim()
        if (clarifyFlag === 'true' || clarifyFlag === '1') task.clarify = true
        const clarifyRaw = parsed.fields.clarifyAnswers
        if (clarifyRaw && typeof clarifyRaw === 'string' && clarifyRaw.trim()) {
          try {
            const parsedAnswers = JSON.parse(clarifyRaw)
            if (parsedAnswers && typeof parsedAnswers === 'object') task.clarifyAnswers = parsedAnswers
          } catch {
            /* 预填 JSON 非法时忽略，走完整交互轮询 */
          }
        }

        void runBackground(async () => {
          try { await orchestrator.run(task, ingest, modelConfig) } finally {
            if (remoteEnabled && principal.tenantId !== 'local') rateLimiter.endTask(principal.tenantId)
          }
        })

        // 兼容层：无 projectId 的旧任务自动归入 proj_default（TaskStore.create 默认 projectId），
        // 响应头提示迁移到项目内任务端点。
        return sendJson(res, 201, { taskId: task.taskId, state: task.state, protocol: PROTOCOL_VERSION, projectId: task.projectId }, DEPRECATED_TASK_API)
      }

      const signExportMatch = /^\/api\/tasks\/([A-Za-z0-9_-]+)\/export\/sign$/.exec(pathName)
      if (remoteEnabled && signExportMatch && method === 'POST') {
        const task = store.get(signExportMatch[1])
        if (!task || (principal.tenantId !== 'local' && task.tenantId !== principal.tenantId)) throw new ApiError(404, ERR.TASK_NOT_FOUND, '任务不存在')
        const data = await readJson(req).catch(() => ({}))
        const plan = resolvePlan(task, data.planId)
        const signed = authManager.signDownload({ tenantId: task.tenantId, taskId: task.taskId, planId: plan.plan_id, ttlMs: data.ttlMs })
        const query = new URLSearchParams(Object.fromEntries(Object.entries(signed).map(([key, value]) => [key, String(value)])))
        return sendJson(res, 200, { expiresAt: signed.expiresAt, url: `/api/downloads/export?${query}` })
      }

      // ---- 可编辑源码：保存为新修订，旧产物立即失效；重新运行前明确标记为未验证 ----
      const codeEditMatch = /^\/api\/tasks\/([A-Za-z0-9_-]+)\/code$/.exec(pathName)
      if (codeEditMatch && method === 'POST') {
        const task = store.get(codeEditMatch[1])
        if (!task) throw new ApiError(404, ERR.TASK_NOT_FOUND, `任务不存在或已清理：${codeEditMatch[1]}`)
        const data = await readJson(req)
        const revision = orchestrator.saveCode(task, {
          planId: String(data.planId ?? ''),
          engine: String(data.engine ?? ''),
          code: typeof data.code === 'string' ? data.code : ''
        })
        return sendJson(res, 200, { ok: true, revision })
      }

      // ---- 任务级路由 ----
      const taskMatch =
        /^\/api\/tasks\/([A-Za-z0-9_-]+)(\/(answer|events|preferences|replan|select|feedback|complete|preview|export|trace|cancel|retry))?$/.exec(pathName)
      if (taskMatch) {
        const [, id, , sub] = taskMatch
        const task = store.get(id)
        // DELETE 幂等：任务不存在时返回稳定、可解释的 200（RFC 9110 幂等语义），
        // 其他端点对未知 id 仍返回 404 TASK_NOT_FOUND。
        if (!task) {
          if (!sub && method === 'DELETE') {
            return sendJson(res, 200, {
              ok: true,
              taskId: id,
              existed: false,
              deleted: false,
              code: ERR.TASK_NOT_FOUND,
              message: '任务不存在或已被删除（DELETE 幂等，重复删除不报错）'
            })
          }
          throw new ApiError(404, ERR.TASK_NOT_FOUND, `任务不存在或已清理：${id}`)
        }
        if (principal.tenantId !== 'local' && task.tenantId !== principal.tenantId) throw new ApiError(404, ERR.TASK_NOT_FOUND, `任务不存在或已清理：${id}`)

        if (!sub && method === 'GET') return sendJson(res, 200, store.snapshot(task), DEPRECATED_TASK_API)

        if (sub === 'retry' && method === 'POST') {
          if (task.state !== 'FAILED' && task.state !== 'CANCELLED') throw new ApiError(409, ERR.TASK_BUSY, '仅失败或已取消的任务可以重试')
          const previousRetry = task.retryTaskId && store.get(task.retryTaskId)
          if (previousRetry && !['FAILED', 'CANCELLED', 'COMPLETE'].includes(previousRetry.state)) throw new ApiError(409, ERR.TASK_BUSY, '重试任务仍在运行，请等待其完成')
          if (!task.bytes?.length) throw new ApiError(409, ERR.BAD_REQUEST, '原始数据已清理，请重新上传数据')
          const data = await readJson(req)
          const ingest = ingestFile(task.fileName, task.bytes)
          if (remoteEnabled && principal.tenantId !== 'local') rateLimiter.beginTask(principal.tenantId)
          const retry = store.create({ title: task.title, engine: task.execution.engine, prompt: typeof data.prompt === 'string' && data.prompt.trim() ? data.prompt.trim() : task.prompt, fileName: task.fileName, bytes: task.bytes, tenantId: task.tenantId, projectId: task.projectId })
          retry.dataset = ingest.profile
          retry.clarify = task.clarify
          retry.clarifyAnswers = task.clarification ? { ...task.clarification, answeredRounds: [1, 2, 3] } : task.clarifyAnswers
          task.retryTaskId = retry.taskId
          store.emit(retry, { type: 'log', log: { level: 'info', text: `重新执行失败任务 ${task.taskId}，原任务记录已保留`, t: Date.now() } })
          void runBackground(async () => {
            try { await orchestrator.run(retry, ingest, modelConfigForIdentity(identity)) }
            finally { if (remoteEnabled && principal.tenantId !== 'local') rateLimiter.endTask(principal.tenantId) }
          })
          return sendJson(res, 201, { taskId: retry.taskId, projectId: retry.projectId, retryOf: task.taskId })
        }

        if (sub === 'cancel' && method === 'POST') {
          return sendJson(res, 200, { ok: true, taskId: task.taskId, ...orchestrator.cancel(task) })
        }

        if (sub === 'answer' && method === 'POST') {
          const data = await readJson(req).catch(() => ({}))
          const answer = (data.answer ?? data.text ?? '').toString()
          if (!answer.trim()) throw new ApiError(400, ERR.BAD_REQUEST, 'answer 字段不能为空')
          if (task.state === 'FAILED' || task.state === 'COMPLETE') {
            throw new ApiError(409, ERR.TASK_TERMINAL, `任务已处于终态 ${task.state}，不再接受澄清回答`)
          }
          if (task.state !== 'NEED_INPUT' || !task.answerResolver) {
            throw new ApiError(409, ERR.TASK_NOT_WAITING, `任务当前状态为 ${task.state}，不处于等待澄清状态`)
          }
          task.answerResolver(answer)
          return sendJson(res, 200, { ok: true, taskId: task.taskId, state: 'UNDERSTAND' })
        }

        // ---- SELECT（协议规范端点）：选择方案 → ITERATE，其他方案保留为可恢复分支 ----
        if (sub === 'select' && method === 'POST') {
          const data = await readJson(req).catch(() => ({}))
          const planId = (data.planId ?? data.plan_id ?? '').toString()
          if (!planId) throw new ApiError(400, ERR.BAD_REQUEST, '缺少 planId')
          const out = orchestrator.selectPlan(task, planId, { weight: data.weight, scope: data.scope })
          return sendJson(res, 200, { ok: true, taskId: task.taskId, ...out })
        }

        // ---- FEEDBACK（协议规范端点）：多轮反馈 → 新 PlotRevision，旧版本不覆盖 ----
        if ((sub === 'feedback' || sub === 'replan') && method === 'POST') {
          const data = await readJson(req).catch(() => ({}))
          const feedback = (data.feedback ?? data.summary ?? '').toString()
          const kind = ['manual_edit', 'set_default', 'browse'].includes(data.kind) ? data.kind : 'manual_edit'
          const planId = data.planId ? String(data.planId) : undefined
          orchestrator.prepareFeedback(task, { feedback, kind, planId })
          void runBackground(() => orchestrator.replan(task, { feedback, kind, planId }))
          return sendJson(res, 202, { ok: true, taskId: task.taskId, state: task.state, revision: 'new' })
        }

        // ---- COMPLETE：用户确认，冻结版本（导出 GET /export 也会自动冻结） ----
        if (sub === 'complete' && method === 'POST') {
          const out = orchestrator.complete(task, { trigger: 'confirm' })
          return sendJson(res, 200, { ok: true, taskId: task.taskId, ...out })
        }

        // ---- 通用偏好（reject/set_default/browse；select_plan 作为 /select 的别名保留） ----
        if (sub === 'preferences' && method === 'POST') {
          const data = await readJson(req).catch(() => ({}))
          const kind = ['select_plan', 'set_default', 'manual_edit', 'browse', 'reject'].includes(data.kind) ? data.kind : 'manual_edit'
          if (kind === 'select_plan') {
            const planId = (data.planId ?? '').toString()
            if (!planId) throw new ApiError(400, ERR.BAD_REQUEST, 'select_plan 缺少 planId')
            const out = orchestrator.selectPlan(task, planId, { weight: data.weight, scope: data.scope })
            return sendJson(res, 200, { ok: true, preference: out.preference, selectedPlanId: task.selectedPlanId, ranking: out.ranking })
          }
          if (task.state === 'FAILED' || task.state === 'COMPLETE') {
            throw new ApiError(409, ERR.TASK_TERMINAL, `任务已处于终态 ${task.state}，不能再提交偏好`)
          }
          if (!task.plans.length) throw new ApiError(409, ERR.TASK_NOT_WAITING, '方案尚未生成，无法提交偏好')
          const plan = data.planId ? task.plans.find((p) => p.plan_id === data.planId) : undefined
          if (data.planId && !plan) throw new ApiError(404, ERR.PLAN_NOT_FOUND, `方案不存在：${data.planId}`)
          const pref = {
            event_id: `pref_${Date.now().toString(36)}_${randomUUID().replace(/-/g, '').slice(0, 6)}`,
            kind,
            weight: typeof data.weight === 'number' ? data.weight : kind === 'reject' ? 0.8 : 0.7,
            scope: data.scope ?? (kind === 'set_default' ? 'global' : 'task'),
            summary: data.summary ?? preferenceSummary(kind, plan),
            confidence: 0.6,
            planId: plan?.plan_id,
            paletteId: plan?.palette?.id,
            t: Date.now()
          }
          // 排序变化只下发 preference 原因的 plans_ready，不产生新 PlotRevision 版本
          const reranked = applyPreference(task.plans, pref)
          const preferenceResult = orchestrator.recordPreference(task, pref)
          store.emit(task, { type: 'plans_ready', plans: reranked, reason: 'preference' })
          return sendJson(res, 200, { ok: true, preference: preferenceResult.event, preferenceWritten: preferenceResult.written, selectedPlanId: task.selectedPlanId, ranking: reranked.map((p) => p.plan_id) })
        }

        // ---- 预览：真实渲染产物（SVG 内联 + PNG 元数据） ----
        if (sub === 'preview' && method === 'GET') {
          const plan = resolvePlan(task, url.searchParams.get('planId'))
          const requestedEngine = url.searchParams.get('engine')
          const art = task.artifacts?.[plan.plan_id]
          if (!art || plan.executionStatus === 'failed_execution') {
            throw new ApiError(404, ERR.ARTIFACT_NOT_FOUND, `方案 ${plan.plan_id} 尚无成功渲染产物（执行状态：${plan.executionStatus ?? '未执行'}）`)
          }
          let svg = art.inline?.svg
          let pngMeta = art.png
          if (!svg && storage) {
            const fp = storage.readArtifact(task.taskId, plan.plan_id, art.svgFile ?? `plan_${plan.strategy}.svg`)
            if (fp) svg = fs.readFileSync(fp, 'utf-8')
          }
          if (!svg) throw new ApiError(404, ERR.ARTIFACT_NOT_FOUND, `方案 ${plan.plan_id} 的 SVG 产物缺失`)
          const artifactEngine = plan.verification?.engine ?? art.engine
          if (requestedEngine && requestedEngine !== artifactEngine) {
            throw new ApiError(409, ERR.ARTIFACT_NOT_FOUND, `方案 ${plan.plan_id} 尚无 ${requestedEngine} 引擎的已验证产物；当前产物为 ${artifactEngine}`)
          }
          return sendJson(res, 200, {
            planId: plan.plan_id,
            engine: artifactEngine,
            svg,
            png: pngMeta ? { ...pngMeta, dataBase64: art.inline?.pngBase64 } : undefined,
            width: pngMeta?.width,
            height: pngMeta?.height,
            verification: plan.verification
          })
        }

        // ---- 导出 ZIP（三引擎代码 + 数据 + 规格 + 证据 + 产物）；导出即 COMPLETE 冻结 ----
        if (sub === 'export' && method === 'GET') {
          const plan = resolvePlan(task, url.searchParams.get('planId'))
          // 架构 6-1：用户导出 → COMPLETE（已冻结则幂等跳过；FAILED 不允许导出终态）
          orchestrator.complete(task, { trigger: 'export' })
          const parseBool = (name, fallback = true) => url.searchParams.has(name) ? url.searchParams.get(name) !== 'false' : fallback
          const zip = buildExport(task, plan.plan_id, storage, {
            includeCode: parseBool('includeCode'), includeData: parseBool('includeData'), includeEvidence: parseBool('includeEvidence'),
            includeArtifacts: parseBool('includeArtifacts'), transparent: parseBool('transparent', false),
            dpi: Number(url.searchParams.get('dpi') ?? 300), colorMode: url.searchParams.get('colorMode') ?? 'color',
            requestedFormats: (url.searchParams.get('formats') ?? 'svg,png,pdf').split(',')
          })
          res.writeHead(200, {
            'content-type': 'application/zip',
            'content-disposition': `attachment; filename="${plan.plan_id}.zip"`,
            'x-agent-protocol': String(PROTOCOL_VERSION)
          })
          return res.end(zip)
        }

        // ---- 单任务 Trace ----
        if (sub === 'trace' && method === 'GET') {
          return sendJson(res, 200, { protocol: PROTOCOL_VERSION, trace: buildTrace(task) })
        }

        if (!sub && method === 'DELETE') {
          // 同步删除：任务记录、订阅连接、原始 data.csv、事件日志与 runs 产物立即不可访问
          const deletedAt = Date.now()
          store.delete(id)
          return sendJson(res, 200, { ok: true, taskId: id, existed: true, deleted: true, deletedAt }, DEPRECATED_TASK_API)
        }
        throw new ApiError(405, ERR.METHOD_NOT_ALLOWED, `该资源不支持 ${method}`)
      }

      const patchMatch = /^\/api\/tasks\/([A-Za-z0-9_-]+)\/patches\/(preview|apply|revert|restore)$/.exec(pathName)
      if (patchMatch) {
        const [, id, action] = patchMatch
        const task = store.get(id)
        if (!task) throw new ApiError(404, ERR.TASK_NOT_FOUND, `任务不存在或已清理：${id}`)
        if (method !== 'POST') throw new ApiError(405, ERR.METHOD_NOT_ALLOWED, `该资源不支持 ${method}`)
        const data = await readJson(req).catch(() => ({}))
        if (action === 'preview') return sendJson(res, 200, { ok: true, preview: orchestrator.previewPatch(task, data) })
        if (action === 'apply') {
          if (!data.token) throw new ApiError(400, ERR.BAD_REQUEST, '缺少补丁预览 token')
          const revision = await orchestrator.applyPatch(task, String(data.token))
          return sendJson(res, 200, { ok: true, revision })
        }
        if (action === 'revert') return sendJson(res, 200, { ok: true, revision: orchestrator.revertPatch(task) })
        if (action === 'restore') {
          if (!Number.isInteger(Number(data.version))) throw new ApiError(400, ERR.BAD_REQUEST, 'version 必须为整数')
          return sendJson(res, 200, { ok: true, revision: orchestrator.restoreVersion(task, Number(data.version)) })
        }
      }

      const sourceMatch = /^\/api\/tasks\/([A-Za-z0-9_-]+)\/source\/(preview|apply)$/.exec(pathName)
      if (sourceMatch) {
        const [, id, action] = sourceMatch
        const task = store.get(id)
        if (!task) throw new ApiError(404, ERR.TASK_NOT_FOUND, `任务不存在或已清理：${id}`)
        if (method !== 'POST') throw new ApiError(405, ERR.METHOD_NOT_ALLOWED, `该资源不支持 ${method}`)
        const data = await readJson(req).catch(() => ({}))
        if (action === 'preview') return sendJson(res, 200, { ok: true, preview: orchestrator.previewSource(task, data) })
        if (!data.token) throw new ApiError(400, ERR.BAD_REQUEST, '缺少源码预览 token')
        return sendJson(res, 200, { ok: true, revision: await orchestrator.applySource(task, String(data.token)) })
      }

      const dataMatch = /^\/api\/tasks\/([A-Za-z0-9_-]+)\/data\/(preview|apply)$/.exec(pathName)
      if (dataMatch) {
        const [, id, action] = dataMatch
        const task = store.get(id)
        if (!task) throw new ApiError(404, ERR.TASK_NOT_FOUND, `任务不存在或已清理：${id}`)
        if (method !== 'POST') throw new ApiError(405, ERR.METHOD_NOT_ALLOWED, `该资源不支持 ${method}`)
        const data = await readJson(req).catch(() => ({}))
        if (action === 'preview') return sendJson(res, 200, { ok: true, preview: orchestrator.previewData(task, data) })
        if (!data.token) throw new ApiError(400, ERR.BAD_REQUEST, '缺少数据修订预览 token')
        return sendJson(res, 200, { ok: true, ...(await orchestrator.applyData(task, String(data.token), data.confirmed)) })
      }

      const styleMatch = /^\/api\/tasks\/([A-Za-z0-9_-]+)\/styles\/apply$/.exec(pathName)
      if (styleMatch) {
        const task = store.get(styleMatch[1])
        if (!task) throw new ApiError(404, ERR.TASK_NOT_FOUND, `任务不存在或已清理：${styleMatch[1]}`)
        if (method !== 'POST') throw new ApiError(405, ERR.METHOD_NOT_ALLOWED, `该资源不支持 ${method}`)
        const data = await readJson(req).catch(() => ({}))
        return sendJson(res, 200, { ok: true, revision: await orchestrator.applyStylePreset(task, data) })
      }

      // ---- 阶段 5：跨任务取数（带 grant 令牌，仅返回列名 + 采样行）----
      const crossReadMatch = /^\/api\/tasks\/([A-Za-z0-9_-]+)\/cross-task-read$/.exec(pathName)
      if (crossReadMatch && method === 'POST') {
        if (!projectStore) throw new ApiError(503, ERR.BAD_REQUEST, '项目存储未启用（persist=0）')
        const fromTaskId = crossReadMatch[1]
        const fromTask = store.get(fromTaskId)
        if (!fromTask) throw new ApiError(404, ERR.TASK_NOT_FOUND, `任务不存在：${fromTaskId}`)
        const body = await readJson(req)
        const grantId = String(body.grantId ?? '')
        const targetTaskId = String(body.targetTaskId ?? '')
        const fields = Array.isArray(body.fields) ? body.fields.map(String) : []
        if (!grantId) throw new ApiError(403, ERR.FORBIDDEN, '缺少授权令牌 grantId', { code: 'cross-task-access-denied' })
        if (!fields.length) throw new ApiError(400, ERR.BAD_REQUEST, 'fields 不能为空')

        const pid = fromTask.projectId
        const target = store.get(targetTaskId)
        // 跨项目隔离：目标任务不属于同一项目 → 即使有 grant 也拒绝
        if (!target) throw new ApiError(404, ERR.TASK_NOT_FOUND, `目标任务不存在：${targetTaskId}`)
        if (target.projectId !== pid) {
          throw new ApiError(403, ERR.FORBIDDEN, '跨项目取数被拒绝', { code: 'cross-project-access-denied' })
        }
        // 逐字段校验 grant（字段白名单）；任一字段未授权即整体拒绝
        const grants = []
        for (const field of fields) {
          grants.push(projectStore.validateGrant(pid, grantId, fromTaskId, targetTaskId, field))
        }
        // 仅返回授权字段的列名 + 采样行（不全量）
        const targetCols = (target.dataset?.columns ?? []).map((c) => c.name)
        const allowedCols = fields.filter((f) => targetCols.includes(f))
        const sampleRows = (target.dataset?.headRows ?? []).map((row) => {
          const out = {}
          for (const f of allowedCols) out[f] = row[f] ?? ''
          return out
        })
        // once 令牌用完即焚（project 令牌不消费）
        const once = grants[0]?.scope === 'once'
        if (once) projectStore.consumeGrant(pid, grantId)
        projectStore.appendAudit(pid, { action: 'grant_used', grantId, fromTaskId, toTaskId: targetTaskId, fields, once, by: identity.userId })
        broadcastProjectEvent({ type: 'grant_resolved', projectId: pid, grantId, approved: true, fields })
        return sendJson(res, 200, { projectId: pid, fromTaskId, targetTaskId, columns: allowedCols, rows: sampleRows, consumed: once })
      }

      // ---- 阶段 6：审批模式读写 ----
      if (pathName === '/api/approval/mode') {
        if (method === 'GET') return sendJson(res, 200, { mode: approvalMode })
        if (method === 'PUT') {
          const body = await readJson(req)
          const next = String(body.mode ?? '')
          if (![MODES.USER, MODES.AUTO, MODES.YOLO].includes(next)) {
            throw new ApiError(400, ERR.BAD_REQUEST, 'mode 必须为 user/auto/yolo 之一')
          }
          approvalMode = next
          return sendJson(res, 200, { ok: true, mode: approvalMode })
        }
        throw new ApiError(405, ERR.METHOD_NOT_ALLOWED, `该资源不支持 ${method}`)
      }

      // ---- 阶段 6：用户响应审批请求 ----
      const approvalRespMatch = /^\/api\/tasks\/([A-Za-z0-9_-]+)\/approval\/([A-Za-z0-9_-]+)$/.exec(pathName)
      if (approvalRespMatch && method === 'POST') {
        const [, taskId, requestId] = approvalRespMatch
        const body = await readJson(req).catch(() => ({}))
        const approved = body.approved === true
        const pending = pendingApprovals.get(requestId)
        if (pending) {
          pendingApprovals.delete(requestId)
          pending.resolve({ approved, taskId, requestId })
        }
        const task = store.get(taskId)
        if (task && projectStore) {
          try { projectStore.appendAudit(task.projectId, { action: 'approval_resolved', requestId, approved, by: identity.userId }) } catch { /* 项目缺失则跳过 */ }
        }
        return sendJson(res, 200, { ok: true, taskId, requestId, approved })
      }

      throw new ApiError(404, ERR.NOT_FOUND, `未找到路径：${pathName}`)
    } catch (err) {
      // 超限等场景已在 readBody 中直接回写响应并销毁连接，避免重复 writeHead
      if (res.headersSent || res.writableEnded) {
        try {
          res.destroy()
        } catch {
          /* ignore */
        }
        return
      }
      if (err instanceof SyntaxError) {
        return jsonError(res, new ApiError(400, ERR.BAD_REQUEST, '请求体不是合法 JSON'), { protocolVersion: PROTOCOL_VERSION })
      }
      jsonError(res, err, { protocolVersion: PROTOCOL_VERSION })
    }
  })

  // ---- WebSocket：/api/tasks/:id/events ----
  // P0-6: WebSocket 不支持自定义 header，改为握手后通过消息认证
  server.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, `http://${req.headers.host ?? '127.0.0.1'}`)
    const fail = (status, code, message) => {
      socket.write(`HTTP/1.1 ${status} ${http.STATUS_CODES[status]}\r\nContent-Type: application/json; charset=utf-8\r\nConnection: close\r\n\r\n`)
      socket.end(JSON.stringify({ error: { code, message } }))
    }
    const m = /^\/api\/tasks\/([A-Za-z0-9_-]+)\/events$/.exec(url.pathname)
    const projectRoom = /^\/api\/projects\/([A-Za-z0-9_-]+)\/collaboration$/.exec(url.pathname)
    if (!m && !projectRoom) return fail(404, ERR.NOT_FOUND, '事件端点路径不受支持')

    const key = req.headers['sec-websocket-key']
    if (!key) return fail(400, ERR.BAD_REQUEST, '缺少 Sec-WebSocket-Key，不是合法 WebSocket 握手')
    socket.write(
      'HTTP/1.1 101 Switching Protocols\r\n' +
        'Upgrade: websocket\r\n' +
        'Connection: Upgrade\r\n' +
        `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n` +
        `X-Agent-Protocol: ${PROTOCOL_VERSION}\r\n\r\n`
    )
    if (head?.length) socket.unshift(head)
    const conn = attachWebSocket(socket)
    wsConns.add(conn)
    upgradedSockets.add(socket)
    const dropSocket = () => upgradedSockets.delete(socket)
    socket.on('close', dropSocket)
    socket.on('error', dropSocket)
    const prevOnClose = conn.onClose
    conn.onClose = (code) => {
      prevOnClose?.(code)
      wsConns.delete(conn)
    }

    // 握手后等待认证消息，5 秒内未认证则关闭
    let authenticated = false
    let wsIdentity = null
    let wsPrincipal = null
    const authTimeout = setTimeout(() => {
      if (!authenticated) {
        conn.send(JSON.stringify({ type: 'error', code: ERR.UNAUTHORIZED, message: '认证超时' }))
        conn.close(1008, '认证超时')
      }
    }, 5000)

    conn.onMessage = (raw) => {
      try {
        const message = JSON.parse(raw)
        if (!authenticated && message.type === 'auth') {
          clearTimeout(authTimeout)
          const clientToken = message.token
          wsIdentity = clientToken === token ? { userId: 'local-user', kind: 'local', displayName: '本机用户' } : identityStore.verify(clientToken) ?? cloudAccounts?.verify(clientToken)
          wsPrincipal = wsIdentity
            ? { tenantId: wsIdentity.kind === 'local' ? 'local' : wsIdentity.userId, subject: wsIdentity.userId }
            : null
          if (!wsIdentity && remoteEnabled) {
            try {
              wsPrincipal = authManager.authenticate(`Bearer ${clientToken ?? ''}`)
              wsIdentity = { userId: wsPrincipal.subject, kind: 'remote', displayName: wsPrincipal.subject }
            } catch {
              conn.send(JSON.stringify({ type: 'error', code: ERR.UNAUTHORIZED, message: 'WebSocket 会话无效或已过期' }))
              return conn.close(1008, '认证失败')
            }
          }
          if (!wsIdentity || !wsPrincipal) {
            conn.send(JSON.stringify({ type: 'error', code: ERR.UNAUTHORIZED, message: 'WebSocket 认证令牌无效' }))
            return conn.close(1008, '认证失败')
          }
          if (projectRoom) {
            try { platformProjectStore.get(projectRoom[1], wsIdentity.userId) } catch (error) {
              conn.send(JSON.stringify({ type: 'error', code: error.code ?? ERR.FORBIDDEN, message: error.message }))
              return conn.close(1008, '权限不足')
            }
          }
          const task = m ? store.get(m[1]) : null
          if (m && !task) {
            conn.send(JSON.stringify({ type: 'error', code: ERR.TASK_NOT_FOUND, message: `任务不存在或已清理：${m[1]}` }))
            return conn.close(1008, '任务不存在')
          }
          if (m && wsPrincipal.tenantId !== 'local' && task.tenantId !== wsPrincipal.tenantId) {
            conn.send(JSON.stringify({ type: 'error', code: ERR.TASK_NOT_FOUND, message: '任务不存在或已清理' }))
            return conn.close(1008, '任务不存在')
          }
          authenticated = true
          conn.send(JSON.stringify({ type: 'authenticated' }))
          if (m) store.subscribe(task, conn)
          else {
            const projectId = projectRoom[1]
            conn.send(JSON.stringify({ type: 'collaboration_snapshot', ...collaborationStore.snapshot(projectId) }))
            const unsubscribe = collaborationStore.subscribe(projectId, (event) => conn.send(JSON.stringify(event)))
            // 项目级事件（project_created/project_updated/task_created）广播到本项目房间
            const onProjectEvent = (event) => conn.send(JSON.stringify(event))
            projectBus.on('project', onProjectEvent)
            const previousClose = conn.onClose
            conn.onClose = (code) => { unsubscribe(); projectBus.off('project', onProjectEvent); previousClose?.(code) }
            conn.onMessage = (raw) => {
              try {
                const msg = JSON.parse(raw)
                if (msg.type === 'presence') collaborationStore.emit(projectId, { type: 'presence', user: { userId: wsIdentity.userId, displayName: wsIdentity.displayName }, status: msg.status ?? 'active' })
              } catch { conn.send(JSON.stringify({ type: 'error', code: ERR.BAD_REQUEST, message: '协作消息不是合法 JSON' })) }
            }
          }
        } else if (!authenticated) {
          conn.send(JSON.stringify({ type: 'error', code: ERR.UNAUTHORIZED, message: '需要先发送认证消息' }))
          conn.close(1008, '未认证')
        }
      } catch (err) {
        if (!authenticated) {
          conn.send(JSON.stringify({ type: 'error', code: ERR.BAD_REQUEST, message: '消息不是合法 JSON' }))
          conn.close(1008, '消息格式错误')
        }
      }
    }
  })

  return {
    server,
    store,
    orchestrator,
    storage,
    preferenceStore,
    formatRegistry,
    bundleStore,
    identityStore,
    inviteStore,
    cloudStore,
    retention,
    projectStore: platformProjectStore,
    fileProjectStore: projectStore,
    localProjectStore,
    pluginRegistry,
    collaborationStore,
    remoteNodes,
    authManager,
    rateLimiter,
    uploadStore,
    token,
    host,
    requestedPort,
    start() {
      return new Promise((resolve) => {
        server.listen(requestedPort, host, () => {
          const addr = server.address()
          resolve({ host, port: typeof addr === 'object' ? addr.port : requestedPort, token, restored })
        })
      })
    },
    async close() {
      // 停止监听前先取消并等待后台编排；否则已关闭测试/桌面服务的 Python
      // 渲染仍会与下一实例争用字体缓存和 CPU，形成偶发的 60 秒连接重置。
      retention.stop()
      clearInterval(uploadCleanupTimer)
      for (const task of store.tasks.values()) {
        clearTimeout(task.ttlTimer)
        if (!task.abortController.signal.aborted) task.abortController.abort(new Error('server shutting down'))
      }
      if (backgroundOperations.size) {
        await Promise.race([
          Promise.allSettled([...backgroundOperations]),
          new Promise((resolve) => setTimeout(resolve, 10_000))
        ])
      }
      return new Promise((resolve) => {
        localProjectStore.closeAll()
        // 先显式关闭升级后的 WebSocket（含服务端 socket 销毁），
        // 再关闭全部 HTTP 连接（undici keep-alive 会让 close 回调永不触发），最后关闭监听。
        for (const conn of wsConns) {
          try {
            conn.close(1001, 'server shutting down')
          } catch {
            /* ignore */
          }
        }
        wsConns.clear()
        // 兜底：销毁所有升级 socket（含已完成关闭帧交换但半关闭残留的连接）
        for (const s of upgradedSockets) {
          try {
            s.destroy()
          } catch {
            /* ignore */
          }
        }
        upgradedSockets.clear()
        server.closeAllConnections?.()
        server.close(() => resolve())
      })
    }
  }
}

// CLI 启动
const isMain = process.argv[1] && process.argv[1] === fileURLToPath(import.meta.url)
if (isMain) {
  const agent = createServer()
  agent.start().then(({ host, port, token: t, restored: n }) => {
    process.stdout.write('[local-agent] research-plotting local agent started (v0.4.0)\n')
    process.stdout.write(`[local-agent] HTTP  http://${host}:${port}/health\n`)
    process.stdout.write(`[local-agent] WS    ws://${host}:${port}/api/tasks/:id/events （连接后发送 {"type":"auth","token":"<TOKEN>"}）\n`)
    // Local hosts consume this boot handshake; production logs must never
    // contain the all-powerful host token.
    if (process.env.REMOTE_MODE !== '1' && process.env.LOCAL_AGENT_WEB_ONLY !== '1') process.stdout.write(`[local-agent] TOKEN ${t}\n`)
    if (n) process.stdout.write(`[local-agent] restored ${n} task(s) from .data\n`)
    process.stdout.write(`[local-agent] persist ${agent.storage ? agent.storage.root : 'off (LOCAL_AGENT_PERSIST=0)'}\n`)
    process.stdout.write(`[local-agent] PROTOCOL v${PROTOCOL_VERSION} (bind ${host}; auth: Authorization: Bearer <TOKEN>；WS 握手后消息认证，令牌不进 URL)\n`)
  })
  const shutdown = () => {
    agent.close().then(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
}
