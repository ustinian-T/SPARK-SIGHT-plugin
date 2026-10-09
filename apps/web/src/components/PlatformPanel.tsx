import { useEffect, useMemo, useState } from 'react'
import { PlatformClient, type ProjectSummary } from '../client/platformClient'
import { getHostBridge } from '../host/bridge'
import { useStore } from '../state/store'
import { Badge, Button, EmptyState, Tooltip } from './common'

// 插件注册标签的中文图例：把内部注册表键翻译为用户能理解的“平台能力”。
const PLUGIN_META: Record<string, { label: string; desc: string }> = {
  charts: { label: '图表类型', desc: '已注册的可绘制图表种类，如折线图、柱状图、误差棒图等' },
  styles: { label: '样式预设', desc: '已注册的配色与版式风格数量' },
  engines: { label: '渲染引擎', desc: '已注册的执行引擎，如 Python、R、MATLAB' },
  tools: { label: '工具节点', desc: '工作流中可被调用的确定性工具，如数据体检、统计分析' },
  dataFormats: { label: '数据格式', desc: '可读取的数据文件格式，如 CSV、XLSX' }
}

export function PlatformPanel() {
  const { state, loadProjects, openTask } = useStore()
  const [client, setClient] = useState<PlatformClient | null>(null)
  const [projects, setProjects] = useState<ProjectSummary[]>([])
  const [active, setActive] = useState<ProjectSummary | null>(null)
  const [name, setName] = useState('科研绘图项目')
  const [comment, setComment] = useState('')
  const [dpi, setDpi] = useState(300)
  const [transparent, setTransparent] = useState(false)
  const [pValue, setPValue] = useState('')
  const [mergeText, setMergeText] = useState({ base: '', current: '', incoming: '' })
  const [mergeResult, setMergeResult] = useState('')
  const [collaboration, setCollaboration] = useState('未加入协作房间')
  const [status, setStatus] = useState('正在连接项目服务…')
  const [pluginCounts, setPluginCounts] = useState<Record<string, number>>({})
  const plan = useMemo(() => state.task?.plans.find((item) => item.plan_id === state.activePlanId) ?? state.task?.plans[0], [state.activePlanId, state.task])

  const refresh = async (api: PlatformClient) => {
    const [{ projects }, plugins] = await Promise.all([api.listProjects(), api.plugins()])
    setProjects(projects)
    setPluginCounts(Object.fromEntries(Object.entries(plugins.registries ?? {}).map(([key, value]) => [key, Array.isArray(value) ? value.length : 0])))
    setStatus('平台能力已连接')
  }

  useEffect(() => { void PlatformClient.create().then(async (api) => { setClient(api); if (api) await refresh(api).catch((error) => setStatus(error.message)); else setStatus('项目服务未连接') }).catch((error) => setStatus(error.message)) }, [])
  useEffect(() => {
    if (!client || !active) return
    setCollaboration('正在加入实时协作房间…')
    return client.subscribeProject(active.projectId, (event) => setCollaboration(event.type === 'collaboration_snapshot' ? `已连接 · ${event.comments?.length ?? 0} 条批注` : `实时事件：${event.type}`))
  }, [active, client])
  if (!client) return <EmptyState icon="info" title="项目服务暂不可用" desc={status} />

  const act = async (label: string, fn: () => Promise<any>) => {
    setStatus(`${label}…`)
    try { const value = await fn(); setStatus(`${label}完成`); return value } catch (error) { setStatus(error instanceof Error ? error.message : String(error)); return null }
  }

  return (
    <div className="platform-panel thin-scroll">
      <div className="platform-panel__status"><Badge tone="brand">平台</Badge><span>{status}</span></div>
      <div className="platform-panel__hint">项目用于归档数据、绘图任务、方案和批注，方便重新打开继续工作。网页端保存于服务器；桌面端与插件默认保存于本机。保存期限和配额以当前服务配置为准。</div>

      <label className="form-label">项目保存 / 重新打开</label>
      <div className="platform-panel__hint">把当前任务连同数据、方案与图表保存为项目，便于以后重新打开继续编辑。</div>
      <div className="platform-panel__row"><input className="form-control" aria-label="保存的项目名称" value={name} onChange={(event) => setName(event.target.value)} /><Button size="sm" disabled={!name.trim()} onClick={async () => { const value = await act('保存项目', async () => { const created = await client.createProject(name); if (state.task) await client.attachTask(created.project.projectId, state.task.taskId); return created }); if (value) { setActive(value.project); await refresh(client); await loadProjects(); setStatus('项目已保存，可从项目列表重新打开') } }}>保存</Button></div>
      <select className="form-control" aria-label="重新打开已保存项目" value={active?.projectId ?? ''} onChange={async (event) => { const id = event.target.value; if (!id) { setActive(null); return } await act('重新打开项目', async () => { const value = await client.openProject(id); setActive(value.project); await loadProjects(); if (value.tasks?.[0]) await openTask(value.tasks[0].taskId, id); return value }) }}>
        <option value="">选择已保存项目…</option>{projects.map((project) => <option key={project.projectId} value={project.projectId}>{project.name}</option>)}
      </select>
      {active && <>
        <div className="platform-panel__hint">{collaboration}</div>
        <div className="platform-panel__row"><Button size="sm" variant="ghost" onClick={() => void act('锁定处理步骤', () => client.setLocks(active.projectId, { filter: true, types: true, missing: true }))}>锁定处理</Button>{!getHostBridge() && <Button size="sm" variant="ghost" onClick={async () => { const value = await act('创建只读分享', () => client.share(active.projectId)); if (value) await navigator.clipboard?.writeText(value.share.urlPath) }}>只读分享</Button>}</div>
        <label className="form-label">完整批注 / 显著性标记</label>
        <div className="platform-panel__row"><input className="form-control" placeholder="输入批注" value={comment} onChange={(event) => setComment(event.target.value)} /><input className="form-control" placeholder="p 值（可选）" value={pValue} onChange={(event) => setPValue(event.target.value)} /><Button size="sm" onClick={() => void act('添加批注', () => client.addComment(active.projectId, comment, { kind: 'plan', id: plan?.plan_id ?? 'project' }, pValue ? { method: '用户确认的统计检验', pValue: Number(pValue), alpha: 0.05 } : undefined))}>批注</Button></div>
      </>}

      <label className="form-label">代码与界面冲突逐项合并</label>
      <div className="platform-panel__hint">当界面调整与代码修改发生冲突时，按「共同基线 / 界面当前版本 / 代码传入版本」三方文本逐项合并，避免互相覆盖。</div>
      {(['base', 'current', 'incoming'] as const).map((field) => <textarea key={field} className="form-control" rows={2} placeholder={field === 'base' ? '共同基线' : field === 'current' ? '界面当前版本' : '代码传入版本'} value={mergeText[field]} onChange={(event) => setMergeText({ ...mergeText, [field]: event.target.value })} />)}
      <Button size="sm" variant="ghost" onClick={async () => { const value = await act('三方合并', () => client.merge(mergeText.base, mergeText.current, mergeText.incoming)); if (value) setMergeResult(`${value.clean ? '无冲突' : `${value.conflicts.length} 项冲突`}\n${value.mergedText}`) }}>逐项合并</Button>
      {mergeResult && <pre className="platform-panel__merge">{mergeResult}</pre>}

      <label className="form-label">方案变体与高级导出</label>
      <div className="platform-panel__hint">基于当前方案生成备选变体，并按 DPI、透明背景与文件格式导出出版级图片。</div>
      <div className="platform-panel__row">
        <Button size="sm" disabled={!state.task || !plan} onClick={() => state.task && plan && void act('生成两个变体', () => client.variants(state.task!.taskId, plan.plan_id))}>生成两个变体</Button>
        <input className="form-control" type="number" min={72} max={1200} value={dpi} onChange={(event) => setDpi(Number(event.target.value))} aria-label="导出 DPI" />
        <label className="platform-panel__hint"><input type="checkbox" checked={transparent} onChange={(event) => setTransparent(event.target.checked)} /> 透明背景</label>
        <Button size="sm" variant="ghost" disabled={!state.task || !plan} onClick={() => state.task && plan && void act('高级导出', () => client.exportAdvanced(state.task!.taskId, plan.plan_id, { dpi, transparent, colorMode: 'color', formats: ['svg', 'png', 'pdf'] }))}>高级导出</Button>
      </div>
      <span className="platform-panel__hint">ZIP 可包含代码、数据、证据、SVG/PNG/PDF、DPI、透明背景与色彩模式。</span>

      <label className="form-label">平台扩展能力</label>
      <div className="platform-panel__plugins">
        {Object.entries(pluginCounts).map(([key, count]) => {
          const meta = PLUGIN_META[key] ?? { label: key, desc: key }
          return (
            <Tooltip key={key} content={`${meta.desc}（当前 ${count} 项）`} placement="top">
              <span className="badge badge--muted" style={{ cursor: 'help' }}>{meta.label} {count}</span>
            </Tooltip>
          )
        })}
      </div>
      <div className="platform-panel__hint">以上数字表示平台当前可扩展能力的数量，来自插件注册，并非你的个人数据。桌面端、VS Code、移动布局与协作房间复用同一协议；远程 R / MATLAB 节点的凭据仅通过宿主环境变量注入。</div>
    </div>
  )
}
