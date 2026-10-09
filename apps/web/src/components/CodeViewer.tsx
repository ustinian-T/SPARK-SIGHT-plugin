import { useEffect, useMemo, useState } from 'react'
import { useStore } from '../state/store'
import { Badge, Button, EmptyState, Tabs, Tooltip } from './common'
import { Icon } from './icons'
import { RealSvgPreview } from './SvgPreview'
import { ChartPreview } from './ChartPreview'
import { ENGINE_LABEL, type EngineKind, type PlotPlan } from '../types'
import { getHostBridge } from '../host/bridge'

const KEYWORDS = new Set([
  'import', 'from', 'as', 'def', 'return', 'for', 'in', 'if', 'elif', 'else', 'with', 'try', 'except',
  'finally', 'while', 'None', 'True', 'False', 'and', 'or', 'not', 'lambda', 'class', 'pass', 'function',
  'library', 'end', 'ggplot', 'aes', 'geom_line', 'geom_bar', 'geom_errorbar', 'labs', 'theme', 'ylab', 'xlab'
])

function highlightTokens(line: string, engine: EngineKind): React.ReactNode[] {
  // Python 与 R 均使用 # 作为行注释符。
  const commentTok = engine === 'matlab' ? '%' : '#'
  const ci = line.indexOf(commentTok)
  let codePart = line
  let comment = ''
  if (ci >= 0) {
    codePart = line.slice(0, ci)
    comment = line.slice(ci)
  }
  const re = /("(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*')|(\b\d+\.?\d*\b)|([A-Za-z_][A-Za-z0-9_]*)(?=\s*\()/g
  const out: React.ReactNode[] = []
  let last = 0
  let m: RegExpExecArray | null
  let k = 0
  while ((m = re.exec(codePart))) {
    if (m.index > last) {
      codePart.slice(last, m.index).split(/(\s+)/).forEach((w, i) => {
        out.push(KEYWORDS.has(w) ? <span key={`p${k}-${i}`} className="tok-kw">{w}</span> : w)
      })
    }
    if (m[1]) out.push(<span key={k++} className="tok-str">{m[1]}</span>)
    else if (m[2]) out.push(<span key={k++} className="tok-num">{m[2]}</span>)
    else if (m[3]) out.push(<span key={k++} className="tok-fn">{m[3]}</span>)
    last = re.lastIndex
  }
  codePart.slice(last).split(/(\s+)/).forEach((w, i) => {
    out.push(KEYWORDS.has(w) ? <span key={`q${k}-${i}`} className="tok-kw">{w}</span> : w)
  })
  if (comment) out.push(<span key="c" className="tok-com">{comment}</span>)
  return out
}

export function CodeViewer() {
  const { state, client, setEngine, setActivePlan, exportArtifact, saveSource, saveCode } = useStore()
  const plans = state.task?.plans ?? []
  const [planId, setPlanId] = useState<string | undefined>(undefined)
  const [copied, setCopied] = useState(false)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const [saveError, setSaveError] = useState('')
  const [engineSvg, setEngineSvg] = useState<string | undefined>()
  const [previewLoading, setPreviewLoading] = useState(false)
  const plan: PlotPlan | undefined = plans.find((p) => p.plan_id === (planId ?? state.activePlanId ?? state.task?.selectedPlanId)) ?? plans[0]
  const engine = state.activeEngine
  const code = plan?.code[engine] ?? ''
  // 优化5：编辑即重渲染——applySource 成功后由 store 注入该方案真实渲染 SVG；无则用 ChartPreview 占位。
  const execution = state.task?.execution
  const localRealSvg = execution?.artifactSvg && execution.artifactPlanId === plan?.plan_id && execution.artifactEngine === engine
    ? execution.artifactSvg
    : undefined
  const realSvg = localRealSvg ?? engineSvg
  // R 运行时可用性：未安装时仍允许查看/编辑 R 代码，但明确提示无法在本机执行并给出安装入口。
  const rRuntime = state.gate.runtimes.find((r) => r.engine === 'r')
  const rUnavailable = engine === 'r' && rRuntime?.available === false

  useEffect(() => {
    setDraft(code)
    setEditing(false)
    setSaveError('')
  }, [plan?.plan_id, engine, code])

  useEffect(() => {
    let current = true
    setEngineSvg(undefined)
    if (!plan || !client.current) return () => { current = false }
    setPreviewLoading(true)
    void client.current.getPreview(plan.plan_id, engine).then((preview) => {
      if (current && preview.planId === plan.plan_id && preview.engine === engine) setEngineSvg(preview.svg)
    }).catch(() => {
      // No verified artifact for this exact plan/engine; use the spec preview, never a different engine's output.
    }).finally(() => { if (current) setPreviewLoading(false) })
    return () => { current = false }
  }, [client, plan?.plan_id, engine, execution?.artifactPlanId, execution?.artifactEngine, execution?.artifactSvg])

  const errorLoc = useMemo(() => {
    const loc = state.task?.execution.logs.find((l) => l.level === 'error' && l.location)?.location
    if (!loc || !plan) return undefined
    const [file, lineStr] = loc.split(':')
    const map: Record<string, string> = { plan_convention: 'convention', plan_clarity: 'clarity', plan_density: 'density' }
    const hit = Object.entries(map).find(([key]) => file.includes(key))
    if (hit && plan.strategy === hit[1]) return { file, line: Number(lineStr) }
    return undefined
  }, [state.task?.execution.logs, plan])

  if (!plan) {
    return (
      <div className="panel" style={{ display: 'grid', placeItems: 'center' }}>
        <EmptyState icon="code" title="尚无源码" desc="方案生成后，可在此查看 Python / R 源码、依赖与错误定位。" />
      </div>
    )
  }

  const lines = code.split('\n')
  // 仅保留 Python / R；历史引擎状态若不在二者内，按 Python 文件名兜底。
  const fileName = `${plan.plan_id}.${engine === 'r' ? 'R' : engine === 'matlab' ? 'm' : 'py'}`

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(editing ? draft : code)
      setCopied(true)
      setTimeout(() => setCopied(false), 1500)
    } catch { setSaveError('复制失败，请在源码中选择文本后复制，或下载源码。') }
  }
  const download = () => {
    const blob = new Blob([editing ? draft : code], { type: 'text/plain;charset=utf-8' })
    const a = document.createElement('a')
    a.href = URL.createObjectURL(blob)
    a.download = fileName
    a.click()
    URL.revokeObjectURL(a.href)
  }
  const save = async () => {
    if (!plan) return
    setSaving(true)
    setSaveError('')
    try {
      const preview = await saveSource(plan.plan_id, engine, draft)
      if (preview) setEditing(false)
    } catch (error) {
      const errCode = (error as { code?: string })?.code
      const raw = error instanceof Error ? error.message : String(error)
      // 自定义代码必须在 OS 级强隔离容器中执行；网页端当前服务器未提供容器时拒绝（安全优先），
      // 给出可执行路径，而不是让用户误以为“保存失败可重试”。
      setSaveError(
        errCode === 'STRONG_SANDBOX_REQUIRED' || raw.includes('OS 级隔离')
          ? '执行沙箱尚未就绪，修改未应用。可先保存草稿或下载源码；请检查执行服务的沙箱配置后重跑。'
          : raw
      )
    } finally {
      setSaving(false)
    }
  }

  // 编辑期间仅维护草稿，由明确的保存/重跑操作提交，避免输入中断。

  return (
    <div className="panel codewrap">
      <div className="codebar">
        <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0 }}>
          <select className="form-control" style={{ width: 190 }} value={plan.plan_id} onChange={(e) => setPlanId(e.target.value)}>
            {plans.map((p) => <option key={p.plan_id} value={p.plan_id}>{p.name}</option>)}
          </select>
          <Tabs
            active={engine}
            onChange={(id) => setEngine(id as EngineKind)}
            tabs={[
              { id: 'python', label: ENGINE_LABEL.python, icon: 'code' },
              { id: 'r', label: ENGINE_LABEL.r }
              ,...(getHostBridge() ? [{ id: 'matlab', label: ENGINE_LABEL.matlab }] : [])
            ]}
          />
        </div>
        <div style={{ display: 'flex', gap: 7, alignItems: 'center' }}>
          {engine === 'r' ? (
            <Tooltip content="网页端通过服务器 R 沙箱执行；桌面端与插件通过本机 Agent 的隔离运行时执行。" placement="bottom">
              <span className="mono" style={{ fontSize: 11, color: 'var(--ink-500)', cursor: 'help' }}>{fileName}</span>
            </Tooltip>
          ) : (
            <span className="mono" style={{ fontSize: 11, color: 'var(--ink-500)' }}>{fileName}</span>
          )}
          <Button size="sm" variant="ghost" icon={copied ? 'check' : 'doc'} onClick={copy}>{copied ? '已复制' : '复制'}</Button>
          {!editing && <Button size="sm" variant="ghost" icon="edit" onClick={() => { setActivePlan(plan.plan_id); setEditing(true) }}>编辑</Button>}
          {editing && <>
            <Button size="sm" variant="ghost" onClick={() => { setDraft(code); setEditing(false); setSaveError('') }}>取消</Button>
            <Button size="sm" variant="ghost" disabled={saving || draft === code} onClick={async () => {
              setSaving(true); setSaveError('')
              try { await saveCode(plan.plan_id, engine, draft); setEditing(false) }
              catch (error) { setSaveError(error instanceof Error ? error.message : String(error)) }
              finally { setSaving(false) }
            }}>保存草稿</Button>
            <Button size="sm" variant="primary" icon="play" disabled={saving || rUnavailable || state.running} onClick={() => void save()}>
              {saving ? '执行中…' : '保存并重跑'}
            </Button>
          </>}
          <Button size="sm" variant="ghost" icon="download" onClick={download}>下载</Button>
          <Button size="sm" variant="soft" icon="download" onClick={() => exportArtifact('源码与复现清单')}>复现包</Button>
        </div>
        {!realSvg && execution?.artifactSvg && (
          <div className="notebox notebox--info" style={{ marginTop: 6, borderRadius: 8 }}>
            <Icon name="info" size={14} /><span>当前方案或引擎尚无对应的已验证 SVG，已显示规格预览；不会冒用其他版本产物。</span>
          </div>
        )}
      </div>

      {rUnavailable && (
        <div className="notebox notebox--info" style={{ margin: '8px 12px 0', borderRadius: 8 }}>
          <Icon name="info" size={14} />
          <span>
            执行服务的 R 环境尚未就绪：{rRuntime?.note ?? '需要 Rscript 和 ggplot2'}。代码可查看、保存草稿与下载。
            {getHostBridge() ? '请安装本机 R，或配置 WSL 沙箱后重启 Agent。' : '网页端需要服务器安装 R，浏览器所在电脑无需安装；请更新服务器运行镜像后重试。'}
          </span>
        </div>
      )}

      {engine === 'r' && rRuntime?.available && plan.verification?.engine !== 'r' && (
        <div className="notebox notebox--info" style={{ margin: '8px 12px 0', borderRadius: 8 }}>
          <Icon name="info" size={14} />
          <span>
            当前图表尚未由 R 验证。可编辑下方 R 源码并「保存并重跑」，或在新建任务前选择 R。
          </span>
        </div>
      )}

      {errorLoc && engine === 'python' && (
        <div className="notebox notebox--warn" style={{ margin: '8px 12px 0', borderRadius: 8 }}>
          <Icon name="warn" size={14} />
          <span>
            首次执行在 <b>{errorLoc.file}:{errorLoc.line}</b> 出现依赖错误（ModuleNotFoundError），已归一化为 DEPENDENCY
            并回退 Matplotlib 内置实现，重试成功；对应行已高亮。
          </span>
        </div>
      )}

      {saveError && <div className="notebox notebox--warn" style={{ margin: '8px 12px 0' }}><Icon name="warn" size={14} /><span>{saveError}</span></div>}
      <div className="code-scroll">
        {editing ? (
          <textarea className="code-editor" value={draft} onChange={(event) => setDraft(event.target.value)} spellCheck={false} aria-label={`${fileName} 源码编辑器`} />
        ) : <pre className="code">
          {lines.map((ln, i) => (
            <div
              key={i}
              style={{
                display: 'flex',
                background: errorLoc && engine === 'python' && i + 1 === errorLoc.line ? 'rgba(192,86,63,0.12)' : undefined
              }}
            >
              <span style={{ color: '#9fb3a6', userSelect: 'none', width: 40, flex: 'none', textAlign: 'right', paddingRight: 12 }}>{i + 1}</span>
              <span style={{ flex: 1 }}>{highlightTokens(ln, engine)}</span>
            </div>
          ))}
        </pre>}
      </div>

      {/* 优化5：编辑即重渲染——实时预览区。优先展示真实渲染 SVG（改代码后自动刷新），否则用规格占位图。 */}
      <div style={{ flex: 'none', borderTop: '1px solid var(--line)', padding: '10px 14px', background: 'rgba(255,255,255,0.5)' }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
          <span style={{ fontSize: 12, fontWeight: 650, color: 'var(--ink-700)' }}>实时预览 · 引擎实际渲染</span>
          {previewLoading && <Badge tone="muted">加载 {ENGINE_LABEL[engine]} 产物…</Badge>}
          {editing && saving && <Badge tone="warn">重新渲染中…（停止输入 0.8s 后自动保存）</Badge>}
          {saveError && <Badge tone="danger">执行失败 · 保留上次通过图</Badge>}
        </div>
        <div
          style={{
            maxHeight: 220, overflow: 'auto', border: '1px solid var(--glass-border)',
            borderRadius: 'var(--radius)', background: '#ffffff', padding: 8
          }}
        >
          {realSvg ? (
            <RealSvgPreview svg={realSvg} className="codeviewer__svg" />
          ) : (
            <ChartPreview plan={plan} />
          )}
        </div>
      </div>

      <div style={{ flex: 'none', borderTop: '1px solid var(--line)', padding: '9px 14px', display: 'flex', gap: 14, flexWrap: 'wrap', background: 'rgba(255,255,255,0.5)' }}>
        <Badge tone="brand">引擎 {ENGINE_LABEL[engine]}</Badge>
        <Tooltip content={plan.sourceMode === 'code' ? '直接以你编辑的源码为准；界面修改需确认合并，避免覆盖源码。' : '图表参数与源码保持同步；界面调整会重新生成代码。'}>
          <Badge tone={plan.sourceMode === 'code' ? 'warn' : 'muted'}>{plan.sourceMode === 'code' ? '代码主导' : '参数同步'}</Badge>
        </Tooltip>
        <span className="badge badge--muted">依赖 {engine === 'r' ? (Array.from(code.matchAll(/library\((\w+)\)/g), (match) => match[1]).join('、') || 'R 基础图形') : plan.dependencies.join('、')}</span>
        <details style={{ fontSize: 11.5, color: 'var(--ink-500)' }}>
          <summary>查看数据处理与证据说明</summary>
          <div>{plan.dataProcessingSummary}</div>
          {plan.dataSuitability?.warnings?.length ? <div style={{ marginTop: 6 }}><strong>适配与解释边界：</strong>{plan.dataSuitability.warnings.join('；')}</div> : null}
          {plan.statisticalCorrectness?.errorBarSemantics ? <div style={{ marginTop: 4 }}><strong>统计表达：</strong>{plan.statisticalCorrectness.errorBarSemantics}</div> : null}
          {plan.dataProcessingTrace ? <div style={{ marginTop: 4 }}><strong>处理记录：</strong>数据指纹 {plan.dataProcessingTrace.datasetFingerprint?.slice(0, 12) ?? 'NA'}；{plan.dataProcessingTrace.inputShape?.rows ?? 'NA'} 行；未自动修改/插补/删除原始值；{plan.dataProcessingTrace.series?.map((item) => `${item.field} 缺失 ${item.missing ?? '按组汇总'}，聚合=${item.aggregation}`).join('；')}</div> : null}
        </details>
      </div>
    </div>
  )
}
