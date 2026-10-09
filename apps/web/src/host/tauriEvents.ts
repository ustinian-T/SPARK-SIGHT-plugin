/**
 * 桌面端 Tauri 事件监听注册模块（P1-3）
 *
 * 背景：Rust 端已经在发出三个事件，但 Web 前端此前零监听：
 *   1. `deep-imaging://open-files` —— 双击关联文件 / 带参启动时发出（lib.rs 第 33/168 行），
 *      Rust 侧 payload 为 `Vec<String>`（纯路径数组）。
 *   2. `tauri://drag-drop` —— tauri.conf.json 中 `dragDropEnabled=true`，Tauri 拦截 HTML5
 *      原生拖放后改投此事件（Tauri v2 内置）。
 *   3. `deep-imaging://open-diff` —— 外部请求打开 Diff 视图时发出（lib.rs 第 84/101 行）。
 *
 * 本模块只负责“注册监听 + 扩展名过滤 + 回调派发”，不直接触碰业务 store；
 * 真正把路径送入上传/建任务链路的逻辑由 App.tsx 注入的回调完成。
 *
 * 关于 listen 的获取方式（重要取舍）：
 *   本工程未把 `@tauri-apps/api` 声明为 npm 依赖；tauri.conf.json 已开启
 *   `withGlobalTauri: true`，Tauri 运行时会在 webview 全局注入 `window.__TAURI__`
 *   （现有 host/bridge.ts 即通过 `window.__TAURI__.core.invoke` 与 Rust 通信）。
 *   因此这里**不**写成 `await import('@tauri-apps/api/event')`：那样 Vite/Rollup 会在
 *   纯 Web 构建期静态解析该模块路径，因包未安装而直接构建失败。改为惰性读取
 *   `window.__TAURI__.event.listen`，对纯 Web 浏览器零负担、对 Tauri 运行时等价生效。
 */

/** Tauri listen 返回的反注册函数签名 */
type UnlistenFn = () => void

/** Tauri v2 事件包络：{ event, id, payload } */
interface TauriEvent<T> {
  event: string
  id: number
  payload: T
}

/** window.__TAURI__ 上我们用到的最小形状（与 host/types.ts 中的 core.invoke 并列） */
interface TauriGlobalEvent {
  listen?: <T>(event: string, handler: (event: TauriEvent<T>) => void) => Promise<UnlistenFn>
}

interface TauriGlobal {
  event?: TauriGlobalEvent
}

/**
 * `deep-imaging://open-files` 的 payload 形状：
 *   - Rust 端实际发出 `string[]`（Vec<String>）；
 *   - 同时兼容 `{ paths: string[] }` 这种对象形状，以防未来后端包装。
 */
type OpenFilesPayload = string[] | { paths?: unknown }

/**
 * `tauri://drag-drop` 的 payload（Tauri v2 内置）：
 *   type: enter / over / leave / drop（仅 drop 表示文件已真正放下）
 *   paths: 被拖入的绝对路径列表
 *   position: 拖放落点坐标
 */
interface DragDropPayload {
  type?: 'enter' | 'over' | 'leave' | 'drop'
  paths?: string[]
  position?: { x: number; y: number }
}

/** 允许进入上传/建任务链路的扩展名（与 Rust desktop_open_files / fileAssociations 保持一致） */
const ALLOWED_EXTENSIONS = ['csv', 'xlsx', 'json', 'dimg']

/**
 * 判断当前是否运行在 Tauri webview 内。
 * Tauri v2 同时存在 `window.__TAURI_INTERNALS__`；`withGlobalTauri:true` 还会注入 `window.__TAURI__`。
 * 纯 Web 浏览器（含 Vite dev）两者皆无，直接走 no-op，绝不抛错。
 */
function hasTauriRuntime(): boolean {
  return (
    typeof window !== 'undefined' &&
    ('__TAURI_INTERNALS__' in window || !!window.__TAURI__)
  )
}

/** 按扩展名白名单过滤单个路径（大小写不敏感） */
function isAllowedFile(path: string): boolean {
  if (typeof path !== 'string' || path.length === 0) return false
  const dot = path.lastIndexOf('.')
  if (dot < 0 || dot === path.length - 1) return false
  const ext = path.slice(dot + 1).toLowerCase()
  return ALLOWED_EXTENSIONS.includes(ext)
}

/**
 * 从 open-files 事件 payload 中提取路径数组。
 * 兼容 `string[]` 与 `{ paths: string[] }` 两种形状，并二次过滤扩展名。
 */
function extractOpenFilesPaths(payload: OpenFilesPayload): string[] {
  let raw: unknown = payload
  // 对象形状：{ paths: [...] }
  if (raw && typeof raw === 'object' && !Array.isArray(raw) && 'paths' in (raw as Record<string, unknown>)) {
    raw = (raw as Record<string, unknown>).paths
  }
  if (!Array.isArray(raw)) return []
  return raw.filter((p): p is string => typeof p === 'string' && isAllowedFile(p))
}

/**
 * 注册桌面端文件相关 Tauri 事件监听。
 *
 * @param onFiles 收到合法文件路径列表后的回调（open-files / drag-drop 共用）
 * @param onDiff  收到 open-diff 请求后的回调
 * @returns       反注册函数：调用后移除全部监听；非 Tauri 环境返回 no-op
 *
 * 任何单个监听注册失败都只 console.warn，不影响其余监听、不崩溃。
 */
export async function registerTauriFileEvents(
  onFiles: (paths: string[]) => void,
  onDiff: (payload: unknown) => void
): Promise<UnlistenFn> {
  const noop: UnlistenFn = () => {}

  // 非 Tauri 环境（纯浏览器 / Vite 开发页）：直接返回 no-op，避免在 Web 端做无意义注册。
  if (!hasTauriRuntime()) return noop

  const tauri = (window as unknown as { __TAURI__?: TauriGlobal }).__TAURI__
  const listen = tauri?.event?.listen
  if (typeof listen !== 'function') {
    console.warn('[tauri-events] 检测到 Tauri 运行时，但 window.__TAURI__.event.listen 不可用，跳过文件事件注册')
    return noop
  }

  const unlisteners: UnlistenFn[] = []

  // 1) deep-imaging://open-files：双击关联文件 / 启动带参打开
  try {
    const unlisten = await listen<OpenFilesPayload>('deep-imaging://open-files', (event) => {
      const paths = extractOpenFilesPaths(event.payload)
      if (paths.length === 0) return
      try {
        onFiles(paths)
      } catch (error) {
        console.warn('[tauri-events] onFiles 回调执行抛错', error)
      }
    })
    unlisteners.push(unlisten)
  } catch (error) {
    console.warn('[tauri-events] 监听 deep-imaging://open-files 失败', error)
  }

  // 2) tauri://drag-drop：Tauri 拦截原生拖放后投递（仅在 type==='drop' 时响应）
  //
  //    dragDropEnabled 取舍说明：
  //      - tauri.conf.json 当前 dragDropEnabled=true，Tauri 会拦截 webview 内的 HTML5
  //        原生拖放（dragover/drop 不会触发），改由 Tauri 统一投递 tauri://drag-drop。
  //      - 前端已在此处监听 tauri://drag-drop，因此保留 true 是正确选择：路径由 Tauri 以
  //        绝对路径形式给出，前端可直接送入上传链路。
  //      - 若未来改用 HTML5 <div onDrop> 自行处理拖放，必须把 dragDropEnabled 改为 false，
  //        二选一，不得两头都不接（true 但不监听 / false 但不写 onDrop 都会导致拖放静默丢失）。
  //      - HTML <input type="file"> 在 webview 中不受 dragDropEnabled 影响，仍会弹出原生
  //        选择框（DatasetPanel 的隐藏 file input 即依赖此能力），未被禁用。
  try {
    const unlisten = await listen<DragDropPayload>('tauri://drag-drop', (event) => {
      const payload = event.payload
      // enter/over/leave 阶段不处理，仅在文件真正放下时触发上传链路
      if (payload?.type && payload.type !== 'drop') return
      const paths = Array.isArray(payload?.paths) ? payload.paths.filter(isAllowedFile) : []
      if (paths.length === 0) return
      try {
        onFiles(paths)
      } catch (error) {
        console.warn('[tauri-events] onFiles 回调执行抛错', error)
      }
    })
    unlisteners.push(unlisten)
  } catch (error) {
    console.warn('[tauri-events] 监听 tauri://drag-drop 失败', error)
  }

  // 3) deep-imaging://open-diff：外部请求打开 Diff 视图
  try {
    const unlisten = await listen<unknown>('deep-imaging://open-diff', (event) => {
      try {
        onDiff(event.payload)
      } catch (error) {
        console.warn('[tauri-events] onDiff 回调执行抛错', error)
      }
    })
    unlisteners.push(unlisten)
  } catch (error) {
    console.warn('[tauri-events] 监听 deep-imaging://open-diff 失败', error)
  }

  // 返回统一的反注册函数：逐个调用，单个失败不影响其余
  return () => {
    unlisteners.forEach((fn) => {
      try {
        fn()
      } catch {
        /* 单个 unlisten 失败不阻塞其余 */
      }
    })
  }
}

/** 经 Rust 桌面宿主读取真实文件；宿主负责格式、文件类型和 50 MB 上限校验。 */
export async function readTauriPathBytes(path: string): Promise<Uint8Array> {
  const invoke = window.__TAURI__?.core?.invoke
  if (!invoke) throw new Error('仅桌面端支持从文件路径读取数据')
  const encoded = await invoke('desktop_read_file', { path })
  if (typeof encoded !== 'string' || !/^[A-Za-z0-9+/]*={0,2}$/.test(encoded)) {
    throw new Error('桌面端返回了无效的文件内容')
  }
  const binary = atob(encoded)
  return Uint8Array.from(binary, (char) => char.charCodeAt(0))
}

/** 启动参数由前端就绪后主动读取，避免 Rust Ready 事件早于 JS 监听导致丢失。 */
export async function readTauriStartupFiles(): Promise<string[]> {
  const invoke = window.__TAURI__?.core?.invoke
  if (!invoke) return []
  const paths = await invoke('desktop_startup_files')
  return extractOpenFilesPaths(paths as OpenFilesPayload)
}
