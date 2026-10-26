/**
 * SPARK SIGHT for DeepSeek Harness — Client half.
 *
 * Native DSH integration:
 *   - a compact switch in `conversation.input.right`, immediately before the
 *     model selector; first activation asks for a local login;
 *   - a real Conversation View tab ("绘图") next to Trajectory, with live SVG
 *     preview, plan selection, clarification, feedback, export and settings;
 *   - the full same-origin workbench remains available as an optional overlay.
 *
 * The browser never receives the local-agent token or port: every call goes
 * through Host routes registered by index.js.
 */

window.__ModuleLoader__.load({
  id: 'sparksight-dsh',
  factory(require) {
    const React = require('react')
    let ReactDom = null
    try { ReactDom = require('react-dom') } catch { ReactDom = null }
    const { useCallback, useEffect, useMemo, useRef, useState } = React
    const h = React.createElement
    const portal = (node) => (ReactDom?.createPortal ? ReactDom.createPortal(node, document.body) : node)

    // ---------------------------------------------------------------------
    // locale
    // ---------------------------------------------------------------------

    const NS = 'sparksight'
    const ZH = {
      'view.label': '绘图',
      'view.subtitle': '科研绘图',
      'toggle.label': '绘图',
      'toggle.on': '绘图模式已开启',
      'toggle.off': '开启科研绘图',
      'toggle.login': '登录后开启绘图',
      'toggle.enable': '开启绘图模式',
      'toggle.enable.desc': '绘图模式会把 SPARK SIGHT 的科研绘图工具交给当前模型，并在对话顶部提供预览与设定。数据与账户都留在本机。',
      'toggle.switch': '切换 SPARK SIGHT 绘图模式',
      'login.title': '登录 SPARK SIGHT',
      'login.subtitle': '账户与本机数据只保存在这台电脑上',
      'login.tab.login': '登录',
      'login.tab.register': '注册',
      'login.username': '账户名',
      'login.username.hint': '至少 6 位，字母、数字、点、下划线或连字符',
      'login.password': '密码',
      'login.password.hint': '至少 10 位',
      'login.displayName': '显示名称（可选）',
      'login.agreement': '我同意本机数据仅用于绘图，并可随时删除',
      'login.submit': '登录',
      'login.register': '创建账户',
      'login.busy': '正在登录…',
      'login.or': '或',
      'login.localAdmin': '使用本机管理员账户进入',
      'login.guest': '以本地访客身份进入',
      'login.guest.hint': '访客数据同样只保存在本机',
      'login.close': '关闭',
      'login.error.username': '账户名至少 6 位，仅支持字母、数字、点、下划线或连字符',
      'login.error.password': '密码至少 10 位',
      'login.error.agreement': '请先同意数据使用说明',
      'auth.loginRequired': '首次使用请先登录',
      'auth.expired': '登录已过期，请重新登录',
      'auth.logout': '退出登录',
      'auth.account': '账户',
      'auth.role.admin': '管理员',
      'auth.role.user': '用户',
      'common.close': '关闭',
      'common.cancel': '取消',
      'common.refresh': '刷新',
      'common.retry': '重试',
      'common.loading': '加载中…',
      'common.none': '暂无',
      'common.copy': '复制',
      'common.open': '打开',
      'common.more': '更多',
      'stage.title': 'SPARK SIGHT 工作台',
      'stage.open': '打开工作台',
      'stage.close': '关闭工作台',
      'stage.loading': '正在启动本机绘图服务…',
      'stage.failed': '工作台暂时不可用',
      'task.new': '新建绘图',
      'task.empty.title': '从一份 CSV 开始',
      'task.empty.desc': '上传数据并描述你的研究问题。DSH 的模型会通过 sparksight_* 工具调用本机绘图管线；你也可以在这里直接建立任务。',
      'task.drop': '把 CSV 拖到这里，或点击选择文件',
      'task.file': '数据文件',
      'task.prompt': '绘图需求',
      'task.prompt.placeholder': '例如：比较各处理组的均值并加误差棒，标题“各处理组产量”，中文标注，适合论文黑白打印。',
      'task.engine': '渲染引擎',
      'task.clarify': '启用三轮需求澄清',
      'task.submit': '开始生成方案',
      'task.submitting': '正在上传并分析数据…',
      'task.history': '最近任务',
      'task.none': '还没有任务',
      'task.id': '任务',
      'task.state': '状态',
      'task.title': '标题',
      'task.dataset': '数据',
      'task.selected': '已选方案',
      'task.plans': '候选方案',
      'task.plan.select': '选择此方案',
      'task.plan.selected': '已选择',
      'task.plan.rendered': '已有预览',
      'task.plan.verified': '已验证',
      'task.plan.unverified': '未验证',
      'task.plan.failed': '渲染失败',
      'task.preview': '预览',
      'task.preview.empty': '方案生成后，这里会显示真实渲染的 SVG 预览。',
      'task.preview.pending': '正在渲染预览…',
      'task.preview.failed': '预览暂不可用',
      'task.preview.meta': '画布',
      'task.preview.engine': '引擎',
      'task.question': '需要你的确认',
      'task.question.placeholder': '输入你的回答，也可以直接点选下面的选项',
      'task.question.submit': '提交回答',
      'task.feedback': '修改意见',
      'task.feedback.placeholder': '例如：把图例移到右侧，标题改为“各处理组日均产量”，配色改为灰度。',
      'task.feedback.submit': '提交修改',
      'task.export': '导出复现包',
      'task.export.wait': '方案完成后可导出',
      'task.export.busy': '正在导出…',
      'task.complete': '确认完成',
      'task.refresh': '刷新任务',
      'task.polling': '正在轮询任务状态',
      'task.error': '任务出错',
      'task.login': '登录后查看绘图任务',
      'task.login.desc': 'SPARK SIGHT 需要本机账户。登录后，模型工具和此页签会共用同一个本机会话。',
      'task.open.workbench': '在完整工作台中打开',
      'settings.tab.task': '任务',
      'settings.tab.settings': '设定',
      'settings.plot': '绘图设定',
      'settings.engine': '默认引擎',
      'settings.clarify': '默认启用需求澄清',
      'settings.prompt': '默认需求模板',
      'settings.prompt.placeholder': '新建任务时预填的提示，可留空',
      'settings.export': '导出设定',
      'settings.formats': '导出格式',
      'settings.dpi': '分辨率（DPI）',
      'settings.transparent': '透明背景',
      'settings.includeCode': '包含可复现代码',
      'settings.includeData': '包含数据文件',
      'settings.account': '账户与本机服务',
      'settings.service': '本机服务',
      'settings.service.ready': '已就绪',
      'settings.service.offline': '未就绪',
      'settings.update': '检查更新',
      'settings.update.current': '当前已是最新版本',
      'settings.update.available': '发现新版本',
      'settings.update.download': '下载并校验升级包',
      'settings.save': '设定会自动保存在本机',
      'error.network': '无法连接 Harness 插件服务',
      'error.authRequired': '请先登录 SPARK SIGHT',
      'error.noFile': '请选择 CSV 文件',
      'error.tooLarge': '数据文件超过 64MB 上限',
      'empty.selectTask': '从上方选择一个最近任务，或新建绘图。',
    }
    const EN = {
      'view.label': 'Plots',
      'view.subtitle': 'Research plotting',
      'toggle.label': 'Plots',
      'toggle.on': 'Plot mode is on',
      'toggle.off': 'Enable research plotting',
      'toggle.login': 'Sign in to enable plotting',
      'toggle.enable': 'Enable plot mode',
      'toggle.enable.desc': 'Plot mode gives the current model the SPARK SIGHT research-plotting tools and adds preview and settings above the conversation. Data and accounts stay local.',
      'toggle.switch': 'Toggle SPARK SIGHT plotting mode',
      'login.title': 'Sign in to SPARK SIGHT',
      'login.subtitle': 'Your account and data stay on this computer',
      'login.tab.login': 'Sign in',
      'login.tab.register': 'Create account',
      'login.username': 'Username',
      'login.username.hint': '6+ characters: letters, digits, dot, underscore or hyphen',
      'login.password': 'Password',
      'login.password.hint': 'At least 10 characters',
      'login.displayName': 'Display name (optional)',
      'login.agreement': 'I agree that local data is used only for plotting and can be deleted at any time',
      'login.submit': 'Sign in',
      'login.register': 'Create account',
      'login.busy': 'Signing in…',
      'login.or': 'or',
      'login.localAdmin': 'Use the local administrator account',
      'login.guest': 'Continue as a local guest',
      'login.guest.hint': 'Guest data also stays on this computer',
      'login.close': 'Close',
      'login.error.username': 'Username needs 6+ characters using letters, digits, dot, underscore or hyphen',
      'login.error.password': 'Password needs at least 10 characters',
      'login.error.agreement': 'Please accept the data notice first',
      'auth.loginRequired': 'Sign in to get started',
      'auth.expired': 'Session expired; please sign in again',
      'auth.logout': 'Sign out',
      'auth.account': 'Account',
      'auth.role.admin': 'Administrator',
      'auth.role.user': 'User',
      'common.close': 'Close',
      'common.cancel': 'Cancel',
      'common.refresh': 'Refresh',
      'common.retry': 'Retry',
      'common.loading': 'Loading…',
      'common.none': 'None',
      'common.copy': 'Copy',
      'common.open': 'Open',
      'common.more': 'More',
      'stage.title': 'SPARK SIGHT workbench',
      'stage.open': 'Open workbench',
      'stage.close': 'Close workbench',
      'stage.loading': 'Starting the local plotting service…',
      'stage.failed': 'The workbench is unavailable',
      'task.new': 'New plot',
      'task.empty.title': 'Start with a CSV',
      'task.empty.desc': 'Upload data and describe the research question. DSH models call the local plotting pipeline through sparksight_* tools; you can also create a task here directly.',
      'task.drop': 'Drop a CSV here, or click to choose a file',
      'task.file': 'Data file',
      'task.prompt': 'Plot request',
      'task.prompt.placeholder': 'e.g. Compare group means with error bars, title “Yield by treatment”, Chinese labels, print-friendly.',
      'task.engine': 'Rendering engine',
      'task.clarify': 'Enable the three-round clarification',
      'task.submit': 'Generate plans',
      'task.submitting': 'Uploading and profiling data…',
      'task.history': 'Recent tasks',
      'task.none': 'No tasks yet',
      'task.id': 'Task',
      'task.state': 'State',
      'task.title': 'Title',
      'task.dataset': 'Data',
      'task.selected': 'Selected plan',
      'task.plans': 'Candidate plans',
      'task.plan.select': 'Select this plan',
      'task.plan.selected': 'Selected',
      'task.plan.rendered': 'Preview ready',
      'task.plan.verified': 'Verified',
      'task.plan.unverified': 'Unverified',
      'task.plan.failed': 'Render failed',
      'task.preview': 'Preview',
      'task.preview.empty': 'A real rendered SVG preview appears here once plans are ready.',
      'task.preview.pending': 'Rendering preview…',
      'task.preview.failed': 'Preview unavailable',
      'task.preview.meta': 'Canvas',
      'task.preview.engine': 'Engine',
      'task.question': 'Needs your confirmation',
      'task.question.placeholder': 'Type an answer, or pick one of the options below',
      'task.question.submit': 'Submit answer',
      'task.feedback': 'Revision request',
      'task.feedback.placeholder': 'e.g. Move the legend to the right, change the title to “Mean daily yield”, use a grayscale palette.',
      'task.feedback.submit': 'Submit revision',
      'task.export': 'Export reproducible ZIP',
      'task.export.wait': 'Available when plans are ready',
      'task.export.busy': 'Exporting…',
      'task.complete': 'Confirm complete',
      'task.refresh': 'Refresh task',
      'task.polling': 'Polling task state',
      'task.error': 'Task error',
      'task.login': 'Sign in to view plotting tasks',
      'task.login.desc': 'SPARK SIGHT needs a local account. Model tools and this tab share the same local session after sign-in.',
      'task.open.workbench': 'Open in the full workbench',
      'settings.tab.task': 'Task',
      'settings.tab.settings': 'Settings',
      'settings.plot': 'Plot settings',
      'settings.engine': 'Default engine',
      'settings.clarify': 'Enable clarification by default',
      'settings.prompt': 'Default request template',
      'settings.prompt.placeholder': 'Prefilled prompt for new tasks (optional)',
      'settings.export': 'Export settings',
      'settings.formats': 'Formats',
      'settings.dpi': 'Resolution (DPI)',
      'settings.transparent': 'Transparent background',
      'settings.includeCode': 'Include reproducible code',
      'settings.includeData': 'Include data file',
      'settings.account': 'Account and local service',
      'settings.service': 'Local service',
      'settings.service.ready': 'Ready',
      'settings.service.offline': 'Not ready',
      'settings.update': 'Check for updates',
      'settings.update.current': 'You are on the latest version',
      'settings.update.available': 'New version available',
      'settings.update.download': 'Download and verify update',
      'settings.save': 'Settings are stored on this computer',
      'error.network': 'Cannot reach the Harness plugin service',
      'error.authRequired': 'Please sign in to SPARK SIGHT first',
      'error.noFile': 'Choose a CSV file first',
      'error.tooLarge': 'Data file exceeds the 64MB limit',
      'empty.selectTask': 'Pick a recent task above, or create a new plot.',
    }

    const isChinese = () => {
      try { return /^zh/i.test(navigator.language || '') } catch { return true }
    }
    const fallbackT = (key) => (isChinese() ? ZH : EN)[key] ?? key
    let translate = fallbackT
    const t = (key) => translate(key)

    const INK = '#12324B'
    const TEAL = '#2A9D8F'
    const TEAL_DARK = '#1F7F74'
    const ERROR = 'var(--dsw-alias-state-error-primary, #C0392B)'
    const TOKENS = {
      bg: 'var(--dsw-alias-bg-base, #ffffff)',
      module: 'var(--dsw-alias-bg-module-platform, #f7f8fa)',
      text: 'var(--dsw-alias-label-primary, #1b1b1b)',
      secondary: 'var(--dsw-alias-label-secondary, #5a6470)',
      tertiary: 'var(--dsw-alias-label-tertiary, #8a94a0)',
      caption: 'var(--dsw-alias-label-caption, #9aa3ad)',
      border: 'var(--dsw-alias-border-l2, rgba(0,0,0,0.10))',
      borderSoft: 'var(--dsw-alias-border-l1, rgba(0,0,0,0.06))',
      hover: 'var(--dsw-alias-interactive-bg-hover, rgba(0,0,0,0.05))',
      hoverSolid: 'var(--dsw-alias-interactive-bg-hover-solid, rgba(0,0,0,0.07))',
      primary: 'var(--dsw-alias-button-info-fill, #2A9D8F)',
      primaryHover: 'var(--dsw-alias-button-info-hover, #23867b)',
    }

    // ---------------------------------------------------------------------
    // host calls
    // ---------------------------------------------------------------------

    async function hostJson(path, { method = 'GET', body } = {}) {
      let response
      try {
        response = await fetch(path, {
          method,
          headers: body === undefined ? undefined : { 'content-type': 'application/json' },
          body: body === undefined ? undefined : JSON.stringify(body),
          credentials: 'same-origin',
        })
      } catch (error) {
        throw new Error(`${t('error.network')}: ${error?.message ?? error}`)
      }
      let data = null
      try { data = await response.json() } catch { data = null }
      if (!response.ok || data?.ok === false) {
        const message = data?.error?.message ?? data?.message ?? `HTTP ${response.status}`
        const error = new Error(message)
        error.code = data?.error?.code
        error.status = response.status
        throw error
      }
      return data ?? {}
    }

    async function agentApi(path, { method = 'GET', body } = {}) {
      const data = await hostJson('/api/sparksight/api', { method: 'POST', body: { method, path, body } })
      return data.result
    }

    // ---------------------------------------------------------------------
    // auth store
    // ---------------------------------------------------------------------

    let authSnapshot = {
      loading: true,
      ready: false,
      authenticated: false,
      user: null,
      loginRequired: true,
      webStage: false,
      version: '',
      error: null,
      expired: false,
    }
    const authListeners = new Set()
    let authPromise = null

    function emitAuth(next) {
      authSnapshot = { ...authSnapshot, ...next }
      for (const listener of authListeners) listener(authSnapshot)
    }

    function readAuth() {
      return authSnapshot
    }

    async function ensureAuth(force = false) {
      if (authPromise && !force) return authPromise
      authPromise = (async () => {
        try {
          const data = await hostJson('/api/sparksight/bootstrap')
          emitAuth({
            loading: false,
            ready: Boolean(data.ready),
            authenticated: Boolean(data.authenticated),
            user: data.user ?? null,
            loginRequired: data.loginRequired !== false,
            webStage: Boolean(data.webStage),
            version: data.version ?? '',
            error: null,
            expired: Boolean(data.expired),
            features: data.features,
          })
          return authSnapshot
        } catch (error) {
          emitAuth({ loading: false, error: error.message })
          return authSnapshot
        } finally {
          authPromise = null
        }
      })()
      return authPromise
    }

    function useAuth() {
      const [snapshot, setSnapshot] = useState(authSnapshot)
      useEffect(() => {
        const listener = (next) => setSnapshot(next)
        authListeners.add(listener)
        listener(authSnapshot)
        if (authSnapshot.loading) ensureAuth()
        return () => authListeners.delete(listener)
      }, [])
      return snapshot
    }

    async function loginWith(route, body) {
      const data = await hostJson(`/api/sparksight/auth/${route}`, { method: 'POST', body })
      emitAuth({
        loading: false,
        authenticated: true,
        user: data.user ?? null,
        error: null,
        expired: false,
      })
      return data
    }

    async function logout() {
      try { await hostJson('/api/sparksight/auth/logout', { method: 'POST', body: {} }) } catch { /* local logout still clears */ }
      emitAuth({ authenticated: false, user: null, expired: false })
    }

    // ---------------------------------------------------------------------
    // per-session toggle + recent tasks
    // ---------------------------------------------------------------------

    const enabledKey = (sessionId) => `sparksight:enabled:${sessionId || 'default'}`
    const tasksKey = 'sparksight:tasks:v1'
    const activeKey = (sessionId) => `sparksight:active:${sessionId || 'default'}`
    const settingsKey = 'sparksight:settings:v1'

    function readEnabled(sessionId) {
      try { return localStorage.getItem(enabledKey(sessionId)) === '1' } catch { return false }
    }

    function writeEnabled(sessionId, value) {
      try { localStorage.setItem(enabledKey(sessionId), value ? '1' : '0') } catch { /* private mode */ }
      window.dispatchEvent(new CustomEvent('sparksight:enabled', { detail: { sessionId, value } }))
    }

    function useEnabled(sessionId) {
      const [value, setValue] = useState(() => readEnabled(sessionId))
      useEffect(() => {
        setValue(readEnabled(sessionId))
        const onChange = (event) => {
          if (event.detail?.sessionId === sessionId) setValue(Boolean(event.detail.value))
        }
        window.addEventListener('sparksight:enabled', onChange)
        return () => window.removeEventListener('sparksight:enabled', onChange)
      }, [sessionId])
      return [value, (next) => {
        const resolved = typeof next === 'function' ? next(value) : next
        setValue(resolved)
        writeEnabled(sessionId, resolved)
      }]
    }

    function readTasks() {
      try {
        const parsed = JSON.parse(localStorage.getItem(tasksKey) || '[]')
        return Array.isArray(parsed) ? parsed.filter((item) => item && typeof item.taskId === 'string') : []
      } catch { return [] }
    }

    function rememberTask(entry) {
      if (!entry?.taskId) return
      try {
        const existing = readTasks().filter((item) => item.taskId !== entry.taskId)
        const next = [{
          taskId: entry.taskId,
          title: String(entry.title ?? existing.find((item) => item.taskId === entry.taskId)?.title ?? '未命名任务'),
          state: entry.state ?? '',
          at: Date.now(),
        }, ...existing].slice(0, 12)
        localStorage.setItem(tasksKey, JSON.stringify(next))
        window.dispatchEvent(new CustomEvent('sparksight:tasks'))
      } catch { /* ignore quota */ }
    }

    function forgetTask(taskId) {
      try {
        localStorage.setItem(tasksKey, JSON.stringify(readTasks().filter((item) => item.taskId !== taskId)))
        window.dispatchEvent(new CustomEvent('sparksight:tasks'))
      } catch { /* ignore */ }
    }

    function useTasks() {
      const [tasks, setTasks] = useState(readTasks)
      useEffect(() => {
        const reload = () => setTasks(readTasks())
        window.addEventListener('sparksight:tasks', reload)
        window.addEventListener('storage', reload)
        return () => {
          window.removeEventListener('sparksight:tasks', reload)
          window.removeEventListener('storage', reload)
        }
      }, [])
      return tasks
    }

    function readSettings() {
      try {
        const parsed = JSON.parse(localStorage.getItem(settingsKey) || '{}')
        return {
          engine: ['python', 'r', 'matlab'].includes(parsed.engine) ? parsed.engine : 'python',
          clarify: parsed.clarify !== false,
          prompt: typeof parsed.prompt === 'string' ? parsed.prompt : '',
          formats: Array.isArray(parsed.formats) && parsed.formats.length > 0 ? parsed.formats.filter((item) => ['svg', 'png', 'pdf'].includes(item)) : ['svg', 'png', 'pdf'],
          dpi: Number.isFinite(Number(parsed.dpi)) ? Math.max(72, Math.min(1200, Number(parsed.dpi))) : 300,
          transparent: parsed.transparent === true,
          includeCode: parsed.includeCode !== false,
          includeData: parsed.includeData !== false,
        }
      } catch {
        return { engine: 'python', clarify: true, prompt: '', formats: ['svg', 'png', 'pdf'], dpi: 300, transparent: false, includeCode: true, includeData: true }
      }
    }

    function writeSettings(settings) {
      try { localStorage.setItem(settingsKey, JSON.stringify(settings)) } catch { /* ignore */ }
    }

    function useSettings() {
      const [settings, setSettings] = useState(readSettings)
      const update = useCallback((patch) => {
        setSettings((current) => {
          const next = { ...current, ...patch }
          writeSettings(next)
          return next
        })
      }, [])
      return [settings, update]
    }

    // ---------------------------------------------------------------------
    // small icons
    // ---------------------------------------------------------------------

    function SparkGlyph({ size = 14 }) {
      return h('svg', { viewBox: '0 0 24 24', width: size, height: size, 'aria-hidden': true, style: { display: 'block', flex: 'none' } },
        h('path', { d: 'M12 2 L14.2 9.8 L22 12 L14.2 14.2 L12 22 L9.8 14.2 L2 12 L9.8 9.8 Z', fill: TEAL }))
    }

    function Icon({ name, size = 14 }) {
      const common = { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', stroke: 'currentColor', strokeWidth: 1.8, strokeLinecap: 'round', strokeLinejoin: 'round', 'aria-hidden': true, style: { display: 'block', flex: 'none' } }
      if (name === 'refresh') return h('svg', common, h('path', { d: 'M20 11a8 8 0 1 0-2.3 5.7' }), h('path', { d: 'M20 4v7h-7' }))
      if (name === 'settings') return h('svg', common, h('circle', { cx: 12, cy: 12, r: 3 }), h('path', { d: 'M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1-2.8 2.8-.1-.1a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.6v.2h-4v-.2a1.7 1.7 0 0 0-1-1.6 1.7 1.7 0 0 0-1.9.3l-.1.1L4.2 17l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.6-1H2.8v-4H3a1.7 1.7 0 0 0 1.6-1 1.7 1.7 0 0 0-.3-1.9L4.2 7 7 4.2l.1.1a1.7 1.7 0 0 0 1.9.3 1.7 1.7 0 0 0 1-1.6v-.2h4V3a1.7 1.7 0 0 0 1 1.6 1.7 1.7 0 0 0 1.9-.3l.1-.1L19.8 7l-.1.1a1.7 1.7 0 0 0-.3 1.9 1.7 1.7 0 0 0 1.6 1h.2v4H21a1.7 1.7 0 0 0-1.6 1Z' }))
      if (name === 'close') return h('svg', common, h('path', { d: 'M6 6l12 12M18 6L6 18' }))
      if (name === 'download') return h('svg', common, h('path', { d: 'M12 3v12' }), h('path', { d: 'm7 10 5 5 5-5' }), h('path', { d: 'M5 21h14' }))
      if (name === 'upload') return h('svg', common, h('path', { d: 'M12 16V4' }), h('path', { d: 'm7 9 5-5 5 5' }), h('path', { d: 'M5 21h14' }))
      if (name === 'check') return h('svg', common, h('path', { d: 'm5 12 4 4L19 6' }))
      if (name === 'chevron') return h('svg', common, h('path', { d: 'm6 9 6 6 6-6' }))
      if (name === 'alert') return h('svg', common, h('path', { d: 'M12 3 2.5 20h19Z' }), h('path', { d: 'M12 9v5' }), h('path', { d: 'M12 17.5v.5' }))
      return null
    }

    function Spinner({ size = 14 }) {
      return h('span', { className: 'ss-spinner', style: { width: size, height: size }, 'aria-hidden': true })
    }

    function StatusPill({ snapshot, loading }) {
      const state = snapshot?.state ?? ''
      const tone = state === 'FAILED' || state === 'CANCELLED' ? 'error'
        : state === 'COMPLETE' ? 'done'
          : snapshot?.pendingQuestion ? 'warn'
            : state ? 'busy' : 'idle'
      return h('span', { className: `ss-pill ss-pill-${tone}` },
        loading ? h(Spinner, { size: 10 }) : h('span', { className: 'ss-dot' }),
        state || (loading ? t('common.loading') : t('common.none')))
    }

    // ---------------------------------------------------------------------
    // login dialog
    // ---------------------------------------------------------------------

    function LoginDialog({ open, onClose, onAuthenticated, reason }) {
      const [mode, setMode] = useState('login')
      const [username, setUsername] = useState('')
      const [password, setPassword] = useState('')
      const [displayName, setDisplayName] = useState('')
      const [agreement, setAgreement] = useState(true)
      const [busy, setBusy] = useState('')
      const [error, setError] = useState('')
      const firstRef = useRef(null)

      useEffect(() => {
        if (!open) return
        setError('')
        setBusy('')
        const timer = setTimeout(() => firstRef.current?.focus(), 60)
        const onKey = (event) => { if (event.key === 'Escape') onClose() }
        window.addEventListener('keydown', onKey)
        return () => { clearTimeout(timer); window.removeEventListener('keydown', onKey) }
      }, [open, onClose])

      if (!open) return null

      const submit = async () => {
        setError('')
        if (mode === 'register') {
          if (!/^[a-z0-9][a-z0-9_.-]{5,31}$/i.test(username.trim().toLowerCase())) { setError(t('login.error.username')); return }
          if (password.length < 10) { setError(t('login.error.password')); return }
          if (!agreement) { setError(t('login.error.agreement')); return }
        } else {
          if (!username.trim()) { setError(t('login.error.username')); return }
          if (!password) { setError(t('login.error.password')); return }
        }
        setBusy(mode)
        try {
          if (mode === 'register') {
            await loginWith('register', { username: username.trim(), password, displayName: displayName.trim() })
          } else {
            await loginWith('login', { username: username.trim(), password })
          }
          onAuthenticated?.()
          onClose()
        } catch (failure) {
          setError(failure.message)
        } finally {
          setBusy('')
        }
      }

      const quick = async (route) => {
        setError('')
        setBusy(route)
        try {
          await loginWith(route, {})
          onAuthenticated?.()
          onClose()
        } catch (failure) {
          setError(failure.message)
        } finally {
          setBusy('')
        }
      }

      const onKeyDown = (event) => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault()
          submit()
        }
      }

      const dialog = h('div', {
        className: 'ss-modal-backdrop',
        onMouseDown: (event) => { if (event.target === event.currentTarget) onClose() },
      },
        h('div', { className: 'ss-modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': t('login.title') },
          h('div', { className: 'ss-modal-head' },
            h('div', { className: 'ss-brand' }, h(SparkGlyph, { size: 20 }), h('div', null,
              h('strong', null, t('login.title')),
              h('span', null, reason || t('login.subtitle')))),
            h('button', { type: 'button', className: 'ss-icon-btn', onClick: onClose, 'aria-label': t('login.close') }, h(Icon, { name: 'close' }))),
          h('div', { className: 'ss-segmented' },
            h('button', { type: 'button', className: mode === 'login' ? 'is-active' : '', onClick: () => { setMode('login'); setError('') } }, t('login.tab.login')),
            h('button', { type: 'button', className: mode === 'register' ? 'is-active' : '', onClick: () => { setMode('register'); setError('') } }, t('login.tab.register'))),
          h('div', { className: 'ss-form', onKeyDown },
            h('label', { className: 'ss-field' },
              h('span', null, t('login.username')),
              h('input', {
                ref: firstRef,
                type: 'text',
                autoComplete: 'username',
                value: username,
                placeholder: t('login.username.hint'),
                onChange: (event) => setUsername(event.target.value),
              })),
            mode === 'register' ? h('label', { className: 'ss-field' },
              h('span', null, t('login.displayName')),
              h('input', { type: 'text', value: displayName, onChange: (event) => setDisplayName(event.target.value) })) : null,
            h('label', { className: 'ss-field' },
              h('span', null, t('login.password')),
              h('input', {
                type: 'password',
                autoComplete: mode === 'register' ? 'new-password' : 'current-password',
                value: password,
                placeholder: t('login.password.hint'),
                onChange: (event) => setPassword(event.target.value),
              })),
            mode === 'register' ? h('label', { className: 'ss-check' },
              h('input', { type: 'checkbox', checked: agreement, onChange: (event) => setAgreement(event.target.checked) }),
              h('span', null, t('login.agreement'))) : null,
            error ? h('div', { className: 'ss-error' }, h(Icon, { name: 'alert', size: 13 }), h('span', null, error)) : null,
            h('button', { type: 'button', className: 'ss-primary ss-block', disabled: Boolean(busy), onClick: submit },
              busy === mode ? h(Spinner, { size: 13 }) : null,
              busy === mode ? t('login.busy') : mode === 'register' ? t('login.register') : t('login.submit'))),
          h('div', { className: 'ss-divider' }, h('span', null, t('login.or'))),
          h('div', { className: 'ss-modal-actions' },
            h('button', { type: 'button', className: 'ss-secondary ss-block', disabled: Boolean(busy), onClick: () => quick('local-admin') },
              busy === 'local-admin' ? h(Spinner, { size: 13 }) : null, t('login.localAdmin')),
            h('button', { type: 'button', className: 'ss-ghost ss-block', disabled: Boolean(busy), onClick: () => quick('anonymous') },
              busy === 'anonymous' ? h(Spinner, { size: 13 }) : null, t('login.guest')),
            h('p', { className: 'ss-fineprint' }, t('login.guest.hint')))))
      return portal(dialog)
    }

    // ---------------------------------------------------------------------
    // composer toggle
    // ---------------------------------------------------------------------

    function SparkToggle({ sessionId }) {
      const auth = useAuth()
      const [enabled, setEnabled] = useEnabled(sessionId)
      const [loginOpen, setLoginOpen] = useState(false)
      const on = enabled && auth.authenticated
      const title = !auth.authenticated ? t('toggle.login') : on ? t('toggle.on') : t('toggle.off')

      const click = () => {
        if (!auth.authenticated) {
          setLoginOpen(true)
          return
        }
        setEnabled(!enabled)
      }

      return h(React.Fragment, null,
        h('button', {
          type: 'button',
          role: 'switch',
          'aria-checked': on,
          'aria-label': t('toggle.switch'),
          title,
          className: `ss-toggle ${on ? 'is-on' : ''}`,
          onClick: click,
        },
          h(SparkGlyph, { size: 13 }),
          h('span', { className: 'ss-toggle-label' }, t('toggle.label')),
          h('span', { className: 'ss-switch', 'aria-hidden': true }, h('span', { className: 'ss-switch-knob' }))),
        h(LoginDialog, {
          open: loginOpen,
          onClose: () => setLoginOpen(false),
          onAuthenticated: () => setEnabled(true),
          reason: t('auth.loginRequired'),
        }))
    }

    // ---------------------------------------------------------------------
    // stage overlay (full workbench)
    // ---------------------------------------------------------------------

    function StageOverlay({ webUrl, onClose }) {
      const iframeRef = useRef(null)

      useEffect(() => {
        const onKey = (event) => { if (event.key === 'Escape') onClose() }
        window.addEventListener('keydown', onKey)
        return () => window.removeEventListener('keydown', onKey)
      }, [onClose])

      useEffect(() => {
        const iframe = iframeRef.current
        if (!iframe) return
        const iframeOrigin = new URL(webUrl).origin
        const onMessage = async (event) => {
          if (event.source !== iframe.contentWindow || event.origin !== iframeOrigin) return
          const message = event.data
          if (!message || typeof message.id !== 'string' || !message.type) return
          const reply = (payload) => {
            if (iframe.contentWindow) iframe.contentWindow.postMessage(payload, iframeOrigin)
          }
          try {
            const response = await fetch('/api/sparksight/host', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify(message),
            })
            reply(await response.json())
          } catch {
            reply({ version: 2, id: message.id, ok: false, error: { code: 'HOST_RELAY_FAILED', message: 'host relay failed' } })
          }
        }
        window.addEventListener('message', onMessage)
        return () => window.removeEventListener('message', onMessage)
      }, [webUrl])

      return h('div', {
        className: 'ss-stage-backdrop',
        role: 'dialog',
        'aria-modal': 'true',
        'aria-label': t('stage.title'),
        onMouseDown: (event) => { if (event.target === event.currentTarget) onClose() },
      },
        h('div', { className: 'ss-stage' },
          h('div', { className: 'ss-stage-head' },
            h('div', { className: 'ss-brand' }, h(SparkGlyph, { size: 16 }), h('strong', null, t('stage.title'))),
            h('button', { type: 'button', className: 'ss-icon-btn', onClick: onClose, 'aria-label': t('stage.close') }, h(Icon, { name: 'close' }))),
          h('iframe', {
            ref: iframeRef,
            title: t('stage.title'),
            src: `${webUrl}/#/app`,
            className: 'ss-stage-frame',
            allow: 'clipboard-read; clipboard-write',
          })))
    }

    // ---------------------------------------------------------------------
    // login gate / empty state / task form
    // ---------------------------------------------------------------------

    function LoginGate({ onLogin }) {
      const auth = useAuth()
      return h('div', { className: 'ss-gate' },
        h('div', { className: 'ss-gate-icon' }, h(SparkGlyph, { size: 28 })),
        h('h3', null, auth.expired ? t('auth.expired') : t('task.login')),
        h('p', null, t('task.login.desc')),
        h('button', { type: 'button', className: 'ss-primary', onClick: onLogin }, t('login.submit')),
        auth.error ? h('p', { className: 'ss-error' }, auth.error) : null)
    }

    function DisabledGate({ onEnable }) {
      return h('div', { className: 'ss-gate' },
        h('div', { className: 'ss-gate-icon' }, h(SparkGlyph, { size: 28 })),
        h('h3', null, t('toggle.enable')),
        h('p', null, t('toggle.enable.desc')),
        h('button', { type: 'button', className: 'ss-primary', onClick: onEnable }, t('toggle.enable')))
    }

    function FileDrop({ file, onFile }) {
      const inputRef = useRef(null)
      const [dragging, setDragging] = useState(false)
      const accept = (selected) => {
        if (!selected) return
        if (!/\.(csv|tsv)$/i.test(selected.name || '')) {
          onFile(null, t('error.noFile'))
          return
        }
        if (selected.size > 64 * 1024 * 1024) {
          onFile(null, t('error.tooLarge'))
          return
        }
        onFile(selected, '')
      }
      return h('div', {
        className: `ss-drop ${dragging ? 'is-dragging' : ''}`,
        role: 'button',
        tabIndex: 0,
        onClick: () => inputRef.current?.click(),
        onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') inputRef.current?.click() },
        onDragOver: (event) => { event.preventDefault(); setDragging(true) },
        onDragLeave: () => setDragging(false),
        onDrop: (event) => {
          event.preventDefault()
          setDragging(false)
          accept(event.dataTransfer?.files?.[0])
        },
      },
        h('input', {
          ref: inputRef,
          type: 'file',
          accept: '.csv,.tsv,text/csv',
          style: { display: 'none' },
          onChange: (event) => accept(event.target.files?.[0]),
        }),
        h(Icon, { name: 'upload', size: 20 }),
        h('strong', null, file ? file.name : t('task.drop')),
        file ? h('span', null, `${(file.size / 1024).toFixed(1)} KB`) : null)
    }

    function NewTaskForm({ auth, onCreated, onLogin, initialError }) {
      const [settings] = useSettings()
      const [file, setFile] = useState(null)
      const [fileError, setFileError] = useState(initialError || '')
      const [prompt, setPrompt] = useState(settings.prompt || '')
      const [engine, setEngine] = useState(settings.engine)
      const [clarify, setClarify] = useState(settings.clarify)
      const [busy, setBusy] = useState(false)
      const [error, setError] = useState('')

      const submit = async () => {
        setError('')
        if (!auth.authenticated) { onLogin(); return }
        if (!file) { setError(t('error.noFile')); return }
        setBusy(true)
        try {
          const form = new FormData()
          form.append('file', file, file.name)
          form.append('prompt', prompt || '请根据数据自动推荐最能说明研究问题的科研配图。')
          form.append('engine', engine)
          form.append('clarify', clarify ? 'true' : 'false')
          const response = await fetch('/api/sparksight/tasks', { method: 'POST', body: form, credentials: 'same-origin' })
          const data = await response.json().catch(() => null)
          if (!response.ok || data?.ok === false) throw new Error(data?.error?.message ?? `HTTP ${response.status}`)
          onCreated({ taskId: data.taskId, snapshot: data.snapshot })
        } catch (failure) {
          setError(failure.message)
        } finally {
          setBusy(false)
        }
      }

      return h('div', { className: 'ss-new' },
        h('div', { className: 'ss-new-head' },
          h('div', null,
            h('h3', null, t('task.empty.title')),
            h('p', null, t('task.empty.desc')))),
        h(FileDrop, { file, onFile: (selected, message) => { setFile(selected); setFileError(message) } }),
        fileError ? h('div', { className: 'ss-error' }, h(Icon, { name: 'alert', size: 13 }), h('span', null, fileError)) : null,
        h('label', { className: 'ss-field' },
          h('span', null, t('task.prompt')),
          h('textarea', {
            rows: 3,
            value: prompt,
            placeholder: t('task.prompt.placeholder'),
            onChange: (event) => setPrompt(event.target.value),
          })),
        h('div', { className: 'ss-row' },
          h('label', { className: 'ss-field ss-field-inline' },
            h('span', null, t('task.engine')),
            h('select', { value: engine, onChange: (event) => setEngine(event.target.value) },
              h('option', { value: 'python' }, 'Python'),
              h('option', { value: 'r' }, 'R'),
              h('option', { value: 'matlab' }, 'MATLAB'))),
          h('label', { className: 'ss-check' },
            h('input', { type: 'checkbox', checked: clarify, onChange: (event) => setClarify(event.target.checked) }),
            h('span', null, t('task.clarify')))),
        error ? h('div', { className: 'ss-error' }, h(Icon, { name: 'alert', size: 13 }), h('span', null, error)) : null,
        h('button', { type: 'button', className: 'ss-primary ss-block', disabled: busy || !file, onClick: submit },
          busy ? h(Spinner, { size: 13 }) : null,
          busy ? t('task.submitting') : t('task.submit')))
    }

    // ---------------------------------------------------------------------
    // task preview + side panels
    // ---------------------------------------------------------------------

    function PlanCard({ plan, selected, onSelect }) {
      const rendered = Boolean(plan?.__rendered)
      const verified = plan?.verification?.passed ?? plan?.verification?.verified
      const failed = plan?.executionStatus === 'failed_execution'
      return h('div', { className: `ss-plan ${selected ? 'is-selected' : ''}` },
        h('div', { className: 'ss-plan-head' },
          h('div', { className: 'ss-plan-name' }, h('strong', null, plan?.chartType || plan?.name || plan?.plan_id), h('span', null, plan?.plan_id)),
          h('span', { className: `ss-badge ${verified === true ? 'is-ok' : failed ? 'is-error' : rendered ? 'is-info' : ''}` },
            failed ? t('task.plan.failed') : verified === true ? t('task.plan.verified') : rendered ? t('task.plan.rendered') : t('task.plan.unverified'))),
        plan?.rationale ? h('p', { className: 'ss-plan-why' }, plan.rationale) : null,
        h('div', { className: 'ss-plan-foot' },
          h('span', { className: 'ss-mono' }, Number.isFinite(Number(plan?.score?.total)) ? `score ${Number(plan.score.total).toFixed(2)}` : ''),
          h('button', {
            type: 'button',
            className: selected ? 'ss-secondary ss-small' : 'ss-primary ss-small',
            disabled: selected,
            onClick: () => onSelect(plan?.plan_id),
          }, selected ? t('task.plan.selected') : t('task.plan.select'))))
    }

    function PreviewPane({ snapshot, preview, loading, error, onSelect, activePlanId }) {
      if (preview?.url) {
        return h('div', { className: 'ss-preview-wrap' },
          h('div', { className: 'ss-preview-toolbar' },
            h('span', { className: 'ss-preview-title' }, t('task.preview')),
            h('span', { className: 'ss-preview-meta' },
              preview.width && preview.height ? `${t('task.preview.meta')} ${preview.width}×${preview.height}` : '',
              preview.engine ? ` · ${t('task.preview.engine')} ${preview.engine}` : '')),
          h('div', { className: 'ss-preview-paper' }, h('img', { src: preview.url, alt: t('task.preview'), className: 'ss-preview-img' })),
          snapshot?.plans?.length > 1 ? h('div', { className: 'ss-preview-plans' },
            snapshot.plans.slice(0, 6).map((plan) => h('button', {
              key: plan.plan_id,
              type: 'button',
              className: `ss-plan-chip ${plan.plan_id === activePlanId ? 'is-selected' : ''}`,
              onClick: () => onSelect(plan.plan_id),
              title: plan.rationale || plan.plan_id,
            }, plan.chartType || plan.plan_id))) : null)
      }
      return h('div', { className: 'ss-preview-empty' },
        loading ? h(Spinner, { size: 22 }) : h(SparkGlyph, { size: 30 }),
        h('strong', null, error ? t('task.preview.failed') : loading ? t('task.preview.pending') : t('task.preview.empty')),
        error ? h('span', { className: 'ss-muted' }, error) : null,
        snapshot?.state ? h('span', { className: 'ss-muted' }, `${t('task.state')}: ${snapshot.state}`) : null)
    }

    function ClarifyCard({ question, onSubmit, busy }) {
      const [answer, setAnswer] = useState('')
      useEffect(() => { setAnswer('') }, [question?.question])
      if (!question) return null
      const choose = (option) => {
        setAnswer(option)
        onSubmit(option)
      }
      return h('div', { className: 'ss-clarify' },
        h('div', { className: 'ss-clarify-head' }, h(Icon, { name: 'alert', size: 14 }), h('strong', null, t('task.question'))),
        h('p', null, question.question),
        question.hint ? h('p', { className: 'ss-muted ss-small-text' }, question.hint) : null,
        Array.isArray(question.options) && question.options.length > 0 ? h('div', { className: 'ss-option-grid' },
          question.options.slice(0, 10).map((option) => h('button', {
            key: option,
            type: 'button',
            className: 'ss-option',
            disabled: busy,
            onClick: () => choose(option),
          }, option))) : null,
        h('textarea', {
          rows: 2,
          value: answer,
          placeholder: t('task.question.placeholder'),
          onChange: (event) => setAnswer(event.target.value),
        }),
        h('button', { type: 'button', className: 'ss-primary ss-small', disabled: busy || !answer.trim(), onClick: () => onSubmit(answer) },
          busy ? h(Spinner, { size: 12 }) : null, t('task.question.submit')))
    }

    function TaskPanel({ snapshot, busy, onAnswer, onSelect, onFeedback, onComplete, onExport, onRefresh }) {
      const [feedback, setFeedback] = useState('')
      if (!snapshot) return h('div', { className: 'ss-panel-empty' }, t('empty.selectTask'))
      const plans = Array.isArray(snapshot.plans) ? snapshot.plans : []
      const selected = snapshot.selectedPlanId
      const dataset = snapshot.dataset
      const rows = Number(dataset?.rows)
      const columns = Array.isArray(dataset?.columns) ? dataset.columns.length : Number(dataset?.columnCount)
      return h('div', { className: 'ss-panel' },
        h('div', { className: 'ss-kv' },
          h('span', null, t('task.id')), h('b', { className: 'ss-mono' }, snapshot.taskId),
          h('span', null, t('task.state')), h('b', null, snapshot.state || t('common.none')),
          snapshot.title ? h(React.Fragment, null, h('span', null, t('task.title')), h('b', null, snapshot.title)) : null,
          Number.isFinite(rows) || Number.isFinite(columns) ? h(React.Fragment, null,
            h('span', null, t('task.dataset')),
            h('b', null, `${Number.isFinite(rows) ? rows : '?'} × ${Number.isFinite(columns) ? columns : '?'}`)) : null,
          selected ? h(React.Fragment, null, h('span', null, t('task.selected')), h('b', { className: 'ss-mono' }, selected)) : null),
        snapshot.error?.message ? h('div', { className: 'ss-error' }, h(Icon, { name: 'alert', size: 13 }), h('span', null, snapshot.error.message)) : null,
        plans.length > 0 ? h('div', { className: 'ss-plans' },
          h('div', { className: 'ss-section-title' }, t('task.plans')),
          plans.slice(0, 6).map((plan) => h(PlanCard, {
            key: plan.plan_id,
            plan: { ...plan, __rendered: Boolean(snapshot.planArtifacts?.[plan.plan_id]?.svgBytes || snapshot.planArtifacts?.[plan.plan_id]?.png) },
            selected: selected === plan.plan_id,
            onSelect,
          }))) : null,
        plans.length > 0 ? h('div', { className: 'ss-section' },
          h('div', { className: 'ss-section-title' }, t('task.feedback')),
          h('textarea', {
            rows: 3,
            value: feedback,
            placeholder: t('task.feedback.placeholder'),
            onChange: (event) => setFeedback(event.target.value),
          }),
          h('div', { className: 'ss-row ss-row-end' },
            h('button', {
              type: 'button',
              className: 'ss-secondary ss-small',
              disabled: Boolean(busy) || !feedback.trim(),
              onClick: () => { onFeedback(feedback); setFeedback('') },
            }, busy === 'feedback' ? h(Spinner, { size: 12 }) : null, t('task.feedback.submit')))) : null,
        h('div', { className: 'ss-row ss-row-between ss-top-gap' },
          h('button', { type: 'button', className: 'ss-ghost ss-small', onClick: onRefresh }, h(Icon, { name: 'refresh', size: 13 }), t('task.refresh')),
          plans.length > 0 ? h('button', { type: 'button', className: 'ss-secondary ss-small', disabled: Boolean(busy) || snapshot.state === 'COMPLETE', onClick: onComplete }, t('task.complete')) : null),
        h('button', {
          type: 'button',
          className: 'ss-primary ss-block ss-top-gap',
          disabled: Boolean(busy) || !snapshot.taskId || !['PRESENT', 'ITERATE', 'COMPLETE'].includes(String(snapshot.state)),
          title: ['PRESENT', 'ITERATE', 'COMPLETE'].includes(String(snapshot.state)) ? t('task.export') : t('task.export.wait'),
          onClick: onExport,
        }, h(Icon, { name: 'download', size: 14 }), busy === 'export' ? t('task.export.busy') : t('task.export')))
    }

    function SettingsPanel({ auth, settings, onChange, onLogout, onOpenWorkbench, onLogin }) {
      const [update, setUpdate] = useState(null)
      const [checking, setChecking] = useState(false)
      const toggleFormat = (format) => {
        const next = settings.formats.includes(format)
          ? settings.formats.filter((item) => item !== format)
          : [...settings.formats, format]
        onChange({ formats: next.length > 0 ? next : [format] })
      }
      const check = async () => {
        setChecking(true)
        try { setUpdate(await hostJson('/api/sparksight/updates')) } catch (error) { setUpdate({ error: error.message }) } finally { setChecking(false) }
      }
      return h('div', { className: 'ss-panel' },
        h('div', { className: 'ss-section-title' }, t('settings.plot')),
        h('label', { className: 'ss-field' },
          h('span', null, t('settings.engine')),
          h('select', { value: settings.engine, onChange: (event) => onChange({ engine: event.target.value }) },
            h('option', { value: 'python' }, 'Python'),
            h('option', { value: 'r' }, 'R'),
            h('option', { value: 'matlab' }, 'MATLAB'))),
        h('label', { className: 'ss-check' },
          h('input', { type: 'checkbox', checked: settings.clarify, onChange: (event) => onChange({ clarify: event.target.checked }) }),
          h('span', null, t('settings.clarify'))),
        h('label', { className: 'ss-field' },
          h('span', null, t('settings.prompt')),
          h('textarea', {
            rows: 3,
            value: settings.prompt,
            placeholder: t('settings.prompt.placeholder'),
            onChange: (event) => onChange({ prompt: event.target.value }),
          })),
        h('div', { className: 'ss-section-title ss-top-gap' }, t('settings.export')),
        h('div', { className: 'ss-chips' },
          ['svg', 'png', 'pdf'].map((format) => h('button', {
            key: format,
            type: 'button',
            className: `ss-chip ${settings.formats.includes(format) ? 'is-selected' : ''}`,
            onClick: () => toggleFormat(format),
          }, format.toUpperCase()))),
        h('div', { className: 'ss-row' },
          h('label', { className: 'ss-field ss-field-inline' },
            h('span', null, t('settings.dpi')),
            h('input', {
              type: 'number',
              min: 72,
              max: 1200,
              step: 1,
              value: settings.dpi,
              onChange: (event) => onChange({ dpi: Math.max(72, Math.min(1200, Number(event.target.value) || 300)) }),
            })),
          h('label', { className: 'ss-check' },
            h('input', { type: 'checkbox', checked: settings.transparent, onChange: (event) => onChange({ transparent: event.target.checked }) }),
            h('span', null, t('settings.transparent')))),
        h('label', { className: 'ss-check' },
          h('input', { type: 'checkbox', checked: settings.includeCode, onChange: (event) => onChange({ includeCode: event.target.checked }) }),
          h('span', null, t('settings.includeCode'))),
        h('label', { className: 'ss-check' },
          h('input', { type: 'checkbox', checked: settings.includeData, onChange: (event) => onChange({ includeData: event.target.checked }) }),
          h('span', null, t('settings.includeData'))),
        h('p', { className: 'ss-fineprint' }, t('settings.save')),

        h('div', { className: 'ss-section-title ss-top-gap' }, t('settings.account')),
        auth.authenticated && auth.user ? h('div', { className: 'ss-account' },
          h('div', { className: 'ss-avatar' }, (auth.user.displayName || auth.user.username || 'S').slice(0, 1).toUpperCase()),
          h('div', null,
            h('strong', null, auth.user.displayName || auth.user.username),
            h('span', null, `${auth.user.username} · ${auth.user.role === 'admin' ? t('auth.role.admin') : t('auth.role.user')}`))) : null,
        h('div', { className: 'ss-kv ss-kv-tight' },
          h('span', null, t('settings.service')),
          h('b', { className: auth.ready ? 'ss-ok' : 'ss-warn' }, auth.ready ? t('settings.service.ready') : t('settings.service.offline'))),
        h('div', { className: 'ss-row ss-row-wrap ss-top-gap' },
          h('button', { type: 'button', className: 'ss-secondary ss-small', onClick: onOpenWorkbench }, t('stage.open')),
          auth.authenticated
            ? h('button', { type: 'button', className: 'ss-ghost ss-small', onClick: onLogout }, t('auth.logout'))
            : h('button', { type: 'button', className: 'ss-primary ss-small', onClick: onLogin }, t('login.submit'))),
        h('div', { className: 'ss-row ss-row-wrap ss-top-gap' },
          h('button', { type: 'button', className: 'ss-ghost ss-small', disabled: checking, onClick: check },
            checking ? h(Spinner, { size: 12 }) : h(Icon, { name: 'refresh', size: 12 }), t('settings.update'))),
        update ? h('p', { className: 'ss-fineprint' },
          update.error ? update.error
            : update.release?.available ? `${t('settings.update.available')}: ${update.release.latestVersion ?? ''}`
              : t('settings.update.current')) : null)
    }

    // ---------------------------------------------------------------------
    // plot view
    // ---------------------------------------------------------------------

    function SparkView({ sessionId }) {
      const auth = useAuth()
      const [enabled, setEnabled] = useEnabled(sessionId)
      const tasks = useTasks()
      const [settings, updateSettings] = useSettings()
      const [activeTaskId, setActiveTaskId] = useState(() => {
        try { return localStorage.getItem(activeKey(sessionId)) || '' } catch { return '' }
      })
      const [snapshot, setSnapshot] = useState(null)
      const [preview, setPreview] = useState(null)
      const [loading, setLoading] = useState(false)
      const [previewLoading, setPreviewLoading] = useState(false)
      const [previewError, setPreviewError] = useState('')
      const [error, setError] = useState('')
      const [busy, setBusy] = useState('')
      const [panelTab, setPanelTab] = useState('task')
      const [loginOpen, setLoginOpen] = useState(false)
      const [stageUrl, setStageUrl] = useState('')
      const [refreshNonce, setRefreshNonce] = useState(0)
      const [showAllTasks, setShowAllTasks] = useState(false)
      const previewKeyRef = useRef('')
      const previewUrlRef = useRef('')

      const selectTask = useCallback((taskId) => {
        setActiveTaskId(taskId || '')
        setSnapshot(null)
        setPreview(null)
        setPreviewError('')
        setError('')
        previewKeyRef.current = ''
        try {
          if (taskId) localStorage.setItem(activeKey(sessionId), taskId)
          else localStorage.removeItem(activeKey(sessionId))
        } catch { /* ignore */ }
      }, [sessionId])

      // Poll the selected task. DSH supplies the turn; this view only polls
      // the local sidecar for durable task state.
      useEffect(() => {
        if (!auth.authenticated || !activeTaskId) return
        let cancelled = false
        let timer = null
        let failures = 0
        const tick = async () => {
          if (cancelled) return
          try {
            const result = await agentApi(`/api/tasks/${encodeURIComponent(activeTaskId)}`)
            if (cancelled) return
            failures = 0
            setSnapshot(result)
            setError('')
            rememberTask({ taskId: result.taskId, title: result.title, state: result.state })
            const terminal = ['PRESENT', 'COMPLETE', 'FAILED', 'CANCELLED'].includes(result.state)
            if (!terminal && !result.pendingQuestion) timer = setTimeout(tick, 1600)
          } catch (failure) {
            if (cancelled) return
            failures += 1
            setError(failure.message)
            const code = failure.code || ''
            if (code === 'AUTH_REQUIRED' || code === 'AUTH_FAILED' || failure.status === 401) {
              emitAuth({ authenticated: false, user: null, expired: true })
              return
            }
            if (failures < 5) timer = setTimeout(tick, Math.min(8000, 1500 * failures))
          }
        }
        setLoading(true)
        tick().finally(() => { if (!cancelled) setLoading(false) })
        return () => { cancelled = true; if (timer) clearTimeout(timer) }
      }, [auth.authenticated, activeTaskId, refreshNonce])

      // Fetch the rendered SVG for the selected/verified plan.
      const renderedIds = useMemo(() => {
        const artifacts = snapshot?.planArtifacts ?? {}
        return Object.keys(artifacts).filter((id) => artifacts[id]?.svgBytes || artifacts[id]?.png)
      }, [snapshot?.planArtifacts])
      const previewPlanId = snapshot?.selectedPlanId || renderedIds[0] || ''
      const planVersion = snapshot?.eventSeq ?? snapshot?.plansVersion ?? snapshot?.currentRevision ?? 0

      useEffect(() => {
        if (!auth.authenticated || !snapshot?.taskId || !previewPlanId) return
        const key = `${snapshot.taskId}:${previewPlanId}:${planVersion}`
        if (previewKeyRef.current === key && preview?.url) return
        let cancelled = false
        setPreviewLoading(true)
        setPreviewError('')
        ;(async () => {
          try {
            const result = await agentApi(`/api/tasks/${encodeURIComponent(snapshot.taskId)}/preview?planId=${encodeURIComponent(previewPlanId)}`)
            if (cancelled || !result?.svg) return
            const blob = new Blob([result.svg], { type: 'image/svg+xml' })
            const url = URL.createObjectURL(blob)
            if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
            previewUrlRef.current = url
            previewKeyRef.current = key
            setPreview({ url, planId: result.planId, width: result.width, height: result.height, engine: result.engine, verification: result.verification })
          } catch (failure) {
            if (!cancelled) setPreviewError(failure.status === 404 ? '' : failure.message)
          } finally {
            if (!cancelled) setPreviewLoading(false)
          }
        })()
        return () => { cancelled = true }
      }, [auth.authenticated, snapshot?.taskId, previewPlanId, planVersion])

      useEffect(() => () => {
        if (previewUrlRef.current) URL.revokeObjectURL(previewUrlRef.current)
      }, [])

      const run = async (kind, action) => {
        setBusy(kind)
        setError('')
        try { await action() } catch (failure) {
          if (failure.code === 'AUTH_REQUIRED' || failure.status === 401) {
            emitAuth({ authenticated: false, user: null, expired: true })
            setLoginOpen(true)
          } else {
            setError(failure.message)
          }
        } finally {
          setBusy('')
        }
      }

      const answer = (text) => run('answer', async () => {
        await agentApi(`/api/tasks/${encodeURIComponent(snapshot.taskId)}/answer`, { method: 'POST', body: { answer: String(text) } })
        setRefreshNonce((value) => value + 1)
      })

      const selectPlan = (planId) => run(`select:${planId}`, async () => {
        await agentApi(`/api/tasks/${encodeURIComponent(snapshot.taskId)}/select`, { method: 'POST', body: { planId } })
        setRefreshNonce((value) => value + 1)
      })

      const feedback = (text) => run('feedback', async () => {
        await agentApi(`/api/tasks/${encodeURIComponent(snapshot.taskId)}/feedback`, { method: 'POST', body: { feedback: String(text), kind: 'manual_edit' } })
        setRefreshNonce((value) => value + 1)
      })

      const complete = () => run('complete', async () => {
        await agentApi(`/api/tasks/${encodeURIComponent(snapshot.taskId)}/complete`, { method: 'POST', body: {} })
        setRefreshNonce((value) => value + 1)
      })

      const exportZip = () => run('export', async () => {
        const params = new URLSearchParams({
          taskId: snapshot.taskId,
          formats: settings.formats.join(','),
          dpi: String(settings.dpi),
          transparent: settings.transparent ? 'true' : 'false',
          includeCode: settings.includeCode ? 'true' : 'false',
          includeData: settings.includeData ? 'true' : 'false',
        })
        if (snapshot.selectedPlanId) params.set('planId', snapshot.selectedPlanId)
        const anchor = document.createElement('a')
        anchor.href = `/api/sparksight/export?${params}`
        anchor.download = ''
        document.body.appendChild(anchor)
        anchor.click()
        anchor.remove()
      })

      const openWorkbench = async () => {
        try {
          const data = await hostJson('/api/sparksight/stage')
          if (data.ready && data.webUrl) setStageUrl(data.webUrl)
          else throw new Error(t('stage.failed'))
        } catch (failure) {
          setError(failure.message)
        }
      }

      const onCreated = ({ taskId, snapshot: created }) => {
        rememberTask({ taskId, title: created?.title, state: created?.state })
        selectTask(taskId)
        if (created) setSnapshot(created)
        setPanelTab('task')
      }

      const shownTasks = showAllTasks ? tasks : tasks.slice(0, 4)

      return h('section', { className: 'ss-root' },
        h('header', { className: 'ss-head' },
          h('div', { className: 'ss-title' },
            h('span', { className: 'ss-logo' }, h(SparkGlyph, { size: 17 })),
            h('div', null,
              h('strong', null, 'SPARK SIGHT'),
              h('span', null, t('view.subtitle'))),
            enabled ? h('span', { className: 'ss-pill ss-pill-on' }, t('toggle.on')) : null),
          h('div', { className: 'ss-head-actions' },
            h(StatusPill, { snapshot, loading }),
            h('select', {
              className: 'ss-task-select',
              value: activeTaskId,
              onChange: (event) => selectTask(event.target.value),
              title: t('task.history'),
            },
              h('option', { value: '' }, t('task.new')),
              tasks.map((task) => h('option', { key: task.taskId, value: task.taskId }, `${task.title || task.taskId} · ${task.state || ''}`))),
            h('button', { type: 'button', className: 'ss-icon-btn', title: t('task.refresh'), onClick: () => setRefreshNonce((value) => value + 1) }, h(Icon, { name: 'refresh' })),
            h('button', { type: 'button', className: 'ss-ghost ss-small', onClick: openWorkbench }, t('stage.open')),
            h('button', { type: 'button', className: `ss-icon-btn ${panelTab === 'settings' ? 'is-active' : ''}`, title: t('settings.tab.settings'), onClick: () => setPanelTab(panelTab === 'settings' ? 'task' : 'settings') }, h(Icon, { name: 'settings' })))),
        h('div', { className: 'ss-body' },
          h('main', { className: 'ss-canvas' },
            !auth.authenticated
              ? h(LoginGate, { onLogin: () => setLoginOpen(true) })
              : !enabled
                ? h(DisabledGate, { onEnable: () => setEnabled(true) })
                : !activeTaskId
                  ? h(NewTaskForm, { auth, onCreated, onLogin: () => setLoginOpen(true) })
                  : h(React.Fragment, null,
                  h('div', { className: 'ss-taskbar' },
                    h('div', { className: 'ss-taskbar-title' },
                      h('strong', null, snapshot?.title || t('task.id')),
                      h('span', { className: 'ss-mono' }, activeTaskId)),
                    h('div', { className: 'ss-taskbar-actions' },
                      h('button', { type: 'button', className: 'ss-ghost ss-small', onClick: () => selectTask('') }, t('task.new')),
                      h('button', { type: 'button', className: 'ss-ghost ss-small', onClick: () => setRefreshNonce((value) => value + 1) }, t('common.refresh')))),
                  h('div', { className: 'ss-stage-area' },
                    h(PreviewPane, {
                      snapshot,
                      preview,
                      loading: previewLoading,
                      error: previewError,
                      activePlanId: previewPlanId,
                      onSelect: selectPlan,
                    }),
                    snapshot?.pendingQuestion ? h(ClarifyCard, { question: snapshot.pendingQuestion, onSubmit: answer, busy: busy === 'answer' }) : null,
                    error ? h('div', { className: 'ss-error ss-error-block' }, h(Icon, { name: 'alert', size: 14 }), h('span', null, error)) : null))),
          h('aside', { className: 'ss-side' },
            h('div', { className: 'ss-tabs' },
              h('button', { type: 'button', className: panelTab === 'task' ? 'is-active' : '', onClick: () => setPanelTab('task') }, t('settings.tab.task')),
              h('button', { type: 'button', className: panelTab === 'settings' ? 'is-active' : '', onClick: () => setPanelTab('settings') }, t('settings.tab.settings'))),
            panelTab === 'task'
              ? h(TaskPanel, {
                snapshot,
                busy,
                onAnswer: answer,
                onSelect: selectPlan,
                onFeedback: feedback,
                onComplete: complete,
                onExport: exportZip,
                onRefresh: () => setRefreshNonce((value) => value + 1),
              })
              : h(SettingsPanel, {
                auth,
                settings,
                onChange: updateSettings,
                onLogout: () => { logout(); selectTask('') },
                onOpenWorkbench: openWorkbench,
                onLogin: () => setLoginOpen(true),
              }),
            tasks.length > 0 ? h('div', { className: 'ss-recent' },
              h('div', { className: 'ss-recent-head' },
                h('span', null, t('task.history')),
                tasks.length > 4 ? h('button', { type: 'button', className: 'ss-link', onClick: () => setShowAllTasks(!showAllTasks) }, showAllTasks ? t('common.close') : t('common.more')) : null),
              shownTasks.map((task) => h('button', {
                key: task.taskId,
                type: 'button',
                className: `ss-recent-item ${task.taskId === activeTaskId ? 'is-active' : ''}`,
                onClick: () => selectTask(task.taskId),
              },
                h('span', { className: 'ss-recent-title' }, task.title || task.taskId),
                h('span', { className: 'ss-recent-state' }, task.state || '')))) : null)),
        h(LoginDialog, {
          open: loginOpen,
          onClose: () => setLoginOpen(false),
          onAuthenticated: () => setEnabled(true),
          reason: t('auth.loginRequired'),
        }),
        stageUrl ? h(StageOverlay, { webUrl: stageUrl, onClose: () => setStageUrl('') }) : null)
    }

    // ---------------------------------------------------------------------
    // styles
    // ---------------------------------------------------------------------

    const CSS = `
      .ss-root { display:flex; flex-direction:column; height:100%; min-height:0; color:${TOKENS.text}; background:${TOKENS.bg}; font-size:13px; }
      .ss-root * { box-sizing:border-box; }
      .ss-head { display:flex; align-items:center; justify-content:space-between; gap:12px; padding:10px 14px; border-bottom:1px solid ${TOKENS.borderSoft}; flex:none; min-height:46px; }
      .ss-title { display:flex; align-items:center; gap:9px; min-width:0; }
      .ss-title > div { display:flex; flex-direction:column; line-height:1.15; min-width:0; }
      .ss-title strong { font-size:13px; font-weight:650; letter-spacing:.2px; }
      .ss-title span { font-size:11px; color:${TOKENS.tertiary}; }
      .ss-logo { width:28px; height:28px; border-radius:8px; display:flex; align-items:center; justify-content:center; background:rgba(42,157,143,.10); border:1px solid rgba(42,157,143,.22); flex:none; }
      .ss-head-actions { display:flex; align-items:center; gap:6px; flex-wrap:wrap; justify-content:flex-end; }
      .ss-body { display:flex; flex:1; min-height:0; }
      .ss-canvas { display:flex; flex-direction:column; flex:1; min-width:0; min-height:0; padding:12px 14px 14px; gap:10px; overflow:auto; }
      .ss-side { width:330px; flex:none; border-left:1px solid ${TOKENS.borderSoft}; background:${TOKENS.module}; display:flex; flex-direction:column; min-height:0; overflow:auto; }
      .ss-tabs { display:flex; gap:4px; padding:8px 10px 0; flex:none; position:sticky; top:0; background:${TOKENS.module}; z-index:2; }
      .ss-tabs button { flex:1; border:0; background:transparent; color:${TOKENS.secondary}; font-size:12px; padding:7px 8px; border-radius:7px; cursor:pointer; }
      .ss-tabs button:hover { background:${TOKENS.hover}; }
      .ss-tabs button.is-active { background:${TOKENS.bg}; color:${TOKENS.text}; box-shadow:0 0 0 1px ${TOKENS.borderSoft}; font-weight:600; }
      .ss-panel { padding:12px; display:flex; flex-direction:column; gap:8px; }
      .ss-panel-empty { padding:28px 16px; color:${TOKENS.tertiary}; text-align:center; font-size:12px; }
      .ss-kv { display:grid; grid-template-columns:auto 1fr; gap:5px 10px; font-size:12px; align-items:center; }
      .ss-kv span { color:${TOKENS.tertiary}; }
      .ss-kv b { font-weight:550; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .ss-kv-tight { margin-top:2px; }
      .ss-mono { font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size:11px; }
      .ss-muted { color:${TOKENS.tertiary}; }
      .ss-small-text { font-size:11px; }
      .ss-ok { color:${TEAL_DARK}; }
      .ss-warn { color:#B7791F; }
      .ss-error { color:${ERROR}; font-size:12px; display:flex; align-items:flex-start; gap:6px; line-height:1.45; }
      .ss-error-block { padding:9px 11px; border:1px solid rgba(192,57,43,.22); background:rgba(192,57,43,.06); border-radius:8px; }
      .ss-spinner { display:inline-block; border:2px solid currentColor; border-right-color:transparent; border-radius:50%; animation:ss-spin .8s linear infinite; flex:none; }
      @keyframes ss-spin { to { transform:rotate(360deg); } }
      .ss-pill { display:inline-flex; align-items:center; gap:5px; height:22px; padding:0 8px; border-radius:11px; font-size:11px; background:${TOKENS.hover}; color:${TOKENS.secondary}; border:1px solid transparent; white-space:nowrap; }
      .ss-pill-on { background:rgba(42,157,143,.10); color:${TEAL_DARK}; border-color:rgba(42,157,143,.22); }
      .ss-pill-busy { color:#2C6E9B; background:rgba(44,110,155,.08); }
      .ss-pill-warn { color:#9A6700; background:rgba(183,121,31,.10); }
      .ss-pill-error { color:${ERROR}; background:rgba(192,57,43,.07); }
      .ss-pill-done { color:${TEAL_DARK}; background:rgba(42,157,143,.10); }
      .ss-dot { width:6px; height:6px; border-radius:50%; background:currentColor; flex:none; }
      .ss-icon-btn { width:28px; height:28px; border:1px solid transparent; background:transparent; color:${TOKENS.secondary}; border-radius:7px; display:inline-flex; align-items:center; justify-content:center; cursor:pointer; padding:0; }
      .ss-icon-btn:hover { background:${TOKENS.hover}; color:${TOKENS.text}; }
      .ss-icon-btn.is-active { background:${TOKENS.hoverSolid}; color:${TOKENS.text}; }
      .ss-ghost, .ss-secondary, .ss-primary { display:inline-flex; align-items:center; justify-content:center; gap:6px; height:28px; padding:0 10px; border-radius:7px; font-size:12px; cursor:pointer; white-space:nowrap; border:1px solid transparent; }
      .ss-ghost { background:transparent; color:${TOKENS.secondary}; }
      .ss-ghost:hover { background:${TOKENS.hover}; color:${TOKENS.text}; }
      .ss-secondary { background:${TOKENS.bg}; border-color:${TOKENS.border}; color:${TOKENS.text}; }
      .ss-secondary:hover { background:${TOKENS.hover}; }
      .ss-primary { background:${TOKENS.primary}; color:#fff; border-color:transparent; font-weight:550; }
      .ss-primary:hover { background:${TOKENS.primaryHover}; }
      .ss-primary:disabled, .ss-secondary:disabled, .ss-ghost:disabled { opacity:.45; cursor:not-allowed; }
      .ss-small { height:26px; font-size:11px; padding:0 8px; }
      .ss-block { width:100%; }
      .ss-top-gap { margin-top:4px; }
      .ss-row { display:flex; align-items:center; gap:8px; }
      .ss-row-between { justify-content:space-between; }
      .ss-row-end { justify-content:flex-end; }
      .ss-row-wrap { flex-wrap:wrap; }
      .ss-task-select { height:28px; max-width:220px; border:1px solid ${TOKENS.border}; background:${TOKENS.bg}; color:${TOKENS.text}; border-radius:7px; font-size:11px; padding:0 6px; min-width:120px; }
      .ss-field { display:flex; flex-direction:column; gap:5px; font-size:11px; color:${TOKENS.secondary}; }
      .ss-field input, .ss-field textarea, .ss-field select, .ss-panel textarea { width:100%; border:1px solid ${TOKENS.border}; background:${TOKENS.bg}; color:${TOKENS.text}; border-radius:7px; padding:7px 8px; font-size:12px; font-family:inherit; outline:none; }
      .ss-field input:focus, .ss-field textarea:focus, .ss-field select:focus, .ss-panel textarea:focus { border-color:${TEAL}; box-shadow:0 0 0 2px rgba(42,157,143,.12); }
      .ss-field-inline { flex-direction:row; align-items:center; gap:8px; flex:1; }
      .ss-field-inline select, .ss-field-inline input { width:auto; flex:1; min-width:0; }
      .ss-check { display:flex; align-items:flex-start; gap:7px; font-size:11px; color:${TOKENS.secondary}; line-height:1.4; cursor:pointer; }
      .ss-check input { margin-top:1px; accent-color:${TEAL}; }
      .ss-section-title { font-size:11px; font-weight:650; color:${TOKENS.tertiary}; letter-spacing:.3px; text-transform:uppercase; }
      .ss-section { display:flex; flex-direction:column; gap:6px; }
      .ss-plans { display:flex; flex-direction:column; gap:6px; }
      .ss-plan { border:1px solid ${TOKENS.border}; background:${TOKENS.bg}; border-radius:9px; padding:8px 9px; display:flex; flex-direction:column; gap:6px; }
      .ss-plan.is-selected { border-color:rgba(42,157,143,.55); box-shadow:0 0 0 1px rgba(42,157,143,.15); }
      .ss-plan-head { display:flex; align-items:flex-start; justify-content:space-between; gap:8px; }
      .ss-plan-name { display:flex; flex-direction:column; min-width:0; }
      .ss-plan-name strong { font-size:12px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .ss-plan-name span { font-size:10px; color:${TOKENS.caption}; font-family:ui-monospace, monospace; }
      .ss-plan-why { margin:0; font-size:11px; color:${TOKENS.secondary}; line-height:1.45; display:-webkit-box; -webkit-line-clamp:3; -webkit-box-orient:vertical; overflow:hidden; }
      .ss-plan-foot { display:flex; align-items:center; justify-content:space-between; gap:8px; }
      .ss-plan-foot .ss-mono, .ss-plan-foot > span { color:${TOKENS.caption}; font-size:10px; }
      .ss-badge { font-size:10px; padding:2px 6px; border-radius:5px; background:${TOKENS.hover}; color:${TOKENS.tertiary}; white-space:nowrap; }
      .ss-badge.is-ok { background:rgba(42,157,143,.12); color:${TEAL_DARK}; }
      .ss-badge.is-info { background:rgba(44,110,155,.10); color:#2C6E9B; }
      .ss-badge.is-error { background:rgba(192,57,43,.10); color:${ERROR}; }
      .ss-taskbar { display:flex; align-items:center; justify-content:space-between; gap:10px; flex:none; }
      .ss-taskbar-title { display:flex; flex-direction:column; min-width:0; }
      .ss-taskbar-title strong { font-size:13px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .ss-taskbar-title span { color:${TOKENS.caption}; }
      .ss-taskbar-actions { display:flex; gap:4px; }
      .ss-stage-area { flex:1; min-height:280px; display:flex; flex-direction:column; gap:10px; }
      .ss-preview-wrap { display:flex; flex-direction:column; flex:1; min-height:0; gap:6px; }
      .ss-preview-toolbar { display:flex; align-items:center; justify-content:space-between; gap:8px; }
      .ss-preview-title { font-size:11px; font-weight:650; color:${TOKENS.tertiary}; letter-spacing:.3px; text-transform:uppercase; }
      .ss-preview-meta { font-size:10px; color:${TOKENS.caption}; }
      .ss-preview-paper { flex:1; min-height:240px; border:1px solid ${TOKENS.border}; border-radius:10px; background:#fff; display:flex; align-items:center; justify-content:center; overflow:auto; padding:10px; }
      .ss-preview-img { max-width:100%; max-height:100%; object-fit:contain; display:block; }
      .ss-preview-plans { display:flex; gap:5px; overflow-x:auto; padding-bottom:2px; }
      .ss-plan-chip { flex:none; border:1px solid ${TOKENS.border}; background:${TOKENS.bg}; color:${TOKENS.secondary}; font-size:10px; height:24px; padding:0 8px; border-radius:12px; cursor:pointer; max-width:160px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .ss-plan-chip.is-selected { border-color:rgba(42,157,143,.55); color:${TEAL_DARK}; background:rgba(42,157,143,.08); }
      .ss-preview-empty { flex:1; min-height:240px; border:1px dashed ${TOKENS.border}; border-radius:10px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:8px; color:${TOKENS.tertiary}; text-align:center; padding:24px; background:${TOKENS.module}; }
      .ss-preview-empty strong { color:${TOKENS.secondary}; font-size:12px; font-weight:550; }
      .ss-clarify { border:1px solid rgba(183,121,31,.30); background:rgba(183,121,31,.06); border-radius:9px; padding:10px; display:flex; flex-direction:column; gap:7px; flex:none; }
      .ss-clarify-head { display:flex; align-items:center; gap:6px; color:#9A6700; font-size:12px; }
      .ss-clarify p { margin:0; font-size:12px; color:${TOKENS.text}; line-height:1.5; }
      .ss-clarify textarea { width:100%; border:1px solid rgba(183,121,31,.25); background:${TOKENS.bg}; border-radius:7px; padding:7px 8px; font-family:inherit; font-size:12px; color:${TOKENS.text}; }
      .ss-option-grid { display:flex; flex-wrap:wrap; gap:5px; }
      .ss-option { border:1px solid ${TOKENS.border}; background:${TOKENS.bg}; color:${TOKENS.text}; border-radius:6px; padding:5px 8px; font-size:11px; cursor:pointer; text-align:left; }
      .ss-option:hover { border-color:${TEAL}; color:${TEAL_DARK}; }
      .ss-gate { flex:1; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; gap:10px; padding:30px; border:1px dashed ${TOKENS.border}; border-radius:12px; background:${TOKENS.module}; }
      .ss-gate-icon { width:52px; height:52px; border-radius:15px; display:flex; align-items:center; justify-content:center; background:rgba(42,157,143,.10); border:1px solid rgba(42,157,143,.20); }
      .ss-gate h3 { margin:0; font-size:15px; }
      .ss-gate p { margin:0; max-width:440px; color:${TOKENS.secondary}; font-size:12px; line-height:1.6; }
      .ss-new { display:flex; flex-direction:column; gap:11px; max-width:680px; width:100%; margin:0 auto; padding:8px 0 20px; }
      .ss-new-head h3 { margin:0 0 5px; font-size:16px; }
      .ss-new-head p { margin:0; color:${TOKENS.secondary}; font-size:12px; line-height:1.6; }
      .ss-drop { border:1.5px dashed ${TOKENS.border}; border-radius:10px; min-height:104px; display:flex; flex-direction:column; align-items:center; justify-content:center; gap:6px; cursor:pointer; color:${TOKENS.secondary}; background:${TOKENS.module}; padding:14px; text-align:center; transition:border-color .15s, background .15s; }
      .ss-drop:hover, .ss-drop.is-dragging { border-color:${TEAL}; background:rgba(42,157,143,.05); color:${TEAL_DARK}; }
      .ss-drop strong { font-size:12px; font-weight:550; }
      .ss-drop span { font-size:10px; color:${TOKENS.caption}; }
      .ss-chips { display:flex; gap:5px; flex-wrap:wrap; }
      .ss-chip { height:25px; padding:0 9px; border-radius:12px; border:1px solid ${TOKENS.border}; background:${TOKENS.bg}; color:${TOKENS.secondary}; font-size:10px; cursor:pointer; }
      .ss-chip.is-selected { border-color:rgba(42,157,143,.55); color:${TEAL_DARK}; background:rgba(42,157,143,.08); }
      .ss-account { display:flex; align-items:center; gap:8px; }
      .ss-account > div:last-child { display:flex; flex-direction:column; min-width:0; }
      .ss-account strong { font-size:12px; font-weight:600; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .ss-account span { font-size:10px; color:${TOKENS.tertiary}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .ss-avatar { width:30px; height:30px; border-radius:50%; background:rgba(42,157,143,.12); color:${TEAL_DARK}; display:flex; align-items:center; justify-content:center; font-weight:700; font-size:12px; flex:none; }
      .ss-fineprint { margin:0; font-size:10px; line-height:1.5; color:${TOKENS.caption}; }
      .ss-link { border:0; background:transparent; color:${TEAL_DARK}; font-size:10px; cursor:pointer; padding:0; }
      .ss-recent { border-top:1px solid ${TOKENS.borderSoft}; padding:10px 12px 14px; display:flex; flex-direction:column; gap:4px; flex:none; }
      .ss-recent-head { display:flex; align-items:center; justify-content:space-between; font-size:10px; text-transform:uppercase; letter-spacing:.3px; color:${TOKENS.caption}; margin-bottom:2px; }
      .ss-recent-item { border:0; background:transparent; text-align:left; padding:5px 7px; border-radius:6px; cursor:pointer; display:flex; flex-direction:column; gap:1px; min-width:0; }
      .ss-recent-item:hover { background:${TOKENS.hover}; }
      .ss-recent-item.is-active { background:${TOKENS.bg}; box-shadow:0 0 0 1px ${TOKENS.borderSoft}; }
      .ss-recent-title { font-size:11px; color:${TOKENS.text}; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
      .ss-recent-state { font-size:9px; color:${TOKENS.caption}; }
      .ss-toggle { height:26px; display:inline-flex; align-items:center; gap:6px; padding:0 7px 0 8px; border:1px solid ${TOKENS.border}; border-radius:13px; background:transparent; color:${TOKENS.secondary}; font-size:11px; cursor:pointer; line-height:1; white-space:nowrap; }
      .ss-toggle:hover { background:${TOKENS.hover}; color:${TOKENS.text}; }
      .ss-toggle.is-on { border-color:rgba(42,157,143,.42); background:rgba(42,157,143,.08); color:${TEAL_DARK}; }
      .ss-toggle-label { font-weight:550; }
      .ss-switch { width:24px; height:13px; border-radius:7px; background:${TOKENS.hoverSolid}; position:relative; display:inline-block; flex:none; transition:background .15s; }
      .ss-switch-knob { position:absolute; top:2px; left:2px; width:9px; height:9px; border-radius:50%; background:#fff; box-shadow:0 1px 2px rgba(0,0,0,.25); transition:transform .15s; }
      .ss-toggle.is-on .ss-switch { background:${TEAL}; }
      .ss-toggle.is-on .ss-switch-knob { transform:translateX(11px); }
      .ss-modal-backdrop { position:fixed; inset:0; z-index:9999; background:rgba(9,20,30,.48); display:flex; align-items:center; justify-content:center; padding:18px; }
      .ss-modal { width:min(400px, 96vw); background:${TOKENS.bg}; color:${TOKENS.text}; border-radius:14px; box-shadow:0 22px 70px rgba(0,0,0,.28); border:1px solid ${TOKENS.border}; overflow:hidden; }
      .ss-modal-head { display:flex; align-items:flex-start; justify-content:space-between; gap:10px; padding:16px 16px 10px; }
      .ss-brand { display:flex; align-items:flex-start; gap:9px; }
      .ss-brand > div { display:flex; flex-direction:column; gap:3px; }
      .ss-brand strong { font-size:14px; font-weight:650; }
      .ss-brand span { font-size:11px; color:${TOKENS.tertiary}; line-height:1.4; }
      .ss-segmented { display:flex; gap:3px; margin:0 16px; padding:3px; background:${TOKENS.module}; border-radius:8px; }
      .ss-segmented button { flex:1; border:0; background:transparent; padding:6px; border-radius:6px; color:${TOKENS.secondary}; font-size:12px; cursor:pointer; }
      .ss-segmented button.is-active { background:${TOKENS.bg}; color:${TOKENS.text}; font-weight:600; box-shadow:0 1px 2px rgba(0,0,0,.08); }
      .ss-form { display:flex; flex-direction:column; gap:9px; padding:12px 16px 4px; }
      .ss-modal-actions { display:flex; flex-direction:column; gap:6px; padding:4px 16px 14px; }
      .ss-divider { display:flex; align-items:center; gap:8px; margin:4px 16px; color:${TOKENS.caption}; font-size:10px; }
      .ss-divider::before, .ss-divider::after { content:""; height:1px; background:${TOKENS.borderSoft}; flex:1; }
      .ss-stage-backdrop { position:fixed; inset:0; z-index:9998; background:rgba(9,20,30,.55); display:flex; flex-direction:column; padding:clamp(8px,2vw,28px); }
      .ss-stage { flex:1; min-height:0; background:${TOKENS.bg}; border-radius:12px; overflow:hidden; display:flex; flex-direction:column; box-shadow:0 24px 80px rgba(0,0,0,.35); }
      .ss-stage-head { display:flex; align-items:center; justify-content:space-between; padding:8px 12px; border-bottom:1px solid ${TOKENS.borderSoft}; flex:none; }
      .ss-stage-frame { flex:1; width:100%; border:0; background:#fff; }
      @media (max-width: 920px) {
        .ss-body { flex-direction:column; }
        .ss-side { width:auto; border-left:0; border-top:1px solid ${TOKENS.borderSoft}; max-height:42%; }
        .ss-head { align-items:flex-start; flex-direction:column; }
        .ss-head-actions { justify-content:flex-start; }
      }
      @media (max-width: 560px) {
        .ss-toggle-label { display:none; }
        .ss-task-select { max-width:140px; }
        .ss-canvas { padding:10px; }
      }
    `

    // ---------------------------------------------------------------------
    // plugin registration
    // ---------------------------------------------------------------------

    function ViewBuilder() {
      const snapshot = Object.freeze({ target: 'sparksight' })
      return {
        replace: () => snapshot,
        apply: () => snapshot,
      }
    }

    return {
      inject: ['slots', 'uiConversation', 'locale'],
      apply(ctx) {
        try {
          const dictionaries = { zh: ZH, en: EN }
          if (ctx.locale?.register) {
            ctx.effect(() => ctx.locale.register(NS, dictionaries), 'sparksight-dsh: locale')
            translate = ctx.locale.bind(NS)
          }
        } catch {
          translate = fallbackT
        }

        ctx.effect(() => {
          const style = document.createElement('style')
          style.id = 'sparksight-dsh-styles'
          style.textContent = CSS
          document.head.appendChild(style)
          return () => style.remove()
        }, 'sparksight-dsh: styles')

        // A real Conversation target, so the tab sits beside Chat and
        // Trajectory and participates in the normal view ring.
        try {
          ctx.effect(
            () => ctx.uiConversation.views.register({ target: 'sparksight', create: () => ViewBuilder() }),
            'sparksight-dsh: conversation view'
          )
        } catch (error) {
          console.warn('[sparksight-dsh] could not register conversation view', error)
        }

        ctx.slots.inject('conversation.view', () => ctx.slots.register({
          name: 'conversation.view',
          id: 'sparksight',
          order: 15,
          locale: NS,
          label: () => t('view.label'),
          inject: (sessionId) => ({ sessionId }),
        }, SparkView))

        ctx.slots.inject('conversation.input.right', () => ctx.slots.register({
          name: 'conversation.input.right',
          id: 'sparksight-toggle',
          order: 20,
          locale: NS,
        }, SparkToggle))
      },
    }
  },
})
