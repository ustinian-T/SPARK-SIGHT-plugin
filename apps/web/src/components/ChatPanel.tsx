import { useEffect, useMemo, useRef, useState, type DragEvent } from 'react'
import { useStore } from '../state/store'
import { Button, IconButton, Tooltip } from './common'
import { Icon } from './icons'
import { PlanTimeline } from './PlanTimeline'
import { BatchSplitPanel } from './BatchSplitPanel'
import { ChartPreview } from './ChartPreview'
import { RealSvgPreview } from './SvgPreview'
import { PaletteSelect } from './PaletteSelect'
import { DataOverviewCard } from './DataOverviewCard'
import { SAMPLE_CSV, SAMPLE_FILE } from '../mock/sample'
import { STATE_LABEL, type PlotPlan } from '../types'
import { buildProfile } from '../lib/csv'
import { summarizeCsv, MEASURE_SERIES_LIMIT, type SummarizeResult } from '../lib/summarize'
import type { DatasetProfile } from '../types'
import { UserProfilePanel } from './UserProfilePanel'

const DEFAULT_PROMPT = '比较不同施氮处理下作物随观测周次的响应，突出组间差异与趋势'
const QUICK_FEEDBACK = ['标题改为更学术的表述', '纵轴补充单位与含义', '弱化装饰、突出数据墨水比', '把图例移到图内右上角']

interface SelectedFile {
  fileName: string
  bytes: Uint8Array
  sizeLabel: string
  profile: DatasetProfile
  summary: SummarizeResult
  risks: string[]
  isSample: boolean
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(2)} MB`
}

/** 数据保留说明：依据真实部署模式给出，不再使用与实现不符的“仅临时处理”。 */
function retentionText(gate: ReturnType<typeof useStore>['state']['gate']): string {
  if (gate.mode === 'remote') {
    return '数据在服务端按任务保留期处理，到期自动清理；你可随时导出复现包或删除任务。'
  }
  if (gate.persist) {
    return '数据保存在本机工作目录的 .data 文件夹中（含原始 CSV、任务记录与产物），会一直保留，直到你删除任务。'
  }
  return '当前后端关闭了持久化，数据仅在本次运行期间存在于内存，重启后不保留。'
}

function buildRisks(profile: DatasetProfile, summary: SummarizeResult): string[] {
  const risks: string[] = []
  if (profile.rows < 1) risks.push('未检测到有效数据行，请确认文件内容与表头。')
  if (profile.encoding.includes('无法识别')) risks.push('编码探测存在无法识别字符，可能出现乱码，建议另存为 UTF-8。')
  const heavyMissing = profile.columns.filter((c) => c.missingRate > 0.3)
  if (heavyMissing.length) risks.push(`字段缺失率超过 30%：${heavyMissing.map((c) => c.name).join('、')}，推断需谨慎。`)
  const dup = (profile as any).duplicateRows?.count
  if (dup) risks.push(`检测到 ${dup} 行疑似重复记录。`)
  if (summary.ignoredMeasures.length) {
    risks.push(`单图最多纳入 ${MEASURE_SERIES_LIMIT} 个测量系列，字段 ${summary.ignoredMeasures.join('、')} 本次不会绘制；如需展示请拆分图表或分批分析。`)
  }
  return risks
}

function Welcome() {
  const { start, state, dismissStartError } = useStore()
  const [prompt, setPrompt] = useState('')
  useEffect(() => {
    const onSelection = (event: Event) => {
      const text = (event as CustomEvent<{ text?: string }>).detail?.text
      if (typeof text === 'string' && text.trim()) setPrompt(`请参考以下选中的代码或数据，提出绘图建议：\n${text}`)
    }
    window.addEventListener('deep-imaging:use-selection', onSelection)
    return () => window.removeEventListener('deep-imaging:use-selection', onSelection)
  }, [])
  const [drag, setDrag] = useState(false)
  const [font, setFont] = useState('SimHei')
  const [dpi, setDpi] = useState('300')
  const [palette, setPalette] = useState('auto')
  const [minFontSize, setMinFontSize] = useState('10')
  const [colorMode, setColorMode] = useState('color_and_mono')
  const [selected, setSelected] = useState<SelectedFile | null>(null)
  const [precheckError, setPrecheckError] = useState('')
  const [batchFiles, setBatchFiles] = useState<File[] | null>(null)
  // v0.4.0：绘图前多轮需求澄清（默认开启：任务目标→图型偏好→标题/图注排版，共三轮）
  const [clarify, setClarify] = useState(true)
  const inputRef = useRef<HTMLInputElement>(null)

  const withRules = (text: string) => `${text.trim()}\n\n[制图规范]\n字体=${font}; 最小字号=${minFontSize}pt; DPI=${dpi}; 配色预设=${palette}; 输出模式=${colorMode}; 背景=纯白; 标题=居中; 图例=自动避让; 文字遮挡=禁止`.trim()

  // 第一阶段：选择文件 → 本地预检，只展示结果，不创建任务、不开始执行。
  const precheck = async (fileName: string, bytes: Uint8Array, isSample = false) => {
    setPrecheckError('')
    try {
      const profile = await buildProfile(fileName, bytes)
      // 编码探测与 buildProfile 一致：UTF-8 优先，失败回退 GBK。
      const decode = () => { try { return new TextDecoder('utf-8', { fatal: true }).decode(bytes) } catch { return new TextDecoder('gbk').decode(bytes) } }
      const summary = summarizeCsv(decode(), profile.delimiter === '\\t' ? '\t' : profile.delimiter, profile)
      setSelected({ fileName, bytes, sizeLabel: formatSize(bytes.length), profile, summary, risks: buildRisks(profile, summary), isSample })
    } catch (e) {
      setSelected(null)
      setPrecheckError(`数据预检失败：${e instanceof Error ? e.message : String(e)}`)
    }
  }

  // 单文件：本地预检；多文件：直接进入批量拆分预览面板。
  const onFile = async (file: File) => {
    const bytes = new Uint8Array(await file.arrayBuffer())
    await precheck(file.name, bytes)
  }
  const onFiles = async (fileList: FileList | File[]) => {
    const arr = Array.from(fileList)
    if (arr.length === 0) return
    if (arr.length === 1) {
      await onFile(arr[0])
    } else {
      // 多文件：清空单文件选择，打开批量拆分面板。
      setSelected(null)
      setPrecheckError('')
      setBatchFiles(arr)
    }
  }
  const onDrop = (e: DragEvent) => {
    e.preventDefault()
    setDrag(false)
    const files = e.dataTransfer.files
    if (files && files.length > 0) void onFiles(files)
  }
  const loadSample = async () => {
    const bytes = new TextEncoder().encode(SAMPLE_CSV)
    await precheck(SAMPLE_FILE, bytes, true)
  }

  // 第二阶段：用户确认需求与设置后，显式点击“开始分析”才创建任务。
  const begin = async () => {
    if (!selected) return
    await start({ fileName: selected.fileName, bytes: selected.bytes, prompt: withRules(prompt || DEFAULT_PROMPT), clarify })
  }

  return (
    <div className="chat__scroll">
      {state.startError && (
        <div className="inline-alert inline-alert--danger" role="alert">
          <Icon name="shield" size={14} />
          <span>{state.startError}</span>
          <button className="inline-alert__close" onClick={() => dismissStartError()} aria-label="关闭">×</button>
        </div>
      )}

      <div className="empty chat__welcome-intro">
        <div className="empty__icon"><Icon name="chart" size={28} /></div>
        <h3>从一份 CSV 开始</h3>
        <p>选择数据并预检，确认后生成三套可复现的科研图表方案。</p>
      </div>

      <div style={{ padding: '0 26px', maxWidth: 720, margin: '0 auto', width: '100%' }}>
        <div
          className={`uploadzone ${drag ? 'is-drag' : ''}`}
          role="button"
          tabIndex={0}
          aria-label="上传 CSV 文件"
          onClick={() => inputRef.current?.click()}
          onKeyDown={(e) => {
            if (e.target === e.currentTarget && (e.key === 'Enter' || e.key === ' ')) {
              e.preventDefault()
              inputRef.current?.click()
            }
          }}
          onDragOver={(e) => { e.preventDefault(); setDrag(true) }}
          onDragLeave={() => setDrag(false)}
          onDrop={onDrop}
        >
          <Tooltip content="UTF-8 / GBK 自动探测；建议 ≤ 10MB，能力上限 50MB / 100 万行。" placement="bottom">
            <div className="uploadzone__icon"><Icon name="upload" size={22} /></div>
          </Tooltip>
          <h4>拖拽 CSV 到此处，或点击选择文件（支持多文件批量拆分）</h4>
          <input
            ref={inputRef}
            type="file"
            accept=".csv,text/csv"
            multiple
            style={{ display: 'none' }}
            onChange={(e) => { if (e.target.files?.length) void onFiles(e.target.files); e.target.value = '' }}
          />
        </div>

        {precheckError && (
          <div className="inline-alert inline-alert--danger" style={{ marginTop: 12 }} role="alert">
            <Icon name="shield" size={14} /><span>{precheckError}</span>
          </div>
        )}

        {/* 已选文件预检卡片：确认前可重新选择或移除 */}
        {selected && (
          <div className="filecard" style={{ marginTop: 12 }}>
            <div className="filecard__head">
              <span className="filecard__icon"><Icon name="table" size={16} /></span>
              <div className="filecard__meta">
                <span className="filecard__name" title={selected.fileName}>{selected.fileName}</span>
                <span className="filecard__sub">
                  {selected.sizeLabel} · {selected.profile.rows} 行 × {selected.profile.cols} 列 · 编码 {selected.profile.encoding} · 分隔符 “{selected.profile.delimiter}”
                </span>
              </div>
              <button className="filecard__action" onClick={() => setSelected(null)} title="移除，重新选择">
                <Icon name="close" size={14} />
              </button>
            </div>
            {selected.risks.length > 0 && (
              <ul className="filecard__risks">
                {selected.risks.map((r, i) => (
                  <li key={i}><Icon name="shield" size={12} /> {r}</li>
                ))}
              </ul>
            )}
            <button className="filecard__reselect" onClick={() => inputRef.current?.click()}>
              <Icon name="upload" size={12} /> 重新选择文件
            </button>
          </div>
        )}

        <UserProfilePanel early onLoaded={profile => setClarify(profile.clarificationMode !== 'off')} />

        <div style={{ marginTop: 12 }}>
          <label className="form-label">你希望图表重点说明什么（可选）</label>
          <div className="inputrow">
            <textarea
              rows={2}
              placeholder="例如：比较对照组与两种施氮处理随周次的变化，需要误差棒，用于论文结果部分…"
              value={prompt}
              onChange={(e) => setPrompt(e.target.value)}
            />
          </div>
        </div>

        <details className="start-rules" style={{ marginTop: 12 }}>
          <summary>制图设置（可选）</summary>
          <div className="start-rules__grid">
            <label>字体<select className="form-control" value={font} onChange={(e) => setFont(e.target.value)}><option value="SimHei">黑体（SimHei）</option><option value="Microsoft YaHei">微软雅黑</option><option value="Noto Sans CJK SC">思源黑体（Noto Sans CJK）</option><option value="Source Han Sans SC">思源黑体（Source Han Sans）</option><option value="SimSun">宋体（SimSun）</option><option value="Noto Serif CJK SC">思源宋体（Noto Serif CJK）</option><option value="Source Han Serif SC">思源宋体（Source Han Serif）</option><option value="KaiTi">楷体（KaiTi）</option><option value="FangSong">仿宋（FangSong）</option><option value="Arial">Arial</option><option value="Times New Roman">Times New Roman</option><option value="Liberation Sans">Liberation Sans</option><option value="Liberation Serif">Liberation Serif</option><option value="DejaVu Sans">DejaVu Sans</option></select></label>
            <label>最小字号<select className="form-control" value={minFontSize} onChange={(e) => setMinFontSize(e.target.value)}><option value="10">10 pt</option><option value="11">11 pt</option><option value="12">12 pt</option></select></label>
            <label>清晰度<select className="form-control" value={dpi} onChange={(e) => setDpi(e.target.value)}><option value="300">300 dpi</option><option value="600">600 dpi</option></select></label>
            <div><label className="form-label">配色</label><PaletteSelect value={palette} onChange={setPalette} options={[{ id: 'auto', label: '自动推荐' }, { id: 'user_ocean', label: '预设一·青蓝递进' }, { id: 'user_garden', label: '预设二·柔和分类' }, { id: 'user_nature', label: '预设三·自然低饱和' }, { id: 'user_macaron', label: '预设四·冷暖马卡龙' }, { id: 'user_pairs', label: '预设五·成对对照' }]} /></div>
            <label>输出模式<select className="form-control" value={colorMode} onChange={(e) => setColorMode(e.target.value)}><option value="color_and_mono">彩色且兼容黑白打印</option><option value="color">仅彩色</option><option value="mono">黑白</option></select></label>
          </div>
        </details>

        {/* v0.4.0：绘图前多轮需求澄清开关（默认开启，符合“先轮询需求再绘图”的产品约束） */}
        <label
          style={{
            display: 'flex', alignItems: 'center', gap: 8, marginTop: 12,
            fontSize: 12.5, color: 'var(--ink-600)', cursor: 'pointer', userSelect: 'none'
          }}
        >
          <input type="checkbox" checked={clarify} onChange={(e) => setClarify(e.target.checked)} />
          <span>
            绘图前先询问我的需求（三轮：图表目标 → 图型偏好 → 标题/图注与排版；无要求按科研制图默认执行）
            <Tooltip content="热力图 / 双Y轴图 / 三维曲面图等新图型可在此轮指定；标题、图注、字体字色字号字距与 DPI 在第三轮询问，未填写则用默认（白底 / SimHei / ≥10pt / 300dpi）。" placement="bottom">
              <span style={{ display: 'inline-flex', marginLeft: 4, verticalAlign: -2 }}><Icon name="shield" size={12} /></span>
            </Tooltip>
          </span>
        </label>

        <div style={{ display: 'flex', gap: 9, marginTop: 12, justifyContent: 'center' }}>
          <Button variant="primary" icon="play" disabled={!selected} onClick={begin}>
            开始分析
          </Button>
          <Button variant="soft" icon="table" onClick={loadSample}>
            选择示例数据
          </Button>
        </div>
        <div style={{ textAlign: 'center', marginTop: 10 }}>
          <Tooltip content={retentionText(state.gate)} placement="top">
            <span style={{ fontSize: 11, color: 'var(--ink-400)', cursor: 'help', borderBottom: '1px dotted var(--ink-400)' }}>
              数据如何保留？
            </span>
          </Tooltip>
        </div>
      </div>

      {/* 阶段 3：多文件上传 → 批量拆分预览 */}
      {batchFiles && (
        <BatchSplitPanel
          open={!!batchFiles}
          files={batchFiles}
          onClose={() => setBatchFiles(null)}
        />
      )}
    </div>
  )
}

/**
 * 阶段 7：工作区内嵌图表预览区。
 * 当任务处于 PRESENT/ITERATE/COMPLETE 且有方案时，在消息流底部展示当前选中方案的图表。
 * 优先使用真实渲染 SVG（execution.artifactSvg），否则用 ChartPreview 占位渲染。
 */
const EmbeddedChartPreview = function EmbeddedChartPreview({ plan }: { plan: PlotPlan }) {
  const { state, setView, setActivePlan, exportArtifact } = useStore()
  const [exportOpen, setExportOpen] = useState(false)
  const [exportOptions, setExportOptions] = useState({ includeCode: true, includeData: true, includeEvidence: true, includeArtifacts: true, colorMode: 'color' as 'color' | 'grayscale', dpi: 300 })
  // 真实渲染产物 SVG（若存在）；否则使用前端即时预览，并明确其状态。
  const execution = state.task?.execution
  const realSvg = execution?.artifactSvg
    && execution.artifactPlanId === plan.plan_id
    && execution.artifactEngine === plan.engine
    ? execution.artifactSvg
    : undefined

  // useMemo 缓存图表渲染结果，避免消息流每次刷新都重算 SVG，防止卡顿。
  const chart = useMemo(() => {
    if (realSvg) {
      return <RealSvgPreview svg={realSvg} className="svg-preview--embedded" />
    }
    return <ChartPreview plan={plan} />
  }, [realSvg, plan])

  return (
    <div
      style={{
        alignSelf: 'center',
        width: '100%',
        maxWidth: 640,
        marginTop: 12,
        border: '1px solid var(--glass-border)',
        borderRadius: 'var(--radius)',
        background: 'var(--glass-bg)',
        overflow: 'auto'
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '8px 12px',
          borderBottom: '1px solid var(--glass-border)',
          fontSize: 12.5,
          fontWeight: 600,
          color: 'var(--ink-700)'
        }}
      >
        <span>当前方案 · {plan.name} <span style={{ fontSize: 10.5, fontWeight: 500, color: 'var(--ink-500)' }}>{realSvg ? '已验证产物' : '即时预览'}</span></span>
        <div style={{ display: 'flex', gap: 4 }}>
          <Button
            size="sm"
            variant="ghost"
            icon="maximize"
            title="放大查看"
            onClick={() => { setActivePlan(plan.plan_id); setView('compare') }}
          >
            放大
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon="grid"
            title="对比三方案"
            onClick={() => setView('compare')}
          >
            对比三方案
          </Button>
          <Button
            size="sm"
            variant="ghost"
            icon="download"
            title="导出复现包（代码、数据、证据与真实产物）"
            onClick={() => exportArtifact('reproduce')}
          >
            复现包
          </Button>
          <details open={exportOpen} onToggle={(event) => setExportOpen((event.currentTarget as HTMLDetailsElement).open)} style={{ position: 'relative' }}>
            <summary style={{ listStyle: 'none', cursor: 'pointer', padding: '4px 7px', border: '1px solid var(--glass-border)', borderRadius: 5, fontSize: 11 }}>设置</summary>
            <div style={{ position: 'absolute', right: 0, top: 30, zIndex: 4, width: 190, padding: 10, background: 'var(--glass-bg)', border: '1px solid var(--glass-border)', borderRadius: 7, boxShadow: '0 8px 24px rgba(0,0,0,.12)', fontSize: 11 }}>
              {(['includeCode', 'includeData', 'includeEvidence', 'includeArtifacts'] as const).map((key) => <label key={key} style={{ display: 'block', marginBottom: 5 }}><input type="checkbox" checked={exportOptions[key]} onChange={(event) => setExportOptions((current) => ({ ...current, [key]: event.target.checked }))} /> {({ includeCode: '源码', includeData: '数据', includeEvidence: '证据', includeArtifacts: '真实产物' } as Record<string, string>)[key]}</label>)}
              <label style={{ display: 'block', marginBottom: 5 }}>色彩 <select value={exportOptions.colorMode} onChange={(event) => setExportOptions((current) => ({ ...current, colorMode: event.target.value as 'color' | 'grayscale' }))}><option value="color">彩色</option><option value="grayscale">灰度打印</option></select></label>
              <label style={{ display: 'block', marginBottom: 8 }}>DPI <select value={exportOptions.dpi} onChange={(event) => setExportOptions((current) => ({ ...current, dpi: Number(event.target.value) }))}><option value={300}>300</option><option value={600}>600</option><option value={1200}>1200</option></select></label>
              <Button size="sm" variant="soft" onClick={() => { exportArtifact('reproduce', exportOptions); setExportOpen(false) }}>按设置导出</Button>
            </div>
          </details>
        </div>
      </div>
      <div style={{ padding: 10 }}>{chart}</div>
    </div>
  )
}

function MessageList() {
  const { state, answer, feedback, cancelRun, addToBacklog, retryTask } = useStore()
  const task = state.task!
  const [text, setText] = useState('')
  const [retrying, setRetrying] = useState(false)
  const [retryError, setRetryError] = useState('')
  const busy = state.running
  const pending = task.state === 'NEED_INPUT' ? task.pendingQuestion : undefined
  // v0.4.0 优化：第三轮（key=presentation）结构化表单字段（协议键 → 「键=值」键值对序列化）
  const [presentationForm, setPresentationForm] = useState<Record<string, string>>({})
  const PRESENTATION_FIELDS = [
    { key: 'title', label: '图表标题', type: 'text', placeholder: '如：不同施氮处理下作物产量响应' },
    { key: 'caption', label: '图注', type: 'text', placeholder: '如：图1-1 各处理组日均产量对比（对象+方法+功能）' },
    { key: 'font', label: '字体', type: 'text', placeholder: '默认 SimHei（黑体）' },
    { key: 'titleColor', label: '标题字色', type: 'color', defaultValue: '#000000' },
    { key: 'titleSize', label: '标题字号', type: 'number', defaultValue: '15' },
    { key: 'captionColor', label: '图注字色', type: 'color', defaultValue: '#000000' },
    { key: 'captionSize', label: '图注字号', type: 'number', defaultValue: '10.5' },
    { key: 'axisLabelSize', label: '轴标签字号', type: 'number', defaultValue: '12.5' },
    { key: 'tickSize', label: '刻度字号', type: 'number', defaultValue: '11' },
    { key: 'legendSize', label: '图例字号', type: 'number', defaultValue: '11' },
    { key: 'spacing', label: '字距', type: 'number', defaultValue: '1.0' },
    { key: 'dpi', label: 'DPI', type: 'number', defaultValue: '300' }
  ]
  const PROTOCOL_KEY: Record<string, string> = {
    title: '标题', caption: '图注', font: '字体', titleColor: '标题字色', titleSize: '标题字号',
    captionColor: '图注字色', captionSize: '图注字号', axisLabelSize: '轴标签字号',
    tickSize: '刻度字号', legendSize: '图例字号', spacing: '字距', dpi: 'DPI', paletteId: '配色', labelLanguage: '标注语言', legendPosition: '图例位置'
  }
  // 第三轮：后端随 need_input 下发推荐色板（依据历史配色学习）→ 渲染结构化表单
  const showPresentationForm = pending?.key === 'presentation'
  // PRESENT / ITERATE 允许对当前方案提修改意见；NEED_INPUT 允许回答智能体的提问（含自由文本）。
  const canFeedback = ['PRESENT', 'ITERATE'].includes(task.state)
  const canAnswer = task.state === 'NEED_INPUT'
  const canSend = canFeedback || canAnswer

  // 阶段 7：内嵌图表预览——任务处于方案呈现/迭代/完成态且有方案时，在消息流底部渲染预览。
  const showInlineChart = ['PRESENT', 'ITERATE', 'COMPLETE'].includes(task.state) && task.plans.length > 0
  const activePlan = task.plans.find((p) => p.plan_id === state.activePlanId)
    ?? task.plans.find((p) => p.plan_id === task.selectedPlanId)
    ?? task.plans[0]

  const sendFeedback = async (t?: string) => {
    const value = (t ?? text).trim()
    if (!value) return
    setText('')
    await feedback(value)
  }

  // 回答 NEED_INPUT 提问：走 answerQuestion，而不是 feedback。
  const sendAnswer = (t?: string) => {
    const value = (t ?? text).trim()
    if (!value) return
    setText('')
    answer(value)
  }

  // 结构化表单 → 协议键值对（「标题=…；图注=…；标题字色=…；…；配色=色板id」），仅含用户填写项。
  const submitPresentationForm = () => {
    const parts: string[] = []
    for (const field of PRESENTATION_FIELDS) {
      const value = presentationForm[field.key]?.trim()
      if (!value) continue
      if (field.type === 'number') {
        const n = Number(value)
        if (!Number.isFinite(n)) continue
      }
      parts.push(`${PROTOCOL_KEY[field.key]}=${value}`)
    }
    const paletteId = presentationForm.paletteId?.trim()
    if (paletteId) parts.push(`配色=${paletteId}`)
    for (const key of ['labelLanguage', 'legendPosition']) if (presentationForm[key]) parts.push(`${PROTOCOL_KEY[key]}=${presentationForm[key]}`)
    if (parts.length === 0) { setText(''); answer('全部按科研默认'); return }
    setPresentationForm({})
    setText('')
    answer(parts.join('；'))
  }

  // 统一提交：按当前任务状态路由到 feedback 或 answer。
  const submit = async () => {
    if (canAnswer) { sendAnswer(); return }
    await sendFeedback()
  }

  return (
    <>
      <div className="chat__scroll">
        {['FAILED', 'CANCELLED'].includes(task.state) && <div role="alert" className="task-retry">
          <strong>{task.state === 'FAILED' ? '本次任务未完成' : '任务已取消'}</strong>
          <p>原数据、需求和失败记录已保留。可重试；若需修正需求，请先填写下方说明。</p>
          <input className="form-control" aria-label="重试需求（可选）" placeholder="可选：填写修正后的完整绘图需求" value={text} onChange={(e) => setText(e.target.value)} />
          <Button variant="primary" icon="play" disabled={retrying} onClick={async () => {
            setRetrying(true); setRetryError('')
            try { await retryTask(text.trim() || undefined); setText('') }
            catch (error) { setRetryError(error instanceof Error ? error.message : String(error)) }
            finally { setRetrying(false) }
          }}>{retrying ? '正在重试…' : '重试任务'}</Button>
          {retryError && <p role="alert">{retryError}</p>}
        </div>}

        {state.messages.map((m) => (
          <div key={m.id} className={`msg msg--${m.role}`}>
            <span className="msg__avatar">
              <Icon name={m.role === 'user' ? 'send' : 'spark'} size={14} />
            </span>
            <div className="msg__bubble">
              {m.text}
              {m.attachments?.map((a) => (
                <div key={a} className="badge badge--muted" style={{ marginTop: 6 }}>
                  <Icon name="file" size={11} /> {a}
                </div>
              ))}
              {m.state && <div className="msg__state"><span className="badge badge--brand">{STATE_LABEL[m.state]}</span></div>}
            </div>
          </div>
        ))}

        {task.steps.length > 0 && (
          <div style={{ alignSelf: 'center', width: '100%', maxWidth: 560 }}>
            <PlanTimeline steps={task.steps} />
          </div>
        )}

        {task.dataOverview && (
          <div className="msg msg--assistant">
            <span className="msg__avatar"><Icon name="spark" size={14} /></span>
            <div className="msg__bubble" style={{ width: '100%' }}>
              {/* v0.4.2：上传后、澄清轮询前的数据概览卡（体检仅提示，数据包不变） */}
              <DataOverviewCard overview={task.dataOverview} fileName={task.title} />
            </div>
          </div>
        )}

        {pending && (
          <div className="msg msg--assistant">
            <span className="msg__avatar"><Icon name="spark" size={14} /></span>
            <div className="msg__bubble" style={{ width: '100%' }}>
              {/* v0.4.0：多轮澄清的轮次进度（第 X/N 轮）与轮次标签 */}
              {pending.total ? (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
                  <span className="badge badge--brand">绘图前需求澄清 · 第 {pending.round ?? 1}/{pending.total} 轮</span>
                  <span style={{ fontSize: 11, color: 'var(--ink-500)' }}>
                    {pending.key === 'goal' ? '图表目标' : pending.key === 'chartType' ? '图型偏好' : pending.key === 'presentation' ? '标题/图注/排版' : '需求补充'}
                  </span>
                </div>
              ) : undefined}
              {pending.question}
              {pending.hint && (
                <div style={{ fontSize: 11.5, color: 'var(--ink-500)', marginTop: 6, lineHeight: 1.5 }}>
                  提示：{pending.hint}
                </div>
              )}
              {/* v0.4.0 优化：第三轮结构化表单（标题/图注/字体字色字号字距/DPI + 推荐配色 swatch 点选） */}
              {showPresentationForm && (
                <div
                  style={{
                    marginTop: 10, border: '1px solid var(--glass-border)',
                    borderRadius: 'var(--radius)', background: 'var(--glass-bg)', padding: 10
                  }}
                >
                  <div style={{ fontSize: 12, fontWeight: 600, marginBottom: 8, color: 'var(--ink-700)' }}>
                    填写排版（未填项按科研制图默认执行）
                  </div>
                  <div style={{ display: 'flex', flexWrap: 'wrap', gap: 10, marginBottom: 10 }}>
                    <label>标注语言<select aria-label="本次标注语言" className="form-control" value={presentationForm.labelLanguage ?? ''} onChange={event => setPresentationForm(form => ({ ...form, labelLanguage: event.target.value }))}>
                      <option value="">沿用账号偏好 / 默认</option><option value="auto">保留原始字段语言</option><option value="zh">中文</option><option value="en">英文</option><option value="bilingual">中英双语</option>
                    </select></label>
                    <label>图例位置<select aria-label="本次图例位置" className="form-control" value={presentationForm.legendPosition ?? ''} onChange={event => setPresentationForm(form => ({ ...form, legendPosition: event.target.value }))}>
                      <option value="">沿用账号偏好 / 默认</option><option value="auto">自动避让</option><option value="right">图外右侧</option><option value="top">图外顶部</option><option value="bottom">图外底部</option><option value="inside">图内右上角</option>
                    </select></label>
                  </div>
                  <div
                    style={{
                      display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(140px, 1fr))',
                      gap: 8, marginBottom: 4
                    }}
                  >
                    {PRESENTATION_FIELDS.map((field) => (
                      <label key={field.key} style={{ display: 'flex', flexDirection: 'column', gap: 3, fontSize: 11.5, color: 'var(--ink-600)' }}>
                        {field.label}
                        {field.type === 'color' ? (
                          <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <input
                              type="color"
                              value={presentationForm[field.key] ?? field.defaultValue}
                              onChange={(e) => setPresentationForm((f) => ({ ...f, [field.key]: e.target.value }))}
                              style={{ width: 34, height: 26, padding: 0, border: '1px solid var(--glass-border)', borderRadius: 6, background: 'transparent', cursor: 'pointer' }}
                            />
                            <span style={{ fontSize: 11, color: 'var(--ink-500)', fontFamily: 'monospace' }}>
                              {presentationForm[field.key] ?? field.defaultValue}
                            </span>
                          </span>
                        ) : (
                          <input
                            type={field.type}
                            placeholder={field.placeholder}
                            value={presentationForm[field.key] ?? ''}
                            onChange={(e) => setPresentationForm((f) => ({ ...f, [field.key]: e.target.value }))}
                            style={{ width: '100%', boxSizing: 'border-box' }}
                          />
                        )}
                      </label>
                    ))}
                  </div>
                  <div style={{ fontSize: 11.5, color: 'var(--ink-600)', margin: '8px 0 6px' }}>
                    推荐配色（依据你的历史配色偏好动态调整，点选即用）
                  </div>
                  <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {(pending.recommendedPalettes ?? []).map((p) => {
                      const selected = presentationForm.paletteId === p.id
                      return (
                        <button
                          key={p.id}
                          type="button"
                          onClick={() => setPresentationForm((f) => ({ ...f, paletteId: p.id }))}
                          style={{
                            display: 'flex', alignItems: 'center', gap: 10, width: '100%', textAlign: 'left',
                            padding: '6px 8px', borderRadius: 8, cursor: 'pointer', fontSize: 12,
                            border: selected ? '1.5px solid var(--brand)' : '1px solid var(--glass-border)',
                            background: selected ? 'color-mix(in srgb, var(--brand) 8%, transparent)' : 'transparent'
                          }}
                        >
                          <span style={{ display: 'inline-flex', gap: 2, flexShrink: 0 }}>
                            {p.colors.slice(0, 6).map((c, i) => (
                              <span key={i} style={{ width: 14, height: 14, borderRadius: 3, background: c, display: 'inline-block', border: '1px solid rgba(0,0,0,0.08)' }} />
                            ))}
                          </span>
                          <span style={{ minWidth: 0 }}>
                            <span style={{ display: 'block', fontWeight: 600, color: 'var(--ink-700)' }}>
                              {p.name} {selected ? ' ✓' : ''}
                            </span>
                            <span style={{ display: 'block', fontSize: 10.5, color: 'var(--ink-500)', lineHeight: 1.4 }}>{p.reason}</span>
                            {p.metrics && (
                              <span style={{ display: 'block', fontSize: 10, color: 'var(--ink-400)', lineHeight: 1.35 }}>
                                CVD {p.metrics.cvdPass === false ? '未通过' : '通过'} · 灰度 {p.metrics.grayscalePass === false ? '未通过' : '通过'}
                              </span>
                            )}
                          </span>
                        </button>
                      )
                    })}
                  </div>
                  <div style={{ display: 'flex', gap: 8, marginTop: 10, justifyContent: 'flex-end' }}>
                    <Button size="sm" variant="ghost" onClick={() => { setPresentationForm({}); setText(''); answer('全部按科研默认') }}>
                      全部按默认
                    </Button>
                    <Button size="sm" variant="primary" icon="send" onClick={submitPresentationForm}>
                      按此设置绘图
                    </Button>
                  </div>
                </div>
              )}
              <div className="askcard">
                <div className="askcard__opts">
                  {pending.options.map((o) => (
                    <Button key={o} size="sm" variant="soft" onClick={() => { setText(''); answer(o); }}>{o}</Button>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {/* v0.4.0：绘图前需求澄清摘要——方案呈现后回显用户确认的需求（目标/图型/排版） */}
        {task.clarification && ['PRESENT', 'ITERATE', 'COMPLETE'].includes(task.state) && (
          <div
            style={{
              alignSelf: 'center', width: '100%', maxWidth: 560, marginTop: 10,
              border: '1px solid var(--glass-border)', borderRadius: 'var(--radius)',
              background: 'var(--glass-bg)', padding: '9px 12px', fontSize: 12
            }}
          >
            <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', alignItems: 'center' }}>
              <span className="badge badge--brand">已按你的需求绘图</span>
              <span style={{ color: 'var(--ink-600)' }}>
                目标：<b>{task.clarification.goal || '—'}</b> · 图型：<b>{task.clarification.chartType || '自动推荐'}</b>
              </span>
              {task.clarification.title && (
                <span style={{ color: 'var(--ink-600)' }}>标题：<b>{task.clarification.title}</b></span>
              )}
              {task.clarification.caption && (
                <span style={{ color: 'var(--ink-600)' }}>图注：<b>{task.clarification.caption}</b></span>
              )}
              {task.clarification.paletteId && (
                <span style={{ color: 'var(--ink-600)' }}>配色：<b>{task.clarification.paletteId}</b></span>
              )}
              {task.clarification.source === 'defaults' && (
                <span style={{ color: 'var(--ink-400)' }}>（未指定项按科研制图默认执行：白底 / SimHei / ≥10pt / 300dpi）</span>
              )}
            </div>
          </div>
        )}

        {/* 阶段 7：工作区内嵌图表预览（消息流最后一个区块） */}
        {showInlineChart && activePlan && <EmbeddedChartPreview plan={activePlan} />}
      </div>

      <div className="chat__input">
        {canFeedback && (
          <div style={{ display: 'flex', gap: 6, flexWrap: 'wrap', marginBottom: 8 }}>
            {QUICK_FEEDBACK.map((q) => (
              <button key={q} className="btn btn--sm" onClick={() => void sendFeedback(q)}>{q}</button>
            ))}
          </div>
        )}
        <div className="inputrow">
          <IconButton
            name={busy ? 'close' : 'play'}
            title={busy ? '取消任务' : '发送'}
            disabled={!text.trim() && !busy}
            onClick={() => { if (busy) cancelRun(); else if (canSend) void submit() }}
          />
          <textarea
            rows={1}
            placeholder={busy ? `智能体运行中（${STATE_LABEL[task.state]}）…可加入待办稍后执行` : canAnswer ? '输入你的回答，或点击上方预设选项…' : canFeedback ? '提出修改意见，进入多轮迭代…' : '等待当前步骤完成…'}
            value={text}
            disabled={!canSend && !busy}
            onChange={(e) => setText(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault()
                // 运行中回车默认加入待办，空闲时回车立即发送。
                if (busy) {
                  const v = text.trim()
                  if (v) { addToBacklog(v); setText('') }
                } else {
                  void submit()
                }
              }
            }}
          />
          {/* 阶段 7：双按钮——运行中时主按钮禁用（只能排队），空闲时可立即发送。 */}
          <Button
            size="sm"
            variant="soft"
            icon="layers"
            disabled={!text.trim()}
            title="将当前内容加入待办队列，不立即执行"
            onClick={() => {
              const v = text.trim()
              if (v) { addToBacklog(v); setText('') }
            }}
          >
            加入待办
          </Button>
          <Button
            size="sm"
            variant="primary"
            icon="send"
            disabled={busy || !canSend || !text.trim()}
            onClick={() => void submit()}
          >
            立即发送
          </Button>
        </div>
        <div className="chat__hint">
          <Tooltip content="执行在沙箱内完成、默认禁网；修改以 SpecPatch 形式提出，可预览、接受或撤销。" placement="top">
            <span style={{ display: 'inline-flex' }}><Icon name="shield" size={12} /></span>
          </Tooltip>
        </div>
      </div>
    </>
  )
}

export function ChatPanel() {
  const { state } = useStore()
  return (
    <div className="panel chat">
      {state.task ? <MessageList /> : <Welcome />}
    </div>
  )
}
