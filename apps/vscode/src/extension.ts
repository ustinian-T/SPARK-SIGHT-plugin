import * as vscode from 'vscode'
import { randomBytes, randomUUID } from 'node:crypto'
import { spawn, type ChildProcess } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { handleHostMessage } from './hostBridge'
import { applyPatchWithReview, type VscodeFacade } from './patchReview'
import { RuntimeRunner } from './runtimeRunner'
import { loadReleaseConfig, accountServiceOrigin } from './releaseConfig'
import { sourceDocument } from './nativeSource'
import { checkUpdate, trustedDownload, verifyArtifact, ARTIFACT_NAME } from './updater'

let agentChild: ChildProcess | undefined
let agentConfig: { baseUrl: string; token: string; engine: string } | undefined
let agentStartPending: Promise<{ baseUrl: string; token: string; engine: string }> | undefined

function isWorkspaceResource(uri: vscode.Uri): boolean {
  if (uri.scheme !== 'file') return false
  const target = path.resolve(uri.fsPath)
  return (vscode.workspace.workspaceFolders ?? []).some((folder) => {
    const root = path.resolve(folder.uri.fsPath)
    return target === root || target.startsWith(root + path.sep)
  })
}

function createFacade(): VscodeFacade {
  return {
    get isTrusted() { return vscode.workspace.isTrusted },
    isUriAllowed: (raw) => isWorkspaceResource(vscode.Uri.parse(raw)),
    async openDocument(raw) {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(raw))
      return { text: document.getText(), isDirty: document.isDirty }
    },
    async openDiff(raw, proposedText, title) {
      const source = vscode.Uri.parse(raw)
      const current = await vscode.workspace.openTextDocument(source)
      const proposed = await vscode.workspace.openTextDocument({ content: proposedText, language: current.languageId })
      await vscode.commands.executeCommand('vscode.diff', source, proposed.uri, title ?? `Review Deep Imaging change: ${path.basename(source.fsPath)}`)
    },
    async applyText(raw, proposedText) {
      const uri = vscode.Uri.parse(raw)
      const document = await vscode.workspace.openTextDocument(uri)
      const edit = new vscode.WorkspaceEdit()
      edit.replace(uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), proposedText)
      if (!(await vscode.workspace.applyEdit(edit))) throw new Error('VSCode rejected the workspace edit')
    },
    async readSelection() {
      const editor = vscode.window.activeTextEditor
      if (!editor || editor.selection.isEmpty || !isWorkspaceResource(editor.document.uri)) return null
      return {
        uri: editor.document.uri.toString(),
        text: editor.document.getText(editor.selection),
        languageId: editor.document.languageId,
        startLine: editor.selection.start.line,
        endLine: editor.selection.end.line
      }
    },
    async createTemporaryDocument(name, content) {
      const extension = path.extname(name).slice(1)
      const document = await vscode.workspace.openTextDocument({ content, language: extension === 'm' ? 'matlab' : extension === 'r' ? 'r' : extension === 'py' ? 'python' : 'plaintext' })
      await vscode.window.showTextDocument(document, { preview: true, preserveFocus: true })
      return document.uri.toString()
    },
    async insertText(raw, text, line, character) {
      const uri = vscode.Uri.parse(raw)
      const document = await vscode.workspace.openTextDocument(uri)
      const position = new vscode.Position(Math.max(0, Math.min(line, document.lineCount - 1)), Math.max(0, character))
      const edit = new vscode.WorkspaceEdit()
      edit.insert(uri, position, text)
      if (!(await vscode.workspace.applyEdit(edit))) throw new Error('VSCode rejected the targeted insertion')
    },
    async revealLocation(raw, line, character) {
      const document = await vscode.workspace.openTextDocument(vscode.Uri.parse(raw))
      const editor = await vscode.window.showTextDocument(document)
      const position = new vscode.Position(Math.max(0, Math.min(line, document.lineCount - 1)), Math.max(0, character))
      editor.selection = new vscode.Selection(position, position)
      editor.revealRange(new vscode.Range(position, position), vscode.TextEditorRevealType.InCenter)
    },
    async undo() {
      await vscode.commands.executeCommand('undo')
    },
    async writeHandoff(payload) {
      const root = vscode.workspace.workspaceFolders?.[0]?.uri
      if (!root) throw new Error('Open a workspace before creating a handoff')
      const folder = vscode.Uri.joinPath(root, '.deep-imaging')
      const target = vscode.Uri.joinPath(folder, 'handoff.json')
      await vscode.workspace.fs.createDirectory(folder)
      await vscode.workspace.fs.writeFile(target, Buffer.from(`${JSON.stringify({ version: 1, createdAt: new Date().toISOString(), payload }, null, 2)}\n`, 'utf8'))
      return target.toString()
    }
  }
}

async function launchAgent(context: vscode.ExtensionContext) {
  const packagedEntry = vscode.Uri.joinPath(context.extensionUri, 'agent', 'src', 'server.js').fsPath
  const devEntry = vscode.Uri.joinPath(context.extensionUri, '..', '..', 'services', 'local-agent', 'src', 'server.js').fsPath
  const entry = process.env.DEEP_IMAGING_AGENT_ENTRY || (fs.existsSync(packagedEntry) ? packagedEntry : devEntry)
  if (!fs.existsSync(entry)) throw new Error('Local Agent bundle is missing; rebuild the VS Code extension package')
  const token = randomUUID().replaceAll('-', '')
  const runtimeRoot = vscode.Uri.joinPath(context.extensionUri, 'runtime').fsPath
  const bundledNode = path.join(runtimeRoot, 'node', 'node.exe')
  const bundled = process.platform === 'win32' && fs.existsSync(bundledNode)
  const node = process.env.DEEP_IMAGING_NODE || (bundled ? bundledNode : 'node')
  const child = spawn(node, [entry], {
    cwd: path.dirname(path.dirname(entry)),
    detached: process.platform !== 'win32',
    windowsHide: true,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env,
      ...(bundled ? { PATH: [path.join(runtimeRoot, 'python'), path.join(runtimeRoot, 'node'), process.env.PATH ?? ''].join(path.delimiter) } : {}),
      LOCAL_AGENT_HOST: '127.0.0.1', LOCAL_AGENT_PORT: '0', LOCAL_AGENT_TOKEN: token,
      LOCAL_AGENT_PERSIST: '1', LOCAL_ONLY_MODE: '1', REMOTE_MODE: '0', TEST_WEB_MODE: '0', LOCAL_AGENT_WEB_ONLY: '0', LOCAL_AGENT_CLOUD_URL: '', LOCAL_AGENT_CLOUD_TOKEN: '',
      LOCAL_AGENT_CLOUD_ACCOUNT_URL: accountServiceOrigin(),
      LOCAL_AGENT_DATA_DIR: path.join(context.globalStorageUri.fsPath, 'agent-data') }
  })
  agentChild = child
  let startupErrors = ''
  child.stderr?.on('data', (chunk: Buffer) => { startupErrors = (startupErrors + chunk.toString('utf8')).slice(-2000) })
  const baseUrl = await new Promise<string>((resolve, reject) => {
    let pending = ''
    const timeout = setTimeout(() => reject(new Error('Local Agent startup timed out')), 10_000)
    child.once('error', (error) => { clearTimeout(timeout); reject(error) })
    child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`本地 Agent 启动失败（${code}）。${startupErrors}`)) })
    child.stdout?.on('data', (chunk: Buffer) => {
      pending += chunk.toString('utf8')
      const match = pending.match(/HTTP\s+(http:\/\/127\.0\.0\.1:\d+)\/health/)
      if (match) { clearTimeout(timeout); resolve(match[1]) }
      if (pending.length > 16_384) pending = pending.slice(-4_096)
    })
  }).catch(async (error) => { await stopAgent(); throw error })
  if (child.exitCode !== null) throw new Error('Local Agent exited during startup')
  agentConfig = { baseUrl, token, engine: 'python' }
  return agentConfig
}

async function startAgent(context: vscode.ExtensionContext) {
  if (agentConfig && agentChild && !agentChild.killed && agentChild.exitCode === null) return agentConfig
  if (agentStartPending) return agentStartPending
  agentStartPending = launchAgent(context)
  try { return await agentStartPending } finally { agentStartPending = undefined }
}

async function stopAgent(): Promise<void> {
  const child = agentChild
  agentChild = undefined
  agentConfig = undefined
  if (!child || child.killed || child.pid === undefined) return
  if (process.platform === 'win32') {
    await new Promise<void>((resolve) => {
      const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' })
      killer.once('exit', () => resolve())
      killer.once('error', () => { child.kill(); resolve() })
    })
  } else {
    try { process.kill(-child.pid, 'SIGTERM') } catch { child.kill() }
  }
}

async function webviewHtml(webview: vscode.Webview, webRoot: vscode.Uri): Promise<string> {
  const entries = await vscode.workspace.fs.readDirectory(vscode.Uri.joinPath(webRoot, 'assets'))
  const js = entries.find(([name]) => /^index-.*\.js$/.test(name))?.[0]
  const css = entries.find(([name]) => /^index-.*\.css$/.test(name))?.[0]
  if (!js || !css) throw new Error('Shared Web bundle is missing; run apps/web npm run build')
  const nonce = randomBytes(18).toString('base64')
  const jsUri = webview.asWebviewUri(vscode.Uri.joinPath(webRoot, 'assets', js))
  const cssUri = webview.asWebviewUri(vscode.Uri.joinPath(webRoot, 'assets', css))
  const assetBase = webview.asWebviewUri(webRoot).toString() + '/'
  const bootstrap = `
    document.documentElement.dataset.sparkHost = 'vscode';
    location.hash = '/app';
    const vscode = acquireVsCodeApi(); const pending = new Map();
    addEventListener('message', ({data}) => {
      if (data?.type === 'webview.openData' || data?.type === 'webview.useSelection') {
        dispatchEvent(new CustomEvent(data.type === 'webview.openData' ? 'deep-imaging:open-data' : 'deep-imaging:use-selection', {detail:data})); return;
      }
      const item = pending.get(data.id); if (!item) return;
      pending.delete(data.id); data.ok ? item.resolve(data.result) : item.reject(Object.assign(new Error(data.error?.message), {code:data.error?.code}));
    });
    addEventListener('deep-imaging:webview-ready', () => vscode.postMessage({type:'webview.ready'}));
    const request = (type,payload={}) => new Promise((resolve,reject) => { const id = crypto.randomUUID(); pending.set(id,{resolve,reject}); vscode.postMessage({version:2,id,type,payload}); });
    window.__SPARK_VSCODE__ = { openSource:(x)=>request('vscode.openSource',x), runCurrent:()=>request('vscode.runCurrent'), useSelection:()=>request('vscode.useSelection'), openWebsite:()=>request('vscode.openWebsite') };
    window.__SPARK_UPDATES__ = { open:()=>request('update.open') };
    window.__DEEP_IMAGING_HOST__ = { getAgentConfig:()=>request('agent.config'), openDiff:(x)=>request('diff.open',x), readSelection:()=>request('selection.read'), applyPatch:(x)=>request('patch.apply',x), getRuntimeCapabilities:()=>request('runtime.capabilities'), runMatlab:(x)=>request('runtime.runMatlab',x), discoverRuntimes:()=>request('runtime.discover'), planRuntime:(x)=>request('runtime.plan',x), runRuntime:(x)=>request('runtime.run',x), getRuntimeEvents:(id)=>request('runtime.events',{runId:id}), cancelRuntime:(id)=>request('runtime.cancel',{runId:id}), openArtifact:(x)=>request('runtime.openArtifact',x), receive:async(x)=>x };
  `
  return `<!doctype html><html><head><meta charset="UTF-8"><base href="${assetBase}"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src ${webview.cspSource} data: blob:; font-src ${webview.cspSource}; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}'; connect-src http://127.0.0.1:* ws://127.0.0.1:*;"><link rel="stylesheet" href="${cssUri}"></head><body><div id="root"></div><script nonce="${nonce}">${bootstrap}</script><script nonce="${nonce}" type="module" src="${jsUri}"></script></body></html>`
}

export function activate(context: vscode.ExtensionContext): void {
  const facade = createFacade()
  const diagnostics = vscode.window.createOutputChannel('spark sight Diagnostics')
  context.subscriptions.push(diagnostics)
  // v2 通用多语言运行时单例：传入工作区根路径与 vscode API 适配
  const runner = new RuntimeRunner({
    workspaceRoot: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '',
    matlabPath: vscode.workspace.getConfiguration('deepImaging').get<string>('matlabPath', 'matlab'),
    isTrusted: () => vscode.workspace.isTrusted,
    openArtifactPath: async (absPath) => { await vscode.commands.executeCommand('vscode.open', vscode.Uri.file(absPath)) },
    onLog: (line) => diagnostics.appendLine(line)
  })
  let sidebar: vscode.WebviewView | undefined
  let ready = false
  const queued: unknown[] = []
  const deliver = async (message: unknown) => {
    if (sidebar && ready) await sidebar.webview.postMessage(message)
    else { if (queued.length >= 10) queued.shift(); queued.push(message) }
  }
  context.subscriptions.push(vscode.window.registerWebviewViewProvider('deepImaging.sidebar', {
    async resolveWebviewView(view) {
      sidebar = view
      ready = false
      view.onDidDispose(() => { if (sidebar === view) {sidebar = undefined;ready = false} }, undefined, context.subscriptions)
      const packaged = vscode.Uri.joinPath(context.extensionUri, 'web', 'dist')
      const webRoot = fs.existsSync(packaged.fsPath) ? packaged : vscode.Uri.joinPath(context.extensionUri, '..', 'web', 'dist')
      view.webview.options = {enableScripts:true,localResourceRoots:[webRoot]}
      view.webview.onDidReceiveMessage(async message => {
        if (message?.type === 'webview.ready') {
          ready = true
          for (const item of queued.splice(0)) await view.webview.postMessage(item)
          return
        }
        if (message?.version === 2 && typeof message.id === 'string' && message.type?.startsWith('vscode.')) {
          const commands: Record<string,string> = {'vscode.openSource':'deepImaging.openSource','vscode.runCurrent':'deepImaging.runInTerminal','vscode.useSelection':'deepImaging.useSelection','vscode.openWebsite':'deepImaging.openWebsite'}
          try {
            const command = commands[message.type]
            if (!command) throw new Error('Unsupported native action')
            const result = await vscode.commands.executeCommand(command, message.payload)
            await view.webview.postMessage({version:2,id:message.id,ok:true,result})
          } catch (error) {
            await view.webview.postMessage({version:2,id:message.id,ok:false,error:{code:'NATIVE_ACTION_FAILED',message:error instanceof Error ? error.message : String(error)}})
          }
          return
        }
        if (message?.type === 'update.open') {
          await vscode.commands.executeCommand('deepImaging.checkUpdates')
          await view.webview.postMessage({version:2,id:message.id,ok:true,result:null})
          return
        }
        await view.webview.postMessage(await handleHostMessage(message,{vscode:facade,getAgentConfig:()=>startAgent(context),runner}))
      },undefined,context.subscriptions)
      view.webview.html = await webviewHtml(view.webview,webRoot)
    }
  }, {webviewOptions:{retainContextWhenHidden:true}}))
  const openSharedUi = () => vscode.commands.executeCommand('deepImaging.open')
  context.subscriptions.push(
    vscode.commands.registerCommand('deepImaging.checkUpdates', async () => {
      try {
        const release = await checkUpdate(context.extension.packageJSON.version)
        if (!release) { await vscode.window.showInformationMessage('Deep Imaging 已是最新版本'); return }
        const consent = await vscode.window.showInformationMessage(`发现 Deep Imaging ${release.version}，下载并校验升级包？`, { modal: true, detail: '升级保留本地项目与设置。发布清单通过 HTTPS 获取，安装包以 SHA-256 校验。' }, '下载')
        if (consent !== '下载') return
        const bytes = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: '下载并校验 Deep Imaging 升级包' }, () => trustedDownload(ARTIFACT_NAME, release.file.bytes))
        verifyArtifact(bytes, release.file)
        const folder = path.join(context.globalStorageUri.fsPath, 'verified-updates')
        fs.mkdirSync(folder, { recursive: true })
        const target = path.join(folder, `${release.version}-${randomUUID()}.vsix`)
        fs.writeFileSync(target, bytes, { flag: 'wx' })
        const install = await vscode.window.showInformationMessage(`升级包 ${release.version} 校验成功`, { modal: true, detail: '确认后由 VS Code 安装扩展；可能需要重新加载窗口。' }, '安装')
        if (install !== '安装') { fs.rmSync(target); return }
        verifyArtifact(fs.readFileSync(target), release.file)
        await stopAgent()
        await vscode.commands.executeCommand('workbench.extensions.installExtension', vscode.Uri.file(target))
        const reload = await vscode.window.showInformationMessage('升级包已交给 VS Code 安装，重新加载以启用新版本。', '重新加载')
        if (reload) await vscode.commands.executeCommand('workbench.action.reloadWindow')
      } catch (error) { await vscode.window.showErrorMessage(`升级失败：${error instanceof Error ? error.message : String(error)}`) }
    }),
    vscode.commands.registerCommand('deepImaging.startAgent', () => startAgent(context)),
    vscode.commands.registerCommand('deepImaging.stopAgent', () => stopAgent()),
    vscode.commands.registerCommand('deepImaging.reviewPatch', (request) => applyPatchWithReview(facade, request)),
    vscode.commands.registerCommand('deepImaging.openData', async (uri?: vscode.Uri) => {
      const selected = uri ?? (await vscode.window.showOpenDialog({ canSelectMany: true, filters: { 'Research data': ['csv', 'xlsx', 'json'] } }))?.[0]
      if (!selected) return
      await vscode.commands.executeCommand('deepImaging.open', selected)
    }),
    vscode.commands.registerCommand('deepImaging.useSelection', async () => {
      const selection = await facade.readSelection()
      if (!selection) return vscode.window.showWarningMessage('Select data or code in a trusted workspace first.')
      await vscode.commands.executeCommand('deepImaging.open', undefined, selection.text)
    }),
    vscode.commands.registerCommand('deepImaging.generateVariants', openSharedUi),
    vscode.commands.registerCommand('deepImaging.syncProject', openSharedUi),
    vscode.commands.registerCommand('deepImaging.exportAdvanced', openSharedUi),
    vscode.commands.registerCommand('deepImaging.showDiagnostics', async () => {
      diagnostics.clear()
      diagnostics.appendLine(`Deep Imaging VSCode ${context.extension.packageJSON.version}`)
      diagnostics.appendLine(`VSCode ${vscode.version}; trusted=${vscode.workspace.isTrusted}`)
      diagnostics.appendLine(`workspaceFolders=${(vscode.workspace.workspaceFolders ?? []).length}`)
      try { const config = await startAgent(context); diagnostics.appendLine(`agent=${config.baseUrl}; engine=${config.engine}`) } catch (error) { diagnostics.appendLine(`agentError=${error instanceof Error ? error.message : String(error)}`) }
      diagnostics.show(true)
    }),
    vscode.commands.registerCommand('deepImaging.runMatlab', async () => {
      const editor = vscode.window.activeTextEditor
      if (!editor) throw new Error('Open a MATLAB script first')
      const result = await runner.runMatlabLegacy({ scriptPath: editor.document.uri.fsPath })
      void vscode.window.showInformationMessage(`MATLAB completed: ${path.basename(result.scriptPath)}`)
      return result
    }),
    vscode.commands.registerCommand('deepImaging.runCurrentFile', async () => {
      const editor = vscode.window.activeTextEditor
      if (!editor) throw new Error('请先打开本地脚本文件')
      if (editor.document.isUntitled && !(await editor.document.save())) throw new Error('请先保存脚本再运行')
      if (editor.document.uri.scheme !== 'file') throw new Error('请先打开本地脚本文件')
      const scriptPath = editor.document.uri.fsPath
      const runtimeId = ({ '.py': 'python', '.r': 'r', '.m': 'matlab', '.js': 'node' } as Record<string, string>)[path.extname(scriptPath).toLowerCase()]
      if (!runtimeId) throw new Error('当前仅支持直接运行 .py、.r、.m、.js 文件')
      if (editor.document.isDirty && !(await editor.document.save())) throw new Error('请先保存脚本再运行')
      const workDir = path.dirname(scriptPath)
      const before = new Map<string, number>()
      for (const name of fs.readdirSync(workDir)) {
        if (/\.(png|svg|pdf|html|csv)$/i.test(name)) before.set(name, fs.statSync(path.join(workDir, name)).mtimeMs)
      }
      const plan = await runner.plan({ runtimeId, scriptPath, workDir, args: [], envWhitelist: [], expectedArtifacts: [] })
      const { runId } = await runner.run({ planId: plan.planId })
      diagnostics.show(true)
      diagnostics.appendLine(`运行 ${path.basename(scriptPath)} (${runtimeId})`)
      let emitted = 0
      for (let count = 0; count < 1200; count += 1) {
        const result = await runner.events(runId)
        for (const event of result.events.slice(emitted)) {
          if (event.type === 'stdout' || event.type === 'stderr') diagnostics.append(String(event.data))
        }
        emitted = result.events.length
        if (result.status !== 'running' && result.status !== 'pending') {
          diagnostics.appendLine(`\n运行结束：${result.status}（退出码 ${result.exitCode ?? '未知'}）`)
          if (result.status === 'completed') {
            const artifacts = fs.readdirSync(workDir).filter((name) => /\.(png|svg|pdf|html|csv)$/i.test(name) && fs.statSync(path.join(workDir, name)).mtimeMs > (before.get(name) ?? 0))
            for (const name of artifacts.slice(0, 3)) await runner.openArtifact({ runId, artifactPath: name })
          } else void vscode.window.showErrorMessage(`脚本运行${result.status === 'cancelled' ? '已取消' : '失败'}，请查看 Deep Imaging Diagnostics 输出`)
          return result
        }
        await new Promise((resolve) => setTimeout(resolve, 250))
      }
      await runner.cancel(runId)
      throw new Error('脚本运行超过 5 分钟，已终止；请查看诊断输出')
    }),
    ...['generate', 'fix', 'preview', 'compare', 'export', 'preferences'].map((name) =>
      vscode.commands.registerCommand(`deepImaging.${name}`, () => vscode.commands.executeCommand('deepImaging.open'))
    ),
    vscode.commands.registerCommand('deepImaging.runInTerminal', async () => {
      if (!vscode.workspace.isTrusted) throw new Error('请先信任当前工作区')
      const editor = vscode.window.activeTextEditor
      if (!editor) throw new Error('请先打开待运行的脚本')
      if ((editor.document.isDirty || editor.document.isUntitled) && !(await editor.document.save())) throw new Error('请先保存脚本')
      if (!isWorkspaceResource(editor.document.uri)) throw new Error('请运行当前工作区内的脚本')
      const file = editor.document.uri.fsPath
      const ext = path.extname(file).toLowerCase()
      const interpreter = ({'.py':process.platform === 'win32' ? 'python' : 'python3','.r':'Rscript','.js':'node','.m':vscode.workspace.getConfiguration('deepImaging').get<string>('matlabPath','matlab')} as Record<string,string>)[ext]
      if (!interpreter) throw new Error('支持 Python、R、MATLAB 和 Node 脚本')
      const args = ext === '.m' ? ['-batch', `run('${file.replaceAll("'", "''").replaceAll('\\','/')}')`] : [file]
      const task = new vscode.Task({type:'sparkSight',script:file}, vscode.workspace.getWorkspaceFolder(editor.document.uri)!, `运行 ${path.basename(file)}`, 'spark sight', new vscode.ProcessExecution(interpreter,args,{cwd:path.dirname(file)}))
      task.presentationOptions = {reveal:vscode.TaskRevealKind.Always,panel:vscode.TaskPanelKind.Dedicated,clear:true}
      await vscode.tasks.executeTask(task)
      return {started:true}
    }),
    vscode.commands.registerCommand('deepImaging.openSource', async input => {
      if (!vscode.workspace.isTrusted) throw new Error('请先信任当前工作区')
      const document = await vscode.workspace.openTextDocument(sourceDocument(input))
      await vscode.window.showTextDocument(document, {preview:false,viewColumn:vscode.ViewColumn.Active})
      return {uri:document.uri.toString()}
    }),
    vscode.commands.registerCommand('deepImaging.openWebsite', () => vscode.env.openExternal(vscode.Uri.parse(loadReleaseConfig().websiteOrigin))),
    vscode.commands.registerCommand('deepImaging.open', async (selectedData?: vscode.Uri, selectedText?: string) => {
      if (selectedText || selectedData) {
        if (!vscode.workspace.isTrusted) throw new Error('请先信任当前工作区')
        if (selectedText) await deliver({type:'webview.useSelection',text:selectedText.slice(0,20000)})
        if (selectedData) {
          if (!isWorkspaceResource(selectedData)) throw new Error('请选择当前工作区内的数据文件')
          const bytes = await vscode.workspace.fs.readFile(selectedData)
          if (bytes.byteLength > 50 * 1024 * 1024) throw new Error('数据文件超过 50 MB 上限')
          await deliver({type:'webview.openData',fileName:path.basename(selectedData.fsPath),bytesBase64:Buffer.from(bytes).toString('base64')})
        }
      }
      await vscode.commands.executeCommand('deepImaging.sidebar.focus')
    })
  )
}

export async function deactivate(): Promise<void> {
  await stopAgent()
}
